import { createHash, randomUUID } from 'node:crypto';
import {
  RunStep,
  RunStepKind,
  RunStepStatus,
  ToolCallRecord,
  ToolCallStatus,
  ToolRisk as RunToolRisk,
  createRunStep,
  createToolCallRecord,
} from '../../models/agent-run';
import {
  ToolIdempotencyExecutionInput,
  ToolIdempotencyReservation,
  ToolIdempotencyReservationInput,
  ToolIdempotencyStore,
} from '../../models/tool-invocation';
import { ToolRisk } from '../../models/tool';
import { ToolResult } from '../../models/tool-result';
import { UnitOfWork } from '../../repositories/unit-of-work';

/** 使用 AgentRun 仓储保存工具占用、执行状态和结果，支持跨进程幂等恢复。 */
export class PersistentToolIdempotencyStore implements ToolIdempotencyStore {
  private readonly activeReservations = new Set<string>();

  /** 注入事务边界和可测试时钟。 */
  constructor(
    private readonly uowFactory: () => UnitOfWork,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** 原子创建 pending ToolCallRecord，或按持久化状态决定复用、等待和暂停。 */
  async reserve(
    input: ToolIdempotencyReservationInput,
  ): Promise<ToolIdempotencyReservation> {
    const stepId = input.stepId ?? await this.ensureToolStep(input);
    const key = activeKey(input.scopeId, input.idempotencyKey);
    const candidate = createToolCallRecord({
      id: input.toolCallId ?? randomUUID(),
      runId: input.scopeId,
      stepId,
      toolName: input.functionName,
      arguments: structuredClone(input.arguments),
      risk: toRunToolRisk(input.risk),
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
    });
    const reservation = await this.uowFactory().run((uow) =>
      uow.agentRun.reserveToolCall(candidate),
    );

    if (reservation.outcome === 'key_conflict') {
      return { outcome: 'conflict' };
    }
    if (reservation.outcome === 'reserved') {
      this.activeReservations.add(key);
      return { outcome: 'reserved' };
    }

    const existing = reservation.toolCall;
    if (
      this.activeReservations.has(key)
      && [
        ToolCallStatus.PENDING,
        ToolCallStatus.RUNNING,
        ToolCallStatus.UNKNOWN,
      ].includes(existing.status)
    ) {
      return { outcome: 'in_progress' };
    }
    if (existing.status === ToolCallStatus.PENDING) {
      // 新进程没有本地占用，pending 表示外部请求尚未提交，可以安全接管。
      this.activeReservations.add(key);
      return { outcome: 'reserved' };
    }
    if (
      existing.risk === RunToolRisk.READ
      && [ToolCallStatus.RUNNING, ToolCallStatus.UNKNOWN].includes(existing.status)
    ) {
      // 只读调用没有外部写入风险；新进程可把未完成记录重新打开后安全重试。
      const reopened: ToolCallRecord = {
        ...existing,
        status: ToolCallStatus.PENDING,
        result: null,
        startedAt: null,
        completedAt: null,
      };
      const update = await this.uowFactory().run((uow) =>
        uow.agentRun.updateToolCall(reopened, existing.status),
      );
      if (update.outcome !== 'updated') {
        return { outcome: 'in_progress' };
      }
      this.activeReservations.add(key);
      return { outcome: 'reserved' };
    }
    if (
      existing.risk !== RunToolRisk.READ
      && [ToolCallStatus.RUNNING, ToolCallStatus.UNKNOWN].includes(existing.status)
    ) {
      return { outcome: 'unresolved' };
    }
    if (isReplayable(existing.status)) {
      const result = asToolResult(existing.result);
      return result
        ? { outcome: 'existing', result }
        : { outcome: 'unresolved' };
    }
    return { outcome: 'in_progress' };
  }

  /** 在外部请求提交前把 pending 记录推进到 running。 */
  async start(input: ToolIdempotencyExecutionInput): Promise<void> {
    const record = await this.getRecord(input);
    if (record.status !== ToolCallStatus.PENDING) {
      throw new Error(`ToolCall 不能从 ${record.status} 开始执行`);
    }
    const candidate: ToolCallRecord = {
      ...record,
      status: ToolCallStatus.RUNNING,
      startedAt: record.startedAt ?? this.clock(),
    };
    const result = await this.uowFactory().run(async (uow) => {
      const step = await uow.agentRun.getStepById(record.stepId);
      if (!step) {
        throw new Error('持久化 ToolCallRecord 对应的 RunStep 不存在');
      }
      if (step.status === RunStepStatus.PENDING) {
        const stepUpdate = await uow.agentRun.updateStep(
          { ...step, status: RunStepStatus.RUNNING },
          RunStepStatus.PENDING,
        );
        if (stepUpdate.outcome !== 'updated') {
          throw new Error(`RunStep 开始状态更新失败：${stepUpdate.outcome}`);
        }
      } else if (step.status !== RunStepStatus.RUNNING) {
        throw new Error(`RunStep 不能从 ${step.status} 开始执行`);
      }
      return uow.agentRun.updateToolCall(candidate, ToolCallStatus.PENDING);
    });
    if (result.outcome !== 'updated') {
      throw new Error(`ToolCall 开始状态更新失败：${result.outcome}`);
    }
  }

  /** 保存调用终态；超时、取消或不明确执行错误的副作用调用转为 unknown。 */
  async complete(input: ToolIdempotencyExecutionInput & {
    result: ToolResult;
    risk: ToolRisk;
  }): Promise<void> {
    const record = await this.getRecord(input);
    const status = completionStatus(input.result, input.risk);
    const candidate: ToolCallRecord = {
      ...record,
      status,
      result: structuredClone(input.result),
      completedAt: status === ToolCallStatus.UNKNOWN ? null : this.clock(),
    };
    const update = await this.uowFactory().run(async (uow) => {
      const toolCallUpdate = await uow.agentRun.updateToolCall(
        candidate,
        ToolCallStatus.RUNNING,
      );
      if (toolCallUpdate.outcome !== 'updated') {
        return toolCallUpdate;
      }

      // unknown 保留 running Step 作为“外部提交后未确认”的恢复现场。
      if (status !== ToolCallStatus.UNKNOWN) {
        const step = await uow.agentRun.getStepById(record.stepId);
        if (!step) {
          throw new Error('持久化 ToolCallRecord 对应的 RunStep 不存在');
        }
        if (step.status === RunStepStatus.RUNNING) {
          const stepCandidate = finishStep(step, status, input.result);
          const stepUpdate = await uow.agentRun.updateStep(
            stepCandidate,
            RunStepStatus.RUNNING,
          );
          if (stepUpdate.outcome !== 'updated') {
            throw new Error(`RunStep 结果状态更新失败：${stepUpdate.outcome}`);
          }
        }
      }
      return toolCallUpdate;
    });
    if (update.outcome !== 'updated') {
      throw new Error(`ToolCall 结果状态更新失败：${update.outcome}`);
    }
    this.activeReservations.delete(activeKey(input.scopeId, input.idempotencyKey));
  }

  /** 为未显式传入 Step 的真实工具调用建立稳定、可恢复的 TOOL Step。 */
  private async ensureToolStep(input: ToolIdempotencyReservationInput): Promise<string> {
    const key = toolStepKey(input.scopeId, input.idempotencyKey);
    const existing = await this.uowFactory().run((uow) =>
      uow.agentRun.getStepByKey(input.scopeId, key, 1),
    );
    if (existing) {
      return existing.id;
    }

    const step = createRunStep({
      runId: input.scopeId,
      key,
      kind: RunStepKind.TOOL,
      input: {
        functionName: input.functionName,
        arguments: structuredClone(input.arguments),
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
      },
    });
    try {
      await this.uowFactory().run((uow) => uow.agentRun.createStep(step));
      return step.id;
    } catch (error) {
      // 并发进程可能同时观察到 Step 不存在；唯一键竞争后复用胜者。
      const winner = await this.uowFactory().run((uow) =>
        uow.agentRun.getStepByKey(input.scopeId, key, 1),
      );
      if (winner) {
        return winner.id;
      }
      throw error;
    }
  }

  /** 按 Run 和幂等键读取记录，并再次校验请求指纹。 */
  private async getRecord(input: ToolIdempotencyExecutionInput): Promise<ToolCallRecord> {
    const record = await this.uowFactory().run((uow) =>
      uow.agentRun.getToolCallByIdempotencyKey(input.scopeId, input.idempotencyKey),
    );
    if (!record) {
      throw new Error('持久化 ToolCallRecord 不存在');
    }
    if (record.requestFingerprint !== input.requestFingerprint) {
      throw new Error('持久化 ToolCallRecord 请求指纹不一致');
    }
    return record;
  }
}

/** 以 Run 和幂等键的摘要生成不含用户输入的稳定 Step key。 */
function toolStepKey(runId: string, idempotencyKey: string): string {
  const digest = createHash('sha256')
    .update(runId)
    .update('\0')
    .update(idempotencyKey)
    .digest('hex');
  return `tool:${digest}`;
}

/** 让 RunStep 与工具终态保持一致，同时保留完整结果用于诊断。 */
function finishStep(
  step: RunStep,
  toolStatus: ToolCallStatus,
  result: ToolResult,
): RunStep {
  if (toolStatus === ToolCallStatus.COMPLETED) {
    return { ...step, status: RunStepStatus.COMPLETED, output: structuredClone(result) };
  }
  if (toolStatus === ToolCallStatus.CANCELLED) {
    return {
      ...step,
      status: RunStepStatus.CANCELLED,
      error: result.error?.message ?? result.message ?? '工具调用已取消',
    };
  }
  return {
    ...step,
    status: RunStepStatus.FAILED,
    error: result.error?.message ?? result.message ?? '工具调用失败',
  };
}

/** 将 Registry 风险联合类型转换为运行聚合枚举。 */
function toRunToolRisk(risk: ToolRisk): RunToolRisk {
  return risk as unknown as RunToolRisk;
}

/** 判断持久化终态是否可直接复用其完整 ToolResult。 */
function isReplayable(status: ToolCallStatus): boolean {
  return [
    ToolCallStatus.COMPLETED,
    ToolCallStatus.FAILED,
    ToolCallStatus.CANCELLED,
  ].includes(status);
}

/** 校验 JSON 结果仍符合 ToolResult 的最小结构。 */
function asToolResult(value: unknown): ToolResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const result = value as Record<string, unknown>;
  return typeof result.success === 'boolean'
    ? structuredClone(result) as ToolResult
    : null;
}

/** 按风险和结果确定 ToolCall 终态，未知副作用保持不可重放。 */
function completionStatus(result: ToolResult, risk: ToolRisk): ToolCallStatus {
  if (result.success) {
    return ToolCallStatus.COMPLETED;
  }
  const uncertain = risk !== 'read' && (
    ['timeout', 'cancelled'].includes(result.error?.code ?? '')
    || result.error?.retryable === true
  );
  if (uncertain) {
    return ToolCallStatus.UNKNOWN;
  }
  return result.error?.code === 'cancelled'
    ? ToolCallStatus.CANCELLED
    : ToolCallStatus.FAILED;
}

/** 组合 Run 与幂等键，隔离不同执行作用域的本地占用。 */
function activeKey(runId: string, idempotencyKey: string): string {
  return `${runId.length}:${runId}${idempotencyKey}`;
}
