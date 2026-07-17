import { randomUUID } from 'node:crypto';

/** Runtime 根据任务特征选择的执行路径。 */
export enum RouteKind {
  DIRECT = 'direct', // 不调用工具，直接生成回答。
  SINGLE_TOOL = 'single_tool', // 限定一次主要工具调用。
  WORKFLOW = 'workflow', // 执行代码预定义的确定性流程。
  PLANNED_AGENT = 'planned_agent', // 允许规划、工具循环和总结。
}

/** AgentRun 从创建到终止的生命周期状态。 */
export enum RunStatus {
  CREATED = 'created', // 已创建，尚未开始执行。
  RUNNING = 'running', // 正在执行。
  WAITING = 'waiting', // 等待用户补充输入。
  PAUSED = 'paused', // 因审批或受控暂停而停止调度。
  COMPLETED = 'completed', // 正常完成的终态。
  FAILED = 'failed', // 执行失败的终态。
  CANCELLED = 'cancelled', // 已确认取消的终态。
}

/** RunStep 所执行工作的类别。 */
export enum RunStepKind {
  MODEL = 'model', // 调用模型。
  TOOL = 'tool', // 调用工具。
  WORKFLOW = 'workflow', // 执行工作流节点。
  HANDOFF = 'handoff', // 将会话所有权转交给其他 Agent。
  SUMMARY = 'summary', // 生成阶段或最终摘要。
}

/** 单个 RunStep 的执行状态。 */
export enum RunStepStatus {
  PENDING = 'pending', // 等待执行。
  RUNNING = 'running', // 正在执行。
  COMPLETED = 'completed', // 执行成功。
  FAILED = 'failed', // 执行失败。
  CANCELLED = 'cancelled', // 因 Run 取消而停止。
}

/** 一次工具调用记录的状态。 */
export enum ToolCallStatus {
  PENDING = 'pending', // 已登记，尚未调用工具。
  RUNNING = 'running', // 工具正在执行。
  COMPLETED = 'completed', // 工具成功完成且结果已保存。
  FAILED = 'failed', // 工具明确执行失败。
  CANCELLED = 'cancelled', // 工具调用已取消。
  UNKNOWN = 'unknown', // 无法确认外部副作用是否完成。
}

/** 工具调用的副作用风险等级。 */
export enum ToolRisk {
  READ = 'read', // 只读取数据，不修改外部状态。
  WRITE = 'write', // 创建或修改数据。
  DESTRUCTIVE = 'destructive', // 删除或进行难以恢复的修改。
  EXTERNAL_COMMUNICATION = 'external_communication', // 向系统外部发送信息或代表用户行动。
}

/** 导致 Run 暂停并等待处理的原因。 */
export enum InterruptionKind {
  USER_INPUT = 'user_input', // 需要用户补充信息。
  APPROVAL = 'approval', // 需要用户批准高风险操作。
}

/** Interruption 从创建到关闭的处理状态。 */
export enum InterruptionStatus {
  PENDING = 'pending', // 等待处理。
  RESOLVED = 'resolved', // 已提供输入或批准。
  REJECTED = 'rejected', // 用户拒绝了请求。
  EXPIRED = 'expired', // 等待超过有效期。
}

/** 执行器对取消请求的最终确认结果。 */
export enum CancellationOutcome {
  CONFIRMED = 'confirmed', // 已确认所有活动操作停止。
  TIMED_OUT = 'timed_out', // 超时，仍有操作无法确认是否停止。
}

/** 一次 Agent 任务执行的聚合根快照。 */
export type AgentRun = {
  readonly id: string; // Run 唯一标识。
  readonly sessionId: string; // 所属会话 ID。
  readonly route: RouteKind; // 本次选择的执行路径。
  readonly status: RunStatus; // 当前生命周期状态。
  readonly currentNode: string | null; // 当前执行节点；尚未定位时为空。
  readonly version: number; // 乐观并发控制版本。
  readonly cancelRequestedAt: Date | null; // 收到取消请求的时间。
  readonly startedAt: Date | null; // 首次进入 running 的时间。
  readonly completedAt: Date | null; // 进入任一终态的时间。
  readonly error: string | null; // failed 状态对应的错误信息。
  readonly metadata: Readonly<Record<string, unknown>>; // 扩展运行元数据。
};

