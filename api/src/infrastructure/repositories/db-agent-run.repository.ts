import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isDeepStrictEqual } from 'node:util';
import {
  AgentRun,
  canTransitionRunStatus,
  Checkpoint,
  Interruption,
  InterruptionStatus,
  RunStep,
  RunStepStatus,
  ToolCallRecord,
  ToolCallStatus,
} from '../../domain/models/agent-run';
import {
  AgentRunRepository,
  AgentRunUpdateResult,
  CheckpointAppendResult,
  ConditionalStatusUpdateResult,
  ToolCallReservationResult,
} from '../../domain/repositories/agent-run.repository';
import {
  agentRunToPersistence,
  agentRunUpdateToPersistence,
  checkpointToPersistence,
  interruptionToPersistence,
  interruptionUpdateToPersistence,
  persistenceToAgentRun,
  persistenceToCheckpoint,
  persistenceToInterruption,
  persistenceToRunStep,
  persistenceToToolCall,
  runStepToPersistence,
  runStepUpdateToPersistence,
  toolCallToPersistence,
  toolCallUpdateToPersistence,
} from '../prisma/agent-run.mapper';
import { PrismaService } from '../prisma/prisma.service';

/** 仓储在根连接和事务连接中共同依赖的最小 Prisma 接口。 */
type RuntimePrismaClient = Pick<
  Prisma.TransactionClient,
  'agentRun' | 'runStep' | 'toolCallRecord' | 'checkpoint' | 'interruption'
>;

