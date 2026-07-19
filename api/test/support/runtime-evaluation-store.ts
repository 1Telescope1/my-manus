import {
  AgentRun,
  Checkpoint,
  Interruption,
  InterruptionStatus,
  RunStep,
  RunStepStatus,
  ToolCallRecord,
  ToolCallStatus,
  canTransitionRunStatus,
} from '../../src/domain/models/agent-run';
import {
  AgentRunRepository,
  CheckpointAppendResult,
} from '../../src/domain/repositories/agent-run.repository';
import { UnitOfWork } from '../../src/domain/repositories/unit-of-work';

/** 耐久执行评测共用的事务内存状态，模拟多个进程实例共享同一数据库。 */
export class RuntimeEvaluationStore {
  readonly runs = new Map<string, AgentRun>();
  readonly steps = new Map<string, RunStep>();
  readonly toolCalls = new Map<string, ToolCallRecord>();
  readonly checkpoints: Checkpoint[] = [];
  readonly interruptions: Interruption[] = [];

  /** 写入一个评测初始 Run。 */
  seedRun(run: AgentRun): void {
    this.runs.set(run.id, run);
  }

  /** 每次返回独立 UoW 对象，失败时回滚全部运行聚合状态。 */
  createUnitOfWork(): UnitOfWork {
    const repository = this.createRepository();
    const unitOfWork = {
      agentRun: repository,
      file: {},
      session: {
        updateStatus: async () => undefined,
      },
      run: async <T>(handler: (active: UnitOfWork) => Promise<T>): Promise<T> => {
        const snapshot = this.snapshot();
        try {
          return await handler(unitOfWork as UnitOfWork);
        } catch (error) {
          this.restore(snapshot);
          throw error;
        }
      },
    } as unknown as UnitOfWork;
    return unitOfWork;
  }

  /** 实现 Evaluation 场景需要的 Run、Step、ToolCall 和 Checkpoint 仓储契约。 */
  private createRepository(): AgentRunRepository {
    return {
      create: async (run: AgentRun) => {
        if (this.runs.has(run.id)) {
          throw new Error('AgentRun ID 已存在');
        }
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
          return {
            outcome: 'version_conflict' as const,
            actualVersion: current.version,
          };
        }
        if (
          candidate.status !== current.status
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
        const duplicate = [...this.steps.values()].some(
          (item) => item.runId === step.runId
            && item.key === step.key
            && item.attempt === step.attempt,
        );
        if (!this.runs.has(step.runId)) {
          throw new Error('RunStep 对应的 AgentRun 不存在');
        }
        if (this.steps.has(step.id) || duplicate) {
          throw new Error('RunStep 唯一键冲突');
        }
        this.steps.set(step.id, step);
      },
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
      getStepById: async (stepId: string) => this.steps.get(stepId) ?? null,
      getStepByKey: async (runId: string, key: string, attempt: number) =>
        [...this.steps.values()].find(
          (step) => step.runId === runId
            && step.key === key
            && step.attempt === attempt,
        ) ?? null,
      listSteps: async (runId: string) => [...this.steps.values()].filter(
        (step) => step.runId === runId,
      ),
      reserveToolCall: async (candidate: ToolCallRecord) => {
        if (!this.steps.has(candidate.stepId)) {
          throw new Error('ToolCall 对应的 RunStep 不存在');
        }
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
      getToolCallById: async (toolCallId: string) => this.toolCalls.get(toolCallId) ?? null,
      getToolCallByIdempotencyKey: async (runId: string, idempotencyKey: string) =>
        [...this.toolCalls.values()].find(
          (toolCall) => toolCall.runId === runId
            && toolCall.idempotencyKey === idempotencyKey,
        ) ?? null,
      listToolCalls: async (runId: string) => [...this.toolCalls.values()].filter(
        (toolCall) => toolCall.runId === runId,
      ),
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
      getPendingInterruptions: async (runId: string) => this.interruptions.filter(
        (interruption) => interruption.runId === runId
          && interruption.status === InterruptionStatus.PENDING,
      ),
    } as unknown as AgentRunRepository;
  }

  /** 返回指定 Run 的最新 Checkpoint。 */
  private latestCheckpoint(runId: string): Checkpoint | null {
    return this.checkpoints
      .filter((checkpoint) => checkpoint.runId === runId)
      .sort((left, right) => right.sequence - left.sequence)[0] ?? null;
  }

  /** 捕获事务开始前的全部可变状态。 */
  private snapshot(): RuntimeEvaluationSnapshot {
    return {
      runs: new Map(this.runs),
      steps: new Map(this.steps),
      toolCalls: new Map(this.toolCalls),
      checkpoints: [...this.checkpoints],
      interruptions: [...this.interruptions],
    };
  }

  /** 回滚到事务开始前的快照。 */
  private restore(snapshot: RuntimeEvaluationSnapshot): void {
    replaceMap(this.runs, snapshot.runs);
    replaceMap(this.steps, snapshot.steps);
    replaceMap(this.toolCalls, snapshot.toolCalls);
    this.checkpoints.splice(0, this.checkpoints.length, ...snapshot.checkpoints);
    this.interruptions.splice(0, this.interruptions.length, ...snapshot.interruptions);
  }
}

type RuntimeEvaluationSnapshot = {
  runs: Map<string, AgentRun>;
  steps: Map<string, RunStep>;
  toolCalls: Map<string, ToolCallRecord>;
  checkpoints: Checkpoint[];
  interruptions: Interruption[];
};

/** 用源 Map 的内容替换目标 Map。 */
function replaceMap<Key, Value>(target: Map<Key, Value>, source: Map<Key, Value>): void {
  target.clear();
  for (const [key, value] of source) {
    target.set(key, value);
  }
}
