import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AgentRun,
  RouteKind,
  RunStatus,
  createAgentRun,
} from '../../src/domain/models/agent-run';
import { ExecutionStatus, createPlan, createStep } from '../../src/domain/models/plan';
import { RouteDecision } from '../../src/domain/models/route-decision';
import {
  DirectResponseProvider,
  DirectRuntimeExecutor,
  PlannedAgentRunner,
  PlannedAgentRuntimeExecutor,
  RuntimeExecutionContext,
  RuntimeExecutionEventPayload,
  RuntimeExecutionRequest,
  RuntimeExecutionRequestError,
  RuntimeExecutor,
  RuntimeExecutorDispatcher,
  RuntimeExecutorOptions,
  RuntimeExecutorRegistrationError,
  RuntimeToolCallInput,
  RuntimeToolInvocation,
  RuntimeToolInvoker,
  RuntimeWorkflowInput,
  RuntimeWorkflowRunner,
  SingleToolResponseInput,
  SingleToolResponseProvider,
  SingleToolRuntimeExecutor,
  SingleToolSelector,
  WorkflowRuntimeExecutor,
} from '../../src/domain/services/runtime-executor.service';
import { RuntimeEvent } from '../../src/domain/models/runtime-event';
import { ToolResult } from '../../src/domain/models/tool-result';

/** 为指定路径创建固定标识的 created Run。 */
function createRun(route: RouteKind, status = RunStatus.CREATED): AgentRun {
  return {
    ...createAgentRun({
      id: `run-${route}`,
      sessionId: 'session-1',
      route,
    }),
    status,
  };
}

/** 为四种路径创建满足 Schema 约束的路由决策。 */
function createDecision(route: RouteKind): RouteDecision {
  return {
    route,
    reason: `测试 ${route}`,
    requiredCapabilities: route === RouteKind.SINGLE_TOOL ? ['search'] : [],
    requestedSkills: [],
    confidence: 0.99,
    ...(route === RouteKind.WORKFLOW ? { workflowName: 'daily-report' } : {}),
  };
}

/** 组装路径执行请求，允许测试覆盖 sequence 和 metadata。 */
function createRequest(
  route: RouteKind,
  overrides: Partial<RuntimeExecutionRequest> = {},
): RuntimeExecutionRequest {
  return {
    run: createRun(route),
    decision: createDecision(route),
    message: '处理这个请求',
    ...overrides,
  };
}

