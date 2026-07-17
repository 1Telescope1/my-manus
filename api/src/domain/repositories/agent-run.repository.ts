import {
  AgentRun,
  Checkpoint,
  Interruption,
  InterruptionStatus,
  RunStatus,
  RunStep,
  RunStepStatus,
  ToolCallRecord,
  ToolCallStatus,
} from '../models/agent-run';

export type AgentRunUpdateResult =
  | { outcome: 'updated'; run: AgentRun }
  | { outcome: 'not_found' }
  | { outcome: 'version_conflict'; actualVersion: number }
  | {
    outcome: 'invalid_status_transition';
    from: RunStatus;
    to: RunStatus;
  };

export type ConditionalStatusUpdateResult<Entity, Status> =
  | { outcome: 'updated'; entity: Entity }
  | { outcome: 'not_found' }
  | { outcome: 'status_conflict'; actualStatus: Status };

export type ToolCallReservationResult =
  | { outcome: 'reserved'; toolCall: ToolCallRecord }
  | { outcome: 'existing'; toolCall: ToolCallRecord }
  | { outcome: 'key_conflict'; existingToolCall: ToolCallRecord };

export type CheckpointAppendResult =
  | { outcome: 'appended'; checkpoint: Checkpoint }
  | { outcome: 'already_exists'; checkpoint: Checkpoint }
  | {
    outcome: 'content_conflict';
    existingCheckpoint: Checkpoint;
  }
  | { outcome: 'sequence_conflict'; expectedSequence: number }
  | {
    outcome: 'event_sequence_regression';
    minimumNextEventSequence: number;
  };

/**
 * AgentRun 聚合的持久化端口。
 *
 * 同一聚合变更的 Run CAS 与子记录写入必须位于一个 UnitOfWork 事务；
 * CAS 冲突必须使整个事务回滚。RUNTIME-101 只定义契约，具体接线属于 RUNTIME-102。
 */
export abstract class AgentRunRepository {
  /** 创建初始版本的 Run；重复 ID 必须失败。 */
  abstract create(run: AgentRun): Promise<void>;

  abstract getById(runId: string): Promise<AgentRun | null>;

  abstract listBySessionId(sessionId: string): Promise<AgentRun[]>;

  /**
   * 仅当持久化版本等于 expectedVersion 时更新，并原子递增一次版本。
   * candidate.version 必须等于 expectedVersion；成功结果返回 version+1 的快照。
   * 若 candidate.status 与持久化状态不同，实现还必须校验领域状态机。
   */
  abstract update(
    run: AgentRun,
    expectedVersion: number,
  ): Promise<AgentRunUpdateResult>;

  abstract createStep(step: RunStep): Promise<void>;

  abstract updateStep(
    step: RunStep,
    expectedStatus: RunStepStatus,
  ): Promise<ConditionalStatusUpdateResult<RunStep, RunStepStatus>>;

  abstract getStepById(stepId: string): Promise<RunStep | null>;

  abstract getStepByKey(
    runId: string,
    key: string,
    attempt: number,
  ): Promise<RunStep | null>;

  abstract listSteps(runId: string): Promise<RunStep[]>;

  /**
   * 按 (runId, idempotencyKey) 原子占用。
   * 只有 requestFingerprint 相同才返回 existing，不同则返回 key_conflict。
   */
  abstract reserveToolCall(toolCall: ToolCallRecord): Promise<ToolCallReservationResult>;

  abstract updateToolCall(
    toolCall: ToolCallRecord,
    expectedStatus: ToolCallStatus,
  ): Promise<ConditionalStatusUpdateResult<ToolCallRecord, ToolCallStatus>>;

  abstract getToolCallById(toolCallId: string): Promise<ToolCallRecord | null>;

  abstract getToolCallByIdempotencyKey(
    runId: string,
    idempotencyKey: string,
  ): Promise<ToolCallRecord | null>;

  abstract listToolCalls(runId: string): Promise<ToolCallRecord[]>;

  /** 返回 pending、running 或 unknown 的调用，供恢复解析器处理。 */
  abstract getIncompleteToolCalls(runId: string): Promise<ToolCallRecord[]>;

  /**
   * 首个序号为 0，随后严格 +1，nextEventSequence 不得回退。
   * already_exists 仅用于所有字段完全相同的重试；同序号不同内容返回 content_conflict。
   */
  abstract appendCheckpoint(checkpoint: Checkpoint): Promise<CheckpointAppendResult>;

  abstract getLatestCheckpoint(runId: string): Promise<Checkpoint | null>;

  abstract createInterruption(interruption: Interruption): Promise<void>;

  abstract updateInterruption(
    interruption: Interruption,
    expectedStatus: InterruptionStatus,
  ): Promise<ConditionalStatusUpdateResult<Interruption, InterruptionStatus>>;

  abstract getInterruptionById(interruptionId: string): Promise<Interruption | null>;

  abstract getPendingInterruptions(runId: string): Promise<Interruption[]>;
}
