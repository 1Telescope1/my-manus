import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AgentRun,
  RouteKind,
  RunStatus,
  RunStep,
  RunStepStatus,
  ToolCallRecord,
  ToolCallStatus,
  ToolRisk as RunToolRisk,
  canTransitionRunStatus,
  createAgentRun,
  transitionAgentRun,
} from '../../src/domain/models/agent-run';
import { ToolIdempotencyStore } from '../../src/domain/models/tool-invocation';
import {
  ToolExecutionContext,
  ToolRegistration,
  ToolRisk,
} from '../../src/domain/models/tool';
import { ToolResult } from '../../src/domain/models/tool-result';
import { AgentRunRepository } from '../../src/domain/repositories/agent-run.repository';
import { UnitOfWork } from '../../src/domain/repositories/unit-of-work';
import { PersistentToolIdempotencyStore } from '../../src/domain/services/runtime/persistent-tool-idempotency.store';
import {
  RuntimeRecoveryDisposition,
  RuntimeRecoveryReason,
  RuntimeRecoveryService,
} from '../../src/domain/services/runtime/recovery.service';
import { ToolInvocationService } from '../../src/domain/services/tools/tool-invocation.service';
import { InMemoryToolRegistry } from '../../src/domain/services/tools/tool-registry';

const NOW = new Date('2026-07-19T04:00:00.000Z');

/** 覆盖 PersistentToolIdempotencyStore 所需的事务仓储行为。 */
class IdempotencyMemoryStore {
  readonly runs = new Map<string, AgentRun>();
  readonly steps = new Map<string, RunStep>();
  readonly toolCalls = new Map<string, ToolCallRecord>();

  /** 写入一个可执行 Run。 */
  seedRun(run: AgentRun): void {
    this.runs.set(run.id, run);
  }

  /** 每次返回带回滚快照的新事务边界，模拟进程重建后的共享数据库。 */
  createUnitOfWork(): UnitOfWork {
    const repository = this.createRepository();
    const unitOfWork = {
      agentRun: repository,
      file: {},
      session: {},
      run: async <T>(handler: (active: UnitOfWork) => Promise<T>): Promise<T> => {
        const snapshot = {
          runs: new Map(this.runs),
          steps: new Map(this.steps),
          toolCalls: new Map(this.toolCalls),
        };
        try {
          return await handler(unitOfWork as UnitOfWork);
        } catch (error) {
          replaceMap(this.runs, snapshot.runs);
          replaceMap(this.steps, snapshot.steps);
          replaceMap(this.toolCalls, snapshot.toolCalls);
          throw error;
        }
      },
    } as UnitOfWork;
    return unitOfWork;
  }