/** 消费异步事件流，便于断言完整顺序和终态。 */
async function collectEvents(events: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const collected: RuntimeEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

/** 创建时间与事件 ID 均可预测的执行器配置。 */
function createExecutorOptions(prefix: string): RuntimeExecutorOptions {
  let sequence = 0;
  return {
    // 固定时间使事件 envelope 可重复验证。
    clock: () => new Date('2026-07-18T00:00:00.000Z'),
    // 每次分配不同 ID，证明各事件由统一工厂生成。
    eventIdFactory: () => `${prefix}-event-${sequence++}`,
  };
}

/** 返回固定文本或预设异常的 Direct 回答端口。 */
class FakeDirectResponseProvider implements DirectResponseProvider {
  calls = 0;

  /** 保存测试需要的回答与可选失败。 */
  constructor(
    private readonly response = '直接回答',
    private readonly failure?: Error,
  ) {}

  /** 记录调用次数并返回固定回答。 */
  async respond(_context: RuntimeExecutionContext): Promise<string> {
    this.calls += 1;
    if (this.failure) {
      throw this.failure;
    }
    return this.response;
  }
}

/** 返回固定唯一工具调用的选择端口。 */
class FakeSingleToolSelector implements SingleToolSelector {
  calls = 0;

  /** 保存选择器要返回的结构化调用。 */
  constructor(private readonly invocation: RuntimeToolInvocation = {
    toolName: 'search',
    functionName: 'web_search',
    arguments: { query: 'runtime' },
  }) {}

  /** 记录调用并返回固定工具选择。 */
  async select(_context: RuntimeExecutionContext): Promise<RuntimeToolInvocation> {
    this.calls += 1;
    return this.invocation;
  }
}

/** 记录实际调用并返回固定 ToolResult 的工具端口。 */
class FakeToolInvoker implements RuntimeToolInvoker {
  readonly calls: RuntimeToolCallInput[] = [];

  /** 保存工具调用结果。 */
  constructor(private readonly result: ToolResult = {
    success: true,
    data: { answer: 42 },
  }) {}

  /** 记录完整调用上下文并返回固定结果。 */
  async invoke(input: RuntimeToolCallInput): Promise<ToolResult> {
    this.calls.push(input);
    return this.result;
  }
}

/** 根据唯一工具结果返回固定用户回答。 */
class FakeSingleToolResponseProvider implements SingleToolResponseProvider {
  readonly calls: SingleToolResponseInput[] = [];

  /** 保存最终回答文本。 */
  constructor(private readonly response = '工具结果是 42') {}

  /** 记录归纳输入并返回固定回答。 */
  async respond(input: SingleToolResponseInput): Promise<string> {
    this.calls.push(input);
    return this.response;
  }
}

/** 模拟一个按固定顺序产生事件的命名 Workflow。 */
class FakeWorkflowRunner implements RuntimeWorkflowRunner {
  readonly calls: RuntimeWorkflowInput[] = [];

  /** 记录 Workflow 名称并产生确定性标题和消息。 */
  async *execute(input: RuntimeWorkflowInput): AsyncIterable<RuntimeExecutionEventPayload> {
    this.calls.push(input);
    yield {
      type: 'title.updated',
      title: `执行 ${input.workflowName}`,
      metadata: { route: 'cannot-override', node: 'start' },
    };
    yield { type: 'message.created', role: 'assistant', message: '日报已生成' };
  }
}

/** 模拟 Planned Agent 的计划、步骤和最终消息事件。 */
class FakePlannedAgentRunner implements PlannedAgentRunner {
  calls = 0;

  /** 产生一个最小计划、完成步骤和最终回答。 */
  async *execute(_context: RuntimeExecutionContext): AsyncIterable<RuntimeExecutionEventPayload> {
    this.calls += 1;
    const step = createStep({
      id: 'step-1',
      description: '研究问题',
      status: ExecutionStatus.COMPLETED,
      success: true,
    });
    const plan = createPlan({
      id: 'plan-1',
      title: '研究计划',
      goal: '回答问题',
      status: ExecutionStatus.RUNNING,
      steps: [step],
    });
    yield { type: 'plan.created', plan };
    yield { type: 'step.completed', step };
    yield { type: 'message.created', role: 'assistant', message: '研究完成' };
  }
}

/** 模拟需要用户输入后停止本次调度的 Planned Agent。 */
class WaitingPlannedAgentRunner implements PlannedAgentRunner {
  /** 只产生 waiting 事件，后续代码不应再被消费。 */
  async *execute(_context: RuntimeExecutionContext): AsyncIterable<RuntimeExecutionEventPayload> {
    yield { type: 'run.waiting' };
    throw new Error('waiting 后不应继续执行');
  }
}

/** 创建完整四路径集合，供 Dispatcher 结构测试使用。 */
function createAllExecutors(): RuntimeExecutor[] {
  return [
    new DirectRuntimeExecutor(new FakeDirectResponseProvider()),
    new SingleToolRuntimeExecutor(
      new FakeSingleToolSelector(),
      new FakeToolInvoker(),
      new FakeSingleToolResponseProvider(),
    ),
    new WorkflowRuntimeExecutor(new FakeWorkflowRunner()),
    new PlannedAgentRuntimeExecutor(new FakePlannedAgentRunner()),
  ];
}

// Direct 必须只产生回答和完成事件，并从恢复水位继续分配 sequence。
test('Direct 路径应独立生成统一消息和完成事件', async () => {
  const provider = new FakeDirectResponseProvider('  这是直接回答  ');
  const executor = new DirectRuntimeExecutor(provider, createExecutorOptions('direct'));

  const events = await collectEvents(executor.execute(createRequest(RouteKind.DIRECT, {
    nextEventSequence: 7,
    metadata: { trace: 'trace-1', route: 'cannot-override' },
  })));

  assert.equal(provider.calls, 1);
  assert.deepEqual(events.map((event) => event.type), [
    'message.created',
    'run.completed',
  ]);
  assert.deepEqual(events.map((event) => event.sequence), [7, 8]);
  assert.deepEqual(events.map((event) => event.id), ['direct-event-0', 'direct-event-1']);
  assert.equal(events[0].runId, 'run-direct');
  assert.equal(events[0].createdAt.toISOString(), '2026-07-18T00:00:00.000Z');
  assert.deepEqual(events[0].metadata, { trace: 'trace-1', route: RouteKind.DIRECT });
  assert.equal(events[0].type === 'message.created' && events[0].message, '这是直接回答');
});

// Single Tool 的固定编排必须从结构上排除第二次主要工具调用。
test('Single Tool 路径应只调用一次工具并生成统一调用和回答事件', async () => {
  const selector = new FakeSingleToolSelector();
  const invoker = new FakeToolInvoker();
  const responder = new FakeSingleToolResponseProvider();
  const executor = new SingleToolRuntimeExecutor(
    selector,
    invoker,
    responder,
    {
      ...createExecutorOptions('single'),
      toolCallIdFactory: () => 'tool-call-1',
    },
  );

  const events = await collectEvents(executor.execute(createRequest(RouteKind.SINGLE_TOOL)));

  assert.equal(selector.calls, 1);
  assert.equal(invoker.calls.length, 1);
  assert.equal(responder.calls.length, 1);
  assert.deepEqual(events.map((event) => event.type), [
    'tool.calling',
    'tool.called',
    'message.created',
    'run.completed',
  ]);
  assert.deepEqual(events.map((event) => event.sequence), [0, 1, 2, 3]);
  assert.equal(invoker.calls[0].toolCallId, 'tool-call-1');
  assert.equal(invoker.calls[0].runId, 'run-single_tool');
  assert.equal(
    events[1].type === 'tool.called' && events[1].result?.success,
    true,
  );
});

// Workflow 必须使用 RouteDecision 中已校验的名称，而不是自行重新路由。
test('Workflow 路径应执行指定命名流程并统一封装业务事件', async () => {
  const runner = new FakeWorkflowRunner();
  const executor = new WorkflowRuntimeExecutor(runner, createExecutorOptions('workflow'));

  const events = await collectEvents(executor.execute(createRequest(RouteKind.WORKFLOW)));

  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].workflowName, 'daily-report');
  assert.deepEqual(events.map((event) => event.type), [
    'title.updated',
    'message.created',
    'run.completed',
  ]);
  assert.deepEqual(events.map((event) => event.runId), [
    'run-workflow',
    'run-workflow',
    'run-workflow',
  ]);
  assert.deepEqual(events[0].metadata, {
    route: RouteKind.WORKFLOW,
    node: 'start',
  });
});

