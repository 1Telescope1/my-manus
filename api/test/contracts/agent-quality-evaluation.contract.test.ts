import assert from 'node:assert/strict';
import test from 'node:test';
import { RouteKind } from '../../src/domain/models/agent-run';
import datasetDocument from '../evaluation/datasets/agent-quality.v1.json';
import {
  AGENT_QUALITY_REQUIRED_SDD_SCENARIOS,
  AgentQualityEvaluator,
  AgentQualityObservation,
  agentQualityEvaluationExitCode,
  parseAgentQualityDataset,
  runAgentQualityEvaluation,
} from '../evaluation/agent-quality.evaluation';
import {
  DurableRuntimeQualityEvaluator,
  RuntimeCoreQualityEvaluator,
} from '../evaluation/current-agent-quality.evaluators';

test('版本化任务集应覆盖 SDD 全部固定场景且稳定 ID 不重复', () => {
  const dataset = parseAgentQualityDataset(datasetDocument);

  assert.equal(dataset.schemaVersion, 1);
  assert.equal(dataset.datasetVersion, '1.0.0');
  assert.equal(dataset.tasks.length, 23);
  assert.equal(new Set(dataset.tasks.map((task) => task.id)).size, dataset.tasks.length);
  assert.deepEqual(
    [...new Set(dataset.tasks.map((task) => task.sddScenario))].sort(),
    [...AGENT_QUALITY_REQUIRED_SDD_SCENARIOS].sort(),
  );
});

test('统一运行器应生成机器可读基线并明确保留未评测任务', async () => {
  const report = await runAgentQualityEvaluation(datasetDocument, [
    new RuntimeCoreQualityEvaluator(),
    new DurableRuntimeQualityEvaluator(),
  ], {
    now: () => new Date('2026-07-20T12:00:00.000Z'),
  });

  assert.equal(report.evaluationId, 'EVAL-101');
  assert.equal(report.dataset.totalTasks, 23);
  assert.equal(report.dataset.sddScenarios, 10);
  assert.deepEqual(report.summary, {
    enabledTasks: 9,
    evaluatedTasks: 9,
    passedTasks: 9,
    failedTasks: 0,
    notEvaluatedTasks: 14,
  });
  assert.equal(report.passed, true);
  assert.equal(report.metrics.taskSuccessRate, 1);
  assert.equal(report.metrics.toolSelectionAccuracy, 1);
  assert.equal(report.metrics.totalModelCalls, 7);
  assert.equal(report.metrics.modelCallsMeasuredTasks, 3);
  assert.equal(report.metrics.tokenUsage, null);
  assert.equal(report.metrics.recoverySuccessRate, 1);
  assert.equal(report.metrics.duplicateSideEffects, 0);
  assert.equal(report.metrics.toolCallsAfterCancellation, 0);
  assert.equal(report.results.filter((result) => result.status === 'not_evaluated').length, 14);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(report)));
  assert.equal(agentQualityEvaluationExitCode(report), 0);
});

test('相同任务集重复运行应保持任务判定和数据集指纹一致', async () => {
  const execute = () => runAgentQualityEvaluation(datasetDocument, [
    new RuntimeCoreQualityEvaluator(),
    new DurableRuntimeQualityEvaluator(),
  ], {
    now: () => new Date('2026-07-20T12:00:00.000Z'),
  });
  const first = await execute();
  const second = await execute();

  assert.equal(first.dataset.sha256, second.dataset.sha256);
  assert.deepEqual(resultDecisions(first.results), resultDecisions(second.results));
  assert.equal(first.metrics.taskSuccessRate, second.metrics.taskSuccessRate);
  assert.equal(first.metrics.toolSelectionAccuracy, second.metrics.toolSelectionAccuracy);
});

test('已启用任务结果不符合期望时应失败并返回非零退出码', async () => {
  const dataset = structuredClone(datasetDocument);
  for (const task of dataset.tasks) {
    task.execution.enabled = task.id === 'core.single_tool_query';
  }
  const report = await runAgentQualityEvaluation(dataset, [new IncorrectToolEvaluator()]);

  assert.equal(report.passed, false);
  assert.equal(report.summary.evaluatedTasks, 1);
  assert.equal(report.summary.failedTasks, 1);
  assert.equal(report.metrics.taskSuccessRate, 0);
  assert.equal(report.metrics.toolSelectionAccuracy, 0);
  assert.equal(agentQualityEvaluationExitCode(report), 1);
  assert.equal(
    report.results.find((result) => result.taskId === 'core.single_tool_query')
      ?.checks.find((item) => item.name === '工具调用序列最小且准确')?.passed,
    false,
  );
});

test('已启用 evaluator 未注册时应视为基线失败而非跳过', async () => {
  const dataset = structuredClone(datasetDocument);
  for (const task of dataset.tasks) {
    task.execution.enabled = task.id === 'core.simple_question';
  }
  const report = await runAgentQualityEvaluation(dataset, []);

  assert.equal(report.passed, false);
  assert.equal(report.summary.evaluatedTasks, 1);
  assert.equal(report.summary.failedTasks, 1);
  assert.equal(report.metrics.taskSuccessRate, 0);
  assert.match(
    report.results.find((result) => result.taskId === 'core.simple_question')?.error ?? '',
    /evaluator 未注册/,
  );
});

/** 故意返回错误工具，用于验证 grader 和退出码。 */
class IncorrectToolEvaluator implements AgentQualityEvaluator {
  readonly id = 'runtime_core';

  /** 返回终态正确但工具选择错误的 observation。 */
  async evaluate(): Promise<AgentQualityObservation> {
    return {
      outcome: 'completed',
      route: RouteKind.SINGLE_TOOL,
      response: 'Runtime',
      toolCalls: ['browser_navigate'],
      activatedSkills: [],
      artifactKinds: [],
      metrics: {
        modelCalls: 2,
        toolCalls: 1,
        inputTokens: null,
        outputTokens: null,
        latencyMs: 1,
        recoverySucceeded: null,
        cancellationLatencyMs: null,
        duplicateSideEffects: 0,
        toolCallsAfterCancellation: 0,
      },
    };
  }
}

/** 去掉非确定耗时，只比较每个任务的稳定判定与检查。 */
function resultDecisions(
  results: Awaited<ReturnType<typeof runAgentQualityEvaluation>>['results'],
) {
  return results.map((result) => ({
    taskId: result.taskId,
    status: result.status,
    taskSucceeded: result.taskSucceeded,
    checks: result.checks,
    error: result.error,
  }));
}
