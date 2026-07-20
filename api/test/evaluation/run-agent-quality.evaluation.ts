import datasetDocument from './datasets/agent-quality.v1.json';
import {
  agentQualityEvaluationExitCode,
  runAgentQualityEvaluation,
} from './agent-quality.evaluation';
import {
  DurableRuntimeQualityEvaluator,
  RuntimeCoreQualityEvaluator,
} from './current-agent-quality.evaluators';

/** 执行 EVAL-101 当前基线、输出单一 JSON 并设置质量门槛退出码。 */
async function main(): Promise<void> {
  const report = await runAgentQualityEvaluation(datasetDocument, [
    new RuntimeCoreQualityEvaluator(),
    new DurableRuntimeQualityEvaluator(),
  ]);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = agentQualityEvaluationExitCode(report);
}

void main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    evaluationId: 'EVAL-101',
    passed: false,
    error: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
});