// Planned Agent 可产生多类业务事件，但不能自行控制 envelope 和成功终态。
test('Planned Agent 路径应统一封装计划步骤消息和完成事件', async () => {
  const runner = new FakePlannedAgentRunner();
  const executor = new PlannedAgentRuntimeExecutor(
    runner,
    createExecutorOptions('planned'),
  );

  const events = await collectEvents(executor.execute(createRequest(RouteKind.PLANNED_AGENT)));

  assert.equal(runner.calls, 1);
  assert.deepEqual(events.map((event) => event.type), [
    'plan.created',
    'step.completed',
    'message.created',
    'run.completed',
  ]);
  assert.deepEqual(events.map((event) => event.sequence), [0, 1, 2, 3]);
});

// 等待输入是一次合法调度终点，不能同时告诉调用方 Run 已完成。
test('执行路径产生 waiting 后应停止且不追加 completed', async () => {
  const executor = new PlannedAgentRuntimeExecutor(new WaitingPlannedAgentRunner());

  const events = await collectEvents(executor.execute(createRequest(RouteKind.PLANNED_AGENT)));

  assert.deepEqual(events.map((event) => event.type), ['run.waiting']);
});

// 路径内部依赖失败应转为统一失败事件，而不是产生错误的成功终态。
test('路径内部异常应转换为 run.failed 且不追加 completed', async () => {
  const executor = new DirectRuntimeExecutor(
    new FakeDirectResponseProvider('', new Error('模型不可用')),
  );

  const events = await collectEvents(executor.execute(createRequest(RouteKind.DIRECT)));

  assert.deepEqual(events.map((event) => event.type), ['run.failed']);
  assert.equal(events[0].type === 'run.failed' && events[0].error, '模型不可用');
});

// Dispatcher 必须在服务启动时保证四条路径完整，并按决策选择唯一执行器。
test('Dispatcher 应要求四路径完整注册并按 RouteDecision 分发', async () => {
  assert.throws(
    () => new RuntimeExecutorDispatcher(createAllExecutors().slice(0, 3)),
    RuntimeExecutorRegistrationError,
  );
  assert.throws(
    () => new RuntimeExecutorDispatcher([
      ...createAllExecutors(),
      new DirectRuntimeExecutor(new FakeDirectResponseProvider()),
    ]),
    /重复注册/,
  );

  const dispatcher = new RuntimeExecutorDispatcher(createAllExecutors());
  const events = await collectEvents(dispatcher.dispatch(createRequest(RouteKind.DIRECT)));
  assert.deepEqual(events.map((event) => event.type), [
    'message.created',
    'run.completed',
  ]);
});

// Run、决策和执行器路径不一致属于调用配置错误，不能静默执行错误能力。
test('执行器应拒绝 Run 与 RouteDecision 不一致的请求', async () => {
  const executor = new DirectRuntimeExecutor(new FakeDirectResponseProvider());
  const request = createRequest(RouteKind.DIRECT, {
    run: createRun(RouteKind.PLANNED_AGENT),
  });

  await assert.rejects(
    collectEvents(executor.execute(request)),
    RuntimeExecutionRequestError,
  );
});
