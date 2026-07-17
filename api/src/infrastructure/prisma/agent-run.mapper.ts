import { Prisma } from '@prisma/client';
import {
  AgentRun,
  Checkpoint,
  Interruption,
  InterruptionKind,
  InterruptionStatus,
  RouteKind,
  RunStatus,
  RunStep,
  RunStepKind,
  RunStepStatus,
  ToolCallRecord,
  ToolCallStatus,
  ToolRisk,
} from '../../domain/models/agent-run';

/** Prisma 查询返回的 AgentRun 数据形状；仅包含恢复领域快照所需字段。 */
export type AgentRunPersistenceRecord = {
  id: string;
  sessionId: string;
  route: string;
  status: string;
  currentNode: string | null;
  version: number;
  cancelRequestedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  error: string | null;
  metadata: unknown;
  updatedAt?: Date;
  createdAt?: Date;
};

/** Prisma 查询返回的 RunStep 数据形状。 */
export type RunStepPersistenceRecord = {
  id: string;
  runId: string;
  key: string;
  kind: string;
  status: string;
  attempt: number;
  input: unknown;
  output: unknown;
  error: string | null;
  updatedAt?: Date;
  createdAt?: Date;
};

/** Prisma 查询返回的 ToolCallRecord 数据形状。 */
export type ToolCallPersistenceRecord = {
  id: string;
  runId: string;
  stepId: string;
  toolName: string;
  arguments: unknown;
  result: unknown;
  status: string;
  risk: string;
  idempotencyKey: string;
  requestFingerprint: string;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt?: Date;
  createdAt?: Date;
};

/** Prisma 查询返回的 Checkpoint 数据形状。 */
export type CheckpointPersistenceRecord = {
  id: string;
  runId: string;
  sequence: number;
  resumeNode: string;
  nextEventSequence: number;
  state: unknown;
  createdAt: Date;
};

/** Prisma 查询返回的 Interruption 数据形状。 */
export type InterruptionPersistenceRecord = {
  id: string;
  runId: string;
  kind: string;
  status: string;
  payload: unknown;
  resolution: unknown;
  updatedAt?: Date;
  createdAt?: Date;
};

/** 持久化记录不能安全恢复为领域模型时抛出。 */
export class RuntimePersistenceMappingError extends Error {
  /** 记录无效字段名，并生成统一的持久化映射错误信息。 */
  constructor(readonly field: string, message: string) {
    super(`运行持久化字段 ${field} 无效：${message}`);
    this.name = RuntimePersistenceMappingError.name;
  }
}

/** 将 AgentRun 转换为 Prisma 创建参数。 */
export function agentRunToPersistence(run: AgentRun): Prisma.AgentRunUncheckedCreateInput {
  return {
    id: run.id,
    sessionId: run.sessionId,
    route: run.route,
    status: run.status,
    currentNode: run.currentNode,
    version: run.version,
    cancelRequestedAt: run.cancelRequestedAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    error: run.error,
    metadata: toJsonValue(run.metadata, 'AgentRun.metadata'),
  };
}

/** 将 AgentRun 转换为不含主键和版本的 Prisma 更新参数。 */
export function agentRunUpdateToPersistence(
  run: AgentRun,
): Prisma.AgentRunUpdateManyMutationInput {
  return {
    route: run.route,
    status: run.status,
    currentNode: run.currentNode,
    cancelRequestedAt: run.cancelRequestedAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    error: run.error,
    metadata: toJsonValue(run.metadata, 'AgentRun.metadata'),
  };
}

/** 将数据库 AgentRun 记录转换为领域快照。 */
export function persistenceToAgentRun(record: AgentRunPersistenceRecord): AgentRun {
  return {
    id: record.id,
    sessionId: record.sessionId,
    route: parseEnum(record.route, RouteKind, 'AgentRun.route'),
    status: parseEnum(record.status, RunStatus, 'AgentRun.status'),
    currentNode: record.currentNode,
    version: record.version,
    cancelRequestedAt: record.cancelRequestedAt,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    error: record.error,
    metadata: toRecord(record.metadata, 'AgentRun.metadata'),
  };
}

/** 将 RunStep 转换为 Prisma 创建参数。 */
export function runStepToPersistence(step: RunStep): Prisma.RunStepUncheckedCreateInput {
  return {
    id: step.id,
    runId: step.runId,
    key: step.key,
    kind: step.kind,
    status: step.status,
    attempt: step.attempt,
    input: toNullableJsonValue(step.input, 'RunStep.input'),
    output: toNullableJsonValue(step.output, 'RunStep.output'),
    error: step.error,
  };
}

/** 将 RunStep 转换为状态条件更新所需参数。 */
export function runStepUpdateToPersistence(
  step: RunStep,
): Prisma.RunStepUpdateManyMutationInput {
  return {
    key: step.key,
    kind: step.kind,
    status: step.status,
    attempt: step.attempt,
    input: toNullableJsonValue(step.input, 'RunStep.input'),
    output: toNullableJsonValue(step.output, 'RunStep.output'),
    error: step.error,
  };
}

/** 将数据库 RunStep 记录解析为领域快照。 */
export function persistenceToRunStep(record: RunStepPersistenceRecord): RunStep {
  return {
    id: record.id,
    runId: record.runId,
    key: record.key,
    kind: parseEnum(record.kind, RunStepKind, 'RunStep.kind'),
    status: parseEnum(record.status, RunStepStatus, 'RunStep.status'),
    attempt: record.attempt,
    input: record.input,
    output: record.output,
    error: record.error,
  };
}