  /** 实现 Run、Step 和 ToolCall 的唯一键与条件更新契约。 */
  private createRepository(): AgentRunRepository {
    return {
      getById: async (runId: string) => this.runs.get(runId) ?? null,
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
        if (!this.runs.has(step.runId)) {
          throw new Error('Run 不存在');
        }
        const duplicate = [...this.steps.values()].some(
          (item) => item.runId === step.runId
            && item.key === step.key
            && item.attempt === step.attempt,
        );
        if (this.steps.has(step.id) || duplicate) {
          throw new Error('RunStep 唯一键冲突');
        }
        this.steps.set(step.id, step);
      },
      getStepById: async (stepId: string) => this.steps.get(stepId) ?? null,
      getStepByKey: async (runId: string, key: string, attempt: number) =>
        [...this.steps.values()].find(
          (step) => step.runId === runId
            && step.key === key
            && step.attempt === attempt,
        ) ?? null,
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
      reserveToolCall: async (candidate: ToolCallRecord) => {
        if (!this.steps.has(candidate.stepId)) {
          throw new Error('RunStep 不存在');
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
      getToolCallByIdempotencyKey: async (runId: string, idempotencyKey: string) =>
        [...this.toolCalls.values()].find(
          (toolCall) => toolCall.runId === runId
            && toolCall.idempotencyKey === idempotencyKey,
        ) ?? null,
      getIncompleteToolCalls: async (runId: string) => [...this.toolCalls.values()].filter(
        (toolCall) => toolCall.runId === runId
          && [
            ToolCallStatus.PENDING,
            ToolCallStatus.RUNNING,
            ToolCallStatus.UNKNOWN,
          ].includes(toolCall.status),
      ),
      listToolCalls: async (runId: string) => [...this.toolCalls.values()].filter(
        (toolCall) => toolCall.runId === runId,
      ),
      getLatestCheckpoint: async () => null,
      getPendingInterruptions: async () => [],
    } as unknown as AgentRunRepository;
  }
}

/** 用源 Map 恢复事务开始前的状态。 */
function replaceMap<Key, Value>(target: Map<Key, Value>, source: Map<Key, Value>): void {
  target.clear();
  for (const [key, value] of source) {
    target.set(key, value);
  }
}

/** 创建处于 running 的测试 Run。 */
function runningRun(id: string): AgentRun {
  return transitionAgentRun(
    createAgentRun({
      id,
      sessionId: 'session-runtime-107',
      route: RouteKind.SINGLE_TOOL,
    }),
    { status: RunStatus.RUNNING, at: NOW },
  );
}

/** 创建一个可计数的工具调用服务。 */
function invocationService(
  invoke: (
    arguments_: Record<string, unknown>,
    context?: ToolExecutionContext,
  ) => Promise<ToolResult>,
  risk: ToolRisk,
  idempotencyStore: ToolIdempotencyStore,
): ToolInvocationService {
  const registration: ToolRegistration = {
    descriptor: {
      id: 'builtin:runtime_107_tool',
      name: 'runtime_107_tool',
      source: 'builtin',
      description: 'RUNTIME-107 故障注入工具',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
      capabilities: ['runtime-107'],
      risk,
      requiresApproval: false,
      timeoutMs: 100,
    },
    groupName: 'runtime-107',
    invoke,
  };
  const registry = new InMemoryToolRegistry();
  registry.register(registration);
  return new ToolInvocationService(registry, { idempotencyStore });
}

/** 固定同一工具调用的持久化身份。 */
function invocationRequest(runId: string, value = 'first') {
  return {
    functionName: 'runtime_107_tool',
    arguments: { value },
    scopeId: runId,
    idempotencyKey: 'runtime-107:stable-call',
    toolCallId: 'runtime-107-tool-call',
  };
}

/** 在真实工具返回后、结果写库前注入进程故障。 */
class FailBeforeResultPersistenceStore implements ToolIdempotencyStore {
  /** 复用真实持久化占用逻辑，只替换结果提交点。 */
  constructor(private readonly delegate: ToolIdempotencyStore) {}

  reserve(input: Parameters<ToolIdempotencyStore['reserve']>[0]) {
    return this.delegate.reserve(input);
  }

  start(input: Parameters<ToolIdempotencyStore['start']>[0]) {
    return this.delegate.start(input);
  }

