import assert from 'node:assert/strict';
import test from 'node:test';
import { RuntimeEventAdapter } from '../../src/application/services/runtime-event.adapter';
import { JSONParser } from '../../src/domain/external/json-parser';
import { LLM, LLMMessage } from '../../src/domain/external/llm';
import { MessageQueue } from '../../src/domain/external/message-queue';
import { Sandbox } from '../../src/domain/external/sandbox';
import { SearchEngine } from '../../src/domain/external/search-engine';
import { Task } from '../../src/domain/external/task';
import {
  AgentRun,
  Checkpoint,
  RouteKind,
  RunStatus,
  RunStep,
  RunStepStatus,
  ToolCallRecord,
  ToolCallStatus,
  canTransitionRunStatus,
} from '../../src/domain/models/agent-run';
import { Event, events } from '../../src/domain/models/event';
import { createSession, SessionStatus } from '../../src/domain/models/session';
import type { SkillProgressiveDisclosure } from '../../src/domain/models/skill-disclosure';
import { SkillResourceKind } from '../../src/domain/models/skill-content';
import {
  AgentRunRepository,
  CheckpointAppendResult,
} from '../../src/domain/repositories/agent-run.repository';
import { UnitOfWork } from '../../src/domain/repositories/unit-of-work';
import { AgentTaskRunner } from '../../src/domain/services/runtime/agent-task-runner';
import { RuntimeCheckpointBoundary } from '../../src/domain/services/runtime/checkpoint.service';
import { createDefaultRuntimeRouteRules } from '../../src/domain/services/runtime/route-rules';
import { RuntimeRouterService } from '../../src/domain/services/runtime/router.service';
import { LLMRuntimeRouteModel } from '../../src/infrastructure/external/llm/llm-runtime-route-model';

/** 为真实 Runner 接线测试保存 Session 历史和运行聚合。 */
class RuntimeWiringStore {
  readonly runs = new Map<string, AgentRun>();
  readonly steps = new Map<string, RunStep>();
  readonly toolCalls = new Map<string, ToolCallRecord>();
  readonly checkpoints: Checkpoint[] = [];
  readonly sessionEvents: Event[];
  readonly session = createSession({ id: 'session-wiring', status: SessionStatus.PENDING });
  savedMemories = 0;

  /** 使用既有历史事件初始化同一 Session。 */
  constructor(history: Event[]) {
    this.sessionEvents = [...history];
  }

  /** 创建 Runner 和 RuntimeCheckpointService 共用的内存 UnitOfWork。 */
  createUnitOfWork(): UnitOfWork {
    const agentRun = this.createAgentRunRepository();
    const unit = {
      agentRun,
      file: {},
      session: {
        addEvent: async (_sessionId: string, event: Event) => {
          this.sessionEvents.push(event);
        },
        updateTitle: async (_sessionId: string, title: string) => {
          this.session.title = title;
        },
        updateLatestMessage: async (_sessionId: string, message: string, at: Date) => {
          this.session.latest_message = message;
          this.session.latest_message_at = at;
        },
        incrementUnreadMessageCount: async () => {
          this.session.unread_message_count += 1;
        },
        updateStatus: async (_sessionId: string, status: SessionStatus) => {
          this.session.status = status;
        },
        saveMemory: async () => {
          this.savedMemories += 1;
        },
      },
      run: async <T>(handler: (active: UnitOfWork) => Promise<T>): Promise<T> =>
        handler(unit as unknown as UnitOfWork),
    } as unknown as UnitOfWork;
    return unit;
  }