/** 将 ToolCallRecord 转换为幂等占用使用的 Prisma 创建参数。 */
export function toolCallToPersistence(
  toolCall: ToolCallRecord,
): Prisma.ToolCallRecordUncheckedCreateInput {
  return {
    id: toolCall.id,
    runId: toolCall.runId,
    stepId: toolCall.stepId,
    toolName: toolCall.toolName,
    arguments: toNullableJsonValue(toolCall.arguments, 'ToolCallRecord.arguments'),
    result: toNullableJsonValue(toolCall.result, 'ToolCallRecord.result'),
    status: toolCall.status,
    risk: toolCall.risk,
    idempotencyKey: toolCall.idempotencyKey,
    requestFingerprint: toolCall.requestFingerprint,
    startedAt: toolCall.startedAt,
    completedAt: toolCall.completedAt,
  };
}

/** 将 ToolCallRecord 转换为状态条件更新参数。 */
export function toolCallUpdateToPersistence(
  toolCall: ToolCallRecord,
): Prisma.ToolCallRecordUpdateManyMutationInput {
  return {
    result: toNullableJsonValue(toolCall.result, 'ToolCallRecord.result'),
    status: toolCall.status,
    startedAt: toolCall.startedAt,
    completedAt: toolCall.completedAt,
  };
}

/** 将数据库 ToolCallRecord 记录解析为领域快照。 */
export function persistenceToToolCall(record: ToolCallPersistenceRecord): ToolCallRecord {
  return {
    id: record.id,
    runId: record.runId,
    stepId: record.stepId,
    toolName: record.toolName,
    arguments: record.arguments,
    result: record.result,
    status: parseEnum(record.status, ToolCallStatus, 'ToolCallRecord.status'),
    risk: parseEnum(record.risk, ToolRisk, 'ToolCallRecord.risk'),
    idempotencyKey: record.idempotencyKey,
    requestFingerprint: record.requestFingerprint,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
  };
}

/** 将 Checkpoint 转换为只追加写入使用的 Prisma 参数。 */
export function checkpointToPersistence(
  checkpoint: Checkpoint,
): Prisma.CheckpointUncheckedCreateInput {
  return {
    id: checkpoint.id,
    runId: checkpoint.runId,
    sequence: checkpoint.sequence,
    resumeNode: checkpoint.resumeNode,
    nextEventSequence: checkpoint.nextEventSequence,
    state: toJsonValue(checkpoint.state, 'Checkpoint.state'),
    createdAt: checkpoint.createdAt,
  };
}

/** 将数据库 Checkpoint 记录解析为可恢复的领域快照。 */
export function persistenceToCheckpoint(record: CheckpointPersistenceRecord): Checkpoint {
  return {
    id: record.id,
    runId: record.runId,
    sequence: record.sequence,
    resumeNode: record.resumeNode,
    nextEventSequence: record.nextEventSequence,
    state: toRecord(record.state, 'Checkpoint.state'),
    createdAt: record.createdAt,
  };
}

/** 将 Interruption 转换为 Prisma 创建参数。 */
export function interruptionToPersistence(
  interruption: Interruption,
): Prisma.InterruptionUncheckedCreateInput {
  return {
    id: interruption.id,
    runId: interruption.runId,
    kind: interruption.kind,
    status: interruption.status,
    payload: toJsonValue(interruption.payload, 'Interruption.payload'),
    resolution: toNullableJsonValue(interruption.resolution, 'Interruption.resolution'),
  };
}

/** 将 Interruption 转换为状态条件更新参数。 */
export function interruptionUpdateToPersistence(
  interruption: Interruption,
): Prisma.InterruptionUpdateManyMutationInput {
  return {
    status: interruption.status,
    resolution: toNullableJsonValue(interruption.resolution, 'Interruption.resolution'),
  };
}

/** 将数据库 Interruption 记录解析为领域快照。 */
export function persistenceToInterruption(
  record: InterruptionPersistenceRecord,
): Interruption {
  return {
    id: record.id,
    runId: record.runId,
    kind: parseEnum(record.kind, InterruptionKind, 'Interruption.kind'),
    status: parseEnum(record.status, InterruptionStatus, 'Interruption.status'),
    payload: toRecord(record.payload, 'Interruption.payload'),
    resolution: record.resolution === null
      ? null
      : toRecord(record.resolution, 'Interruption.resolution'),
  };
}

/** 将数据库字符串解析为指定枚举，未知值立即失败。 */
function parseEnum<EnumValue extends string>(
  value: string,
  values: Record<string, EnumValue>,
  field: string,
): EnumValue {
  if (!Object.values(values).includes(value as EnumValue)) {
    throw new RuntimePersistenceMappingError(field, `未知枚举值 ${value}`);
  }
  return value as EnumValue;
}

/** 将未知 JSON 值收窄并复制为普通只读对象。 */
function toRecord(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RuntimePersistenceMappingError(field, '必须是对象');
  }
  return { ...(value as Record<string, unknown>) };
}

/** 通过 JSON 往返校验可序列化性，并移除对象原型等运行时细节。 */
function toJsonValue(value: unknown, field: string): Prisma.InputJsonValue {
  try {
    // 真实序列化能统一拒绝 BigInt、循环引用和顶层 undefined。
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new Error('值不能序列化为 JSON');
    }
    return JSON.parse(serialized) as Prisma.InputJsonValue;
  } catch (error) {
    throw new RuntimePersistenceMappingError(field, (error as Error).message);
  }
}

/** 将领域 null 映射为 SQL NULL，其余值映射为 Prisma JSON。 */
function toNullableJsonValue(
  value: unknown,
  field: string,
): Prisma.InputJsonValue | Prisma.NullTypes.DbNull {
  return value === null ? Prisma.DbNull : toJsonValue(value, field);
}
