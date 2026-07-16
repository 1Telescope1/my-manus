import 'reflect-metadata';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { Response } from 'express';
import { AgentService } from '../../src/application/services/agent.service';
import { SessionService } from '../../src/application/services/session.service';
import { SessionStreamService } from '../../src/application/services/session-stream.service';
import { NotFoundError } from '../../src/core/errors/app-exception';
import { Event, events, PlanEventStatus, StepEventStatus, ToolEventStatus } from '../../src/domain/models/event';
import { createPlan, ExecutionStatus } from '../../src/domain/models/plan';
import { createSession, SessionStatus } from '../../src/domain/models/session';
import { SessionController } from '../../src/interfaces/controllers/session.controller';

class FakeResponse {
  statusCode?: number;
  readonly headers = new Map<string, string>();
  readonly chunks: string[] = [];
  flushed = false;
  ended = false;
  destroyed = false;
  writableEnded = false;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  setHeader(name: string, value: string): this {
    this.headers.set(name, value);
    return this;
  }

  flushHeaders(): void {
    this.flushed = true;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  end(): this {
    this.ended = true;
    this.writableEnded = true;
    return this;
  }
}

function createController(input: {
  session?: ReturnType<typeof createSession> | null;
  sessions?: ReturnType<typeof createSession>[];
  chatEvents?: Event[];
} = {}): SessionController {
  const createdSession = input.session ?? createSession({ id: 'session-new', title: '新对话' });
  const sessionService = {
    createSession: async () => createdSession,
    getAllSessions: async () => input.sessions ?? [createdSession],
    getSession: async () => input.session === undefined ? createdSession : input.session,
  } as unknown as SessionService;
  const agentService = {
    async *chat(): AsyncGenerator<Event> {
      for (const event of input.chatEvents ?? []) {
        yield event;
      }
    },
  } as unknown as AgentService;

  return new SessionController(
    sessionService,
    {} as SessionStreamService,
    agentService,
  );
}

test('创建和查询会话时应保持现有响应结构与字段名', async () => {
  const session = createSession({
    id: 'session-1',
    title: '测试会话',
    latest_message: '你好',
    latest_message_at: new Date('2026-07-16T08:00:00.000Z'),
    status: SessionStatus.RUNNING,
    unread_message_count: 2,
    events: [events.done()],
  });
  const controller = createController({ session, sessions: [session] });

  assert.deepEqual(await controller.createSession(), {
    code: 200,
    msg: '创建任务会话成功',
    data: { session_id: 'session-1' },
  });
  assert.deepEqual(await controller.getAllSessions(), {
    code: 200,
    msg: '获取任务会话列表成功',
    data: {
      sessions: [{
        session_id: 'session-1',
        title: '测试会话',
        latest_message: '你好',
        latest_message_at: new Date('2026-07-16T08:00:00.000Z'),
        status: 'running',
        unread_message_count: 2,
      }],
    },
  });

  const detail = await controller.getSession('session-1');
  assert.equal(detail.code, 200);
  assert.equal(detail.msg, '获取会话详情成功');
  assert.equal(detail.data.session_id, 'session-1');
  assert.equal(detail.data.title, '测试会话');
  assert.equal(detail.data.status, 'running');
  assert.deepEqual(detail.data.events.map((event) => event.event), ['done']);
  const eventData = JSON.parse(JSON.stringify(detail.data.events[0].data));
  assert.deepEqual(Object.keys(eventData).sort(), ['created_at', 'event_id']);
});

test('查询不存在的会话时应抛出当前约定的 NotFoundError', async () => {
  const controller = createController({ session: null });
  await assert.rejects(
    () => controller.getSession('missing'),
    (error: unknown) => error instanceof NotFoundError
      && error.message === '该会话不存在，请核实后重试',
  );
});

test('聊天接口应按生成顺序写入标准 SSE 事件', async () => {
  const plan = createPlan({
    id: 'plan-1',
    title: '测试会话',
    status: ExecutionStatus.RUNNING,
    steps: [{ id: 'step-1', description: '执行任务', status: ExecutionStatus.RUNNING }],
  });
  const step = plan.steps[0];
  const controller = createController({
    chatEvents: [
      events.plan(plan, PlanEventStatus.CREATED),
      events.step(step, StepEventStatus.STARTED),
      events.tool({
        tool_call_id: 'call-1',
        tool_name: 'search',
        function_name: 'search_web',
        function_args: { query: '测试查询' },
        status: ToolEventStatus.CALLING,
      }),
      events.wait(),
    ],
  });
  const response = new FakeResponse();

  await controller.chat(
    'session-1',
    { message: '开始测试', attachments: [] },
    response as unknown as Response,
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers.get('Content-Type'), 'text/event-stream');
  assert.equal(response.headers.get('Cache-Control'), 'no-cache');
  assert.equal(response.headers.get('Connection'), 'keep-alive');
  assert.equal(response.flushed, true);
  assert.equal(response.ended, true);

  const payload = response.chunks.join('');
  assert.deepEqual(
    [...payload.matchAll(/^event: ([^\n]+)$/gm)].map((match) => match[1]),
    ['plan', 'step', 'tool', 'wait'],
  );
  const dataLines = [...payload.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]));
  assert.equal(dataLines.length, 4);
  assert.equal(dataLines[0].steps[0].id, 'step-1');
  assert.equal(dataLines[1].id, 'step-1');
  assert.equal(dataLines[2].tool_call_id, 'call-1');
  assert.deepEqual(Object.keys(dataLines[3]).sort(), ['created_at', 'event_id']);
  assert.equal(payload.split('\n\n').filter(Boolean).length, 4);
});

test('会话列表流应发送 sessions 事件，并在断开连接时取消订阅', async () => {
  const session = createSession({ id: 'session-1', title: '测试会话' });
  let listener: ((sessions: ReturnType<typeof createSession>[]) => void) | undefined;
  let unsubscribed = false;
  const streamService = {
    subscribe(next: typeof listener) {
      listener = next;
      return () => { unsubscribed = true; };
    },
  } as unknown as SessionStreamService;
  const controller = new SessionController(
    {} as SessionService,
    streamService,
    {} as AgentService,
  );
  const request = new EventEmitter();
  const response = new FakeResponse();

  const streaming = controller.streamSessions(
    request as never,
    response as unknown as Response,
  );
  listener?.([session]);
  request.emit('close');
  await streaming;

  assert.match(response.chunks.join(''), /^event: sessions\ndata: /);
  assert.match(response.chunks.join(''), /"session_id":"session-1"/);
  assert.equal(unsubscribed, true);
});