  /** 返回 Runtime 实际使用的最小 AgentRunRepository。 */
  private createAgentRunRepository(): AgentRunRepository {
    return {
      create: async (run: AgentRun) => {
        this.runs.set(run.id, run);
      },
      getById: async (runId: string) => this.runs.get(runId) ?? null,
      listBySessionId: async (sessionId: string) => [...this.runs.values()].filter(
        (run) => run.sessionId === sessionId,
      ),
      update: async (candidate: AgentRun, expectedVersion: number) => {
        const current = this.runs.get(candidate.id);
        if (!current) {
          return { outcome: 'not_found' as const };
        }
        if (current.version !== expectedVersion || candidate.version !== expectedVersion) {
          return { outcome: 'version_conflict' as const, actualVersion: current.version };
        }
        if (
          current.status !== candidate.status
          && !canTransitionRunStatus(current.status, candidate.status)
        ) {
          return {
            outcome: 'invalid_status_transition' as const,
            from: current.status,
            to: candidate.status,
          };
        }
        const updated = { ...candidate, version: expectedVersion + 1 };
        this.runs.set(updated.id, updated);
        return { outcome: 'updated' as const, run: updated };
      },
      createStep: async (step: RunStep) => {
        this.steps.set(step.id, step);
      },
      getStepById: async (stepId: string) => this.steps.get(stepId) ?? null,
      getStepByKey: async (runId: string, key: string, attempt: number) =>
        [...this.steps.values()].find(
          (step) => step.runId === runId
            && step.key === key
            && step.attempt === attempt,
        ) ?? null,
      updateStep: async (candidate: RunStep, expectedStatus: RunStepStatus) => {
        const current = this.steps.get(candidate.id);
        if (!current) {
          return { outcome: 'not_found' as const };
        }
        if (current.status !== expectedStatus) {
          return {
            outcome: 'status_conflict' as const,
            actualStatus: current.status,
          };
        }
        this.steps.set(candidate.id, candidate);
        return { outcome: 'updated' as const, entity: candidate };
      },
      reserveToolCall: async (candidate: ToolCallRecord) => {
        const existing = [...this.toolCalls.values()].find(
          (toolCall) => toolCall.runId === candidate.runId
            && toolCall.idempotencyKey === candidate.idempotencyKey,
        );
        if (!existing) {
          this.toolCalls.set(candidate.id, candidate);
          return { outcome: 'reserved' as const, toolCall: candidate };
        }
        return existing.requestFingerprint === candidate.requestFingerprint
          ? { outcome: 'existing' as const, toolCall: existing }
          : { outcome: 'key_conflict' as const, existingToolCall: existing };
      },
      getToolCallByIdempotencyKey: async (runId: string, idempotencyKey: string) =>
        [...this.toolCalls.values()].find(
          (toolCall) => toolCall.runId === runId
            && toolCall.idempotencyKey === idempotencyKey,
        ) ?? null,
      updateToolCall: async (
        candidate: ToolCallRecord,
        expectedStatus: ToolCallStatus,
      ) => {
        const current = this.toolCalls.get(candidate.id);
        if (!current) {
          return { outcome: 'not_found' as const };
        }
        if (current.status !== expectedStatus) {
          return {
            outcome: 'status_conflict' as const,
            actualStatus: current.status,
          };
        }
        this.toolCalls.set(candidate.id, candidate);
        return { outcome: 'updated' as const, entity: candidate };
      },
      appendCheckpoint: async (checkpoint: Checkpoint): Promise<CheckpointAppendResult> => {
        const latest = this.latestCheckpoint(checkpoint.runId);
        const expectedSequence = latest ? latest.sequence + 1 : 0;
        if (checkpoint.sequence !== expectedSequence) {
          return { outcome: 'sequence_conflict', expectedSequence };
        }
        this.checkpoints.push(checkpoint);
        return { outcome: 'appended', checkpoint };
      },
      getLatestCheckpoint: async (runId: string) => this.latestCheckpoint(runId),
    } as unknown as AgentRunRepository;
  }

  /** 返回指定 Run 的最后一个 Checkpoint。 */
  private latestCheckpoint(runId: string): Checkpoint | null {
    return this.checkpoints
      .filter((checkpoint) => checkpoint.runId === runId)
      .sort((left, right) => right.sequence - left.sequence)[0] ?? null;
  }
}

/** 提供内存输入/输出流并保留写入顺序。 */
class MemoryMessageQueue extends MessageQueue {
  readonly values: unknown[] = [];
  private nextId = 0;

  /** 写入一条消息并返回稳定 ID。 */
  async put(message: unknown): Promise<string> {
    this.values.push(message);
    return `queue-${this.nextId++}`;
  }

