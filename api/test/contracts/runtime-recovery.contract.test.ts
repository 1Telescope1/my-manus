import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AgentRun,
  Checkpoint,
  Interruption,
  InterruptionKind,
  InterruptionStatus,
  RouteKind,
  RunStatus,
  ToolCallRecord,
  ToolCallStatus,
  ToolRisk,
  canTransitionRunStatus,
  createAgentRun,
  createInterruption,
  createToolCallRecord,
  transitionAgentRun,
} from '../../src/domain/models/agent-run';
import {
  AgentRunRepository,
  CheckpointAppendResult,
} from '../../src/domain/repositories/agent-run.repository';
import { UnitOfWork } from '../../src/domain/repositories/unit-of-work';
import {
  RuntimeCheckpointBoundary,
  RuntimeCheckpointCommitError,
  RuntimeCheckpointService,
} from '../../src/domain/services/runtime/checkpoint.service';
import {
  RuntimeRecoveryDisposition,
  RuntimeRecoveryReason,
  RuntimeRecoveryService,
} from '../../src/domain/services/runtime/recovery.service';

const NOW = new Date('2026-07-17T02:00:00.000Z');
const LATER = new Date('2026-07-17T02:01:00.000Z');

/** 为恢复契约测试提供带事务回滚能力的最小内存运行仓储。 */
class RuntimeMemoryStore {
  readonly runs = new Map<string, AgentRun>();
  readonly checkpoints: Checkpoint[] = [];
  readonly toolCalls: ToolCallRecord[] = [];
  readonly interruptions: Interruption[] = [];
  appendFailure: CheckpointAppendResult | null = null;

  /** 写入测试初始 Run。 */
  seedRun(run: AgentRun): void {
    this.runs.set(run.id, run);
  }

  /** 写入测试初始 ToolCall。 */
  seedToolCall(toolCall: ToolCallRecord): void {
    this.toolCalls.push(toolCall);
  }

  /** 写入测试初始 Interruption。 */
  seedInterruption(interruption: Interruption): void {
    this.interruptions.push(interruption);
  }

  /** 返回供领域服务使用的事务 UnitOfWork。 */
  createUnitOfWork(): UnitOfWork {
    const repository = this.createRepository();
    const unitOfWork = {
      agentRun: repository,
      file: {},
      session: {},
      run: async <T>(handler: (active: UnitOfWork) => Promise<T>): Promise<T> => {
        const snapshot = this.snapshot();
        try {
          return await handler(unitOfWork as UnitOfWork);
        } catch (error) {
          this.restore(snapshot);
          throw error;
        }
      },
    } as UnitOfWork;
    return unitOfWork;
  }

  /** 创建本组测试实际使用的 AgentRunRepository 方法集合。 */
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
          current.status !== candidate.status
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
      appendCheckpoint: async (checkpoint: Checkpoint) => {
        if (this.appendFailure) {
          return this.appendFailure;
        }
        const latest = this.latestCheckpoint(checkpoint.runId);
        const expectedSequence = latest ? latest.sequence + 1 : 0;
        if (checkpoint.sequence !== expectedSequence) {
          return { outcome: 'sequence_conflict' as const, expectedSequence };
        }
        this.checkpoints.push(checkpoint);
        return { outcome: 'appended' as const, checkpoint };
      },
      getLatestCheckpoint: async (runId: string) => this.latestCheckpoint(runId),
      getIncompleteToolCalls: async (runId: string) => this.toolCalls.filter(
        (toolCall) =>
          toolCall.runId === runId
          && [
            ToolCallStatus.PENDING,
            ToolCallStatus.RUNNING,
            ToolCallStatus.UNKNOWN,
          ].includes(toolCall.status),
      ),
      listToolCalls: async (runId: string) => this.toolCalls.filter(
        (toolCall) => toolCall.runId === runId,
      ),
      updateToolCall: async (
        candidate: ToolCallRecord,
        expectedStatus: ToolCallStatus,
      ) => {
        const index = this.toolCalls.findIndex((toolCall) => toolCall.id === candidate.id);
        if (index < 0) {
          return { outcome: 'not_found' as const };
        }
        const current = this.toolCalls[index];
        if (current.status !== expectedStatus) {
          return {
            outcome: 'status_conflict' as const,
            actualStatus: current.status,
          };
        }
        this.toolCalls[index] = candidate;
        return { outcome: 'updated' as const, entity: candidate };
      },
      getPendingInterruptions: async (runId: string) => this.interruptions.filter(
        (interruption) =>
          interruption.runId === runId
          && interruption.status === InterruptionStatus.PENDING,
      ),
    } as unknown as AgentRunRepository;
  }

  /** 返回指定 Run 中序号最大的 Checkpoint。 */
  private latestCheckpoint(runId: string): Checkpoint | null {
    return this.checkpoints
      .filter((checkpoint) => checkpoint.runId === runId)
      .sort((left, right) => right.sequence - left.sequence)[0] ?? null;
  }

  /** 捕获事务开始前的全部可变状态。 */
  private snapshot(): RuntimeMemorySnapshot {
    return {
      runs: new Map(this.runs),
      checkpoints: [...this.checkpoints],
      toolCalls: [...this.toolCalls],
      interruptions: [...this.interruptions],
    };
  }

  /** 在事务失败时恢复全部内存状态。 */
  private restore(snapshot: RuntimeMemorySnapshot): void {
    replaceMap(this.runs, snapshot.runs);
    this.checkpoints.splice(0, this.checkpoints.length, ...snapshot.checkpoints);
    this.toolCalls.splice(0, this.toolCalls.length, ...snapshot.toolCalls);
    this.interruptions.splice(0, this.interruptions.length, ...snapshot.interruptions);
  }
}

