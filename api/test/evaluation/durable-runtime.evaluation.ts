import { isDeepStrictEqual } from 'node:util';
import { LLM, LLMMessage } from '../../src/domain/external/llm';
import { RuntimeRouteModel } from '../../src/domain/external/runtime-route-model';
import {
  AgentRun,
  RouteKind,
  RunStatus,
  ToolCallStatus,
  createAgentRun,
  transitionAgentRun,
} from '../../src/domain/models/agent-run';
import { createMessage } from '../../src/domain/models/message';
import {
  ToolIdempotencyStore,
} from '../../src/domain/models/tool-invocation';
import {
  ToolExecutionContext,
  ToolRegistration,
  ToolRisk,
} from '../../src/domain/models/tool';
import { RuntimeEvent } from '../../src/domain/models/runtime-event';
import { ToolResult } from '../../src/domain/models/tool-result';
import { LLMDirectResponseProvider } from '../../src/domain/services/runtime/adapters';
import {
  RuntimeCheckpointBoundary,
  RuntimeCheckpointService,
} from '../../src/domain/services/runtime/checkpoint.service';
import {
  DirectRuntimeExecutor,
  PlannedAgentRunner,
  PlannedAgentRuntimeExecutor,
  RuntimeExecutionContext,
  RuntimeExecutionEventPayload,
  RuntimeExecutorDispatcher,
  SingleToolRuntimeExecutor,
  WorkflowRuntimeExecutor,
} from '../../src/domain/services/runtime/executor.service';
import { PersistentToolIdempotencyStore } from '../../src/domain/services/runtime/persistent-tool-idempotency.store';
import {
  RuntimeRecoveryDisposition,
  RuntimeRecoveryReason,
  RuntimeRecoveryService,
} from '../../src/domain/services/runtime/recovery.service';
import { RuntimeRouterService } from '../../src/domain/services/runtime/router.service';
import { RuntimeService } from '../../src/domain/services/runtime/runtime.service';
import { ToolInvocationService } from '../../src/domain/services/tools/tool-invocation.service';
import { InMemoryToolRegistry } from '../../src/domain/services/tools/tool-registry';
import { RuntimeEvaluationStore } from '../support/runtime-evaluation-store';

const FIXED_TIME = new Date('2026-07-19T06:00:00.000Z');

/** EVAL-103 当前覆盖的故障类别。 */
export type DurableRuntimeScenarioCategory =
  | 'crash'
  | 'timeout'
  | 'cancellation'
  | 'uncertain_side_effect';

/** 单个场景的一条机器可读断言。 */
export type DurableRuntimeEvaluationCheck = {
  name: string;
  passed: boolean;
  expected: unknown;
  actual: unknown;
};

/** 所有场景统一上报的耐久执行指标。 */
export type DurableRuntimeScenarioMetrics = {
  recoveryExpected: boolean;
  recoverySucceeded: boolean;
  externalSideEffects: number;
  logicalSideEffects: number;
  duplicateSideEffects: number;
  toolCallsAfterCancellation: number;
  cancellationLatencyMs: number | null;
};

/** 单个故障注入场景的完整结果。 */
export type DurableRuntimeScenarioResult = {
  id: string;
  category: DurableRuntimeScenarioCategory;
  passed: boolean;
  durationMs: number;
  checks: DurableRuntimeEvaluationCheck[];
  metrics: DurableRuntimeScenarioMetrics;
  error: string | null;
};

/** 一条发布硬门槛的实际值、阈值和判定。 */
export type DurableRuntimeEvaluationGate = {
  passed: boolean;
  actual: number;
  operator: 'eq' | 'gte' | 'lte';
  threshold: number;
};

/** EVAL-103 固定的四个发布门槛。 */
export type DurableRuntimeEvaluationGates = {
  allScenariosPassed: DurableRuntimeEvaluationGate;
  recoverySuccessRate: DurableRuntimeEvaluationGate;
  duplicateSideEffects: DurableRuntimeEvaluationGate;
  toolCallsAfterCancellation: DurableRuntimeEvaluationGate;
};

/** 可直接序列化、比较和归档的 EVAL-103 报告。 */
export type DurableRuntimeEvaluationReport = {
  schemaVersion: 1;
  evaluationId: 'EVAL-103';
  generatedAt: string;
  durationMs: number;
  passed: boolean;
  summary: {
    totalScenarios: number;
    passedScenarios: number;
    recoveryScenarios: number;
    recoveredScenarios: number;
  };
  gates: DurableRuntimeEvaluationGates;
  scenarios: DurableRuntimeScenarioResult[];
};

