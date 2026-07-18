import assert from 'node:assert/strict';
import test from 'node:test';
import { RuntimeEventAdapter } from '../../src/application/services/runtime-event.adapter';
import { createPlan, ExecutionStatus } from '../../src/domain/models/plan';
import { RuntimeEvent, RuntimeEventBase } from '../../src/domain/models/runtime-event';
import { EventMapper } from '../../src/interfaces/dto/event.dto';

const CREATED_AT = new Date('2026-07-16T08:00:00.000Z');

function eventBase(
  type: RuntimeEvent['type'],
  sequence: number,
  runId = 'run-1',
): RuntimeEventBase {
  return {
    id: `${runId}-event-${sequence}`,
    type,
    runId,
    sequence,
    createdAt: CREATED_AT,
  };
}

function wireValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

test('Runtime 事件应转换为现有 UI 能识别的事件序列', () => {
  const plan = createPlan({
    id: 'plan-1',
    title: '测试计划',
    goal: '验证兼容适配',
    language: 'zh-CN',
    steps: [{ id: 'step-1', description: '执行测试步骤' }],
  });
  const step = plan.steps[0];
  const runtimeEvents: RuntimeEvent[] = [
    { ...eventBase('title.updated', 1), type: 'title.updated', title: '测试会话' },
    { ...eventBase('plan.created', 2), type: 'plan.created', plan },
    { ...eventBase('step.started', 3), type: 'step.started', step },
    {
      ...eventBase('tool.calling', 4),
      type: 'tool.calling',
      toolCallId: 'call-1',
      toolName: 'search',
      functionName: 'search_web',
      arguments: { query: '测试查询' },
    },
    {
      ...eventBase('tool.called', 5),
      type: 'tool.called',
      toolCallId: 'call-1',
      toolName: 'search',
      functionName: 'search_web',
      arguments: { query: '测试查询' },
      result: { success: true },
      content: { results: [] },
    },
    {
      ...eventBase('step.completed', 6),
      type: 'step.completed',
      step: { ...step, result: '执行完成', success: true },
    },
    {
      ...eventBase('message.created', 7),
      type: 'message.created',
      role: 'assistant',
      message: '执行完成',
    },
    { ...eventBase('plan.completed', 8), type: 'plan.completed', plan },
    { ...eventBase('run.completed', 9), type: 'run.completed' },
  ];

  const sessionEvents = new RuntimeEventAdapter().adaptAll(runtimeEvents);
  const sseEvents = wireValue(EventMapper.eventsToSseEvents(sessionEvents)) as Array<{
    event: string;
    data: Record<string, unknown>;
  }>;

  assert.deepEqual(sseEvents.map((event) => event.event), [
    'title',
    'plan',
    'step',
    'tool',
    'tool',
    'step',
    'message',
    'plan',
    'done',
  ]);
  assert.deepEqual(
    sseEvents.map((event) => [event.data.run_id, event.data.sequence]),
    runtimeEvents.map((event) => [event.runId, event.sequence]),
  );
  assert.deepEqual(sseEvents[1].data.steps, [{
    event_id: 'run-1-event-2',
    created_at: 1_784_188_800,
    run_id: 'run-1',
    sequence: 2,
    id: 'step-1',
    status: 'pending',
    description: '执行测试步骤',
  }]);
  assert.deepEqual(sseEvents[3].data, {
    event_id: 'run-1-event-4',
    created_at: 1_784_188_800,
    run_id: 'run-1',
    sequence: 4,
    tool_call_id: 'call-1',
    name: 'search',
    status: 'calling',
    function: 'search_web',
    args: { query: '测试查询' },
  });
  assert.equal(sseEvents[5].data.status, ExecutionStatus.COMPLETED);
});

test('Runtime 上下文字段应按原值写入 SSE，且不改变现有字段', () => {
  const runtimeEvent: RuntimeEvent = {
    ...eventBase('message.created', 12),
    type: 'message.created',
    checkpointId: 'checkpoint-3',
    metadata: { agent_id: 'researcher' },
    role: 'assistant',
    message: '测试消息',
  };

  const event = new RuntimeEventAdapter().adapt(runtimeEvent);
  assert.ok(event);
  assert.deepEqual(wireValue(EventMapper.eventToSseEvent(event)), {
    event: 'message',
    data: {
      event_id: 'run-1-event-12',
      created_at: 1_784_188_800,
      run_id: 'run-1',
      sequence: 12,
      checkpoint_id: 'checkpoint-3',
      metadata: { agent_id: 'researcher' },
      role: 'assistant',
      message: '测试消息',
      attachments: [],
    },
  });
});

test('同一 Run 的重复和过期 sequence 应被过滤，不同 Run 互不影响', () => {
  const adapter = new RuntimeEventAdapter();
  const message = (runId: string, sequence: number, text: string): RuntimeEvent => ({
    ...eventBase('message.created', sequence, runId),
    type: 'message.created',
    role: 'assistant',
    message: text,
  });

  const events = adapter.adaptAll([
    message('run-a', 1, '第一条'),
    message('run-a', 1, '重复事件'),
    message('run-a', 0, '过期事件'),
    message('run-a', 2, '第二条'),
    message('run-b', 1, '另一个 Run'),
  ]);

  assert.deepEqual(
    events.map((event) => event.type === 'message' ? event.message : ''),
    ['第一条', '第二条', '另一个 Run'],
  );
  assert.equal(adapter.getLastSequence('run-a'), 2);
  assert.equal(adapter.getLastSequence('run-b'), 1);

  adapter.reset('run-a');
  assert.ok(adapter.adapt(message('run-a', 1, '重置后重新接收')));
});

test('等待、失败和取消事件应映射为现有终端事件', () => {
  const adapter = new RuntimeEventAdapter();
  const runtimeEvents: RuntimeEvent[] = [
    { ...eventBase('run.waiting', 1, 'run-wait'), type: 'run.waiting' },
    {
      ...eventBase('run.failed', 1, 'run-failed'),
      type: 'run.failed',
      error: '执行失败',
    },
    {
      ...eventBase('run.cancelled', 1, 'run-cancelled'),
      type: 'run.cancelled',
      metadata: { reason: 'user_requested' },
    },
  ];

  const sseEvents = wireValue(
    EventMapper.eventsToSseEvents(adapter.adaptAll(runtimeEvents)),
  ) as Array<{ event: string; data: Record<string, unknown> }>;

  assert.deepEqual(sseEvents.map((event) => event.event), ['wait', 'error', 'done']);
  assert.equal(sseEvents[1].data.error, '执行失败');
  assert.deepEqual(sseEvents[2].data.metadata, {
    reason: 'user_requested',
    terminal_status: 'cancelled',
  });
});

test('无效的 sequence 不应进入兼容事件流', () => {
  const invalidEvent = {
    ...eventBase('run.completed', -1),
    type: 'run.completed',
  } as RuntimeEvent;

  assert.throws(
    () => new RuntimeEventAdapter().adapt(invalidEvent),
    /sequence 必须是非负安全整数/,
  );
});
