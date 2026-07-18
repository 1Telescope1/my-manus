import { randomUUID } from 'node:crypto';
import {
  AgentRun,
  RouteKind,
  RunStatus,
} from '../../models/agent-run';
import { RouteDecision } from '../../models/route-decision';
import {
  RuntimeEvent,
  RuntimeFailedEvent,
  RuntimeTerminalEvent,
} from '../../models/runtime-event';
import { ToolResult } from '../../models/tool-result';
import { ToolSelectionConstraints } from '../../models/tool-selection';

type RuntimeEventEnvelopeKey = 'id' | 'runId' | 'sequence' | 'createdAt';
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type RuntimeActivityEvent = Exclude<RuntimeEvent, RuntimeFailedEvent | RuntimeTerminalEvent>;

/** 路径驱动器可提交的业务事件；统一 envelope 由执行器集中补齐。 */
export type RuntimeExecutionEventPayload = DistributiveOmit<
  RuntimeActivityEvent,
  RuntimeEventEnvelopeKey
>;

type RuntimeEventPayload = DistributiveOmit<RuntimeEvent, RuntimeEventEnvelopeKey>;

/** 启动一条 Runtime 执行路径所需的完整输入。 */
export type RuntimeExecutionRequest = {
  run: AgentRun;
  decision: RouteDecision;
  message: string;
  nextEventSequence?: number;
  metadata?: Readonly<Record<string, unknown>>;
  privateContext?: Readonly<Record<string, unknown>>;
  toolSelection?: ToolSelectionConstraints;
};

/** 已完成校验、可安全传给具体能力端口的执行上下文。 */
export type RuntimeExecutionContext = {
  run: AgentRun;
  decision: RouteDecision;
  message: string;
  metadata: Readonly<Record<string, unknown>>;
  privateContext: Readonly<Record<string, unknown>>;
  toolSelection: ToolSelectionConstraints;
};

/** 为事件时间和标识提供可测试的注入点。 */
export type RuntimeExecutorOptions = {
  clock?: () => Date;
  eventIdFactory?: () => string;
};

/** 四类执行路径共同遵守的厂商无关接口。 */
export interface RuntimeExecutor {
  readonly route: RouteKind;

  /** 执行已匹配的 Run，并按产生顺序流式返回统一 Runtime Event。 */
  execute(request: RuntimeExecutionRequest): AsyncIterable<RuntimeEvent>;
}

/** 执行请求与已选择路径不一致或不满足运行前置条件。 */
export class RuntimeExecutionRequestError extends Error {
  /** 保存稳定错误消息，供调用方区分配置错误和路径内部失败。 */
  constructor(message: string) {
    super(message);
    this.name = RuntimeExecutionRequestError.name;
  }
}

/** 执行器集合存在重复或缺失路径。 */
export class RuntimeExecutorRegistrationError extends Error {
  /** 保存注册表结构错误，避免请求到达后才发现路径不可执行。 */
  constructor(message: string) {
    super(message);
    this.name = RuntimeExecutorRegistrationError.name;
  }
}

/** Direct 路径需要的无工具回答端口。 */
export interface DirectResponseProvider {
  /** 只根据当前上下文生成回答，不获得任何工具调用入口。 */
  respond(context: RuntimeExecutionContext): Promise<string>;
}

/** Single Tool 路径选出的唯一主要工具调用。 */
export type RuntimeToolInvocation = {
  toolName: string;
  functionName: string;
  arguments: Record<string, unknown>;
};

/** Single Tool 路径的工具选择端口。 */
export interface SingleToolSelector {
  /** 根据路由已批准的能力选择一次结构化工具调用。 */
  select(context: RuntimeExecutionContext): Promise<RuntimeToolInvocation>;
}

/** 交给统一工具层的一次调用输入。 */
export type RuntimeToolCallInput = RuntimeToolInvocation & {
  runId: string;
  sessionId: string;
  toolCallId: string;
};