  /** 返回起点后的第一条消息；本测试不依赖阻塞语义。 */
  async get(): Promise<[string | null, unknown]> {
    return this.values.length > 0 ? ['queue-0', this.values[0]] : [null, null];
  }

  /** 移除并返回队首消息。 */
  async pop(): Promise<[string | null, unknown]> {
    return this.values.length > 0
      ? [`queue-pop-${this.nextId++}`, this.values.shift()]
      : [null, null];
  }

  /** 清空全部消息。 */
  async clear(): Promise<void> {
    this.values.splice(0, this.values.length);
  }

  /** 判断队列当前是否为空。 */
  async isEmpty(): Promise<boolean> {
    return this.values.length === 0;
  }

  /** 返回当前消息数量。 */
  async size(): Promise<number> {
    return this.values.length;
  }

  /** 删除指定消息；内存测试队列不保存 ID 索引。 */
  async deleteMessage(_messageId: string): Promise<boolean> {
    return false;
  }
}

/** 提供可直接交给 AgentTaskRunner.invoke 的内存 Task。 */
class MemoryTask extends Task {
  readonly inputStream = new MemoryMessageQueue();
  readonly outputStream = new MemoryMessageQueue();
  readonly id = 'task-wiring';
  readonly done = false;

  /** 本测试直接调用 Runner，因此 Task.invoke 无需调度。 */
  async invoke(): Promise<void> {}

  /** 内存任务没有后台操作需要取消。 */
  cancel(): boolean {
    return true;
  }
}

/** 模拟 Runtime 启动前已收到的用户取消。 */
class CancelledMemoryTask extends MemoryTask {
  private readonly controller = new AbortController();

  constructor() {
    super();
    this.controller.abort(new DOMException('用户取消任务', 'AbortError'));
  }

  override get signal(): AbortSignal {
    return this.controller.signal;
  }
}

/** 解析测试 LLM 返回的 JSON 参数。 */
class ParseJson extends JSONParser {
  /** 解析 JSON，失败时使用调用方默认值。 */
  async invoke<T>(text: string, defaultValue?: T): Promise<T> {
    try {
      return JSON.parse(text) as T;
    } catch {
      return defaultValue as T;
    }
  }
}

/** 依次返回预设消息并记录模型是否携带工具。 */
class SequenceLLM extends LLM {
  readonly modelName = 'runtime-wiring-test';
  readonly temperature = 0;
  readonly maxTokens = 256;
  readonly calls: Array<Parameters<LLM['invoke']>[0]> = [];

  /** 保存调用顺序对应的模型消息。 */
  constructor(private readonly responses: LLMMessage[]) {
    super();
  }

  /** 记录调用并返回下一条预设消息。 */
  async invoke(input: Parameters<LLM['invoke']>[0]): Promise<LLMMessage> {
    this.calls.push(input);
    const response = this.responses.shift();
    if (!response) {
      throw new Error('测试 LLM 缺少预设响应');
    }
    return response;
  }
}

/** 记录 Single Tool 实际搜索次数并返回空结果集。 */
class RecordingSearchEngine extends SearchEngine {
  readonly queries: string[] = [];

  /** 保存查询并返回符合现有搜索工具展示契约的结果。 */
  async invoke(query: string): Promise<{
    success: true;
    data: { query: string; total_results: number; results: [] };
  }> {
    this.queries.push(query);
    return {
      success: true,
      data: { query, total_results: 0, results: [] },
    };
  }
}

/** 创建只实现当前接线测试实际调用方法的 Sandbox。 */
function createSandbox(): Sandbox {
  return {
    id: 'sandbox-wiring',
    cdpUrl: '',
    vncUrl: '',
    ensureSandbox: async () => undefined,
    destroy: async () => true,
  } as unknown as Sandbox;
}