/** Run 内一个可重试执行步骤的持久化快照。 */
export type RunStep = {
  readonly id: string; // Step 唯一标识。
  readonly runId: string; // 所属 Run ID。
  readonly key: string; // Run 内稳定的逻辑步骤键。
  readonly kind: RunStepKind; // 步骤类型。
  readonly status: RunStepStatus; // 当前执行状态。
  readonly attempt: number; // 从 1 开始的尝试次数。
  readonly input: unknown; // 本次尝试的输入快照。
  readonly output: unknown; // 成功后的输出快照。
  readonly error: string | null; // 失败原因。
};

/** 一次工具调用及其副作用恢复信息。 */
export type ToolCallRecord = {
  readonly id: string; // ToolCall 唯一标识。
  readonly runId: string; // 所属 Run ID。
  readonly stepId: string; // 所属 Step ID。
  readonly toolName: string; // 被调用的工具名称。
  readonly arguments: unknown; // 传给工具的参数快照。
  readonly result: unknown; // 已持久化的工具结果。
  readonly status: ToolCallStatus; // 当前调用状态。
  readonly risk: ToolRisk; // 工具副作用风险。
  readonly idempotencyKey: string; // Run 内防止重复执行的稳定键。
  readonly requestFingerprint: string; // 规范化工具名和参数的指纹。
  readonly startedAt: Date | null; // 工具实际开始时间。
  readonly completedAt: Date | null; // 工具进入终态的时间。
};

/** 可供进程重启后恢复执行的运行快照。 */
export type Checkpoint = {
  readonly id: string; // Checkpoint 唯一标识。
  readonly runId: string; // 所属 Run ID。
  readonly sequence: number; // Run 内从 0 开始递增的检查点序号。
  readonly resumeNode: string; // 恢复后要执行的精确下一节点。
  readonly nextEventSequence: number; // 恢复后下一个 Runtime Event 序号。
  readonly state: Readonly<Record<string, unknown>>; // 恢复执行所需的状态快照。
  readonly createdAt: Date; // 检查点创建时间。
};

/** 等待用户输入或审批的持久化中断记录。 */
export type Interruption = {
  readonly id: string; // Interruption 唯一标识。
  readonly runId: string; // 所属 Run ID。
  readonly kind: InterruptionKind; // 中断原因。
  readonly status: InterruptionStatus; // 当前处理状态。
  readonly payload: Readonly<Record<string, unknown>>; // 展示给处理方的上下文。
  readonly resolution: Readonly<Record<string, unknown>> | null; // 用户输入或审批结果。
};

/** 创建新 AgentRun 时允许调用方提供的字段。 */
export type CreateAgentRunInput = {
  id?: string; // 可选的外部生成 ID。
  sessionId: string; // 所属会话 ID。
  route: RouteKind; // 已确定的执行路径。
  currentNode?: string | null; // 可选的初始节点。
  metadata?: Record<string, unknown>; // 可选扩展元数据。
};

/** 创建处于 created、version=0 的新 AgentRun。 */
export function createAgentRun(input: CreateAgentRunInput): AgentRun {
  return {
    id: input.id ?? randomUUID(),
    sessionId: input.sessionId,
    route: input.route,
    status: RunStatus.CREATED,
    currentNode: input.currentNode ?? null,
    version: 0,
    cancelRequestedAt: null,
    startedAt: null,
    completedAt: null,
    error: null,
    metadata: { ...(input.metadata ?? {}) },
  };
}

/** 创建新 RunStep 时允许调用方提供的字段。 */
export type CreateRunStepInput = {
  id?: string; // 可选的外部生成 ID。
  runId: string; // 所属 Run ID。
  key: string; // Run 内稳定的逻辑步骤键。
  kind: RunStepKind; // 步骤类型。
  attempt?: number; // 尝试次数，默认从 1 开始。
  input?: unknown; // 步骤输入快照。
};