  /** 模拟外部副作用已发生、但进程在持久化 ToolResult 前崩溃。 */
  async complete(_input: Parameters<ToolIdempotencyStore['complete']>[0]): Promise<void> {
    throw new Error('故障注入：结果持久化前进程退出');
  }
}

test('副作用结果持久化后应跨服务实例复用，且同键不同请求必须冲突', async () => {
  const memory = new IdempotencyMemoryStore();
  const run = runningRun('run-runtime-107-replay');
  memory.seedRun(run);
  let externalWrites = 0;
  const invoke = async (arguments_: Record<string, unknown>): Promise<ToolResult> => {
    externalWrites += 1;
    return { success: true, data: { saved: arguments_.value } };
  };

  const first = await invocationService(
    invoke,
    'write',
    new PersistentToolIdempotencyStore(() => memory.createUnitOfWork()),
  ).invoke(invocationRequest(run.id));
  const restarted = invocationService(
    invoke,
    'write',
    new PersistentToolIdempotencyStore(() => memory.createUnitOfWork()),
  );
  const replayed = await restarted.invoke(invocationRequest(run.id));
  const conflict = await restarted.invoke(invocationRequest(run.id, 'different'));

  assert.equal(first.success, true);
  assert.equal(replayed.success, true);
  assert.equal(replayed.metadata?.replayed, true);
  assert.equal(replayed.metadata?.attempts, 0);
  assert.equal(conflict.error?.code, 'idempotency_conflict');
  assert.equal(externalWrites, 1);
  assert.equal(memory.toolCalls.get('runtime-107-tool-call')?.status, ToolCallStatus.COMPLETED);
  assert.equal([...memory.steps.values()][0]?.status, RunStepStatus.COMPLETED);
});

test('副作用发生后结果未持久化时，恢复必须标记 unknown、暂停 Run 且禁止重放', async () => {
  const memory = new IdempotencyMemoryStore();
  const run = runningRun('run-runtime-107-crash');
  memory.seedRun(run);
  let externalWrites = 0;
  const invoke = async (): Promise<ToolResult> => {
    externalWrites += 1;
    return { success: true, data: 'external-write-finished' };
  };
  const persistent = new PersistentToolIdempotencyStore(
    () => memory.createUnitOfWork(),
  );
  const crashing = invocationService(
    invoke,
    'external_communication',
    new FailBeforeResultPersistenceStore(persistent),
  );

  await assert.rejects(
    crashing.invoke(invocationRequest(run.id)),
    /结果持久化前进程退出/,
  );
  assert.equal(externalWrites, 1);
  assert.equal(memory.toolCalls.get('runtime-107-tool-call')?.status, ToolCallStatus.RUNNING);

  const plan = await new RuntimeRecoveryService(
    () => memory.createUnitOfWork(),
    () => NOW,
  ).resolve(run.id);
  assert.equal(plan?.disposition, RuntimeRecoveryDisposition.PAUSE);
  assert.equal(plan?.reason, RuntimeRecoveryReason.UNCERTAIN_SIDE_EFFECT);
  assert.equal(plan?.run.status, RunStatus.PAUSED);
  assert.equal(plan?.unresolvedToolCalls[0]?.status, ToolCallStatus.UNKNOWN);
  assert.equal(memory.toolCalls.get('runtime-107-tool-call')?.risk, RunToolRisk.EXTERNAL_COMMUNICATION);

  const replayAttempt = await invocationService(
    invoke,
    'external_communication',
    new PersistentToolIdempotencyStore(() => memory.createUnitOfWork()),
  ).invoke(invocationRequest(run.id));
  assert.equal(replayAttempt.error?.code, 'uncertain_side_effect');
  assert.equal(externalWrites, 1);
});

test('只读调用崩溃后可由新实例重新打开并安全重试', async () => {
  const memory = new IdempotencyMemoryStore();
  const run = runningRun('run-runtime-107-read-retry');
  memory.seedRun(run);
  let reads = 0;
  const invoke = async (): Promise<ToolResult> => {
    reads += 1;
    return { success: true, data: `read-${reads}` };
  };
  const persistent = new PersistentToolIdempotencyStore(
    () => memory.createUnitOfWork(),
  );

  await assert.rejects(
    invocationService(
      invoke,
      'read',
      new FailBeforeResultPersistenceStore(persistent),
    ).invoke(invocationRequest(run.id)),
    /结果持久化前进程退出/,
  );
  const retried = await invocationService(
    invoke,
    'read',
    new PersistentToolIdempotencyStore(() => memory.createUnitOfWork()),
  ).invoke(invocationRequest(run.id));

  assert.equal(retried.success, true);
  assert.equal(retried.data, 'read-2');
  assert.equal(reads, 2);
  assert.equal(memory.toolCalls.get('runtime-107-tool-call')?.status, ToolCallStatus.COMPLETED);
});