type ScenarioOutcome = {
  checks: DurableRuntimeEvaluationCheck[];
  metrics: DurableRuntimeScenarioMetrics;
};

type ScenarioDefinition = {
  id: string;
  category: DurableRuntimeScenarioCategory;
  execute: () => Promise<ScenarioOutcome>;
};

/** 执行全部固定场景，并在末尾统一计算发布门槛。 */
export async function runDurableRuntimeEvaluation(): Promise<DurableRuntimeEvaluationReport> {
  const startedAt = Date.now();
  const scenarios: DurableRuntimeScenarioResult[] = [];
  for (const definition of scenarioDefinitions()) {
    scenarios.push(await executeScenario(definition));
  }
  const gates = evaluateDurableRuntimeGates(scenarios);
  const recoveryScenarios = scenarios.filter((scenario) => scenario.metrics.recoveryExpected);
  return {
    schemaVersion: 1,
    evaluationId: 'EVAL-103',
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    passed: Object.values(gates).every((gate) => gate.passed),
    summary: {
      totalScenarios: scenarios.length,
      passedScenarios: scenarios.filter((scenario) => scenario.passed).length,
      recoveryScenarios: recoveryScenarios.length,
      recoveredScenarios: recoveryScenarios.filter(
        (scenario) => scenario.metrics.recoverySucceeded,
      ).length,
    },
    gates,
    scenarios,
  };
}

/** 从场景结果计算 SDD 要求的硬门槛，供 CLI 与契约测试共享。 */
export function evaluateDurableRuntimeGates(
  scenarios: readonly DurableRuntimeScenarioResult[],
): DurableRuntimeEvaluationGates {
  const recoveryScenarios = scenarios.filter((scenario) => scenario.metrics.recoveryExpected);
  const recovered = recoveryScenarios.filter(
    (scenario) => scenario.metrics.recoverySucceeded,
  ).length;
  const recoveryRate = recoveryScenarios.length > 0
    ? recovered / recoveryScenarios.length
    : 0;
  const duplicateSideEffects = scenarios.reduce(
    (total, scenario) => total + scenario.metrics.duplicateSideEffects,
    0,
  );
  const toolCallsAfterCancellation = scenarios.reduce(
    (total, scenario) => total + scenario.metrics.toolCallsAfterCancellation,
    0,
  );
  const passedScenarios = scenarios.filter((scenario) => scenario.passed).length;
  return {
    allScenariosPassed: gate(passedScenarios, 'eq', scenarios.length),
    recoverySuccessRate: gate(recoveryRate, 'gte', 1),
    duplicateSideEffects: gate(duplicateSideEffects, 'lte', 0),
    toolCallsAfterCancellation: gate(toolCallsAfterCancellation, 'lte', 0),
  };
}

/** 把总门槛判定转换为 CLI 退出码：全部通过为 0，否则为 1。 */
export function durableRuntimeEvaluationExitCode(
  gates: DurableRuntimeEvaluationGates,
): 0 | 1 {
  return Object.values(gates).every((gate) => gate.passed) ? 0 : 1;
}

/** 返回 EVAL-103 的稳定场景集合。 */
function scenarioDefinitions(): ScenarioDefinition[] {
  return [
    {
      id: 'checkpoint_before_model_crash',
      category: 'crash',
      execute: evaluateCheckpointCrash,
    },
    {
      id: 'completed_side_effect_replay',
      category: 'crash',
      execute: evaluateCompletedSideEffectReplay,
    },
    {
      id: 'side_effect_result_persistence_crash',
      category: 'uncertain_side_effect',
      execute: evaluateUncertainSideEffectCrash,
    },
    {
      id: 'side_effect_timeout_pause',
      category: 'timeout',
      execute: evaluateSideEffectTimeout,
    },
    {
      id: 'root_cancellation',
      category: 'cancellation',
      execute: evaluateRootCancellation,
    },
    {
      id: 'cancellation_blocks_late_tool_call',
      category: 'cancellation',
      execute: evaluateCancellationBlocksLateToolCall,
    },
  ];
}

