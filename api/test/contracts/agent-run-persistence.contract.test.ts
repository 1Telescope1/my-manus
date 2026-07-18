import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import {
  InterruptionKind,
  InterruptionStatus,
  RouteKind,
  RunStatus,
  RunStepKind,
  RunStepStatus,
  ToolCallRecord,
  ToolCallStatus,
  ToolRisk,
  createAgentRun,
  createCheckpoint,
  createInterruption,
  createRunStep,
  createToolCallRecord,
  transitionAgentRun,
} from '../../src/domain/models/agent-run';
import {
  RuntimePersistenceMappingError,
  agentRunToPersistence,
  checkpointToPersistence,
  interruptionToPersistence,
  persistenceToAgentRun,
  persistenceToCheckpoint,
  persistenceToInterruption,
  persistenceToRunStep,
  persistenceToToolCall,
  runStepToPersistence,
  toolCallToPersistence,
} from '../../src/infrastructure/prisma/agent-run.mapper';
import { DbAgentRunRepository } from '../../src/infrastructure/repositories/db-agent-run.repository';
import { DbUnitOfWork } from '../../src/infrastructure/repositories/db-uow';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';

const NOW = new Date('2026-07-17T00:00:00.000Z');
const LATER = new Date('2026-07-17T00:01:00.000Z');

/** 模拟 Prisma 将 DbNull 写成数据库 SQL NULL 的行为。 */
function persistJson(value: unknown): unknown {
  return value === Prisma.DbNull ? null : value;
}

/** 只实现 Run 仓储契约测试所需操作的内存 Prisma delegate。 */
class FakeAgentRunDelegate {
  readonly records = new Map<string, Record<string, unknown>>();

  /** 模拟插入 AgentRun 并补齐数据库时间字段。 */
  async create(args: { data: Record<string, unknown> }): Promise<Record<string, unknown>> {
    const record: Record<string, unknown> = {
      ...args.data,
      currentNode: args.data.currentNode ?? null,
      cancelRequestedAt: args.data.cancelRequestedAt ?? null,
      startedAt: args.data.startedAt ?? null,
      completedAt: args.data.completedAt ?? null,
      error: persistJson(args.data.error),
      metadata: persistJson(args.data.metadata),
      createdAt: NOW,
      updatedAt: NOW,
    };
    this.records.set(String(record.id), record);
    return { ...record };
  }

  /** 按主键读取 AgentRun 的独立副本。 */
  async findUnique(args: { where: { id: string } }): Promise<Record<string, unknown> | null> {
    const record = this.records.get(args.where.id);
    return record ? { ...record } : null;
  }

  /** 按 Session 筛选全部 AgentRun。 */
  async findMany(args: {
    where: { sessionId: string };
    orderBy: Array<Record<string, string>>;
  }): Promise<Array<Record<string, unknown>>> {
    return [...this.records.values()]
      .filter((record) => record.sessionId === args.where.sessionId)
      .map((record) => ({ ...record }));
  }

  /** 模拟同时匹配 ID、版本和状态的原子条件更新。 */
  async updateMany(args: {
    where: { id: string; version: number; status?: string };
    data: Record<string, unknown> & { version: { increment: number } };
  }): Promise<{ count: number }> {
    const current = this.records.get(args.where.id);
    if (
      !current ||
      current.version !== args.where.version ||
      (args.where.status !== undefined && current.status !== args.where.status)
    ) {
      return { count: 0 };
    }

    const { version, ...changes } = args.data;
    this.records.set(args.where.id, {
      ...current,
      ...changes,
      error: persistJson(changes.error),
      metadata: persistJson(changes.metadata),
      version: Number(current.version) + version.increment,
      updatedAt: LATER,
    });
    return { count: 1 };
  }
}

/** 只实现工具幂等占用测试所需操作的内存 Prisma delegate。 */
class FakeToolCallDelegate {
  readonly records = new Map<string, Record<string, unknown>>();

  /** 模拟受主键和幂等唯一键保护的 createMany(skipDuplicates)。 */
  async createMany(args: {
    data: Record<string, unknown>;
    skipDuplicates: boolean;
  }): Promise<{ count: number }> {
    const id = String(args.data.id);
    const existingKey = [...this.records.values()].find(
      (record) =>
        record.runId === args.data.runId &&
        record.idempotencyKey === args.data.idempotencyKey,
    );
    if (this.records.has(id) || existingKey) {
      return { count: 0 };
    }

    this.records.set(id, {
      ...args.data,
      startedAt: args.data.startedAt ?? null,
      completedAt: args.data.completedAt ?? null,
      arguments: persistJson(args.data.arguments),
      result: persistJson(args.data.result),
      createdAt: NOW,
      updatedAt: NOW,
    });
    return { count: 1 };
  }

