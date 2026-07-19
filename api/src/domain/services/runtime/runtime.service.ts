import {
  AgentRun,
  CancellationOutcome,
  RouteKind,
  RunStatus,
  createAgentRun,
  isTerminalRunStatus,
  requestAgentRunCancellation,
  transitionAgentRun,
} from '../../models/agent-run';
import { Message } from '../../models/message';
import { RouteDecision } from '../../models/route-decision';
import { RuntimeEvent } from '../../models/runtime-event';
import { SessionStatus } from '../../models/session';
import { ToolSelectionConstraints } from '../../models/tool-selection';
import { UnitOfWork } from '../../repositories/unit-of-work';
import {
  RuntimeCheckpointBoundary,
  RuntimeCheckpointService,
} from './checkpoint.service';
import { RuntimeExecutorDispatcher } from './executor.service';
import { RuntimeRouterService } from './router.service';

/** Runtime 执行一次真实 Session 消息所需的输入。 */
export type RuntimeRequest = {
  sessionId: string;
  message: Message;
  toolSelection?: ToolSelectionConstraints;
  signal?: AbortSignal;
};

/** Runtime 协调器可注入的时钟和当前工具 capability catalog。 */
export type RuntimeServiceOptions = {
  clock?: () => Date;
  availableToolCapabilities?: () => readonly string[];
};

/** 串联 Router、AgentRun/Checkpoint 和多路径执行器的运行协调器。 */
export class RuntimeService {
  private readonly checkpointService: RuntimeCheckpointService;
  private readonly clock: () => Date;
  private readonly availableToolCapabilities: () => readonly string[];
  private activeRun?: AgentRun;

  /** 注入事务边界、路由器、执行器集合和可测试时钟。 */
  constructor(
    private readonly uowFactory: () => UnitOfWork,
    private readonly router: RuntimeRouterService,
    private readonly dispatcher: RuntimeExecutorDispatcher,
    options: RuntimeServiceOptions | (() => Date) = {},
  ) {
    // 兼容 RUNTIME-105 期间公开的第四参数 clock 函数签名。
    const normalizedOptions = typeof options === 'function' ? { clock: options } : options;
    this.checkpointService = new RuntimeCheckpointService(this.uowFactory);
    this.clock = normalizedOptions.clock ?? (() => new Date());
    this.availableToolCapabilities = normalizedOptions.availableToolCapabilities ?? (() => []);
  }

  /** 为一条用户消息创建持久化 Run，并流式返回统一 Runtime Event。 */
  async *execute(request: RuntimeRequest): AsyncIterable<RuntimeEvent> {
    const routed = await this.router.route({
      message: request.message.message,
      availableCapabilities: [...this.availableToolCapabilities()],
    }, request.signal);
    const decision = executableDecision(routed);
    let run = createAgentRun({
      sessionId: request.sessionId,
      route: decision.route,
      metadata: {
        routeReason: decision.reason,
        requiredCapabilities: [...decision.requiredCapabilities],
        requestedSkills: [...decision.requestedSkills],
      },
    });

    await this.withUow((uow) => uow.agentRun.create(run));
    this.activeRun = run;

    try {
      run = await this.updateStatus(run, RunStatus.RUNNING);
      this.activeRun = run;
      const routeCheckpoint = await this.checkpointService.commit({
        run,
        expectedVersion: run.version,
        boundary: RuntimeCheckpointBoundary.ROUTE_COMPLETED,
        resumeNode: `executor.${decision.route}.start`,
        nextEventSequence: 0,
        state: { decision },
      });
      run = routeCheckpoint.run;
      this.activeRun = run;

      // Planned Agent Flow 会自行处理 PENDING/WAITING/RUNNING 语义。
      if (decision.route !== RouteKind.PLANNED_AGENT) {
        await this.withUow((uow) =>
          uow.session.updateStatus(request.sessionId, SessionStatus.RUNNING),
        );
      }

      for await (const runtimeEvent of this.dispatcher.dispatch({
        run,
        decision,
        message: request.message.message,
        nextEventSequence: routeCheckpoint.checkpoint.nextEventSequence,
        privateContext: { attachments: [...request.message.attachments] },
        toolSelection: request.toolSelection,
        signal: request.signal,
      })) {
        if (runtimeEvent.type === 'run.cancelled') {
          run = await this.ensureCancellationRequested(run);
        }
        const stopped = await this.persistStopBoundary(run, runtimeEvent);
        run = stopped.run;
        this.activeRun = run;
        yield stopped.event;
      }
    } catch (error) {
      if (!isTerminalRunStatus(run.status) && !request.signal?.aborted) {
        await this.markFailed(run, error);
      }
      throw error;
    } finally {
      if (this.activeRun?.id === run.id) {
        this.activeRun = undefined;
      }
    }
  }

  /** 在根 AbortController 触发前原子记录当前活动 Run 的首次取消请求。 */
  async requestCancellation(): Promise<void> {
    if (!this.activeRun || isTerminalRunStatus(this.activeRun.status)) {
      return;
    }
    this.activeRun = await this.ensureCancellationRequested(this.activeRun);
  }

  /** 在一个 UnitOfWork 中执行运行仓储操作。 */
  private withUow<T>(handler: (uow: UnitOfWork) => Promise<T>): Promise<T> {
    return this.uowFactory().run(handler);
  }

