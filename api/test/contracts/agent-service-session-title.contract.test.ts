import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentService } from '../../src/application/services/agent.service';
import { MessageQueue } from '../../src/domain/external/message-queue';
import { Task, TaskManager } from '../../src/domain/external/task';
import { BaseEvent } from '../../src/domain/models/event';
import {
  createInitialSessionTitle,
  createSession,
  DEFAULT_SESSION_TITLE,
  SessionStatus,
} from '../../src/domain/models/session';
import { UnitOfWork } from '../../src/domain/repositories/unit-of-work';

class TestQueue extends MessageQueue {
  readonly values: unknown[] = [];

  async put(message: unknown): Promise<string> {
    this.values.push(message);
    return `event-${this.values.length}`;
  }

  async get(): Promise<[string | null, unknown]> {
    return [null, null];
  }

  async pop(): Promise<[string | null, unknown]> {
    return [null, this.values.shift() ?? null];
  }

  async clear(): Promise<void> {
    this.values.length = 0;
  }

  async isEmpty(): Promise<boolean> {
    return this.values.length === 0;
  }

  async size(): Promise<number> {
    return this.values.length;
  }

  async deleteMessage(): Promise<boolean> {
    return false;
  }
}

class CompletedTask extends Task {
  readonly inputStream = new TestQueue();
  readonly outputStream = new TestQueue();
  readonly id = 'task-title';
  readonly done = true;

  async invoke(): Promise<void> {}

  cancel(): boolean {
    return true;
  }
}

function createHarness(initialTitle: string) {
  const session = createSession({
    id: 'session-title',
    task_id: 'task-title',
    title: initialTitle,
    status: SessionStatus.RUNNING,
  });
  const persistedEvents: BaseEvent[] = [];
  const task = new CompletedTask();
  const unit = {
    agentRun: {},
    file: {
      getById: async () => null,
    },
    session: {
      getById: async () => session,
      updateLatestMessage: async (_sessionId: string, message: string, timestamp: Date) => {
        session.latest_message = message;
        session.latest_message_at = timestamp;
      },
      addEvent: async (_sessionId: string, event: BaseEvent) => {
        persistedEvents.push(event);
      },
      updateTitle: async (_sessionId: string, title: string) => {
        session.title = title;
      },
      updateUnreadMessageCount: async (_sessionId: string, count: number) => {
        session.unread_message_count = count;
      },
    },
    run: async <T>(handler: (active: UnitOfWork) => Promise<T>): Promise<T> =>
      handler(unit as unknown as UnitOfWork),
  } as unknown as UnitOfWork;
  const taskManager = {
    get: (taskId: string) => taskId === task.id ? task : undefined,
  } as unknown as TaskManager;
  const service = new AgentService(
    unit,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    taskManager,
    {} as never,
    {} as never,
  );
  return { service, session, persistedEvents };
}

async function collectChatEvents(service: AgentService, message: string): Promise<BaseEvent[]> {
  const result: BaseEvent[] = [];
  for await (const event of service.chat('session-title', { message })) {
    result.push(event);
  }
  return result;
}

test('默认会话应在第一条用户消息后立即产生路由无关的标题', async () => {
  const harness = createHarness(DEFAULT_SESSION_TITLE);

  const output = await collectChatEvents(harness.service, '解释一下什么是乐观锁');

  assert.deepEqual(output.map((event) => event.type), ['message', 'title']);
  assert.equal(harness.session.title, '解释一下什么是乐观锁');
  assert.deepEqual(harness.persistedEvents.map((event) => event.type), ['message', 'title']);
});

test('已有标题的会话不应被后续消息覆盖', async () => {
  const harness = createHarness('解释乐观锁');

  const output = await collectChatEvents(harness.service, '再搜索比萨斜塔');

  assert.deepEqual(output.map((event) => event.type), ['message']);
  assert.equal(harness.session.title, '解释乐观锁');
});

test('初始标题应折叠空白并按 Unicode 字符安全截断', () => {
  assert.equal(createInitialSessionTitle('  解释\n\t乐观锁  '), '解释 乐观锁');
  assert.equal(
    createInitialSessionTitle('一'.repeat(31)),
    `${'一'.repeat(30)}…`,
  );
});