  /** 按主键或 Run 内幂等键读取工具调用。 */
  async findUnique(args: {
    where:
      | { id: string }
      | { runId_idempotencyKey: { runId: string; idempotencyKey: string } };
  }): Promise<Record<string, unknown> | null> {
    if ('id' in args.where) {
      const record = this.records.get(args.where.id);
      return record ? { ...record } : null;
    }
    const composite = args.where.runId_idempotencyKey;
    const record = [...this.records.values()].find(
      (candidate) =>
        candidate.runId === composite.runId &&
        candidate.idempotencyKey === composite.idempotencyKey,
    );
    return record ? { ...record } : null;
  }

  /** 按 Run 和可选状态集合筛选工具调用。 */
  async findMany(args: {
    where: { runId: string; status?: { in: string[] } };
    orderBy: Array<Record<string, string>>;
  }): Promise<Array<Record<string, unknown>>> {
    return [...this.records.values()]
      .filter(
        (record) =>
          record.runId === args.where.runId &&
          (!args.where.status || args.where.status.in.includes(String(record.status))),
      )
      .map((record) => ({ ...record }));
  }

  /** 模拟按 expectedStatus 更新工具调用。 */
  async updateMany(args: {
    where: { id: string; status: string };
    data: Record<string, unknown>;
  }): Promise<{ count: number }> {
    const current = this.records.get(args.where.id);
    if (!current || current.status !== args.where.status) {
      return { count: 0 };
    }
    this.records.set(args.where.id, {
      ...current,
      ...args.data,
      result: persistJson(args.data.result),
      updatedAt: LATER,
    });
    return { count: 1 };
  }
}

/** 只实现 Checkpoint 追加契约测试所需操作的内存 Prisma delegate。 */
class FakeCheckpointDelegate {
  readonly records = new Map<string, Record<string, unknown>>();

  /** 生成与数据库复合唯一键等价的内存键。 */
  private key(runId: unknown, sequence: unknown): string {
    return `${String(runId)}:${String(sequence)}`;
  }

  /** 按 Run 和序号读取唯一 Checkpoint。 */
  async findUnique(args: {
    where: { runId_sequence: { runId: string; sequence: number } };
  }): Promise<Record<string, unknown> | null> {
    const { runId, sequence } = args.where.runId_sequence;
    const record = this.records.get(this.key(runId, sequence));
    return record ? { ...record } : null;
  }

  /** 返回指定 Run 中序号最大的 Checkpoint。 */
  async findFirst(args: {
    where: { runId: string };
    orderBy: { sequence: string };
  }): Promise<Record<string, unknown> | null> {
    const records = [...this.records.values()]
      .filter((record) => record.runId === args.where.runId)
      .sort((left, right) => Number(right.sequence) - Number(left.sequence));
    return records[0] ? { ...records[0] } : null;
  }

  /** 模拟受复合唯一键保护的只追加插入。 */
  async createMany(args: {
    data: Record<string, unknown>;
    skipDuplicates: boolean;
  }): Promise<{ count: number }> {
    const key = this.key(args.data.runId, args.data.sequence);
    if (this.records.has(key)) {
      return { count: 0 };
    }
    this.records.set(key, {
      ...args.data,
      state: persistJson(args.data.state),
      createdAt: args.data.createdAt ?? NOW,
    });
    return { count: 1 };
  }

  /** 按序号返回 Run 的 Checkpoint 列表。 */
  async findMany(args: {
    where: { runId: string };
    orderBy: { sequence: string };
  }): Promise<Array<Record<string, unknown>>> {
    return [...this.records.values()]
      .filter((record) => record.runId === args.where.runId)
      .sort((left, right) => Number(left.sequence) - Number(right.sequence))
      .map((record) => ({ ...record }));
  }
}

/** 用单个内存 delegate 构造当前测试需要的仓储实例。 */
function repositoryWithDelegate(
  name: 'agentRun' | 'toolCallRecord' | 'checkpoint',
  delegate: object,
): DbAgentRunRepository {
  return new DbAgentRunRepository({ [name]: delegate } as never);
}