type RuntimeMemorySnapshot = {
  runs: Map<string, AgentRun>;
  checkpoints: Checkpoint[];
  toolCalls: ToolCallRecord[];
  interruptions: Interruption[];
};

/** 用源 Map 的内容替换目标 Map。 */
function replaceMap<Key, Value>(target: Map<Key, Value>, source: Map<Key, Value>): void {
  target.clear();
  for (const [key, value] of source) {
    target.set(key, value);
  }
}

/** 创建处于 running 的确定性测试 Run。 */
function createRunningRun(id: string): AgentRun {
  return transitionAgentRun(
    createAgentRun({
      id,
      sessionId: 'session-recovery',
      route: RouteKind.PLANNED_AGENT,
    }),
    { status: RunStatus.RUNNING, at: NOW },
  );
}

/** 创建服务并让它们共享同一个内存持久化状态。 */
function createServices(store: RuntimeMemoryStore): {
  checkpoint: RuntimeCheckpointService;
  recovery: RuntimeRecoveryService;
} {
  const factory = () => store.createUnitOfWork();
  return {
    checkpoint: new RuntimeCheckpointService(factory),
    recovery: new RuntimeRecoveryService(factory),
  };
}

// 所有 SDD 指定边界都必须具有稳定持久化值。
test('Checkpoint 边界应覆盖路由、模型、步骤、工具、等待、Handoff 和终态', () => {
  assert.deepEqual(Object.values(RuntimeCheckpointBoundary), [
    'route_completed',
    'model_calling',
    'model_completed',
    'step_starting',
    'step_completed',
    'side_effect_submitting',
    'tool_result_persisted',
    'entering_wait',
    'entering_pause',
    'handoff_starting',
    'handoff_completed',
    'entering_terminal',
  ]);
});

// 模拟模型调用前进程崩溃，新服务实例必须从模型调用节点恢复。
test('模型调用前崩溃时应从模型节点恢复并延续已持久化事件序号', async () => {
  const store = new RuntimeMemoryStore();
  const run = createRunningRun('run-before-model');
  store.seedRun(run);
  const services = createServices(store);

  await services.checkpoint.commit({
    run,
    expectedVersion: 0,
    boundary: RuntimeCheckpointBoundary.MODEL_CALLING,
    resumeNode: 'planner.invoke_model',
    nextEventSequence: 7,
    state: { promptVersion: 'v1' },
    checkpointId: 'checkpoint-before-model',
    createdAt: NOW,
  });

  const restarted = new RuntimeRecoveryService(() => store.createUnitOfWork());
  const plan = await restarted.resolve(run.id);
  assert.equal(plan?.disposition, RuntimeRecoveryDisposition.RESUME);
  assert.equal(plan?.resumeNode, 'planner.invoke_model');
  assert.equal(plan?.nextEventSequence, 7);
  assert.equal(plan?.state.checkpointBoundary, RuntimeCheckpointBoundary.MODEL_CALLING);
});