/** 创建处于 pending 状态的新 RunStep。 */
export function createRunStep(input: CreateRunStepInput): RunStep {
  const attempt = input.attempt ?? 1;
  assertPositiveSafeInteger(attempt, 'RunStep.attempt');

  return {
    id: input.id ?? randomUUID(),
    runId: input.runId,
    key: input.key,
    kind: input.kind,
    status: RunStepStatus.PENDING,
    attempt,
    input: input.input ?? null,
    output: null,
    error: null,
  };
}

/** 创建新 ToolCallRecord 时允许调用方提供的字段。 */
export type CreateToolCallRecordInput = {
  id?: string; // 可选的外部生成 ID。
  runId: string; // 所属 Run ID。
  stepId: string; // 所属 Step ID。
  toolName: string; // 被调用的工具名称。
  arguments?: unknown; // 调用参数快照。
  risk: ToolRisk; // 工具副作用风险。
  idempotencyKey: string; // Run 内唯一的幂等键。
  requestFingerprint: string; // 用于验证幂等重试身份的请求指纹。
};

/** 校验幂等信息并创建处于 pending 状态的工具调用记录。 */
export function createToolCallRecord(input: CreateToolCallRecordInput): ToolCallRecord {
  assertNonEmptyString(input.idempotencyKey, 'ToolCallRecord.idempotencyKey');
  assertNonEmptyString(input.requestFingerprint, 'ToolCallRecord.requestFingerprint');

  return {
    id: input.id ?? randomUUID(),
    runId: input.runId,
    stepId: input.stepId,
    toolName: input.toolName,
    arguments: input.arguments ?? null,
    result: null,
    status: ToolCallStatus.PENDING,
    risk: input.risk,
    idempotencyKey: input.idempotencyKey,
    requestFingerprint: input.requestFingerprint,
    startedAt: null,
    completedAt: null,
  };
}

/** 创建新 Checkpoint 时允许调用方提供的字段。 */
export type CreateCheckpointInput = {
  id?: string; // 可选的外部生成 ID。
  runId: string; // 所属 Run ID。
  sequence: number; // Run 内检查点序号。
  resumeNode: string; // 恢复后的精确下一节点。
  nextEventSequence: number; // 恢复后要分配的事件序号。
  state?: Record<string, unknown>; // 恢复状态快照。
  createdAt?: Date; // 可注入的创建时间，便于确定性测试。
};

/** 校验序号并创建新的不可变 Checkpoint。 */
export function createCheckpoint(input: CreateCheckpointInput): Checkpoint {
  assertNonNegativeSafeInteger(input.sequence, 'Checkpoint.sequence');
  assertNonNegativeSafeInteger(input.nextEventSequence, 'Checkpoint.nextEventSequence');

  return {
    id: input.id ?? randomUUID(),
    runId: input.runId,
    sequence: input.sequence,
    resumeNode: input.resumeNode,
    nextEventSequence: input.nextEventSequence,
    state: { ...(input.state ?? {}) },
    createdAt: input.createdAt ?? new Date(),
  };
}

/** 创建新 Interruption 时允许调用方提供的字段。 */
export type CreateInterruptionInput = {
  id?: string; // 可选的外部生成 ID。
  runId: string; // 所属 Run ID。
  kind: InterruptionKind; // 中断原因。
  payload?: Record<string, unknown>; // 提供给用户或审批方的上下文。
};

/** 创建处于 pending 状态的新 Interruption。 */
export function createInterruption(input: CreateInterruptionInput): Interruption {
  return {
    id: input.id ?? randomUUID(),
    runId: input.runId,
    kind: input.kind,
    status: InterruptionStatus.PENDING,
    payload: { ...(input.payload ?? {}) },
    resolution: null,
  };
}