/** 捕获意外异常但继续执行其余场景，避免报告只包含首个失败。 */
async function executeScenario(
  definition: ScenarioDefinition,
): Promise<DurableRuntimeScenarioResult> {
  const startedAt = Date.now();
  try {
    const outcome = await definition.execute();
    return {
      id: definition.id,
      category: definition.category,
      passed: outcome.checks.every((item) => item.passed),
      durationMs: Date.now() - startedAt,
      checks: outcome.checks,
      metrics: outcome.metrics,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      id: definition.id,
      category: definition.category,
      passed: false,
      durationMs: Date.now() - startedAt,
      checks: [check('场景执行不抛出未处理异常', message, null)],
      metrics: emptyMetrics(),
      error: message,
    };
  }
}

/** 模拟模型调用前进程退出，验证精确恢复节点和事件水位。 */
async function evaluateCheckpointCrash(): Promise<ScenarioOutcome> {
  const store = new RuntimeEvaluationStore();
  const run = runningRun('eval-checkpoint-crash', RouteKind.PLANNED_AGENT);
  store.seedRun(run);
  await new RuntimeCheckpointService(() => store.createUnitOfWork()).commit({
    run,
    expectedVersion: run.version,
    boundary: RuntimeCheckpointBoundary.MODEL_CALLING,
    resumeNode: 'planner.invoke_model',
    nextEventSequence: 7,
    state: { promptVersion: 'eval-v1' },
    checkpointId: 'eval-checkpoint-before-model',
    createdAt: FIXED_TIME,
  });

  const plan = await new RuntimeRecoveryService(
    () => store.createUnitOfWork(),
    () => FIXED_TIME,
  ).resolve(run.id);
  const recoverySucceeded = plan?.disposition === RuntimeRecoveryDisposition.RESUME
    && plan.resumeNode === 'planner.invoke_model'
    && plan.nextEventSequence === 7;
  return {
    checks: [
      check('恢复动作为 RESUME', plan?.disposition, RuntimeRecoveryDisposition.RESUME),
      check('恢复到模型调用节点', plan?.resumeNode, 'planner.invoke_model'),
      check('事件水位从 7 继续', plan?.nextEventSequence, 7),
      check(
        'Checkpoint 边界保持 model_calling',
        plan?.state.checkpointBoundary,
        RuntimeCheckpointBoundary.MODEL_CALLING,
      ),
    ],
    metrics: metrics({ recoveryExpected: true, recoverySucceeded }),
  };
}

/** 模拟工具结果已落库后进程重建，验证恢复计划和结果复用都跳过外部写。 */
async function evaluateCompletedSideEffectReplay(): Promise<ScenarioOutcome> {
  const store = new RuntimeEvaluationStore();
  const run = runningRun('eval-completed-replay', RouteKind.SINGLE_TOOL);
  store.seedRun(run);
  let externalWrites = 0;
  const invoke = async (): Promise<ToolResult> => {
    externalWrites += 1;
    return { success: true, data: { saved: true } };
  };
  const request = toolRequest(run.id, 'eval-completed-call');
  const first = await toolService(
    invoke,
    'write',
    new PersistentToolIdempotencyStore(() => store.createUnitOfWork(), () => FIXED_TIME),
  ).invoke(request);

  const persistedRun = store.runs.get(run.id) as AgentRun;
  await new RuntimeCheckpointService(() => store.createUnitOfWork()).commit({
    run: persistedRun,
    expectedVersion: persistedRun.version,
    boundary: RuntimeCheckpointBoundary.TOOL_RESULT_PERSISTED,
    resumeNode: 'step.consume_tool_result',
    nextEventSequence: 12,
    state: { toolCallId: request.toolCallId },
    checkpointId: 'eval-checkpoint-after-tool',
    createdAt: FIXED_TIME,
  });
  const plan = await new RuntimeRecoveryService(
    () => store.createUnitOfWork(),
    () => FIXED_TIME,
  ).resolve(run.id);
  const replayed = await toolService(
    invoke,
    'write',
    new PersistentToolIdempotencyStore(() => store.createUnitOfWork(), () => FIXED_TIME),
  ).invoke(request);
  const recoverySucceeded = plan?.disposition === RuntimeRecoveryDisposition.RESUME
    && plan.resumeNode === 'step.consume_tool_result'
    && plan.reusableToolCalls.length === 1;
  return {
    checks: [
      check('首次副作用调用成功', first.success, true),
      check('恢复到工具结果消费节点', plan?.resumeNode, 'step.consume_tool_result'),
      check('恢复计划包含一个可复用结果', plan?.reusableToolCalls.length, 1),
      check('新服务实例直接重放结果', replayed.metadata?.replayed, true),
      check('外部写操作只执行一次', externalWrites, 1),
    ],
    metrics: metrics({
      recoveryExpected: true,
      recoverySucceeded,
      externalSideEffects: externalWrites,
      logicalSideEffects: 1,
    }),
  };
}

