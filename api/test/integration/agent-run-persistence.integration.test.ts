import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';
import {
  InterruptionKind,
  InterruptionStatus,
  RouteKind,
  RunStatus,
  RunStepKind,
  RunStepStatus,
  ToolCallStatus,
  ToolRisk,
  createAgentRun,
  createCheckpoint,
  createInterruption,
  createRunStep,
  createToolCallRecord,
  transitionAgentRun,
} from '../../src/domain/models/agent-run';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { DbAgentRunRepository } from '../../src/infrastructure/repositories/db-agent-run.repository';
import { DbUnitOfWork } from '../../src/infrastructure/repositories/db-uow';
import {
  RuntimeCheckpointBoundary,
  RuntimeCheckpointService,
} from '../../src/domain/services/runtime/checkpoint.service';
import {
  RuntimeRecoveryDisposition,
  RuntimeRecoveryReason,
  RuntimeRecoveryService,
} from '../../src/domain/services/runtime/recovery.service';

const NOW = new Date('2026-07-17T01:00:00.000Z');
const LATER = new Date('2026-07-17T01:01:00.000Z');

// 在真实 PostgreSQL 上串联验证仓储、并发、事务、级联删除和迁移回滚。
test('PostgreSQL 运行持久化应支持并发控制、事务回滚和可逆迁移', async () => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required for this integration test');

  const prisma = new PrismaClient();
  const suffix = `${process.pid}-${Date.now()}`;
  const sessionId = `runtime-102-session-${suffix}`;
  let runtimeTablesRolledBack = false;

  await prisma.$connect();
  try {
    // 先创建父 Session，确保后续外键和级联删除走真实数据库约束。
    await prisma.session.create({ data: { id: sessionId, title: 'RUNTIME-102 integration' } });
    const repository = new DbAgentRunRepository(prisma);
    const run = createAgentRun({
      id: `runtime-102-run-${suffix}`,
      sessionId,
      route: RouteKind.PLANNED_AGENT,
      currentNode: 'planner',
      metadata: { source: 'postgres-integration' },
    });
    await repository.create(run);
    assert.deepEqual(await repository.getById(run.id), run);
    assert.deepEqual(await repository.listBySessionId(sessionId), [run]);

    // 两个写者同时提交 version=0，数据库 CAS 必须保证只有一个写入成功。
    const running = transitionAgentRun(run, { status: RunStatus.RUNNING, at: NOW });
    const concurrentUpdates = await Promise.all([
      repository.update(running, 0),
      repository.update(running, 0),
    ]);
    assert.equal(
      concurrentUpdates.filter((result) => result.outcome === 'updated').length,
      1,
    );
    assert.equal(
      concurrentUpdates.filter((result) => result.outcome === 'version_conflict').length,
      1,
    );
    assert.equal((await repository.getById(run.id))?.version, 1);

    const step = createRunStep({
      id: `runtime-102-step-${suffix}`,
      runId: run.id,
      key: 'execute',
      kind: RunStepKind.TOOL,
      input: { command: 'pwd' },
    });
    await repository.createStep(step);
    assert.deepEqual(await repository.getStepById(step.id), step);
    assert.deepEqual(await repository.getStepByKey(run.id, step.key, step.attempt), step);

    const completedStep = {
      ...step,
      status: RunStepStatus.COMPLETED,
      output: { exitCode: 0 },
    };
    assert.equal(
      (await repository.updateStep(completedStep, RunStepStatus.PENDING)).outcome,
      'updated',
    );
    assert.deepEqual(await repository.listSteps(run.id), [completedStep]);

    // 先验证相同请求可复用，再验证相同幂等键不能被不同请求占用。
    const toolCall = createToolCallRecord({
      id: `runtime-102-tool-${suffix}`,
      runId: run.id,
      stepId: step.id,
      toolName: 'shell',
      arguments: { command: 'pwd' },
      risk: ToolRisk.READ,
      idempotencyKey: 'execute:shell:1',
      requestFingerprint: 'sha256:runtime-102-original',
    });
    assert.equal((await repository.reserveToolCall(toolCall)).outcome, 'reserved');
    assert.equal((await repository.reserveToolCall(toolCall)).outcome, 'existing');

    const conflictingToolCall = createToolCallRecord({
      ...toolCall,
      id: `runtime-102-tool-conflict-${suffix}`,
      arguments: { command: 'whoami' },
      requestFingerprint: 'sha256:runtime-102-different',
    });
    assert.equal(
      (await repository.reserveToolCall(conflictingToolCall)).outcome,
      'key_conflict',
    );

    const runningToolCall = {
      ...toolCall,
      status: ToolCallStatus.RUNNING,
      startedAt: LATER,
    };
    assert.equal(
      (await repository.updateToolCall(runningToolCall, ToolCallStatus.PENDING)).outcome,
      'updated',
    );

    // 完全相同的 Checkpoint 重试应命中 already_exists，而不是重复插入。
    const checkpoint = createCheckpoint({
      id: `runtime-102-checkpoint-${suffix}`,
      runId: run.id,
      sequence: 0,
      resumeNode: 'executor',
      nextEventSequence: 3,
      state: { currentStep: step.id },
      createdAt: NOW,
    });
    assert.equal((await repository.appendCheckpoint(checkpoint)).outcome, 'appended');
    assert.equal((await repository.appendCheckpoint(checkpoint)).outcome, 'already_exists');
    assert.deepEqual(await repository.getLatestCheckpoint(run.id), checkpoint);

    // 使用真实 Prisma 事务原子推进 Run version/游标并追加下一个 Checkpoint。
    const runtimeUnitOfWorkFactory = () =>
      new DbUnitOfWork(prisma as unknown as PrismaService);
    const persistedRun = await repository.getById(run.id);
    assert.ok(persistedRun);
    const committed = await new RuntimeCheckpointService(runtimeUnitOfWorkFactory).commit({
      run: persistedRun,
      expectedVersion: 1,
      boundary: RuntimeCheckpointBoundary.MODEL_COMPLETED,
      resumeNode: 'executor.consume_model_result',
      nextEventSequence: 4,
      state: { modelOutput: { action: 'continue' } },
      checkpointId: `runtime-102-checkpoint-recovery-${suffix}`,
      createdAt: LATER,
    });
    assert.equal(committed.run.version, 2);
    assert.equal(committed.run.currentNode, 'executor.consume_model_result');
    assert.equal(committed.checkpoint.sequence, 1);

    // 进行中的只读调用可安全重试，因此恢复计划继续使用 Checkpoint 游标。
    const recoveryService = new RuntimeRecoveryService(runtimeUnitOfWorkFactory);
    const resumablePlan = await recoveryService.resolve(run.id);
    assert.equal(resumablePlan?.disposition, RuntimeRecoveryDisposition.RESUME);
    assert.deepEqual(resumablePlan?.retryableToolCalls, [runningToolCall]);
    assert.equal(resumablePlan?.nextEventSequence, 4);

    // unknown 写调用不能盲目重放，恢复解析器必须返回 PAUSE。
    const uncertainToolCall = createToolCallRecord({
      id: `runtime-102-uncertain-tool-${suffix}`,
      runId: run.id,
      stepId: step.id,
      toolName: 'write_external_state',
      arguments: { value: 'maybe-written' },
      risk: ToolRisk.WRITE,
      idempotencyKey: 'execute:write:1',
      requestFingerprint: 'sha256:runtime-103-uncertain',
    });
    await repository.reserveToolCall(uncertainToolCall);
    await repository.updateToolCall(
      {
        ...uncertainToolCall,
        status: ToolCallStatus.UNKNOWN,
        startedAt: LATER,
      },
      ToolCallStatus.PENDING,
    );
    const pausedPlan = await recoveryService.resolve(run.id);
    assert.equal(pausedPlan?.disposition, RuntimeRecoveryDisposition.PAUSE);
    assert.equal(pausedPlan?.reason, RuntimeRecoveryReason.UNCERTAIN_SIDE_EFFECT);
    assert.equal(pausedPlan?.unresolvedToolCalls[0]?.id, uncertainToolCall.id);

    const interruption = createInterruption({
      id: `runtime-102-interruption-${suffix}`,
      runId: run.id,
      kind: InterruptionKind.APPROVAL,
      payload: { toolCallId: toolCall.id },
    });
    await repository.createInterruption(interruption);
    assert.deepEqual(await repository.getPendingInterruptions(run.id), [interruption]);

    const resolvedInterruption = {
      ...interruption,
      status: InterruptionStatus.RESOLVED,
      resolution: { approved: true },
    };
    assert.equal(
      (
        await repository.updateInterruption(
          resolvedInterruption,
          InterruptionStatus.PENDING,
        )
      ).outcome,
      'updated',
    );
    assert.deepEqual(
      await repository.getInterruptionById(interruption.id),
      resolvedInterruption,
    );

    // 在同一 UoW 中写入 Run 和 Step 后故意失败，验证两条记录整体回滚。
    const rolledBackRun = createAgentRun({
      id: `runtime-102-rolled-back-${suffix}`,
      sessionId,
      route: RouteKind.DIRECT,
    });
    const rolledBackStep = createRunStep({
      id: `runtime-102-rolled-back-step-${suffix}`,
      runId: rolledBackRun.id,
      key: 'must-not-commit',
      kind: RunStepKind.MODEL,
    });
    const unitOfWork = new DbUnitOfWork(prisma as unknown as PrismaService);
    await assert.rejects(
      unitOfWork.run(async (transaction) => {
        await transaction.agentRun.create(rolledBackRun);
        await transaction.agentRun.createStep(rolledBackStep);
        throw new Error('intentional RUNTIME-102 rollback');
      }),
      /intentional RUNTIME-102 rollback/,
    );
    assert.equal(await repository.getById(rolledBackRun.id), null);
    assert.equal(await repository.getStepById(rolledBackStep.id), null);

    // 删除聚合最外层 Session，逐表确认数据库级联没有遗留孤儿记录。
    await prisma.session.delete({ where: { id: sessionId } });
    assert.equal(await prisma.agentRun.count({ where: { sessionId } }), 0);
    assert.equal(await prisma.runStep.count({ where: { runId: run.id } }), 0);
    assert.equal(await prisma.toolCallRecord.count({ where: { runId: run.id } }), 0);
    assert.equal(await prisma.checkpoint.count({ where: { runId: run.id } }), 0);
    assert.equal(await prisma.interruption.count({ where: { runId: run.id } }), 0);

    // 最后执行显式 down SQL，并确认只删除 Runtime 表、不影响既有 Session 表。
    const rollbackSql = await readFile(
      resolve(
        process.cwd(),
        'prisma/migrations/20260717000000_runtime_persistence/rollback.sql',
      ),
      'utf8',
    );
    for (const statement of rollbackSql.split(';').map((part) => part.trim()).filter(Boolean)) {
      await prisma.$executeRawUnsafe(statement);
    }
    runtimeTablesRolledBack = true;

    const tableLookup = await prisma.$queryRawUnsafe<Array<{ relation: string | null }>>(
      "SELECT to_regclass('public.agent_runs')::text AS relation",
    );
    assert.equal(tableLookup[0]?.relation, null);
    const sessionLookup = await prisma.$queryRawUnsafe<Array<{ relation: string | null }>>(
      "SELECT to_regclass('public.sessions')::text AS relation",
    );
    assert.equal(sessionLookup[0]?.relation, 'sessions');
  } finally {
    if (!runtimeTablesRolledBack) {
      await prisma.session.deleteMany({ where: { id: sessionId } }).catch(() => undefined);
    }
    await prisma.$disconnect();
  }
});
