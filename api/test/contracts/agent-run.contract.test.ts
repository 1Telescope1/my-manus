import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AgentRun,
  AgentRunTransition,
  CancellationOutcome,
  createAgentRun,
  createCheckpoint,
  createInterruption,
  createRunStep,
  createToolCallRecord,
  getAllowedRunStatusTransitions,
  InterruptionKind,
  InterruptionStatus,
  InvalidRunStatusTransitionError,
  isTerminalRunStatus,
  MissingAgentRunCancellationRequestError,
  MissingAgentRunFailureError,
  MissingAgentRunUncertainOperationsError,
  requestAgentRunCancellation,
  RouteKind,
  RunStatus,
  RunStepKind,
  RunStepStatus,
  TerminalAgentRunCancellationRequestError,
  ToolCallStatus,
  ToolRisk,
  transitionAgentRun,
} from '../../src/domain/models/agent-run';
import {
  AgentRunRepository,
  AgentRunUpdateResult,
  CheckpointAppendResult,
  ToolCallReservationResult,
} from '../../src/domain/repositories/agent-run.repository';

const TRANSITION_AT = new Date('2026-07-17T02:00:00.000Z');
const REQUESTED_AT = new Date('2026-07-17T01:30:00.000Z');

const LEGAL_TRANSITIONS: ReadonlyArray<readonly [RunStatus, RunStatus]> = [
  [RunStatus.CREATED, RunStatus.RUNNING],
  [RunStatus.CREATED, RunStatus.CANCELLED],
  [RunStatus.RUNNING, RunStatus.WAITING],
  [RunStatus.RUNNING, RunStatus.PAUSED],
  [RunStatus.RUNNING, RunStatus.COMPLETED],
  [RunStatus.RUNNING, RunStatus.FAILED],
  [RunStatus.RUNNING, RunStatus.CANCELLED],
  [RunStatus.WAITING, RunStatus.RUNNING],
  [RunStatus.WAITING, RunStatus.CANCELLED],
  [RunStatus.PAUSED, RunStatus.RUNNING],
  [RunStatus.PAUSED, RunStatus.CANCELLED],
];

const ALL_STATUSES = Object.values(RunStatus);
const TERMINAL_STATUSES: RunStatus[] = [
  RunStatus.COMPLETED,
  RunStatus.FAILED,
  RunStatus.CANCELLED,
];

function runWithStatus(status: RunStatus): AgentRun {
  const terminal = TERMINAL_STATUSES.includes(status);
  return {
    ...createAgentRun({
      id: `run-${status}`,
      sessionId: 'session-1',
      route: RouteKind.PLANNED_AGENT,
      currentNode: 'node-1',
      metadata: { source: 'test' },
    }),
    status,
    cancelRequestedAt: status === RunStatus.CANCELLED ? REQUESTED_AT : null,
    startedAt: status === RunStatus.CREATED
      ? null
      : new Date('2026-07-17T01:00:00.000Z'),
    completedAt: terminal ? TRANSITION_AT : null,
    error: status === RunStatus.FAILED ? '测试失败' : null,
  };
}

function transitionTo(status: RunStatus): AgentRunTransition {
  if (status === RunStatus.FAILED) {
    return { status, at: TRANSITION_AT, error: '模型输出校验失败' };
  }
  if (status === RunStatus.CANCELLED) {
    return {
      status,
      at: TRANSITION_AT,
      cancellation: { outcome: CancellationOutcome.CONFIRMED },
    };
  }
  return {
    status: status as Exclude<RunStatus, RunStatus.FAILED | RunStatus.CANCELLED>,
    at: TRANSITION_AT,
  };
}