/** 创建装配真实 Router 与 Event Adapter 的 Runner。 */
function createRunner(
  store: RuntimeWiringStore,
  llm: LLM,
  searchEngine: SearchEngine = {} as SearchEngine,
  skillDisclosure?: SkillProgressiveDisclosure,
): AgentTaskRunner {
  return new AgentTaskRunner(
    () => store.createUnitOfWork(),
    llm,
    { max_iterations: 2, max_retries: 2, max_search_results: 5 },
    { mcpServers: {} },
    { a2a_servers: [] },
    store.session.id,
    {} as never,
    new ParseJson(),
    {} as never,
    searchEngine,
    createSandbox(),
    {
      router: new RuntimeRouterService(new LLMRuntimeRouteModel(llm), {
        rules: createDefaultRuntimeRouteRules(),
      }),
      eventAdapter: new RuntimeEventAdapter(),
      skillDisclosure,
    },
  );
}

/** 创建只包含 document-review 的单 Run 渐进披露测试端口。 */
function createDocumentReviewDisclosure(
  onActivate?: (requestedSkills: readonly string[]) => void,
): SkillProgressiveDisclosure {
  const descriptor = {
    id: 'project:document-review',
    name: 'document-review',
    description: '审阅用户文档。',
  };
  return {
    /** 每次返回独立激活状态，模拟真实服务的 Run 隔离。 */
    async initialize() {
      return {
        catalog: [descriptor],
        explicitSkillIds: [],
        /** 返回固定完整正文和工具上界。 */
        async activate(requestedSkills: readonly string[]) {
          onActivate?.(requestedSkills);
          return {
            catalog: [descriptor],
            activated: [{
              descriptor,
              content: 'DOCUMENT-REVIEW-SKILL-BODY',
              contentDigest: 'digest-document-review',
              allowedTools: ['search_web'],
              resources: [{
                path: 'references/rules.md',
                kind: SkillResourceKind.REFERENCE,
                sizeBytes: 12,
              }],
            }],
          };
        },
      };
    },
  };
}

/** 把用户消息放入 Task 输入流并执行 Runner。 */
async function invokeRunner(runner: AgentTaskRunner, message: string): Promise<MemoryTask> {
  const task = new MemoryTask();
  await task.inputStream.put(JSON.stringify(events.message({ role: 'user', message })));
  await runner.invoke(task);
  return task;
}

/** 解析内存输出队列中的 Session Event。 */
function outputEvents(task: MemoryTask): Event[] {
  return task.outputStream.values.map((value) => JSON.parse(String(value)) as Event);
}

test('Runner 应将启动阶段取消视为正常终止而非错误', async () => {
  const store = new RuntimeWiringStore([]);
  const runner = createRunner(store, new SequenceLLM([]));
  const task = new CancelledMemoryTask();

  await assert.doesNotReject(() => runner.invoke(task));

  const output = outputEvents(task);
  assert.deepEqual(output.map((event) => event.type), ['done']);
  assert.equal(output[0].metadata?.terminal_status, 'cancelled');
  assert.equal(store.sessionEvents[0]?.type, 'done');
  assert.equal(store.sessionEvents[0]?.metadata?.terminal_status, 'cancelled');
  assert.equal(store.session.status, SessionStatus.COMPLETED);
});

// 生产默认规则必须在 Runner 真实接线中跳过路由模型并直接执行回答路径。
test('生产规则应将概念解释请求直接路由到 Direct', async () => {
  const store = new RuntimeWiringStore([]);
  const llm = new SequenceLLM([{ role: 'assistant', content: '乐观锁是一种并发控制策略。' }]);
  const runner = createRunner(store, llm);

  const task = await invokeRunner(runner, '解释一下什么是乐观锁');
  const output = outputEvents(task);
  const [run] = [...store.runs.values()];

  assert.deepEqual(output.map((event) => event.type), ['message', 'done']);
  assert.equal(run.route, RouteKind.DIRECT);
  assert.equal(run.metadata.routeReason, '命中无需外部能力的概念解释规则');
  assert.equal(llm.calls.length, 1);
  assert.equal(Object.hasOwn(llm.calls[0], 'responseFormat'), false);
});

