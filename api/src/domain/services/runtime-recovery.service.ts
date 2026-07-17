import {
  AgentRun,
  Checkpoint,
  Interruption,
  InterruptionKind,
  RunStatus,
  ToolCallRecord,
  ToolCallStatus,
  ToolRisk,
  isTerminalRunStatus,
} from '../models/agent-run';
import { UnitOfWork } from '../repositories/unit-of-work';

/** 恢复解析器交给运行调度器的下一步动作。 */
export enum RuntimeRecoveryDisposition {
  RESUME = 'resume', // 从 Checkpoint 指定的节点继续调度。
  WAIT = 'wait', // 保持等待，直到用户补充所需输入。
  PAUSE = 'pause', // 暂停调度，等待审批或人工处理风险。
  TERMINAL = 'terminal', // Run 已进入终态，无需继续恢复。
  NO_CHECKPOINT = 'no_checkpoint', // 缺少恢复快照，无法执行普通恢复。
}

/** 恢复动作的稳定机器可读原因。 */
export enum RuntimeRecoveryReason {
  CHECKPOINT_AVAILABLE = 'checkpoint_available', // 已找到有效 Checkpoint，可以继续执行。
  USER_INPUT_PENDING = 'user_input_pending', // 存在尚未处理的用户输入请求。
  APPROVAL_PENDING = 'approval_pending', // 存在尚未处理的操作审批请求。
  UNCERTAIN_SIDE_EFFECT = 'uncertain_side_effect', // 无法确认外部副作用是否已经发生。
  RUN_TERMINAL = 'run_terminal', // Run 已处于 completed、failed 或 cancelled 终态。
  RUN_WAITING = 'run_waiting', // Run 当前处于等待用户输入状态。
  RUN_PAUSED = 'run_paused', // Run 当前处于暂停状态。
  CHECKPOINT_MISSING = 'checkpoint_missing', // 没有可用于恢复的持久化 Checkpoint。
}

/** 从持久化状态重建出的完整恢复计划。 */
export type RuntimeRecoveryPlan = {
  disposition: RuntimeRecoveryDisposition;
  reason: RuntimeRecoveryReason;
  run: AgentRun;
  checkpoint: Checkpoint | null;
  resumeNode: string | null;
  nextEventSequence: number;
  state: Readonly<Record<string, unknown>>;
  reusableToolCalls: ToolCallRecord[];
  retryableToolCalls: ToolCallRecord[];
  unresolvedToolCalls: ToolCallRecord[];
  pendingInterruptions: Interruption[];
};

/** 读取运行聚合并把崩溃现场解析为可执行的恢复决策。 */
export class RuntimeRecoveryService {
  /** 接收 UoW 工厂，使一次恢复读取共享相同的数据访问边界。 */
  constructor(private readonly uowFactory: () => UnitOfWork) {}