/** 模拟副作用已发生但结果未落库，验证 UNKNOWN/PAUSED 和禁止重放。 */
async function evaluateUncertainSideEffectCrash(): Promise<ScenarioOutcome> {
  const store = new RuntimeEvaluationStore();
  const run = runningRun('eval-uncertain-crash', RouteKind.SINGLE_TOOL);
  store.seedRun(run);
  let externalWrites = 0;
  const invoke = async (): Promise<ToolResult> => {
    externalWrites += 1;
    return { success: true, data: 'submitted' };
  };
  const persistent = new PersistentToolIdempotencyStore(
    () => store.createUnitOfWork(),
    () => FIXED_TIME,
  );
  let injectedCrashObserved = false;
  try {
    await toolService(
      invoke,
      'external_communication',
      new FailBeforeResultPersistenceStore(persistent),
    ).invoke(toolRequest(run.id, 'eval-uncertain-call'));
  } catch (error) {
    injectedCrashObserved = String(error).includes('结果持久化前进程退出');
  }

  const plan = await new RuntimeRecoveryService(
    () => store.createUnitOfWork(),
    () => FIXED_TIME,
  ).resolve(run.id);
  const replayAttempt = await toolService(
    invoke,
    'external_communication',
    new PersistentToolIdempotencyStore(() => store.createUnitOfWork(), () => FIXED_TIME),
  ).invoke(toolRequest(run.id, 'eval-uncertain-call'));
  const recoverySucceeded = plan?.disposition === RuntimeRecoveryDisposition.PAUSE
    && plan.reason === RuntimeRecoveryReason.UNCERTAIN_SIDE_EFFECT
    && plan.run.status === RunStatus.PAUSED
    && plan.unresolvedToolCalls[0]?.status === ToolCallStatus.UNKNOWN;
  return {
    checks: [
      check('故障注入发生在结果持久化前', injectedCrashObserved, true),
      check('恢复动作是 PAUSE', plan?.disposition, RuntimeRecoveryDisposition.PAUSE),
      check('恢复原因是不确定副作用', plan?.reason, RuntimeRecoveryReason.UNCERTAIN_SIDE_EFFECT),
      check('Run 持久化为 PAUSED', plan?.run.status, RunStatus.PAUSED),
      check('ToolCall 持久化为 UNKNOWN', plan?.unresolvedToolCalls[0]?.status, ToolCallStatus.UNKNOWN),
      check('再次调用返回 uncertain_side_effect', replayAttempt.error?.code, 'uncertain_side_effect'),
      check('外部写操作没有重复', externalWrites, 1),
    ],
    metrics: metrics({
      recoveryExpected: true,
      recoverySucceeded,
      externalSideEffects: externalWrites,
      logicalSideEffects: 1,
    }),
  };
}