// 验证五类领域快照经过 Prisma 数据形状往返后语义不变。
test('运行持久化 Mapper 应保持五类聚合记录往返转换语义不变', () => {
  const run = createAgentRun({
    id: 'run-1',
    sessionId: 'session-1',
    route: RouteKind.PLANNED_AGENT,
    metadata: { source: 'contract-test' },
  });
  const runData = agentRunToPersistence(run);
  const restoredRun = persistenceToAgentRun({
    ...runData,
    id: run.id,
    status: run.status,
    version: run.version,
    currentNode: null,
    cancelRequestedAt: null,
    startedAt: null,
    completedAt: null,
    error: null,
    metadata: { source: 'contract-test' },
    createdAt: NOW,
    updatedAt: NOW,
  });
  assert.deepEqual(restoredRun, run);

  const step = createRunStep({
    id: 'step-1',
    runId: run.id,
    key: 'plan',
    kind: RunStepKind.MODEL,
    attempt: 1,
    input: { goal: 'verify persistence' },
  });
  const stepData = runStepToPersistence(step);
  assert.deepEqual(
    persistenceToRunStep({
      ...stepData,
      id: step.id,
      status: step.status,
      attempt: step.attempt,
      input: step.input,
      output: null,
      error: null,
      createdAt: NOW,
      updatedAt: NOW,
    }),
    step,
  );

  const toolCall = createToolCallRecord({
    id: 'tool-1',
    runId: run.id,
    stepId: step.id,
    toolName: 'search',
    risk: ToolRisk.READ,
    idempotencyKey: 'search:1',
    requestFingerprint: 'sha256:abc',
    arguments: { query: 'RUNTIME-102' },
  });
  const toolData = toolCallToPersistence(toolCall);
  assert.deepEqual(
    persistenceToToolCall({
      ...toolData,
      id: toolCall.id,
      arguments: toolCall.arguments,
      status: toolCall.status,
      startedAt: null,
      completedAt: null,
      result: null,
      createdAt: NOW,
      updatedAt: NOW,
    }),
    toolCall,
  );

  const checkpoint = createCheckpoint({
    id: 'checkpoint-1',
    runId: run.id,
    sequence: 0,
    resumeNode: 'planner',
    state: { messages: [] },
    nextEventSequence: 1,
    createdAt: NOW,
  });
  assert.deepEqual(
    persistenceToCheckpoint({
      ...checkpointToPersistence(checkpoint),
      id: checkpoint.id,
      state: checkpoint.state,
      createdAt: checkpoint.createdAt,
    }),
    checkpoint,
  );

  const interruption = createInterruption({
    id: 'interrupt-1',
    runId: run.id,
    kind: InterruptionKind.APPROVAL,
    payload: { tool: 'shell' },
  });
  const interruptionData = interruptionToPersistence(interruption);
  assert.deepEqual(
    persistenceToInterruption({
      ...interruptionData,
      id: interruption.id,
      status: interruption.status,
      payload: interruption.payload,
      resolution: null,
      createdAt: NOW,
      updatedAt: NOW,
    }),
    interruption,
  );
});