/** Single Tool 执行器依赖的最小工具调用端口。 */
export interface RuntimeToolInvoker {
  /** 执行一次已经选定的工具调用并返回统一 ToolResult。 */
  invoke(input: RuntimeToolCallInput): Promise<ToolResult>;
}

/** Single Tool 路径生成最终回答所需的上下文。 */
export type SingleToolResponseInput = {
  context: RuntimeExecutionContext;
  invocation: RuntimeToolCallInput;
  result: ToolResult;
};

/** Single Tool 路径的结果归纳端口。 */
export interface SingleToolResponseProvider {
  /** 根据唯一工具结果生成面向用户的最终回答。 */
  respond(input: SingleToolResponseInput): Promise<string>;
}

/** Single Tool 事件标识的可测试配置。 */
export type SingleToolExecutorOptions = RuntimeExecutorOptions & {
  toolCallIdFactory?: () => string;
};

/** 确定性 Workflow 驱动器收到的执行输入。 */
export type RuntimeWorkflowInput = RuntimeExecutionContext & {
  workflowName: string;
};

/** Workflow 的具体注册与节点实现通过此端口接入。 */
export interface RuntimeWorkflowRunner {
  /** 执行指定 Workflow，并只提交不含统一 envelope 和终态的业务事件。 */
  execute(input: RuntimeWorkflowInput): AsyncIterable<RuntimeExecutionEventPayload>;
}

/** Planned Agent 的规划与工具循环通过此端口接入。 */
export interface PlannedAgentRunner {
  /** 执行开放式 Agent 流程，并只提交不含统一 envelope 和终态的业务事件。 */
  execute(context: RuntimeExecutionContext): AsyncIterable<RuntimeExecutionEventPayload>;
}

/** 为单个 Run 集中分配事件 ID、时间和单调 sequence。 */
class RuntimeEventFactory {
  private nextSequence: number;

  /** 固定 Run 级上下文并设置恢复后的首个事件序号。 */
  constructor(
    private readonly runId: string,
    nextEventSequence: number,
    private readonly baseMetadata: Readonly<Record<string, unknown>>,
    private readonly clock: () => Date,
    private readonly eventIdFactory: () => string,
  ) {
    this.nextSequence = nextEventSequence;
  }

  /** 把路径业务载荷封装成可直接交给兼容适配器的 Runtime Event。 */
  create(payload: RuntimeEventPayload): RuntimeEvent {
    const metadata = {
      ...this.baseMetadata,
      ...payload.metadata,
      // route 属于执行器确定的运行语义，路径驱动器不能通过事件元数据覆盖。
      route: this.baseMetadata.route,
    };
    const event = {
      ...payload,
      id: this.eventIdFactory(),
      runId: this.runId,
      sequence: this.nextSequence,
      createdAt: this.clock(),
      metadata,
    } as RuntimeEvent;
    this.nextSequence += 1;
    return event;
  }
}

/** 集中处理输入校验、事件封装、等待短路、成功终态和失败终态。 */
abstract class BaseRuntimeExecutor implements RuntimeExecutor {
  abstract readonly route: RouteKind;
  private readonly clock: () => Date;
  private readonly eventIdFactory: () => string;

  /** 保存所有路径共用的事件依赖。 */
  protected constructor(options: RuntimeExecutorOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.eventIdFactory = options.eventIdFactory ?? randomUUID;
  }

  /** 运行具体路径并保证所有成功、等待和失败结果都使用统一事件语义。 */
  async *execute(request: RuntimeExecutionRequest): AsyncIterable<RuntimeEvent> {
    const normalized = normalizeExecutionRequest(request, this.route);
    const eventFactory = new RuntimeEventFactory(
      normalized.context.run.id,
      normalized.nextEventSequence,
      {
        ...normalized.context.metadata,
        route: this.route,
      },
      this.clock,
      this.eventIdFactory,
    );

    try {
      // 路径驱动器只提交类型约束后的业务载荷，Run envelope 和终态由本层控制。
      for await (const payload of this.executePath(normalized.context)) {
        yield eventFactory.create(payload);

        // 等待输入是本次调度的合法停止点，不能再伪造 completed 终态。
        if (payload.type === 'run.waiting') {
          return;
        }
      }

      yield eventFactory.create({ type: 'run.completed' });
    } catch (error) {
      yield eventFactory.create({
        type: 'run.failed',
        error: errorMessage(error),
      });
    }
  }

