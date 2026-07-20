import {
  RouteKind,
  createAgentRun,
} from '../../src/domain/models/agent-run';
import { RuntimeEvent, RuntimeToolEvent } from '../../src/domain/models/runtime-event';
import { ToolResult } from '../../src/domain/models/tool-result';
import {
  DirectRuntimeExecutor,
  PlannedAgentRuntimeExecutor,
  RuntimeExecutionContext,
  RuntimeExecutionEventPayload,
  RuntimeExecutorDispatcher,
  SingleToolRuntimeExecutor,
  WorkflowRuntimeExecutor,
} from '../../src/domain/services/runtime/executor.service';
import {
  AgentQualityEvaluator,
  AgentQualityObservation,
  AgentQualityTask,
} from './agent-quality.evaluation';
import {
  DurableRuntimeEvaluationReport,
  DurableRuntimeScenarioResult,
  runDurableRuntimeEvaluation,
} from './durable-runtime.evaluation';

const EVALUATION_TIME = new Date('2026-07-20T12:00:00.000Z');

/** 使用受控依赖驱动真实 Runtime Executor 的当前核心路径 evaluator。 */
export class RuntimeCoreQualityEvaluator implements AgentQualityEvaluator {
  readonly id = 'runtime_core';

  /** 执行一个核心正常路径任务并从真实 Runtime Event 生成 observation。 */
  async evaluate(task: AgentQualityTask): Promise<AgentQualityObservation> {
    return executeRuntimeCoreTask(task);
  }
}

/** 把 EVAL-103 的真实故障注入报告适配为统一质量 observation。 */
export class DurableRuntimeQualityEvaluator implements AgentQualityEvaluator {
  readonly id = 'eval_103';
  private report?: Promise<DurableRuntimeEvaluationReport>;

  /** 只运行一次 EVAL-103，并按固定 scenarioId 返回对应结果。 */
  async evaluate(task: AgentQualityTask): Promise<AgentQualityObservation> {
    this.report ??= runDurableRuntimeEvaluation();
    const report = await this.report;
    const scenario = report.scenarios.find(
      (item) => item.id === task.execution.scenarioId,
    );
    if (!scenario) {
      throw new Error(`EVAL-103 场景不存在：${task.execution.scenarioId}`);
    }
    return durableScenarioObservation(scenario);
  }
}

/** Planned Agent 正常路径的受控事件驱动器。 */
class ScriptedPlannedRunner {
  /** 固定当前任务，防止 evaluator 根据 expected 字段伪造结果。 */
  constructor(private readonly scenarioId: string) {}

  /** 为复杂研究场景产生两次搜索和一个综合回答。 */
  async *execute(
    _context: RuntimeExecutionContext,
  ): AsyncIterable<RuntimeExecutionEventPayload> {
    if (this.scenarioId !== 'complex_research') {
      throw new Error(`runtime_core 不支持 Planned 场景：${this.scenarioId}`);
    }
    yield* searchEvents('quality-source-1', 'Agent Runtime 来源一');
    yield* searchEvents('quality-source-2', 'Agent Runtime 来源二');
    yield {
      type: 'message.created',
      role: 'assistant',
      message: '已交叉验证两个来源并完成 Agent Runtime 研究。',
    };
  }
}

/** 使用真实四路径 Dispatcher 执行一个固定核心任务。 */
async function executeRuntimeCoreTask(
  task: AgentQualityTask,
): Promise<AgentQualityObservation> {
  const startedAt = Date.now();
  const route = coreRoute(task.execution.scenarioId);
  let eventIndex = 0;
  const executorOptions = {
    clock: () => EVALUATION_TIME,
    eventIdFactory: () => `quality-event-${eventIndex++}`,
  };
  const dispatcher = new RuntimeExecutorDispatcher([
    new DirectRuntimeExecutor({
      /** 返回固定概念解释，避免在线模型波动。 */
      respond: async () => '乐观锁通过版本条件检测并发覆盖。',
    }, executorOptions),
    new SingleToolRuntimeExecutor(
      {
        /** 为单工具场景选择唯一搜索调用。 */
        select: async () => ({
          toolName: 'search',
          functionName: 'search_web',
          arguments: { query: 'Runtime 最新资料' },
        }),
      },
      {
        /** 返回受控搜索结果，不访问真实网络。 */
        invoke: async (): Promise<ToolResult> => ({
          success: true,
          data: { title: 'Runtime 当前资料' },
        }),
      },
      {
        /** 根据受控工具结果生成固定回答。 */
        respond: async () => '已找到 Runtime 当前资料。',
      },
      executorOptions,
    ),
    new WorkflowRuntimeExecutor({
      /** 当前固定任务集不启用 Workflow，若误路由则明确失败。 */
      async *execute() {
        throw new Error('EVAL-101 当前核心任务不应进入 Workflow');
      },
    }, executorOptions),
    new PlannedAgentRuntimeExecutor(
      new ScriptedPlannedRunner(task.execution.scenarioId),
      executorOptions,
    ),
  ]);
  const events = await collect(dispatcher.dispatch({
    run: createAgentRun({
      id: `quality-${task.id}`,
      sessionId: 'quality-session',
      route,
    }),
    decision: {
      route,
      reason: `EVAL-101 ${task.execution.scenarioId}`,
      requiredCapabilities: route === RouteKind.DIRECT ? [] : ['search'],
      requestedSkills: [],
      confidence: 1,
    },
    message: task.input.message,
  }));
  return observationFromEvents(
    route,
    events,
    coreModelCalls(task.execution.scenarioId),
    Date.now() - startedAt,
  );
}