// Runtime 必须在创建新 Run 时保留同一 Session 的历史事件。
test('Runtime 应在同一历史 Session 中完成请求并保留历史事件', async () => {
  const history = events.message({ role: 'assistant', message: '历史消息' });
  const store = new RuntimeWiringStore([history]);
  const llm = new SequenceLLM([
    {
      content: JSON.stringify({
        route: RouteKind.DIRECT,
        reason: '无需工具',
        requiredCapabilities: [],
        requestedSkills: [],
        confidence: 0.99,
      }),
    },
    { role: 'assistant', content: 'Runtime 回答' },
  ]);
  const runner = createRunner(store, llm);
  const task = await invokeRunner(runner, '继续会话');
  const output = outputEvents(task);

  assert.deepEqual(output.map((event) => event.type), ['message', 'done']);
  assert.equal(output[0].type === 'message' && output[0].message, 'Runtime 回答');
  assert.deepEqual(output.map((event) => event.sequence), [0, 1]);
  assert.ok(output.every((event) => Boolean(event.run_id)));
  assert.ok(output[1].checkpoint_id);

  assert.equal(store.sessionEvents[0], history);
  assert.deepEqual(
    store.sessionEvents.map((event) => event.type),
    ['message', 'message', 'done'],
  );
  assert.equal(store.savedMemories, 0);

  const [run] = [...store.runs.values()];
  assert.equal(run.route, RouteKind.DIRECT);
  assert.equal(run.status, RunStatus.COMPLETED);
  assert.equal(run.sessionId, store.session.id);
  assert.deepEqual(
    store.checkpoints.map((checkpoint) => checkpoint.state.checkpointBoundary),
    [
      RuntimeCheckpointBoundary.ROUTE_COMPLETED,
      RuntimeCheckpointBoundary.ENTERING_TERMINAL,
    ],
  );
  assert.equal(store.checkpoints[1].nextEventSequence, 2);
  assert.equal(store.session.status, SessionStatus.COMPLETED);
  assert.equal(llm.calls.length, 2);
  assert.equal(Object.hasOwn(llm.calls[0], 'tools'), false);
  assert.equal(Object.hasOwn(llm.calls[1], 'tools'), false);
});

test('Runtime 应先向 Router 披露 Catalog 再向执行模型披露激活正文', async () => {
  const store = new RuntimeWiringStore([]);
  let activations = 0;
  const skillDisclosure = createDocumentReviewDisclosure((requestedSkills) => {
    assert.deepEqual(requestedSkills, ['project:document-review']);
    activations += 1;
  });
  const llm = new SequenceLLM([
    {
      content: JSON.stringify({
        route: RouteKind.DIRECT,
        reason: '使用文档审阅 Skill 回答',
        requiredCapabilities: [],
        requestedSkills: ['project:document-review'],
        confidence: 0.99,
      }),
    },
    { role: 'assistant', content: '已按 Skill 回答' },
  ]);
  const runner = createRunner(store, llm, {} as SearchEngine, skillDisclosure);

  const task = await invokeRunner(runner, '审阅这段内容');
  const output = outputEvents(task);
  const routerPayload = String(llm.calls[0].messages[1].content);
  const executionMessages = JSON.stringify(llm.calls[1].messages);

  assert.deepEqual(output.map((event) => event.type), ['message', 'done']);
  assert.equal(activations, 1);
  assert.match(routerPayload, /审阅用户文档/);
  assert.doesNotMatch(routerPayload, /DOCUMENT-REVIEW-SKILL-BODY/);
  assert.match(executionMessages, /DOCUMENT-REVIEW-SKILL-BODY/);
  assert.equal(executionMessages.match(/DOCUMENT-REVIEW-SKILL-BODY/g)?.length, 1);
  assert.doesNotMatch(executionMessages, /references\/rules\.md/);
  assert.deepEqual([...store.runs.values()][0].metadata.requestedSkills, [
    'project:document-review',
  ]);
});