  /** 由具体路径实现自身最小编排，只返回尚未封装的业务事件。 */
  protected abstract executePath(
    context: RuntimeExecutionContext,
  ): AsyncIterable<RuntimeExecutionEventPayload>;
}

/** 不暴露工具能力、只生成一次回答的 Direct 执行器。 */
export class DirectRuntimeExecutor extends BaseRuntimeExecutor {
  readonly route = RouteKind.DIRECT;

  /** 注入仅能生成文本的 Direct 端口。 */
  constructor(
    private readonly responseProvider: DirectResponseProvider,
    options: RuntimeExecutorOptions = {},
  ) {
    super(options);
  }

  /** 生成一条 assistant 消息，成功终态由基类统一追加。 */
  protected async *executePath(
    context: RuntimeExecutionContext,
  ): AsyncIterable<RuntimeExecutionEventPayload> {
    const response = (await this.responseProvider.respond(context)).trim();
    yield {
      type: 'message.created',
      role: 'assistant',
      message: response,
    };
  }
}

/** 严格限制为一次主要工具调用并随后归纳结果的执行器。 */
export class SingleToolRuntimeExecutor extends BaseRuntimeExecutor {
  readonly route = RouteKind.SINGLE_TOOL;
  private readonly toolCallIdFactory: () => string;

  /** 注入工具选择、单次调用、结果归纳和标识生成依赖。 */
  constructor(
    private readonly selector: SingleToolSelector,
    private readonly invoker: RuntimeToolInvoker,
    private readonly responseProvider: SingleToolResponseProvider,
    options: SingleToolExecutorOptions = {},
  ) {
    super(options);
    this.toolCallIdFactory = options.toolCallIdFactory ?? randomUUID;
  }

  /** 按 select → call once → summarize 的固定顺序执行，路径内不存在调用循环。 */
  protected async *executePath(
    context: RuntimeExecutionContext,
  ): AsyncIterable<RuntimeExecutionEventPayload> {
    const selected = await this.selector.select(context);
    const toolCallId = this.toolCallIdFactory();
    const invocation: RuntimeToolCallInput = {
      ...selected,
      arguments: { ...selected.arguments },
      runId: context.run.id,
      sessionId: context.run.sessionId,
      toolCallId,
    };

    yield {
      type: 'tool.calling',
      toolCallId,
      toolName: invocation.toolName,
      functionName: invocation.functionName,
      arguments: invocation.arguments,
    };

    // Invoker 只在这一处调用一次；失败直接进入 run.failed，不在本任务内隐式重试。
    const result = await this.invoker.invoke(invocation);
    yield {
      type: 'tool.called',
      toolCallId,
      toolName: invocation.toolName,
      functionName: invocation.functionName,
      arguments: invocation.arguments,
      result,
      content: result.data,
    };

    const response = (
      await this.responseProvider.respond({ context, invocation, result })
    ).trim();
    yield {
      type: 'message.created',
      role: 'assistant',
      message: response,
    };
  }
}

/** 按路由指定名称运行代码定义流程的 Workflow 执行器。 */
export class WorkflowRuntimeExecutor extends BaseRuntimeExecutor {
  readonly route = RouteKind.WORKFLOW;

  /** 注入负责解析名称并执行确定性节点的 Workflow 驱动器。 */
  constructor(
    private readonly runner: RuntimeWorkflowRunner,
    options: RuntimeExecutorOptions = {},
  ) {
    super(options);
  }

  /** 把已校验的 workflowName 交给驱动器并转发其业务事件。 */
  protected async *executePath(
    context: RuntimeExecutionContext,
  ): AsyncIterable<RuntimeExecutionEventPayload> {
    const workflowName = context.decision.workflowName;
    if (!workflowName) {
      throw new RuntimeExecutionRequestError('Workflow 路径缺少 workflowName');
    }
    yield* this.runner.execute({ ...context, workflowName });
  }
}