/** 返回当前核心场景的确定执行路径。 */
function coreRoute(scenarioId: string): RouteKind {
  switch (scenarioId) {
    case 'simple_question':
      return RouteKind.DIRECT;
    case 'single_tool_query':
      return RouteKind.SINGLE_TOOL;
    case 'complex_research':
      return RouteKind.PLANNED_AGENT;
    default:
      throw new Error(`runtime_core 场景不存在：${scenarioId}`);
  }
}

/** 返回当前受控场景的逻辑模型调用次数。 */
function coreModelCalls(scenarioId: string): number {
  switch (scenarioId) {
    case 'simple_question':
      return 1;
    case 'single_tool_query':
      return 2;
    case 'complex_research':
      return 4;
    default:
      throw new Error(`runtime_core 场景不存在：${scenarioId}`);
  }
}

/** 为一个研究来源产生调用中和调用完成事件。 */
async function* searchEvents(
  toolCallId: string,
  title: string,
): AsyncIterable<RuntimeExecutionEventPayload> {
  const arguments_ = { query: title };
  yield {
    type: 'tool.calling',
    toolCallId,
    toolName: 'search',
    functionName: 'search_web',
    arguments: arguments_,
  };
  yield {
    type: 'tool.called',
    toolCallId,
    toolName: 'search',
    functionName: 'search_web',
    arguments: arguments_,
    result: { success: true, data: { title } },
    content: { title },
  };
}

/** 收集一次 Runtime 事件流。 */
async function collect(events: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const collected: RuntimeEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

/** 从真实 Runtime Event 提取统一 observation。 */
function observationFromEvents(
  route: RouteKind,
  events: readonly RuntimeEvent[],
  modelCalls: number,
  latencyMs: number,
): AgentQualityObservation {
  const terminal = events.at(-1)?.type;
  const outcome = terminal === 'run.completed'
    ? 'completed'
    : terminal === 'run.waiting'
      ? 'waiting'
      : terminal === 'run.cancelled'
        ? 'cancelled'
        : 'failed';
  const toolCalls = events
    .filter((event): event is RuntimeToolEvent =>
      event.type === 'tool.calling')
    .map((event) => event.functionName);
  return {
    outcome,
    route,
    response: events
      .filter((event) => event.type === 'message.created')
      .map((event) => event.message)
      .join('\n'),
    toolCalls,
    activatedSkills: [],
    artifactKinds: [],
    metrics: {
      modelCalls,
      toolCalls: toolCalls.length,
      inputTokens: null,
      outputTokens: null,
      latencyMs,
      recoverySucceeded: null,
      cancellationLatencyMs: null,
      duplicateSideEffects: 0,
      toolCallsAfterCancellation: 0,
    },
  };
}

/** 将一个 EVAL-103 场景映射为统一 observation。 */
function durableScenarioObservation(
  scenario: DurableRuntimeScenarioResult,
): AgentQualityObservation {
  return {
    outcome: scenario.passed ? durableOutcome(scenario.id) : 'failed',
    route: null,
    response: '',
    toolCalls: [],
    activatedSkills: [],
    artifactKinds: [],
    metrics: {
      modelCalls: null,
      toolCalls: scenario.metrics.logicalSideEffects,
      inputTokens: null,
      outputTokens: null,
      latencyMs: scenario.durationMs,
      recoverySucceeded: scenario.metrics.recoveryExpected
        ? scenario.metrics.recoverySucceeded
        : null,
      cancellationLatencyMs: scenario.metrics.cancellationLatencyMs,
      duplicateSideEffects: scenario.metrics.duplicateSideEffects,
      toolCallsAfterCancellation: scenario.metrics.toolCallsAfterCancellation,
    },
  };
}

/** 根据耐久场景的安全收敛语义返回任务终态。 */
function durableOutcome(scenarioId: string): AgentQualityObservation['outcome'] {
  switch (scenarioId) {
    case 'side_effect_timeout_pause':
    case 'side_effect_result_persistence_crash':
      return 'waiting';
    case 'root_cancellation':
    case 'cancellation_blocks_late_tool_call':
      return 'cancelled';
    case 'checkpoint_before_model_crash':
    case 'completed_side_effect_replay':
      return 'completed';
    default:
      throw new Error(`未知 EVAL-103 场景：${scenarioId}`);
  }
}