/** 使用 Prisma 实现运行聚合持久化、条件更新和恢复查询。 */
@Injectable()
export class DbAgentRunRepository extends AgentRunRepository {
  /** 接受根 PrismaService 或 UnitOfWork 内的事务客户端。 */
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService | Prisma.TransactionClient,
  ) {
    super();
  }

  /** 将两种客户端收窄为仓储实际使用的运行表接口。 */
  private get client(): RuntimePrismaClient {
    return this.prisma as unknown as RuntimePrismaClient;
  }

  /** 创建初始 AgentRun；重复主键或不存在的 Session 由数据库拒绝。 */
  async create(run: AgentRun): Promise<void> {
    await this.client.agentRun.create({
      data: agentRunToPersistence(run),
    });
  }

  /** 按主键读取并校验 AgentRun。 */
  async getById(runId: string): Promise<AgentRun | null> {
    const record = await this.client.agentRun.findUnique({ where: { id: runId } });
    return record ? persistenceToAgentRun(record) : null;
  }

  /** 按稳定顺序返回指定 Session 的全部 AgentRun。 */
  async listBySessionId(sessionId: string): Promise<AgentRun[]> {
    const records = await this.client.agentRun.findMany({
      where: { sessionId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return records.map(persistenceToAgentRun);
  }

  /** 使用 expectedVersion 执行 AgentRun 乐观锁更新并原子递增版本。 */
  async update(run: AgentRun, expectedVersion: number): Promise<AgentRunUpdateResult> {
    // 先读取当前快照，用于区分不存在、调用方版本错误和非法状态转换。
    const currentRecord = await this.client.agentRun.findUnique({ where: { id: run.id } });
    if (!currentRecord) {
      return { outcome: 'not_found' };
    }

    const current = persistenceToAgentRun(currentRecord);
    if (current.version !== expectedVersion || run.version !== expectedVersion) {
      return { outcome: 'version_conflict', actualVersion: current.version };
    }
    if (current.sessionId !== run.sessionId) {
      return { outcome: 'not_found' };
    }
    if (
      current.status !== run.status
      && !canTransitionRunStatus(current.status, run.status)
    ) {
      return {
        outcome: 'invalid_status_transition',
        from: current.status,
        to: run.status,
      };
    }

    // 最终写入匹配版本；并发写者最多只有一个能命中该条件。
    const result = await this.client.agentRun.updateMany({
      where: {
        id: run.id,
        version: expectedVersion,
      },
      data: {
        ...agentRunUpdateToPersistence(run),
        version: { increment: 1 },
      },
    });
    if (result.count === 1) {
      return {
        outcome: 'updated',
        run: { ...run, version: expectedVersion + 1 },
      };
    }

    // 条件更新未命中说明预读后发生了竞争，再读一次以返回精确冲突结果。
    const latest = await this.client.agentRun.findUnique({ where: { id: run.id } });
    return latest
      ? { outcome: 'version_conflict', actualVersion: latest.version }
      : { outcome: 'not_found' };
  }

  /** 创建一次 RunStep 尝试记录。 */
  async createStep(step: RunStep): Promise<void> {
    await this.client.runStep.create({ data: runStepToPersistence(step) });
  }

  /** 仅在状态仍等于 expectedStatus 时更新 RunStep。 */
  async updateStep(
    step: RunStep,
    expectedStatus: RunStepStatus,
  ): Promise<ConditionalStatusUpdateResult<RunStep, RunStepStatus>> {
    // 状态进入 WHERE 条件，迟到的执行结果不会覆盖较新的步骤状态。
    const result = await this.client.runStep.updateMany({
      where: { id: step.id, runId: step.runId, status: expectedStatus },
      data: runStepUpdateToPersistence(step),
    });
    if (result.count === 1) {
      return { outcome: 'updated', entity: step };
    }

    const current = await this.client.runStep.findUnique({ where: { id: step.id } });
    if (!current || current.runId !== step.runId) {
      return { outcome: 'not_found' };
    }
    return {
      outcome: 'status_conflict',
      actualStatus: persistenceToRunStep(current).status,
    };
  }

  /** 按主键读取 RunStep。 */
  async getStepById(stepId: string): Promise<RunStep | null> {
    const record = await this.client.runStep.findUnique({ where: { id: stepId } });
    return record ? persistenceToRunStep(record) : null;
  }

  /** 按 Run 内逻辑键和尝试次数读取唯一 RunStep。 */
  async getStepByKey(
    runId: string,
    key: string,
    attempt: number,
  ): Promise<RunStep | null> {
    const record = await this.client.runStep.findUnique({
      where: { runId_key_attempt: { runId, key, attempt } },
    });
    return record ? persistenceToRunStep(record) : null;
  }

  /** 按稳定顺序返回 Run 的全部步骤尝试。 */
  async listSteps(runId: string): Promise<RunStep[]> {
    const records = await this.client.runStep.findMany({
      where: { runId },
      orderBy: [{ createdAt: 'asc' }, { attempt: 'asc' }, { id: 'asc' }],
    });
    return records.map(persistenceToRunStep);
  }

  /** 原子占用工具幂等键，并区分合法重试与请求身份冲突。 */
  async reserveToolCall(toolCall: ToolCallRecord): Promise<ToolCallReservationResult> {
    // skipDuplicates 让唯一键竞争返回 count=0，避免 PostgreSQL 事务被异常中止。
    const inserted = await this.client.toolCallRecord.createMany({
      data: toolCallToPersistence(toolCall),
      skipDuplicates: true,
    });
    if (inserted.count === 1) {
      return { outcome: 'reserved', toolCall };
    }

    // 未插入时必须读取唯一键所有者，再通过请求指纹判断能否安全复用。
    const existingRecord = await this.client.toolCallRecord.findUnique({
      where: {
        runId_idempotencyKey: {
          runId: toolCall.runId,
          idempotencyKey: toolCall.idempotencyKey,
        },
      },
    });
    if (!existingRecord) {
      throw new Error('ToolCall 幂等键占用失败');
    }

    const existingToolCall = persistenceToToolCall(existingRecord);
    return existingToolCall.requestFingerprint === toolCall.requestFingerprint
      ? { outcome: 'existing', toolCall: existingToolCall }
      : { outcome: 'key_conflict', existingToolCall };
  }

  /** 仅在状态仍等于 expectedStatus 时更新工具执行结果。 */
  async updateToolCall(
    toolCall: ToolCallRecord,
    expectedStatus: ToolCallStatus,
  ): Promise<ConditionalStatusUpdateResult<ToolCallRecord, ToolCallStatus>> {
    // 同时锁定所属 Run/Step，防止调用方把记录移动到另一个聚合位置。
    const result = await this.client.toolCallRecord.updateMany({
      where: {
        id: toolCall.id,
        runId: toolCall.runId,
        stepId: toolCall.stepId,
        status: expectedStatus,
      },
      data: toolCallUpdateToPersistence(toolCall),
    });
    if (result.count === 1) {
      return { outcome: 'updated', entity: toolCall };
    }

    const current = await this.client.toolCallRecord.findUnique({
      where: { id: toolCall.id },
    });
    if (
      !current
      || current.runId !== toolCall.runId
      || current.stepId !== toolCall.stepId
    ) {
      return { outcome: 'not_found' };
    }
    return {
      outcome: 'status_conflict',
      actualStatus: persistenceToToolCall(current).status,
    };
  }

  /** 按主键读取 ToolCallRecord。 */
  async getToolCallById(toolCallId: string): Promise<ToolCallRecord | null> {
    const record = await this.client.toolCallRecord.findUnique({
      where: { id: toolCallId },
    });
    return record ? persistenceToToolCall(record) : null;
  }

  /** 按 Run 内幂等键读取已占用的工具调用。 */
  async getToolCallByIdempotencyKey(
    runId: string,
    idempotencyKey: string,
  ): Promise<ToolCallRecord | null> {
    const record = await this.client.toolCallRecord.findUnique({
      where: { runId_idempotencyKey: { runId, idempotencyKey } },
    });
    return record ? persistenceToToolCall(record) : null;
  }

  /** 按稳定顺序返回 Run 的全部工具调用。 */
  async listToolCalls(runId: string): Promise<ToolCallRecord[]> {
    const records = await this.client.toolCallRecord.findMany({
      where: { runId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return records.map(persistenceToToolCall);
  }

  /** 以连续序号追加 Checkpoint，并处理重试、冲突和事件水位回退。 */
  async appendCheckpoint(checkpoint: Checkpoint): Promise<CheckpointAppendResult> {
    // 第一阶段先处理同序号重试：内容完全相同才视为幂等成功。
    const sameSequence = await this.client.checkpoint.findUnique({
      where: {
        runId_sequence: {
          runId: checkpoint.runId,
          sequence: checkpoint.sequence,
        },
      },
    });
    if (sameSequence) {
      const existingCheckpoint = persistenceToCheckpoint(sameSequence);
      return checkpointsEqual(existingCheckpoint, checkpoint)
        ? { outcome: 'already_exists', checkpoint: existingCheckpoint }
        : { outcome: 'content_conflict', existingCheckpoint };
    }

    // 第二阶段根据最新检查点校验严格 +1 序号和单调递增的事件水位。
    const latestRecord = await this.client.checkpoint.findFirst({
      where: { runId: checkpoint.runId },
      orderBy: { sequence: 'desc' },
    });
    const latest = latestRecord ? persistenceToCheckpoint(latestRecord) : null;
    const expectedSequence = latest ? latest.sequence + 1 : 0;
    if (checkpoint.sequence !== expectedSequence) {
      return { outcome: 'sequence_conflict', expectedSequence };
    }
    if (latest && checkpoint.nextEventSequence < latest.nextEventSequence) {
      return {
        outcome: 'event_sequence_regression',
        minimumNextEventSequence: latest.nextEventSequence,
      };
    }

    // 第三阶段原子插入；唯一索引负责解决校验后发生的并发竞争。
    const inserted = await this.client.checkpoint.createMany({
      data: checkpointToPersistence(checkpoint),
      skipDuplicates: true,
    });
    if (inserted.count === 1) {
      return { outcome: 'appended', checkpoint };
    }

    // 插入未命中时重新读取竞争结果，仍需区分相同重试与不同内容冲突。
    const concurrentRecord = await this.client.checkpoint.findUnique({
      where: {
        runId_sequence: {
          runId: checkpoint.runId,
          sequence: checkpoint.sequence,
        },
      },
    });
    if (!concurrentRecord) {
      const concurrentLatest = await this.client.checkpoint.findFirst({
        where: { runId: checkpoint.runId },
        orderBy: { sequence: 'desc' },
      });
      return {
        outcome: 'sequence_conflict',
        expectedSequence: concurrentLatest ? concurrentLatest.sequence + 1 : 0,
      };
    }

    const existingCheckpoint = persistenceToCheckpoint(concurrentRecord);
    return checkpointsEqual(existingCheckpoint, checkpoint)
      ? { outcome: 'already_exists', checkpoint: existingCheckpoint }
      : { outcome: 'content_conflict', existingCheckpoint };
  }

  /** 返回 Run 序号最大的 Checkpoint，供恢复解析器使用。 */
  async getLatestCheckpoint(runId: string): Promise<Checkpoint | null> {
    const record = await this.client.checkpoint.findFirst({
      where: { runId },
      orderBy: { sequence: 'desc' },
    });
    return record ? persistenceToCheckpoint(record) : null;
  }

  /** 创建等待输入或审批的 Interruption。 */
  async createInterruption(interruption: Interruption): Promise<void> {
    await this.client.interruption.create({
      data: interruptionToPersistence(interruption),
    });
  }

  /** 仅在状态仍等于 expectedStatus 时更新 Interruption 处理结果。 */
  async updateInterruption(
    interruption: Interruption,
    expectedStatus: InterruptionStatus,
  ): Promise<ConditionalStatusUpdateResult<Interruption, InterruptionStatus>> {
    // 状态条件避免过期的批准、拒绝或超时处理相互覆盖。
    const result = await this.client.interruption.updateMany({
      where: {
        id: interruption.id,
        runId: interruption.runId,
        status: expectedStatus,
      },
      data: interruptionUpdateToPersistence(interruption),
    });
    if (result.count === 1) {
      return { outcome: 'updated', entity: interruption };
    }

    const current = await this.client.interruption.findUnique({
      where: { id: interruption.id },
    });
    if (!current || current.runId !== interruption.runId) {
      return { outcome: 'not_found' };
    }
    return {
      outcome: 'status_conflict',
      actualStatus: persistenceToInterruption(current).status,
    };
  }

  /** 按主键读取 Interruption。 */
  async getInterruptionById(interruptionId: string): Promise<Interruption | null> {
    const record = await this.client.interruption.findUnique({
      where: { id: interruptionId },
    });
    return record ? persistenceToInterruption(record) : null;
  }

  /** 按稳定顺序返回 Run 中仍待处理的 Interruption。 */
  async getPendingInterruptions(runId: string): Promise<Interruption[]> {
    const records = await this.client.interruption.findMany({
      where: { runId, status: InterruptionStatus.PENDING },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return records.map(persistenceToInterruption);
  }
}

/** 比较 Checkpoint 的全部持久化字段，判断是否为完全相同的重试。 */
function checkpointsEqual(left: Checkpoint, right: Checkpoint): boolean {
  return left.id === right.id
    && left.runId === right.runId
    && left.sequence === right.sequence
    && left.resumeNode === right.resumeNode
    && left.nextEventSequence === right.nextEventSequence
    && left.createdAt.getTime() === right.createdAt.getTime()
    && isDeepStrictEqual(left.state, right.state);
}
