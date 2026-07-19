import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DurableRuntimeScenarioResult,
  durableRuntimeEvaluationExitCode,
  evaluateDurableRuntimeGates,
  runDurableRuntimeEvaluation,
} from '../evaluation/durable-runtime.evaluation';

test('耐久执行评测应覆盖四类故障并满足全部发布门槛', async () => {
  const report = await runDurableRuntimeEvaluation();

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.evaluationId, 'EVAL-103');
  assert.equal(report.passed, true);
  assert.equal(report.summary.totalScenarios, 6);
  assert.equal(report.summary.passedScenarios, 6);
  assert.equal(report.summary.recoveryScenarios, 4);
  assert.equal(report.summary.recoveredScenarios, 4);
  assert.deepEqual(
    [...new Set(report.scenarios.map((scenario) => scenario.category))].sort(),
    ['cancellation', 'crash', 'timeout', 'uncertain_side_effect'],
  );
  assert.ok(report.scenarios.every((scenario) => scenario.checks.length > 0));
  assert.ok(Object.values(report.gates).every((gate) => gate.passed));
  assert.equal(report.gates.recoverySuccessRate.actual, 1);
  assert.equal(report.gates.duplicateSideEffects.actual, 0);
  assert.equal(report.gates.toolCallsAfterCancellation.actual, 0);
  assert.equal(durableRuntimeEvaluationExitCode(report.gates), 0);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(report)));
});

test('重复副作用或恢复率不足时硬门槛必须失败', async () => {
  const report = await runDurableRuntimeEvaluation();
  const failingScenarios = structuredClone(report.scenarios) as DurableRuntimeScenarioResult[];
  failingScenarios[0].metrics.recoverySucceeded = false;
  failingScenarios[1].metrics.duplicateSideEffects = 1;

  const gates = evaluateDurableRuntimeGates(failingScenarios);

  assert.equal(gates.recoverySuccessRate.passed, false);
  assert.equal(gates.duplicateSideEffects.passed, false);
  assert.equal(gates.allScenariosPassed.passed, true);
  assert.equal(durableRuntimeEvaluationExitCode(gates), 1);
});

test('取消后出现新 ToolCall 时取消门槛必须失败', async () => {
  const report = await runDurableRuntimeEvaluation();
  const failingScenarios = structuredClone(report.scenarios) as DurableRuntimeScenarioResult[];
  const cancellation = failingScenarios.find(
    (scenario) => scenario.category === 'cancellation',
  );
  assert.ok(cancellation);
  cancellation.metrics.toolCallsAfterCancellation = 1;

  const gates = evaluateDurableRuntimeGates(failingScenarios);

  assert.equal(gates.toolCallsAfterCancellation.actual, 1);
  assert.equal(gates.toolCallsAfterCancellation.passed, false);
  assert.equal(durableRuntimeEvaluationExitCode(gates), 1);
});