// 模拟模型完成后进程崩溃，恢复点必须跳过已经完成的模型调用。
test('模型完成后崩溃时应携带模型输出从下一节点恢复', async () => {
  const store = new RuntimeMemoryStore();
  const run = createRunningRun('run-after-model');
  store.seedRun(run);
  const services = createServices(store);

  const before = await services.checkpoint.commit({
    run,
    expectedVersion: 0,
    boundary: RuntimeCheckpointBoundary.MODEL_CALLING,
    resumeNode: 'planner.invoke_model',
    nextEventSequence: 3,
    state: {},
    checkpointId: 'checkpoint-model-0',
    createdAt: NOW,
  });
  await services.checkpoint.commit({
    run: before.run,
    expectedVersion: 1,
    boundary: RuntimeCheckpointBoundary.MODEL_COMPLETED,
    resumeNode: 'planner.apply_result',
    nextEventSequence: 4,
    state: { modelOutput: { steps: ['execute'] } },
    checkpointId: 'checkpoint-model-1',
    createdAt: LATER,
  });

  const plan = await new RuntimeRecoveryService(() => store.createUnitOfWork())
    .resolve(run.id);
  assert.equal(plan?.resumeNode, 'planner.apply_result');
  assert.deepEqual(plan?.state.modelOutput, { steps: ['execute'] });
  assert.equal(plan?.checkpoint?.sequence, 1);
});

// 工具结果已经持久化时，恢复计划应提供结果复用集合并跳过工具执行节点。
test('工具结果持久化后崩溃时应复用结果并从工具后续节点恢复', async () => {
  const store = new RuntimeMemoryStore();
  const run = createRunningRun('run-after-tool');
  store.seedRun(run);
  const completedToolCall: ToolCallRecord = {
    ...createToolCallRecord({
      id: 'tool-completed',
      runId: run.id,
      stepId: 'step-tool',
      toolName: 'search',
      arguments: { query: 'runtime recovery' },
      risk: ToolRisk.READ,
      idempotencyKey: 'search:1',
      requestFingerprint: 'sha256:search',
    }),
    status: ToolCallStatus.COMPLETED,
    result: { items: ['saved'] },
    startedAt: NOW,
    completedAt: LATER,
  };
  store.seedToolCall(completedToolCall);

  await createServices(store).checkpoint.commit({
    run,
    expectedVersion: 0,
    boundary: RuntimeCheckpointBoundary.TOOL_RESULT_PERSISTED,
    resumeNode: 'step.consume_tool_result',
    nextEventSequence: 12,
    state: { toolCallId: completedToolCall.id },
    checkpointId: 'checkpoint-after-tool',
    createdAt: LATER,
  });

  const plan = await new RuntimeRecoveryService(() => store.createUnitOfWork())
    .resolve(run.id);
  assert.equal(plan?.disposition, RuntimeRecoveryDisposition.RESUME);
  assert.equal(plan?.resumeNode, 'step.consume_tool_result');
  assert.deepEqual(plan?.reusableToolCalls, [completedToolCall]);
});

// 进行中或 unknown 的副作用调用状态不确定，恢复时必须暂停而不是重放。
test('副作用状态不确定时应暂停恢复，只读调用仍可安全重试', async () => {
  const store = new RuntimeMemoryStore();
  const run = createRunningRun('run-uncertain-tool');
  store.seedRun(run);
  await createServices(store).checkpoint.commit({
    run,
    expectedVersion: 0,
    boundary: RuntimeCheckpointBoundary.SIDE_EFFECT_SUBMITTING,
    resumeNode: 'tool.invoke',
    nextEventSequence: 5,
    state: {},
  });

  const runningWrite: ToolCallRecord = {
    ...createToolCallRecord({
      id: 'tool-uncertain-write',
      runId: run.id,
      stepId: 'step-write',
      toolName: 'send_email',
      risk: ToolRisk.EXTERNAL_COMMUNICATION,
      idempotencyKey: 'email:1',
      requestFingerprint: 'sha256:email',
    }),
    status: ToolCallStatus.RUNNING,
    startedAt: NOW,
  };
  const runningRead: ToolCallRecord = {
    ...createToolCallRecord({
      id: 'tool-running-read',
      runId: run.id,
      stepId: 'step-read',
      toolName: 'search',
      risk: ToolRisk.READ,
      idempotencyKey: 'search:2',
      requestFingerprint: 'sha256:read',
    }),
    status: ToolCallStatus.UNKNOWN,
    startedAt: NOW,
  };
  store.seedToolCall(runningWrite);
  store.seedToolCall(runningRead);

  const plan = await createServices(store).recovery.resolve(run.id);
  assert.equal(plan?.disposition, RuntimeRecoveryDisposition.PAUSE);
  assert.equal(plan?.reason, RuntimeRecoveryReason.UNCERTAIN_SIDE_EFFECT);
  assert.equal(plan?.run.status, RunStatus.PAUSED);
  assert.deepEqual(plan?.unresolvedToolCalls, [{
    ...runningWrite,
    status: ToolCallStatus.UNKNOWN,
  }]);
  assert.deepEqual(plan?.retryableToolCalls, [runningRead]);
  assert.equal(store.toolCalls[0]?.status, ToolCallStatus.UNKNOWN);
  assert.equal(store.runs.get(run.id)?.status, RunStatus.PAUSED);
});