  /** 返回指定 Run 的恢复计划；Run 不存在时返回 null。 */
  async resolve(runId: string): Promise<RuntimeRecoveryPlan | null> {
    return this.uowFactory().run(async (uow) => {
      // 先确认聚合根仍然存在；不存在的 Run 没有可恢复的运行现场。
      const run = await uow.agentRun.getById(runId);
      if (!run) {
        return null;
      }

      // 终态必须最先短路，防止后续 Checkpoint 或工具记录让它重新进入调度。
      if (isTerminalRunStatus(run.status)) {
        return createPlan({
          disposition: RuntimeRecoveryDisposition.TERMINAL,
          reason: RuntimeRecoveryReason.RUN_TERMINAL,
          run,
        });
      }

      // 汇总恢复所需的持久化现场，后续只基于这些记录生成确定性决策。
      const checkpoint = await uow.agentRun.getLatestCheckpoint(runId);
      const incompleteToolCalls = await uow.agentRun.getIncompleteToolCalls(runId);
      const allToolCalls = await uow.agentRun.listToolCalls(runId);
      const pendingInterruptions = await uow.agentRun.getPendingInterruptions(runId);

      // 将工具调用分为结果复用、安全重试和必须人工确认三类，避免恢复时重复副作用。
      const reusableToolCalls = allToolCalls.filter(
        (toolCall) => toolCall.status === ToolCallStatus.COMPLETED,
      );
      const unresolvedToolCalls = incompleteToolCalls.filter(requiresResolution);
      const retryableToolCalls = incompleteToolCalls.filter(isSafeToRetry);

      // 不确定副作用的风险最高，必须优先于审批、等待和普通 Checkpoint 恢复。
      if (unresolvedToolCalls.length > 0) {
        return createPlan({
          disposition: RuntimeRecoveryDisposition.PAUSE,
          reason: RuntimeRecoveryReason.UNCERTAIN_SIDE_EFFECT,
          run,
          checkpoint,
          reusableToolCalls,
          retryableToolCalls,
          unresolvedToolCalls,
          pendingInterruptions,
        });
      }

      // 明确的中断记录比 Run 状态提供更具体的原因，审批优先进入受控暂停。
      if (pendingInterruptions.some(
        (interruption) => interruption.kind === InterruptionKind.APPROVAL,
      )) {
        return createPlan({
          disposition: RuntimeRecoveryDisposition.PAUSE,
          reason: RuntimeRecoveryReason.APPROVAL_PENDING,
          run,
          checkpoint,
          reusableToolCalls,
          retryableToolCalls,
          pendingInterruptions,
        });
      }

      // 用户输入尚未补齐时保持等待，不能越过中断继续执行后续节点。
      if (pendingInterruptions.some(
        (interruption) => interruption.kind === InterruptionKind.USER_INPUT,
      )) {
        return createPlan({
          disposition: RuntimeRecoveryDisposition.WAIT,
          reason: RuntimeRecoveryReason.USER_INPUT_PENDING,
          run,
          checkpoint,
          reusableToolCalls,
          retryableToolCalls,
          pendingInterruptions,
        });
      }

      // 没有待处理中断时，仍需尊重 Run 自身已持久化的暂停或等待状态。
      if (run.status === RunStatus.PAUSED) {
        return createPlan({
          disposition: RuntimeRecoveryDisposition.PAUSE,
          reason: RuntimeRecoveryReason.RUN_PAUSED,
          run,
          checkpoint,
          reusableToolCalls,
          retryableToolCalls,
          pendingInterruptions,
        });
      }

      if (run.status === RunStatus.WAITING) {
        return createPlan({
          disposition: RuntimeRecoveryDisposition.WAIT,
          reason: RuntimeRecoveryReason.RUN_WAITING,
          run,
          checkpoint,
          reusableToolCalls,
          retryableToolCalls,
          pendingInterruptions,
        });
      }

      // 可运行的 Run 如果没有 Checkpoint，就没有可信的恢复节点，不能猜测执行位置。
      if (!checkpoint) {
        return createPlan({
          disposition: RuntimeRecoveryDisposition.NO_CHECKPOINT,
          reason: RuntimeRecoveryReason.CHECKPOINT_MISSING,
          run,
          reusableToolCalls,
          retryableToolCalls,
          pendingInterruptions,
        });
      }

      // 通过全部安全检查后，才允许从最新 Checkpoint 的精确下一节点恢复。
      return createPlan({
        disposition: RuntimeRecoveryDisposition.RESUME,
        reason: RuntimeRecoveryReason.CHECKPOINT_AVAILABLE,
        run,
        checkpoint,
        reusableToolCalls,
        retryableToolCalls,
        pendingInterruptions,
      });
    });
  }
}

/** running/unknown 的有副作用调用必须先确认外部结果，不能直接重放。 */
function requiresResolution(toolCall: ToolCallRecord): boolean {
  return toolCall.risk !== ToolRisk.READ
    && [ToolCallStatus.RUNNING, ToolCallStatus.UNKNOWN].includes(toolCall.status);
}

/** 尚未提交的调用和 running/unknown 的只读调用可以从原工具节点安全重试。 */
function isSafeToRetry(toolCall: ToolCallRecord): boolean {
  return toolCall.status === ToolCallStatus.PENDING
    || (
      toolCall.risk === ToolRisk.READ
      && [ToolCallStatus.RUNNING, ToolCallStatus.UNKNOWN].includes(toolCall.status)
    );
}

type CreatePlanInput = Pick<
  RuntimeRecoveryPlan,
  'disposition' | 'reason' | 'run'
> & Partial<Pick<
  RuntimeRecoveryPlan,
  | 'checkpoint'
  | 'reusableToolCalls'
  | 'retryableToolCalls'
  | 'unresolvedToolCalls'
  | 'pendingInterruptions'
>>;

/** 用统一默认值组装恢复计划，并从 Checkpoint 恢复游标和状态。 */
function createPlan(input: CreatePlanInput): RuntimeRecoveryPlan {
  const checkpoint = input.checkpoint ?? null;
  return {
    disposition: input.disposition,
    reason: input.reason,
    run: input.run,
    checkpoint,
    resumeNode: checkpoint?.resumeNode ?? null,
    nextEventSequence: checkpoint?.nextEventSequence ?? 0,
    state: checkpoint?.state ?? {},
    reusableToolCalls: input.reusableToolCalls ?? [],
    retryableToolCalls: input.retryableToolCalls ?? [],
    unresolvedToolCalls: input.unresolvedToolCalls ?? [],
    pendingInterruptions: input.pendingInterruptions ?? [],
  };
}