/** 每个 RunStatus 允许到达的后继状态；空数组表示终态。 */
const RUN_STATUS_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  [RunStatus.CREATED]: Object.freeze([RunStatus.RUNNING, RunStatus.CANCELLED]),
  [RunStatus.RUNNING]: Object.freeze([
    RunStatus.WAITING,
    RunStatus.PAUSED,
    RunStatus.COMPLETED,
    RunStatus.FAILED,
    RunStatus.CANCELLED,
  ]),
  [RunStatus.WAITING]: Object.freeze([RunStatus.RUNNING, RunStatus.CANCELLED]),
  [RunStatus.PAUSED]: Object.freeze([RunStatus.RUNNING, RunStatus.CANCELLED]),
  [RunStatus.COMPLETED]: Object.freeze([]),
  [RunStatus.FAILED]: Object.freeze([]),
  [RunStatus.CANCELLED]: Object.freeze([]),
};

/** 返回指定状态的只读合法后继状态列表。 */
export function getAllowedRunStatusTransitions(status: RunStatus): readonly RunStatus[] {
  return RUN_STATUS_TRANSITIONS[status];
}

/** 判断一个 Run 状态转换是否出现在状态机中。 */
export function canTransitionRunStatus(from: RunStatus, to: RunStatus): boolean {
  return RUN_STATUS_TRANSITIONS[from].includes(to);
}

/** 判断状态是否为 completed、failed 或 cancelled 终态。 */
export function isTerminalRunStatus(status: RunStatus): boolean {
  return RUN_STATUS_TRANSITIONS[status].length === 0;
}

/** 调用方尝试执行状态机未定义的转换时抛出。 */
export class InvalidRunStatusTransitionError extends Error {
  readonly code = 'INVALID_RUN_STATUS_TRANSITION'; // 稳定的机器可读错误码。

  /** 保存非法转换的起点和目标状态，便于诊断。 */
  constructor(
    readonly from: RunStatus,
    readonly to: RunStatus,
  ) {
    super(`AgentRun 状态不能从 ${from} 转换为 ${to}`);
    this.name = InvalidRunStatusTransitionError.name;
  }
}

/** 断言状态转换合法；非法时抛出领域错误。 */
export function assertRunStatusTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransitionRunStatus(from, to)) {
    throw new InvalidRunStatusTransitionError(from, to);
  }
}

/**
 * 取消确认信息：正常确认无需额外字段，超时必须列出无法确认的活动操作。
 */
export type AgentRunCancellationAcknowledgement =
  | { outcome: CancellationOutcome.CONFIRMED } // 所有活动操作均已停止。
  | {
    outcome: CancellationOutcome.TIMED_OUT; // 等待停止确认超时。
    uncertainOperationIds: readonly string[]; // 无法确认状态的操作 ID。
  };

/**
 * AgentRun 状态转换命令；失败和取消使用判别联合强制携带必要信息。
 */
export type AgentRunTransition =
  | {
    status: Exclude<RunStatus, RunStatus.FAILED | RunStatus.CANCELLED>; // 普通目标状态。
    at: Date; // 转换发生时间。
  }
  | {
    status: RunStatus.FAILED; // 失败终态。
    at: Date; // 失败时间。
    error: string; // 必填的非空失败原因。
  }
  | {
    status: RunStatus.CANCELLED; // 取消终态。
    at: Date; // 取消确认时间。
    cancellation: AgentRunCancellationAcknowledgement; // 执行器的停止确认结果。
  };

/** AgentRun 进入 failed 但没有有效错误信息时抛出。 */
export class MissingAgentRunFailureError extends Error {
  readonly code = 'MISSING_AGENT_RUN_FAILURE_ERROR'; // 稳定的机器可读错误码。

  /** 构造缺少失败原因的领域错误。 */
  constructor() {
    super('AgentRun 进入 failed 时必须提供非空错误');
    this.name = MissingAgentRunFailureError.name;
  }
}

/** 尚未记录取消请求就尝试进入 cancelled 时抛出。 */
export class MissingAgentRunCancellationRequestError extends Error {
  readonly code = 'MISSING_AGENT_RUN_CANCELLATION_REQUEST'; // 稳定的机器可读错误码。