  /** 使用领域状态机和仓储 CAS 推进 Run 状态。 */
  private async updateStatus(
    run: AgentRun,
    status: Exclude<RunStatus, RunStatus.FAILED | RunStatus.CANCELLED>,
  ): Promise<AgentRun> {
    const candidate = transitionAgentRun(run, { status, at: this.clock() });
    const result = await this.withUow((uow) => uow.agentRun.update(candidate, run.version));
    if (result.outcome !== 'updated') {
      throw new Error(`AgentRun 状态更新失败：${result.outcome}`);
    }
    return result.run;
  }

  /** 幂等写入 cancelRequestedAt，并在并发更新后重新读取当前 Run。 */
  private async ensureCancellationRequested(run: AgentRun): Promise<AgentRun> {
    const current = await this.withUow((uow) => uow.agentRun.getById(run.id)) ?? run;
    if (current.cancelRequestedAt || isTerminalRunStatus(current.status)) {
      return current;
    }
    const candidate = requestAgentRunCancellation(current, this.clock());
    const result = await this.withUow((uow) => uow.agentRun.update(candidate, current.version));
    if (result.outcome === 'updated') {
      return result.run;
    }
    if (result.outcome === 'version_conflict') {
      const refreshed = await this.withUow((uow) => uow.agentRun.getById(run.id));
      if (refreshed?.cancelRequestedAt) {
        return refreshed;
      }
    }
    throw new Error(`AgentRun 取消请求更新失败：${result.outcome}`);
  }

  /** 在停止事件对外可见前写 Checkpoint 并持久化对应 Run 状态。 */
  private async persistStopBoundary(
    run: AgentRun,
    event: RuntimeEvent,
  ): Promise<{ run: AgentRun; event: RuntimeEvent }> {
    const status = runtimeStopStatus(event);
    if (!status) {
      return { run, event };
    }
    const committed = await this.checkpointService.commit({
      run,
      expectedVersion: run.version,
      boundary: status === RunStatus.WAITING
        ? RuntimeCheckpointBoundary.ENTERING_WAIT
        : RuntimeCheckpointBoundary.ENTERING_TERMINAL,
      resumeNode: status === RunStatus.WAITING
        ? `executor.${run.route}.resume_after_input`
        : `terminal.${status}`,
      nextEventSequence: event.sequence + 1,
      state: { lastEventType: event.type },
    });
    const nextRun = status === RunStatus.FAILED
      ? await this.updateFailedStatus(
        committed.run,
        event.type === 'run.failed' ? event.error : 'Runtime 执行失败',
      )
      : status === RunStatus.CANCELLED
        ? await this.updateCancelledStatus(committed.run)
        : await this.updateStatus(committed.run, status);
    return {
      run: nextRun,
      event: { ...event, checkpointId: committed.checkpoint.id },
    };
  }

  /** 将执行或协调异常尽力记录为 failed，原异常仍交给上层兼容错误流。 */
  private async markFailed(run: AgentRun, error: unknown): Promise<void> {
    if (run.status !== RunStatus.RUNNING) {
      return;
    }
    await this.updateFailedStatus(run, errorMessage(error));
  }

  /** 持久化必须携带错误文本的 failed 终态。 */
  private async updateFailedStatus(run: AgentRun, error: string): Promise<AgentRun> {
    const candidate = transitionAgentRun(run, {
      status: RunStatus.FAILED,
      at: this.clock(),
      error,
    });
    const result = await this.withUow((uow) => uow.agentRun.update(candidate, run.version));
    if (result.outcome !== 'updated') {
      throw new Error(`AgentRun 失败状态更新失败：${result.outcome}`);
    }
    return result.run;
  }

  /** 在活动执行链已退出后把已请求取消的 Run 收敛到 confirmed 终态。 */
  private async updateCancelledStatus(run: AgentRun): Promise<AgentRun> {
    const candidate = transitionAgentRun(run, {
      status: RunStatus.CANCELLED,
      at: this.clock(),
      cancellation: { outcome: CancellationOutcome.CONFIRMED },
    });
    const result = await this.withUow((uow) => uow.agentRun.update(candidate, run.version));
    if (result.outcome !== 'updated') {
      throw new Error(`AgentRun 取消状态更新失败：${result.outcome}`);
    }
    return result.run;
  }
}

/** Workflow Registry 尚未接入时将 Workflow 决策降级到可工作的 Planned Agent。 */
function executableDecision(decision: RouteDecision): RouteDecision {
  if (decision.route !== RouteKind.WORKFLOW) {
    return decision;
  }
  const { workflowName: _workflowName, ...withoutWorkflow } = decision;
  return {
    ...withoutWorkflow,
    route: RouteKind.PLANNED_AGENT,
    reason: `${decision.reason}；Workflow 尚未注册，回退到 planned_agent`,
  };
}

type RuntimeStopStatus =
  | RunStatus.WAITING
  | RunStatus.FAILED
  | RunStatus.COMPLETED
  | RunStatus.CANCELLED;

/** 把 Runtime 停止事件映射为需要持久化的 Run 状态。 */
function runtimeStopStatus(event: RuntimeEvent): RuntimeStopStatus | null {
  switch (event.type) {
    case 'run.waiting':
      return RunStatus.WAITING;
    case 'run.failed':
      return RunStatus.FAILED;
    case 'run.completed':
      return RunStatus.COMPLETED;
    case 'run.cancelled':
      return RunStatus.CANCELLED;
    default:
      return null;
  }
}

/** 将未知异常转换为可持久化的非空错误文本。 */
function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() || 'Runtime 执行失败';
}