test('五类运行实体工厂应只产生可持久化的完整初始状态', () => {
  const run = createAgentRun({
    id: 'run-1',
    sessionId: 'session-1',
    route: RouteKind.WORKFLOW,
    metadata: { workflow: 'research' },
  });
  const step = createRunStep({
    id: 'step-1',
    runId: run.id,
    key: 'collect',
    kind: RunStepKind.TOOL,
    input: { query: 'runtime' },
  });
  const toolCall = createToolCallRecord({
    id: 'call-1',
    runId: run.id,
    stepId: step.id,
    toolName: 'search',
    arguments: { query: 'runtime' },
    risk: ToolRisk.READ,
    idempotencyKey: 'run-1:step-1:call-1',
    requestFingerprint: 'sha256:search-runtime',
  });
  const checkpoint = createCheckpoint({
    id: 'checkpoint-1',
    runId: run.id,
    sequence: 0,
    resumeNode: 'execute-first-step',
    nextEventSequence: 8,
    state: { route: run.route },
    createdAt: new Date('2026-07-17T00:00:00.000Z'),
  });
  const interruption = createInterruption({
    id: 'interruption-1',
    runId: run.id,
    kind: InterruptionKind.APPROVAL,
    payload: { toolCallId: toolCall.id },
  });

  assert.deepEqual(run, {
    id: 'run-1',
    sessionId: 'session-1',
    route: RouteKind.WORKFLOW,
    status: RunStatus.CREATED,
    currentNode: null,
    version: 0,
    cancelRequestedAt: null,
    startedAt: null,
    completedAt: null,
    error: null,
    metadata: { workflow: 'research' },
  });
  assert.deepEqual(
    [step.status, step.attempt, step.output, step.error],
    [RunStepStatus.PENDING, 1, null, null],
  );
  assert.deepEqual(
    [toolCall.status, toolCall.result, toolCall.startedAt, toolCall.completedAt],
    [ToolCallStatus.PENDING, null, null, null],
  );
  assert.deepEqual(
    [checkpoint.sequence, checkpoint.resumeNode, checkpoint.nextEventSequence],
    [0, 'execute-first-step', 8],
  );
  assert.deepEqual(
    [interruption.status, interruption.resolution],
    [InterruptionStatus.PENDING, null],
  );

  if (false) {
    // @ts-expect-error 状态只能通过领域转换产生，不能直接赋值。
    run.status = RunStatus.COMPLETED;
  }
});

test('Run 状态机应允许 SDD 中定义的全部 11 条转换', () => {
  assert.equal(LEGAL_TRANSITIONS.length, 11);

  for (const [from, to] of LEGAL_TRANSITIONS) {
    let run = runWithStatus(from);
    if (to === RunStatus.CANCELLED) {
      run = requestAgentRunCancellation(run, REQUESTED_AT);
    }

    const transitioned = transitionAgentRun(run, transitionTo(to));

    assert.equal(transitioned.status, to, `${from} -> ${to}`);
    assert.ok(getAllowedRunStatusTransitions(from).includes(to), `${from} -> ${to}`);
  }
});

test('Run 状态机应拒绝全部未定义转换且不修改原快照', () => {
  const legal = new Set(LEGAL_TRANSITIONS.map(([from, to]) => `${from}:${to}`));
  let rejected = 0;

  for (const from of ALL_STATUSES) {
    for (const to of ALL_STATUSES) {
      if (legal.has(`${from}:${to}`)) {
        continue;
      }

      const run = runWithStatus(from);
      const before = { ...run, metadata: { ...run.metadata } };

      assert.throws(
        () => transitionAgentRun(run, transitionTo(to)),
        (error: unknown) => error instanceof InvalidRunStatusTransitionError
          && error.from === from
          && error.to === to
          && error.code === 'INVALID_RUN_STATUS_TRANSITION',
        `${from} -> ${to} 应被拒绝`,
      );
      assert.deepEqual(run, before);
      rejected += 1;
    }
  }

  assert.equal(rejected, (ALL_STATUSES.length ** 2) - LEGAL_TRANSITIONS.length);
});

test('终态应没有任何后继状态', () => {
  for (const status of TERMINAL_STATUSES) {
    assert.equal(isTerminalRunStatus(status), true);
    assert.deepEqual(getAllowedRunStatusTransitions(status), []);
  }

  for (const status of ALL_STATUSES.filter((value) => !TERMINAL_STATUSES.includes(value))) {
    assert.equal(isTerminalRunStatus(status), false);
  }
});