  /** 构造缺少取消请求的领域错误。 */
  constructor() {
    super('AgentRun 进入 cancelled 前必须先记录取消请求');
    this.name = MissingAgentRunCancellationRequestError.name;
  }
}

/** 取消确认超时但没有记录未知操作时抛出。 */
export class MissingAgentRunUncertainOperationsError extends Error {
  readonly code = 'MISSING_AGENT_RUN_UNCERTAIN_OPERATIONS'; // 稳定的机器可读错误码。

  /** 构造缺少未知操作列表的领域错误。 */
  constructor() {
    super('取消确认超时时必须记录至少一个无法确认的活动操作');
    this.name = MissingAgentRunUncertainOperationsError.name;
  }
}

/**
 * 返回转换后的新快照，不修改输入，也不递增持久化版本。
 * version 只在仓储成功完成 expectedVersion 条件更新时递增。
 */
export function transitionAgentRun(
  run: AgentRun,
  transition: AgentRunTransition,
): AgentRun {
  const nextStatus = transition.status;
  assertRunStatusTransition(run.status, nextStatus);

  if (nextStatus === RunStatus.FAILED && !transition.error.trim()) {
    throw new MissingAgentRunFailureError();
  }

  if (nextStatus === RunStatus.CANCELLED && !run.cancelRequestedAt) {
    throw new MissingAgentRunCancellationRequestError();
  }

  if (
    nextStatus === RunStatus.CANCELLED
    && transition.cancellation.outcome === CancellationOutcome.TIMED_OUT
    && (
      transition.cancellation.uncertainOperationIds.length === 0
      || transition.cancellation.uncertainOperationIds.some((id) => !id.trim())
    )
  ) {
    throw new MissingAgentRunUncertainOperationsError();
  }

  const metadata = nextStatus === RunStatus.CANCELLED
    ? {
      ...run.metadata,
      cancellation: transition.cancellation.outcome === CancellationOutcome.TIMED_OUT
        ? {
          outcome: transition.cancellation.outcome,
          uncertainOperationIds: [...transition.cancellation.uncertainOperationIds],
        }
        : { outcome: transition.cancellation.outcome },
    }
    : { ...run.metadata };

  return {
    ...run,
    status: nextStatus,
    startedAt: run.status === RunStatus.CREATED && nextStatus === RunStatus.RUNNING
      ? run.startedAt ?? transition.at
      : run.startedAt,
    completedAt: isTerminalRunStatus(nextStatus) ? transition.at : run.completedAt,
    error: nextStatus === RunStatus.FAILED ? transition.error : null,
    metadata,
  };
}

/** 已处于终态的 Run 再次收到取消请求时抛出。 */
export class TerminalAgentRunCancellationRequestError extends Error {
  readonly code = 'TERMINAL_AGENT_RUN_CANCELLATION_REQUEST'; // 稳定的机器可读错误码。

  /** 保存当前终态，便于调用方诊断重复取消请求。 */
  constructor(readonly status: RunStatus) {
    super(`终态 AgentRun(${status}) 不能再请求取消`);
    this.name = TerminalAgentRunCancellationRequestError.name;
  }
}

/**
 * 记录首次取消请求时间，但不直接改变 Run 状态。
 * 请求标记与执行器确认后的 cancelled 终态是两件事。
 */
export function requestAgentRunCancellation(
  run: AgentRun,
  requestedAt: Date,
): AgentRun {
  if (isTerminalRunStatus(run.status)) {
    throw new TerminalAgentRunCancellationRequestError(run.status);
  }

  return {
    ...run,
    metadata: { ...run.metadata },
    cancelRequestedAt: run.cancelRequestedAt ?? requestedAt,
  };
}

/** 校验字段是大于 0 的安全整数。 */
function assertPositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} 必须是正安全整数`);
  }
}

/** 校验字段是大于或等于 0 的安全整数。 */
function assertNonNegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} 必须是非负安全整数`);
  }
}

/** 校验字符串至少包含一个非空白字符。 */
function assertNonEmptyString(value: string, field: string): void {
  if (!value.trim()) {
    throw new RangeError(`${field} 不能为空`);
  }
}