test('Single Tool 的选择和总结模型都应接收同一激活正文', async () => {
  const store = new RuntimeWiringStore([]);
  const searchEngine = new RecordingSearchEngine();
  const llm = new SequenceLLM([
    {
      content: JSON.stringify({
        route: RouteKind.SINGLE_TOOL,
        reason: '需要检索后审阅',
        requiredCapabilities: ['search'],
        requestedSkills: ['project:document-review'],
        confidence: 0.99,
      }),
    },
    {
      role: 'assistant',
      tool_calls: [{
        id: 'call-skill-search',
        function: {
          name: 'search_web',
          arguments: JSON.stringify({ query: '文档规则' }),
        },
      }],
    },
    { role: 'assistant', content: '已完成检索审阅' },
  ]);
  const runner = createRunner(
    store,
    llm,
    searchEngine,
    createDocumentReviewDisclosure(),
  );

  await invokeRunner(runner, '检索并审阅文档规则');

  assert.equal(searchEngine.queries.length, 1);
  assert.doesNotMatch(JSON.stringify(llm.calls[0].messages), /DOCUMENT-REVIEW-SKILL-BODY/);
  assert.equal(
    JSON.stringify(llm.calls[1].messages).match(/DOCUMENT-REVIEW-SKILL-BODY/g)?.length,
    1,
  );
  assert.equal(
    JSON.stringify(llm.calls[2].messages).match(/DOCUMENT-REVIEW-SKILL-BODY/g)?.length,
    1,
  );
  assert.deepEqual(llm.calls[1].tools?.map((tool) => tool.name), ['search_web']);
});

test('Planned Agent 桥接应把激活正文作为受保护上下文传给 Flow', async () => {
  const store = new RuntimeWiringStore([]);
  const llm = new SequenceLLM([{
    content: JSON.stringify({
      route: RouteKind.PLANNED_AGENT,
      reason: '需要规划审阅',
      requiredCapabilities: [],
      requestedSkills: ['project:document-review'],
      confidence: 0.99,
    }),
  }]);
  const runner = createRunner(
    store,
    llm,
    {} as SearchEngine,
    createDocumentReviewDisclosure(),
  );
  let protectedContext = '';
  const runnerFlow = runner as unknown as {
    flow: {
      invoke: (
        message: unknown,
        toolSelection: unknown,
        toolInvocation: unknown,
        currentProtectedContext?: string,
      ) => AsyncGenerator<Event>;
    };
  };
  Object.assign(runnerFlow.flow, {
    /** 记录 Runtime 传入的 Run 级上下文并立即完成。 */
    async *invoke(
      _message: unknown,
      _toolSelection: unknown,
      _toolInvocation: unknown,
      currentProtectedContext?: string,
    ): AsyncGenerator<Event> {
      protectedContext = currentProtectedContext ?? '';
      yield events.message({ role: 'assistant', message: '规划审阅完成' });
      yield events.done();
    },
  });

  await invokeRunner(runner, '规划并审阅文档');

  assert.equal(protectedContext.match(/DOCUMENT-REVIEW-SKILL-BODY/g)?.length, 1);
  assert.doesNotMatch(protectedContext, /references\/rules\.md/);
});

// Single Tool 必须只调用一次真实工具，并继续输出 UI 可消费的事件。
test('Single Tool 应执行一次现有工具并输出兼容事件', async () => {
  const store = new RuntimeWiringStore([]);
  const searchEngine = new RecordingSearchEngine();
  const llm = new SequenceLLM([
    {
      content: JSON.stringify({
        route: RouteKind.SINGLE_TOOL,
        reason: '只需一次搜索',
        requiredCapabilities: ['search'],
        requestedSkills: [],
        confidence: 0.99,
      }),
    },
    {
      role: 'assistant',
      tool_calls: [{
        id: 'call-search',
        function: {
          name: 'search_web',
          arguments: JSON.stringify({ query: 'runtime 架构' }),
        },
      }],
    },
    { role: 'assistant', content: '搜索完成' },
  ]);
  const runner = createRunner(store, llm, searchEngine);

  const task = await invokeRunner(runner, '搜索 runtime 架构');
  const output = outputEvents(task);

  assert.deepEqual(output.map((event) => event.type), [
    'tool',
    'tool',
    'message',
    'done',
  ]);
  assert.deepEqual(output.map((event) => event.sequence), [0, 1, 2, 3]);
  assert.equal(searchEngine.queries.length, 1);
  assert.equal(searchEngine.queries[0], 'runtime 架构');
  assert.equal(output[0].type === 'tool' && output[0].status, 'calling');
  assert.equal(output[1].type === 'tool' && output[1].status, 'called');
  assert.equal(
    output[1].type === 'tool' && output[1].function_result?.metadata?.attempts,
    1,
  );
  assert.equal(
    output[1].type === 'tool' && output[1].function_result?.metadata?.risk,
    'read',
  );
  assert.equal(output[2].type === 'message' && output[2].message, '搜索完成');
  assert.equal([...store.toolCalls.values()][0]?.status, ToolCallStatus.COMPLETED);
  assert.equal([...store.steps.values()][0]?.status, RunStepStatus.COMPLETED);
  assert.equal([...store.runs.values()][0].status, RunStatus.COMPLETED);
  assert.equal(llm.calls.length, 3);
  assert.equal(llm.calls[1].toolChoice, 'auto');
  assert.deepEqual(
    llm.calls[1].tools?.map((descriptor) => descriptor.name),
    ['search_web'],
  );
  assert.equal(llm.calls[2].toolChoice, 'none');
});