/** 允许规划、工具循环和总结的 Planned Agent 执行器边界。 */
export class PlannedAgentRuntimeExecutor extends BaseRuntimeExecutor {
  readonly route = RouteKind.PLANNED_AGENT;

  /** 注入具体 Planned Agent 驱动器，不依赖特定 Planner 类型。 */
  constructor(
    private readonly runner: PlannedAgentRunner,
    options: RuntimeExecutorOptions = {},
  ) {
    super(options);
  }

  /** 转发 Planned Agent 产生的计划、步骤、工具和消息业务事件。 */
  protected async *executePath(
    context: RuntimeExecutionContext,
  ): AsyncIterable<RuntimeExecutionEventPayload> {
    yield* this.runner.execute(context);
  }
}

/** 按 RouteDecision 选择唯一执行器，并在启动前验证四条路径均已注册。 */
export class RuntimeExecutorDispatcher {
  private readonly executors = new Map<RouteKind, RuntimeExecutor>();

  /** 注册执行器并立即拒绝重复或不完整的路径集合。 */
  constructor(executors: readonly RuntimeExecutor[]) {
    for (const executor of executors) {
      if (this.executors.has(executor.route)) {
        throw new RuntimeExecutorRegistrationError(`执行路径重复注册：${executor.route}`);
      }
      this.executors.set(executor.route, executor);
    }

    const missingRoutes = Object.values(RouteKind).filter(
      (route) => !this.executors.has(route),
    );
    if (missingRoutes.length > 0) {
      throw new RuntimeExecutorRegistrationError(
        `执行路径未注册：${missingRoutes.join(', ')}`,
      );
    }
  }

  /** 使用严格路由决策选择执行器，具体事件在调用方消费流时开始产生。 */
  dispatch(request: RuntimeExecutionRequest): AsyncIterable<RuntimeEvent> {
    const decision = request.decision;
    const executor = this.executors.get(decision.route);
    if (!executor) {
      throw new RuntimeExecutorRegistrationError(`执行路径未注册：${decision.route}`);
    }
    return executor.execute({ ...request, decision });
  }
}

type NormalizedExecutionRequest = {
  context: RuntimeExecutionContext;
  nextEventSequence: number;
};

/** 校验 Run、决策、消息和恢复水位，并返回不可变执行上下文。 */
function normalizeExecutionRequest(
  request: RuntimeExecutionRequest,
  executorRoute: RouteKind,
): NormalizedExecutionRequest {
  const decision = request.decision;
  if (decision.route !== executorRoute) {
    throw new RuntimeExecutionRequestError(
      `执行器路径 ${executorRoute} 与路由决策 ${decision.route} 不一致`,
    );
  }
  if (request.run.route !== decision.route) {
    throw new RuntimeExecutionRequestError(
      `AgentRun 路径 ${request.run.route} 与路由决策 ${decision.route} 不一致`,
    );
  }
  if (![RunStatus.CREATED, RunStatus.RUNNING].includes(request.run.status)) {
    throw new RuntimeExecutionRequestError(
      `AgentRun 状态 ${request.run.status} 不允许启动执行路径`,
    );
  }
  const message = request.message.trim();
  const nextEventSequence = request.nextEventSequence ?? 0;
  if (!Number.isSafeInteger(nextEventSequence) || nextEventSequence < 0) {
    throw new RuntimeExecutionRequestError('nextEventSequence 必须是非负安全整数');
  }

  return {
    context: {
      run: request.run,
      decision,
      message,
      metadata: { ...(request.metadata ?? {}) },
      // 私有上下文仅供路径驱动器使用，不能进入对外 Runtime Event。
      privateContext: { ...(request.privateContext ?? {}) },
      toolSelection: structuredClone(request.toolSelection ?? {}),
    },
    nextEventSequence,
  };
}

/** 将未知异常转换为稳定且非空的 run.failed 文本。 */
function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  const message = String(error).trim();
  return message || 'Runtime 执行失败';
}
