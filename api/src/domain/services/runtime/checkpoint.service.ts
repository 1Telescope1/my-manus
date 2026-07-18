import {
  AgentRun,
  Checkpoint,
  createCheckpoint,
} from '../../models/agent-run';
import {
  AgentRunUpdateResult,
  CheckpointAppendResult,
} from '../../repositories/agent-run.repository';
import { UnitOfWork } from '../../repositories/unit-of-work';

/** 可恢复快照的运行边界。 */
export enum RuntimeCheckpointBoundary {
  ROUTE_COMPLETED = 'route_completed', // 路由决策已完成并持久化。
  MODEL_CALLING = 'model_calling', // 即将调用模型，尚未产生模型输出。
  MODEL_COMPLETED = 'model_completed', // 模型输出已完成并写入运行状态。
  STEP_STARTING = 'step_starting', // 即将开始执行一个 RunStep。
  STEP_COMPLETED = 'step_completed', // RunStep 已完成且结果已持久化。
  SIDE_EFFECT_SUBMITTING = 'side_effect_submitting', // 即将提交可能产生外部副作用的操作。
  TOOL_RESULT_PERSISTED = 'tool_result_persisted', // 工具结果已持久化，可在恢复时复用。
  ENTERING_WAIT = 'entering_wait', // Run 即将进入等待用户输入状态。
  ENTERING_PAUSE = 'entering_pause', // Run 即将进入暂停调度状态。
  HANDOFF_STARTING = 'handoff_starting', // 即将开始 Agent 所有权转交。
  HANDOFF_COMPLETED = 'handoff_completed', // Agent 所有权转交已经完成。
  ENTERING_TERMINAL = 'entering_terminal', // Run 即将进入不可继续执行的终态。
}

/** 提交一个运行边界时需要持久化的完整输入。 */
export type CommitRuntimeCheckpointInput = {
  run: AgentRun;
  expectedVersion: number;
  boundary: RuntimeCheckpointBoundary;
  resumeNode: string;
  nextEventSequence: number;
  state: Record<string, unknown>;
  checkpointId?: string;
  createdAt?: Date;
};

/** 原子提交成功后返回的新 Run 版本和 Checkpoint。 */
export type CommittedRuntimeCheckpoint = {
  run: AgentRun;
  checkpoint: Checkpoint;
};

/** Run CAS（乐观锁） 或 Checkpoint 追加冲突导致边界无法提交。 */
export class RuntimeCheckpointCommitError extends Error {
  /** 保存冲突发生阶段和仓储返回结果，便于调度器决定是否重试。 */
  constructor(
    readonly phase: 'run' | 'checkpoint',
    readonly result: AgentRunUpdateResult | CheckpointAppendResult,
  ) {
    super(`Runtime Checkpoint 提交失败：${phase}/${result.outcome}`);
    this.name = RuntimeCheckpointCommitError.name;
  }
}

/** 在同一 UnitOfWork 中提交 Run 游标和只追加 Checkpoint。 */
export class RuntimeCheckpointService {
  /** 接收 UoW 工厂，使服务同时适用于生产 Prisma 和测试仓储。 */
  constructor(private readonly uowFactory: () => UnitOfWork) {}

  /** 原子推进 Run 版本并追加指向精确下一节点的 Checkpoint。 */
  async commit(input: CommitRuntimeCheckpointInput): Promise<CommittedRuntimeCheckpoint> {
    return this.uowFactory().run(async (uow) => {
      const latest = await uow.agentRun.getLatestCheckpoint(input.run.id);
      const checkpoint = createCheckpoint({
        id: input.checkpointId,
        runId: input.run.id,
        sequence: latest ? latest.sequence + 1 : 0,
        resumeNode: input.resumeNode,
        nextEventSequence: input.nextEventSequence,
        state: {
          ...input.state,
          checkpointBoundary: input.boundary,
        },
        createdAt: input.createdAt,
      });

      // Run 游标与 version 先通过 CAS 推进；后续失败会由 UoW 回滚本次更新。
      const runResult = await uow.agentRun.update(
        { ...input.run, currentNode: input.resumeNode },
        input.expectedVersion,
      );
      if (runResult.outcome !== 'updated') {
        throw new RuntimeCheckpointCommitError('run', runResult);
      }

      const checkpointResult = await uow.agentRun.appendCheckpoint(checkpoint);
      if (checkpointResult.outcome !== 'appended') {
        throw new RuntimeCheckpointCommitError('checkpoint', checkpointResult);
      }

      return {
        run: runResult.run,
        checkpoint: checkpointResult.checkpoint,
      };
    });
  }
}