// 验证数据库脏枚举不会逃逸到领域层。
test('运行持久化 Mapper 应拒绝数据库中的未知枚举值', () => {
  assert.throws(
    () =>
      persistenceToAgentRun({
        id: 'run-invalid',
        sessionId: 'session-1',
        route: RouteKind.PLANNED_AGENT,
        status: 'not-a-runtime-status',
        currentNode: null,
        version: 0,
        cancelRequestedAt: null,
        startedAt: null,
        completedAt: null,
        error: null,
        metadata: null,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    RuntimePersistenceMappingError,
  );
});

// 验证两个相同版本写者竞争时只有一个 CAS 更新成功。
test('AgentRun 仓储使用 CAS 时并发更新应只有一个成功', async () => {
  const delegate = new FakeAgentRunDelegate();
  const repository = repositoryWithDelegate('agentRun', delegate);
  const run = createAgentRun({
    id: 'run-cas',
    sessionId: 'session-cas',
    route: RouteKind.PLANNED_AGENT,
    currentNode: 'planner',
  });
  await repository.create(run);

  const candidate = transitionAgentRun(run, {
    status: RunStatus.RUNNING,
    at: LATER,
  });
  const outcomes = await Promise.all([
    repository.update(candidate, 0),
    repository.update(candidate, 0),
  ]);

  assert.equal(outcomes.filter((result) => result.outcome === 'updated').length, 1);
  assert.equal(
    outcomes.filter((result) => result.outcome === 'version_conflict').length,
    1,
  );
  const stored = await repository.getById(run.id);
  assert.equal(stored?.status, RunStatus.RUNNING);
  assert.equal(stored?.version, 1);
});

// 验证工具幂等键能区分相同请求重试与不同请求冲突。
test('工具调用占用应支持幂等重试并识别不同请求复用同一键', async () => {
  const delegate = new FakeToolCallDelegate();
  const repository = repositoryWithDelegate('toolCallRecord', delegate);
  const toolCall = createToolCallRecord({
    id: 'tool-idempotent',
    runId: 'run-tools',
    stepId: 'step-tools',
    toolName: 'shell',
    risk: ToolRisk.WRITE,
    idempotencyKey: 'shell:once',
    requestFingerprint: 'sha256:first',
    arguments: { command: 'pwd' },
  });

  assert.equal((await repository.reserveToolCall(toolCall)).outcome, 'reserved');
  assert.equal((await repository.reserveToolCall(toolCall)).outcome, 'existing');

  const conflicting = createToolCallRecord({
    ...toolCall,
    id: 'tool-conflicting',
    requestFingerprint: 'sha256:second',
    arguments: { command: 'whoami' },
  });
  const conflict = await repository.reserveToolCall(conflicting);
  assert.equal(conflict.outcome, 'key_conflict');
  if (conflict.outcome === 'key_conflict') {
    assert.equal(conflict.existingToolCall.requestFingerprint, 'sha256:first');
  }

  const running: ToolCallRecord = {
    ...toolCall,
    status: ToolCallStatus.RUNNING,
    startedAt: LATER,
  };
  assert.equal(
    (await repository.updateToolCall(running, ToolCallStatus.PENDING)).outcome,
    'updated',
  );
  assert.equal(
    (await repository.updateToolCall(running, ToolCallStatus.PENDING)).outcome,
    'status_conflict',
  );
});

// 验证 Checkpoint 的连续序号、事件水位和完全相同重试语义。
test('Checkpoint 追加应保证连续序号、事件水位单调和完全相同重试', async () => {
  const delegate = new FakeCheckpointDelegate();
  const repository = repositoryWithDelegate('checkpoint', delegate);
  const first = createCheckpoint({
    id: 'checkpoint-0',
    runId: 'run-checkpoints',
    sequence: 0,
    resumeNode: 'planner',
    state: { messages: [] },
    nextEventSequence: 2,
    createdAt: NOW,
  });

  assert.equal((await repository.appendCheckpoint(first)).outcome, 'appended');
  assert.equal((await repository.appendCheckpoint(first)).outcome, 'already_exists');

  const sameSequenceDifferentState = createCheckpoint({
    ...first,
    id: 'checkpoint-0-other',
    state: { messages: ['different'] },
  });
  assert.equal(
    (await repository.appendCheckpoint(sameSequenceDifferentState)).outcome,
    'content_conflict',
  );

  const skipped = createCheckpoint({
    id: 'checkpoint-2',
    runId: first.runId,
    sequence: 2,
    resumeNode: 'executor',
    state: {},
    nextEventSequence: 3,
  });
  assert.equal((await repository.appendCheckpoint(skipped)).outcome, 'sequence_conflict');

  const regressed = createCheckpoint({
    id: 'checkpoint-1-regressed',
    runId: first.runId,
    sequence: 1,
    resumeNode: 'executor',
    state: {},
    nextEventSequence: 1,
  });
  assert.equal(
    (await repository.appendCheckpoint(regressed)).outcome,
    'event_sequence_regression',
  );

  const second = createCheckpoint({
    id: 'checkpoint-1',
    runId: first.runId,
    sequence: 1,
    resumeNode: 'executor',
    state: { messages: ['continued'] },
    nextEventSequence: 3,
  });
  assert.equal((await repository.appendCheckpoint(second)).outcome, 'appended');
  assert.equal((await repository.getLatestCheckpoint(first.runId))?.sequence, 1);
});

// 验证事务回调拿到的 UnitOfWork 已暴露运行仓储。
test('DbUnitOfWork 应在事务中暴露运行仓储', async () => {
  const transactionClient = {};
  const prisma = {
    $transaction: async <T>(callback: (tx: object) => Promise<T>): Promise<T> =>
      callback(transactionClient),
  } as unknown as PrismaService;
  const uow = new DbUnitOfWork(prisma);

  await uow.run(async (transaction) => {
    assert.ok(transaction.agentRun instanceof DbAgentRunRepository);
  });
});

// 验证前向迁移覆盖五张表，回滚顺序遵守外键依赖。
test('运行迁移应创建全部表，并按子表优先顺序回滚', async () => {
  const migrationDirectory = resolve(
    process.cwd(),
    'prisma/migrations/20260717000000_runtime_persistence',
  );
  const [up, down] = await Promise.all([
    readFile(resolve(migrationDirectory, 'migration.sql'), 'utf8'),
    readFile(resolve(migrationDirectory, 'rollback.sql'), 'utf8'),
  ]);

  for (const table of [
    'agent_runs',
    'run_steps',
    'tool_call_records',
    'checkpoints',
    'interruptions',
  ]) {
    assert.ok(up.includes(`CREATE TABLE \"${table}\"`));
    assert.ok(down.includes(`DROP TABLE IF EXISTS \"${table}\"`));
  }
  assert.match(up, /ON DELETE CASCADE ON UPDATE CASCADE/);
  assert.ok(down.indexOf('tool_call_records') < down.indexOf('run_steps'));
  assert.ok(down.indexOf('run_steps') < down.indexOf('agent_runs'));
  assert.ok(down.indexOf('checkpoints') < down.indexOf('agent_runs'));
  assert.ok(down.indexOf('interruptions') < down.indexOf('agent_runs'));
});