// Workflow Registry 尚未提供时必须保留请求可用性，并以 Planned Agent 完成执行。
test('未注册 Workflow 应回退 Planned Agent 并保持事件兼容', async () => {
  const store = new RuntimeWiringStore([]);
  const llm = new SequenceLLM([{
    content: JSON.stringify({
      route: RouteKind.WORKFLOW,
      reason: '识别为日报流程',
      requiredCapabilities: [],
      requestedSkills: [],
      workflowName: 'daily-report',
      confidence: 0.99,
    }),
  }]);
  const runner = createRunner(store, llm);
  const runnerFlow = runner as unknown as {
    flow: { invoke: (message: unknown) => AsyncGenerator<Event> };
  };
  Object.assign(runnerFlow.flow, {
    // 修改同一个 Flow 实例，使 Planned Agent 适配器继续持有有效引用。
    async *invoke(): AsyncGenerator<Event> {
      yield events.message({ role: 'assistant', message: '计划路径完成' });
      yield events.done();
    },
  });

  const task = await invokeRunner(runner, '生成日报');
  const output = outputEvents(task);
  const [run] = [...store.runs.values()];

  assert.deepEqual(output.map((event) => event.type), ['message', 'done']);
  assert.equal(output[0].type === 'message' && output[0].message, '计划路径完成');
  assert.equal(run.route, RouteKind.PLANNED_AGENT);
  assert.match(String(run.metadata.routeReason), /回退到 planned_agent/);
  assert.equal(
    store.checkpoints[0].state.decision
      && (store.checkpoints[0].state.decision as { route: RouteKind }).route,
    RouteKind.PLANNED_AGENT,
  );
});

// 等待事件必须同时停止调度、更新 Session，并持久化可恢复的 Run 边界。
test('Planned Agent 等待输入时应持久化 waiting 状态', async () => {
  const store = new RuntimeWiringStore([]);
  const llm = new SequenceLLM([{
    content: JSON.stringify({
      route: RouteKind.PLANNED_AGENT,
      reason: '需要多步处理',
      requiredCapabilities: [],
      requestedSkills: [],
      confidence: 0.99,
    }),
  }]);
  const runner = createRunner(store, llm);
  const runnerFlow = runner as unknown as {
    flow: { invoke: (message: unknown) => AsyncGenerator<Event> };
  };
  Object.assign(runnerFlow.flow, {
    /** 产生提示和等待事件，模拟 Planner 请求用户补充信息。 */
    async *invoke(): AsyncGenerator<Event> {
      yield events.message({ role: 'assistant', message: '请补充范围' });
      yield events.wait();
      yield events.done();
    },
  });

  const task = await invokeRunner(runner, '处理开放任务');
  const output = outputEvents(task);
  const [run] = [...store.runs.values()];

  assert.deepEqual(output.map((event) => event.type), ['message', 'wait']);
  assert.equal(run.status, RunStatus.WAITING);
  assert.equal(store.session.status, SessionStatus.WAITING);
  assert.equal(
    store.checkpoints[1].state.checkpointBoundary,
    RuntimeCheckpointBoundary.ENTERING_WAIT,
  );
  assert.equal(store.checkpoints[1].resumeNode, 'executor.planned_agent.resume_after_input');
  assert.equal(store.checkpoints[1].nextEventSequence, 2);
});