test('状态转换应维护生命周期字段、清理陈旧错误且保持版本不变', () => {
  const startedAt = new Date('2026-07-17T01:00:00.000Z');
  const completedAt = new Date('2026-07-17T03:00:00.000Z');
  const created = createAgentRun({
    id: 'run-1',
    sessionId: 'session-1',
    route: RouteKind.DIRECT,
  });

  const running = transitionAgentRun(created, { status: RunStatus.RUNNING, at: startedAt });
  const waiting = transitionAgentRun(running, { status: RunStatus.WAITING, at: TRANSITION_AT });
  const resumed = transitionAgentRun(waiting, { status: RunStatus.RUNNING, at: TRANSITION_AT });
  const failed = transitionAgentRun(resumed, {
    status: RunStatus.FAILED,
    at: completedAt,
    error: '模型输出校验失败',
  });

  const runningWithStaleError = { ...running, error: '瞬时错误' } as AgentRun;
  const completed = transitionAgentRun(runningWithStaleError, {
    status: RunStatus.COMPLETED,
    at: completedAt,
  });

  assert.equal(created.startedAt, null);
  assert.equal(running.startedAt, startedAt);
  assert.equal(resumed.startedAt, startedAt);
  assert.equal(failed.completedAt, completedAt);
  assert.equal(failed.error, '模型输出校验失败');
  assert.equal(failed.version, 0);
  assert.equal(completed.error, null);
});

test('显式转换时间应使相同输入产生相同输出', () => {
  const run = createAgentRun({ sessionId: 'session-1', route: RouteKind.DIRECT });
  const transition: AgentRunTransition = { status: RunStatus.RUNNING, at: TRANSITION_AT };

  assert.deepEqual(
    transitionAgentRun(run, transition),
    transitionAgentRun(run, transition),
  );
});

test('failed 必须提供非空错误，非 failed 状态不接受 error 参数', () => {
  const running = runWithStatus(RunStatus.RUNNING);

  assert.throws(
    () => transitionAgentRun(running, {
      status: RunStatus.FAILED,
      at: TRANSITION_AT,
      error: '   ',
    }),
    (error: unknown) => error instanceof MissingAgentRunFailureError,
  );

  if (false) {
    // @ts-expect-error failed 转换必须显式提供 error。
    transitionAgentRun(running, { status: RunStatus.FAILED, at: TRANSITION_AT });
    transitionAgentRun(running, {
      status: RunStatus.COMPLETED,
      at: TRANSITION_AT,
      // @ts-expect-error 非 failed 转换不能携带 error。
      error: '不应出现',
    });
  }
});

test('cancelled 必须先有取消请求并携带确认结果', () => {
  const running = runWithStatus(RunStatus.RUNNING);
  const cancellation = {
    status: RunStatus.CANCELLED,
    at: TRANSITION_AT,
    cancellation: { outcome: CancellationOutcome.CONFIRMED },
  } as const;

  assert.throws(
    () => transitionAgentRun(running, cancellation),
    (error: unknown) => error instanceof MissingAgentRunCancellationRequestError,
  );

  const requested = requestAgentRunCancellation(running, REQUESTED_AT);
  const cancelled = transitionAgentRun(requested, cancellation);
  assert.equal(cancelled.status, RunStatus.CANCELLED);
  assert.equal(cancelled.cancelRequestedAt, REQUESTED_AT);
  assert.deepEqual(cancelled.metadata.cancellation, { outcome: CancellationOutcome.CONFIRMED });

  const timedOut = transitionAgentRun(requested, {
    status: RunStatus.CANCELLED,
    at: TRANSITION_AT,
    cancellation: {
      outcome: CancellationOutcome.TIMED_OUT,
      uncertainOperationIds: ['tool-call-1'],
    },
  });
  assert.deepEqual(timedOut.metadata.cancellation, {
    outcome: CancellationOutcome.TIMED_OUT,
    uncertainOperationIds: ['tool-call-1'],
  });

  assert.throws(
    () => transitionAgentRun(requested, {
      status: RunStatus.CANCELLED,
      at: TRANSITION_AT,
      cancellation: {
        outcome: CancellationOutcome.TIMED_OUT,
        uncertainOperationIds: [],
      },
    }),
    (error: unknown) => error instanceof MissingAgentRunUncertainOperationsError,
  );
});