// 待用户输入恢复为 WAIT，待审批恢复为更高优先级的 PAUSE。
test('待处理中断应根据类型恢复为等待或暂停', async () => {
  const waitingStore = new RuntimeMemoryStore();
  const waitingRun = createRunningRun('run-waiting');
  waitingStore.seedRun(waitingRun);
  await createServices(waitingStore).checkpoint.commit({
    run: waitingRun,
    expectedVersion: 0,
    boundary: RuntimeCheckpointBoundary.ENTERING_WAIT,
    resumeNode: 'input.apply',
    nextEventSequence: 2,
    state: {},
  });
  waitingStore.seedInterruption(createInterruption({
    id: 'input-interruption',
    runId: waitingRun.id,
    kind: InterruptionKind.USER_INPUT,
  }));
  assert.equal(
    (await createServices(waitingStore).recovery.resolve(waitingRun.id))?.disposition,
    RuntimeRecoveryDisposition.WAIT,
  );

  waitingStore.seedInterruption(createInterruption({
    id: 'approval-interruption',
    runId: waitingRun.id,
    kind: InterruptionKind.APPROVAL,
  }));
  assert.equal(
    (await createServices(waitingStore).recovery.resolve(waitingRun.id))?.disposition,
    RuntimeRecoveryDisposition.PAUSE,
  );
});

// Checkpoint 追加冲突必须回滚已经成功的 Run version/游标更新。
test('Checkpoint 冲突应在同一 UnitOfWork 中回滚 Run 游标和版本', async () => {
  const store = new RuntimeMemoryStore();
  const run = createRunningRun('run-checkpoint-conflict');
  store.seedRun(run);
  store.appendFailure = { outcome: 'sequence_conflict', expectedSequence: 0 };

  await assert.rejects(
    createServices(store).checkpoint.commit({
      run,
      expectedVersion: 0,
      boundary: RuntimeCheckpointBoundary.STEP_STARTING,
      resumeNode: 'step.execute',
      nextEventSequence: 1,
      state: {},
    }),
    (error: unknown) =>
      error instanceof RuntimeCheckpointCommitError
      && error.phase === 'checkpoint',
  );

  assert.equal(store.runs.get(run.id)?.version, 0);
  assert.equal(store.runs.get(run.id)?.currentNode, null);
  assert.equal(store.checkpoints.length, 0);
});

// Run version 已变化时，提交必须在追加 Checkpoint 前停止。
test('Run 版本冲突时不应追加 Checkpoint', async () => {
  const store = new RuntimeMemoryStore();
  const run = createRunningRun('run-version-conflict');
  store.seedRun({ ...run, version: 1 });

  await assert.rejects(
    createServices(store).checkpoint.commit({
      run,
      expectedVersion: 0,
      boundary: RuntimeCheckpointBoundary.STEP_COMPLETED,
      resumeNode: 'step.next',
      nextEventSequence: 2,
      state: {},
    }),
    (error: unknown) =>
      error instanceof RuntimeCheckpointCommitError
      && error.phase === 'run',
  );

  assert.equal(store.runs.get(run.id)?.version, 1);
  assert.equal(store.checkpoints.length, 0);
});

// 终态、等待和暂停 Run 不会被自动调度；普通 Run 缺快照时返回明确结果。
test('终态、暂停态和缺少 Checkpoint 的 Run 不应作为普通可恢复任务调度', async () => {
  const store = new RuntimeMemoryStore();
  const running = createRunningRun('run-no-checkpoint');
  const waiting = transitionAgentRun(
    createRunningRun('run-waiting-without-interruption'),
    { status: RunStatus.WAITING, at: LATER },
  );
  const paused = transitionAgentRun(
    createRunningRun('run-paused-without-interruption'),
    { status: RunStatus.PAUSED, at: LATER },
  );
  const completed = transitionAgentRun(
    createRunningRun('run-terminal'),
    { status: RunStatus.COMPLETED, at: LATER },
  );
  store.seedRun(running);
  store.seedRun(waiting);
  store.seedRun(paused);
  store.seedRun(completed);

  const recovery = createServices(store).recovery;
  assert.equal(
    (await recovery.resolve(running.id))?.disposition,
    RuntimeRecoveryDisposition.NO_CHECKPOINT,
  );
  assert.equal(
    (await recovery.resolve(completed.id))?.disposition,
    RuntimeRecoveryDisposition.TERMINAL,
  );
  assert.equal(
    (await recovery.resolve(waiting.id))?.disposition,
    RuntimeRecoveryDisposition.WAIT,
  );
  assert.equal(
    (await recovery.resolve(paused.id))?.disposition,
    RuntimeRecoveryDisposition.PAUSE,
  );
});