/** 注入副作用工具超时，验证 Signal 中止、UNKNOWN/PAUSED 和零重复提交。 */
async function evaluateSideEffectTimeout(): Promise<ScenarioOutcome> {
  const store = new RuntimeEvaluationStore();
  const run = runningRun('eval-side-effect-timeout', RouteKind.SINGLE_TOOL);
  store.seedRun(run);
  let externalSubmissions = 0;
  let receivedSignal: AbortSignal | undefined;
  const invoke = async (
    _arguments: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> => {
    externalSubmissions += 1;
    receivedSignal = context?.signal;
    return new Promise<ToolResult>(() => undefined);
  };
  const request = toolRequest(run.id, 'eval-timeout-call');
  const result = await toolService(
    invoke,
    'write',
    new PersistentToolIdempotencyStore(() => store.createUnitOfWork(), () => FIXED_TIME),
    5,
  ).invoke(request);
  const plan = await new RuntimeRecoveryService(
    () => store.createUnitOfWork(),
    () => FIXED_TIME,
  ).resolve(run.id);
  const replayAttempt = await toolService(
    invoke,
    'write',
    new PersistentToolIdempotencyStore(() => store.createUnitOfWork(), () => FIXED_TIME),
    5,
  ).invoke(request);
  const recoverySucceeded = plan?.disposition === RuntimeRecoveryDisposition.PAUSE
    && plan.unresolvedToolCalls[0]?.status === ToolCallStatus.UNKNOWN;
  return {
    checks: [
      check('工具结果为 timeout', result.error?.code, 'timeout'),
      check('超时 Signal 已中止', receivedSignal?.aborted, true),
      check('恢复动作是 PAUSE', plan?.disposition, RuntimeRecoveryDisposition.PAUSE),
      check('超时副作用记录为 UNKNOWN', plan?.unresolvedToolCalls[0]?.status, ToolCallStatus.UNKNOWN),
      check('恢复后禁止再次提交', replayAttempt.error?.code, 'uncertain_side_effect'),
      check('外部提交次数保持一次', externalSubmissions, 1),
    ],
    metrics: metrics({
      recoveryExpected: true,
      recoverySucceeded,
      externalSideEffects: externalSubmissions,
      logicalSideEffects: 1,
    }),
  };
}

/** 在真实 Runtime 根执行树中取消 LLM，验证请求先落库且没有后续 ToolCall。 */
async function evaluateRootCancellation(): Promise<ScenarioOutcome> {
  const store = new RuntimeEvaluationStore();
  const llm = new AbortableEvaluationLLM();
  const dispatcher = cancellationDispatcher(llm);
  const runtime = new RuntimeService(
    () => store.createUnitOfWork(),
    fixedRouter(RouteKind.DIRECT),
    dispatcher,
  );
  const controller = new AbortController();
  const pending = collect(runtime.execute({
    sessionId: 'eval-session-cancel',
    message: createMessage({ message: '执行取消评测' }),
    signal: controller.signal,
  }));

  await llm.started.promise;
  await runtime.requestCancellation();
  const requestedBeforeAbort = [...store.runs.values()][0]?.cancelRequestedAt instanceof Date;
  const cancellationStartedAt = Date.now();
  controller.abort(new DOMException('EVAL-103 取消', 'AbortError'));
  const events = await pending;
  const cancellationLatencyMs = Date.now() - cancellationStartedAt;
  const finalRun = [...store.runs.values()][0];
  const toolCallsAfterCancellation = store.toolCalls.size;
  return {
    checks: [
      check('取消请求在 abort 前持久化', requestedBeforeAbort, true),
      check('只产生 run.cancelled 终态', events.map((event) => event.type), ['run.cancelled']),
      check('Run 终态为 CANCELLED', finalRun?.status, RunStatus.CANCELLED),
      check('取消确认结果为 confirmed', finalRun?.metadata.cancellation, { outcome: 'confirmed' }),
      check('取消后没有 ToolCall', toolCallsAfterCancellation, 0),
    ],
    metrics: metrics({
      toolCallsAfterCancellation,
      cancellationLatencyMs,
    }),
  };
}

/** 取消后让 Planned runner 故意尝试产生工具事件，验证 Runtime 边界阻止其对外可见。 */
async function evaluateCancellationBlocksLateToolCall(): Promise<ScenarioOutcome> {
  const store = new RuntimeEvaluationStore();
  const runner = new LateToolPlannedRunner();
  const runtime = new RuntimeService(
    () => store.createUnitOfWork(),
    fixedRouter(RouteKind.PLANNED_AGENT),
    lateToolCancellationDispatcher(runner),
  );
  const controller = new AbortController();
  const pending = collect(runtime.execute({
    sessionId: 'eval-session-late-tool-cancel',
    message: createMessage({ message: '取消后不得继续调用工具' }),
    signal: controller.signal,
  }));

  await runner.started.promise;
  await runtime.requestCancellation();
  controller.abort(new DOMException('EVAL-103 取消晚到工具', 'AbortError'));
  const events = await pending;
  const emittedToolCalls = events.filter((event) => event.type === 'tool.calling').length;
  const toolCallsAfterCancellation = emittedToolCalls + store.toolCalls.size;
  const finalRun = [...store.runs.values()][0];
  return {
    checks: [
      check('runner 在取消后尝试调度一次工具', runner.scheduleAttempts, 1),
      check('Runtime 未发布晚到工具事件', emittedToolCalls, 0),
      check('Runtime 未持久化晚到 ToolCall', store.toolCalls.size, 0),
      check('事件流只保留 run.cancelled', events.map((event) => event.type), ['run.cancelled']),
      check('Run 终态为 CANCELLED', finalRun?.status, RunStatus.CANCELLED),
    ],
    metrics: metrics({ toolCallsAfterCancellation }),
  };
}

/** 创建处于 running 的确定性评测 Run。 */
function runningRun(id: string, route: RouteKind): AgentRun {
  return transitionAgentRun(
    createAgentRun({ id, sessionId: `session-${id}`, route }),
    { status: RunStatus.RUNNING, at: FIXED_TIME },
  );
}

/** 创建单个可控工具的可靠调用服务。 */
function toolService(
  invoke: (
    arguments_: Record<string, unknown>,
    context?: ToolExecutionContext,
  ) => Promise<ToolResult>,
  risk: ToolRisk,
  idempotencyStore: ToolIdempotencyStore,
  timeoutMs = 100,
): ToolInvocationService {
  const registration: ToolRegistration = {
    descriptor: {
      id: 'builtin:durable_eval_tool',
      name: 'durable_eval_tool',
      source: 'builtin',
      description: 'EVAL-103 可控故障工具',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
      capabilities: ['durable-evaluation'],
      risk,
      requiresApproval: false,
      timeoutMs,
    },
    groupName: 'evaluation',
    invoke,
  };
  const registry = new InMemoryToolRegistry();
  registry.register(registration);
  return new ToolInvocationService(registry, { idempotencyStore });
}

/** 创建场景内稳定、跨实例一致的工具调用身份。 */
function toolRequest(runId: string, toolCallId: string) {
  return {
    functionName: 'durable_eval_tool',
    arguments: { value: 'eval' },
    scopeId: runId,
    idempotencyKey: toolCallId,
    toolCallId,
  };
}

/** 在工具返回后、结果写入前注入进程故障。 */
class FailBeforeResultPersistenceStore implements ToolIdempotencyStore {
  /** 保存真实持久化 store，只替换 complete 故障点。 */
  constructor(private readonly delegate: ToolIdempotencyStore) {}

  reserve(input: Parameters<ToolIdempotencyStore['reserve']>[0]) {
    return this.delegate.reserve(input);
  }

  start(input: Parameters<ToolIdempotencyStore['start']>[0]) {
    return this.delegate.start(input);
  }

  /** 模拟结果持久化前进程退出。 */
  async complete(_input: Parameters<ToolIdempotencyStore['complete']>[0]): Promise<void> {
    throw new Error('EVAL-103 故障注入：结果持久化前进程退出');
  }
}

/** 可被根 Signal 中止的 Evaluation LLM。 */
class AbortableEvaluationLLM extends LLM {
  readonly modelName = 'eval-abortable';
  readonly temperature = 0;
  readonly maxTokens = 128;
  readonly started = deferred<void>();

  /** 保持模型请求进行中，直到根 Signal 取消。 */
  async invoke(input: Parameters<LLM['invoke']>[0]): Promise<LLMMessage> {
    this.started.resolve();
    return new Promise((_resolve, reject) => {
      input.signal?.addEventListener('abort', () => reject(
        input.signal?.reason ?? new DOMException('模型调用已取消', 'AbortError'),
      ), { once: true });
    });
  }
}

/** 创建只允许指定路径的固定路由器。 */
function fixedRouter(route: RouteKind): RuntimeRouterService {
  const routeModel = new class extends RuntimeRouteModel {
    /** 固定规则命中时不应调用模型路由。 */
    async decide(): Promise<unknown> {
      throw new Error('取消评测不应调用路由模型');
    }
  }();
  return new RuntimeRouterService(routeModel, {
    rules: [{
      name: `eval-always-${route}`,
      /** 固定选择目标路径，隔离路由模型波动。 */
      evaluate: () => ({
        route,
        reason: `EVAL-103 ${route} 取消场景`,
        requiredCapabilities: [],
        requestedSkills: [],
        confidence: 1,
      }),
    }],
  });
}

/** 在根取消后故意产出一个工具载荷，供执行器的取消短路拦截。 */
class LateToolPlannedRunner implements PlannedAgentRunner {
  readonly started = deferred<void>();
  scheduleAttempts = 0;

  /** 等待取消后尝试调度工具；该载荷不应越过 BaseRuntimeExecutor。 */
  async *execute(
    context: RuntimeExecutionContext,
  ): AsyncIterable<RuntimeExecutionEventPayload> {
    this.started.resolve();
    await new Promise<void>((resolve) => {
      if (context.signal?.aborted) {
        resolve();
        return;
      }
      context.signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    this.scheduleAttempts += 1;
    yield {
      type: 'tool.calling',
      toolCallId: 'eval-late-tool-call',
      toolName: 'evaluation',
      functionName: 'durable_eval_tool',
      arguments: { value: 'must-not-run' },
    };
  }
}

/** 创建晚到 ToolCall 取消场景的四路径 Dispatcher。 */
function lateToolCancellationDispatcher(
  runner: PlannedAgentRunner,
): RuntimeExecutorDispatcher {
  const unavailable = {
    /** 本场景只允许 Planned Agent 路径。 */
    async *execute(): AsyncIterable<never> {
      throw new Error('晚到工具取消评测调度了错误路径');
    },
  };
  return new RuntimeExecutorDispatcher([
    new DirectRuntimeExecutor({
      respond: async () => { throw new Error('晚到工具取消评测不应调用 Direct'); },
    }),
    new SingleToolRuntimeExecutor(
      { select: async () => { throw new Error('不应选择 Single Tool'); } },
      { invoke: async () => { throw new Error('不应调用 Single Tool'); } },
      { respond: async () => { throw new Error('不应总结 Single Tool'); } },
    ),
    new WorkflowRuntimeExecutor(unavailable),
    new PlannedAgentRuntimeExecutor(runner),
  ]);
}

/** 创建取消场景的完整四路径 Dispatcher，非 Direct 路径被调用即失败。 */
function cancellationDispatcher(llm: LLM): RuntimeExecutorDispatcher {
  const unavailable = {
    /** 取消评测只允许 Direct 路径。 */
    async *execute(): AsyncIterable<never> {
      throw new Error('取消评测调度了非 Direct 路径');
    },
  };
  return new RuntimeExecutorDispatcher([
    new DirectRuntimeExecutor(new LLMDirectResponseProvider(llm)),
    new SingleToolRuntimeExecutor(
      { select: async () => { throw new Error('取消评测不应选择工具'); } },
      { invoke: async () => { throw new Error('取消评测不应调用工具'); } },
      { respond: async () => { throw new Error('取消评测不应总结工具'); } },
    ),
    new WorkflowRuntimeExecutor(unavailable),
    new PlannedAgentRuntimeExecutor(unavailable),
  ]);
}

/** 消费完整 Runtime Event 流。 */
async function collect(events: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const collected: RuntimeEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

/** 创建可由场景显式完成的 Promise。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** 创建一条深比较断言，并把 undefined 归一为 null 以保持 JSON 字段稳定。 */
function check(name: string, actual: unknown, expected: unknown): DurableRuntimeEvaluationCheck {
  const normalizedActual = actual === undefined ? null : actual;
  const normalizedExpected = expected === undefined ? null : expected;
  return {
    name,
    passed: isDeepStrictEqual(normalizedActual, normalizedExpected),
    expected: normalizedExpected,
    actual: normalizedActual,
  };
}

/** 组装指标并集中计算重复副作用。 */
function metrics(
  input: Partial<DurableRuntimeScenarioMetrics> = {},
): DurableRuntimeScenarioMetrics {
  const externalSideEffects = input.externalSideEffects ?? 0;
  const logicalSideEffects = input.logicalSideEffects ?? 0;
  return {
    recoveryExpected: input.recoveryExpected ?? false,
    recoverySucceeded: input.recoverySucceeded ?? false,
    externalSideEffects,
    logicalSideEffects,
    duplicateSideEffects: Math.max(0, externalSideEffects - logicalSideEffects),
    toolCallsAfterCancellation: input.toolCallsAfterCancellation ?? 0,
    cancellationLatencyMs: input.cancellationLatencyMs ?? null,
  };
}

/** 返回意外异常场景使用的零值指标。 */
function emptyMetrics(): DurableRuntimeScenarioMetrics {
  return metrics();
}

/** 按比较符创建硬门槛判定。 */
function gate(
  actual: number,
  operator: DurableRuntimeEvaluationGate['operator'],
  threshold: number,
): DurableRuntimeEvaluationGate {
  const passed = operator === 'eq'
    ? actual === threshold
    : operator === 'gte'
      ? actual >= threshold
      : actual <= threshold;
  return { passed, actual, operator, threshold };
}