test('取消请求只设置时间标记，并拒绝修改终态', () => {
  const requestedAt = new Date('2026-07-17T04:00:00.000Z');
  const running = runWithStatus(RunStatus.RUNNING);
  const requested = requestAgentRunCancellation(running, requestedAt);
  const duplicateRequest = requestAgentRunCancellation(
    requested,
    new Date('2026-07-17T05:00:00.000Z'),
  );

  assert.equal(requested.status, RunStatus.RUNNING);
  assert.equal(requested.cancelRequestedAt, requestedAt);
  assert.equal(duplicateRequest.cancelRequestedAt, requestedAt);
  assert.equal(running.cancelRequestedAt, null);

  for (const terminalStatus of TERMINAL_STATUSES) {
    assert.throws(
      () => requestAgentRunCancellation(runWithStatus(terminalStatus), requestedAt),
      (error: unknown) => error instanceof TerminalAgentRunCancellationRequestError
        && error.status === terminalStatus,
    );
  }
});

test('仓储端口应显式建模 CAS、非法转换、幂等占用和 Checkpoint 冲突', async () => {
  function describeUpdate(result: AgentRunUpdateResult): string {
    switch (result.outcome) {
      case 'updated':
        return `v${result.run.version}`;
      case 'not_found':
        return 'missing';
      case 'version_conflict':
        return `conflict:v${result.actualVersion}`;
      case 'invalid_status_transition':
        return `invalid:${result.from}->${result.to}`;
    }
  }

  const persisted = { ...runWithStatus(RunStatus.RUNNING), version: 1 };
  assert.equal(describeUpdate({ outcome: 'updated', run: persisted }), 'v1');
  assert.equal(describeUpdate({ outcome: 'not_found' }), 'missing');
  assert.equal(
    describeUpdate({ outcome: 'version_conflict', actualVersion: 3 }),
    'conflict:v3',
  );
  assert.equal(
    describeUpdate({
      outcome: 'invalid_status_transition',
      from: RunStatus.CREATED,
      to: RunStatus.COMPLETED,
    }),
    'invalid:created->completed',
  );

  const updatePort: AgentRunRepository['update'] = async (run, expectedVersion) => ({
    outcome: 'updated',
    run: { ...run, version: expectedVersion + 1 },
  });
  const updateResult = await updatePort(runWithStatus(RunStatus.RUNNING), 4);
  assert.equal(updateResult.outcome, 'updated');
  assert.equal(updateResult.outcome === 'updated' ? updateResult.run.version : null, 5);

  const reservation: ToolCallReservationResult = {
    outcome: 'existing',
    toolCall: createToolCallRecord({
      runId: 'run-1',
      stepId: 'step-1',
      toolName: 'search',
      risk: ToolRisk.READ,
      idempotencyKey: 'stable-key',
      requestFingerprint: 'sha256:stable-request',
    }),
  };
  assert.equal(reservation.outcome, 'existing');

  const keyConflict: ToolCallReservationResult = {
    outcome: 'key_conflict',
    existingToolCall: reservation.toolCall,
  };
  assert.equal(keyConflict.existingToolCall.requestFingerprint, 'sha256:stable-request');

  const checkpointConflict: CheckpointAppendResult = {
    outcome: 'sequence_conflict',
    expectedSequence: 2,
  };
  assert.equal(checkpointConflict.expectedSequence, 2);

  const eventSequenceRegression: CheckpointAppendResult = {
    outcome: 'event_sequence_regression',
    minimumNextEventSequence: 8,
  };
  assert.equal(eventSequenceRegression.minimumNextEventSequence, 8);
});

test('attempt、Checkpoint 和事件水位应拒绝不可持久化的数值', () => {
  assert.throws(
    () => createRunStep({
      runId: 'run-1',
      key: 'invalid',
      kind: RunStepKind.MODEL,
      attempt: 0,
    }),
    /RunStep\.attempt 必须是正安全整数/,
  );
  assert.throws(
    () => createCheckpoint({
      runId: 'run-1',
      sequence: -1,
      resumeNode: 'invalid',
      nextEventSequence: 0,
    }),
    /Checkpoint\.sequence 必须是非负安全整数/,
  );
  assert.throws(
    () => createCheckpoint({
      runId: 'run-1',
      sequence: 0,
      resumeNode: 'invalid',
      nextEventSequence: Number.NaN,
    }),
    /Checkpoint\.nextEventSequence 必须是非负安全整数/,
  );
  assert.throws(
    () => createToolCallRecord({
      runId: 'run-1',
      stepId: 'step-1',
      toolName: 'search',
      risk: ToolRisk.READ,
      idempotencyKey: 'stable-key',
      requestFingerprint: '   ',
    }),
    /ToolCallRecord\.requestFingerprint 不能为空/,
  );
});
