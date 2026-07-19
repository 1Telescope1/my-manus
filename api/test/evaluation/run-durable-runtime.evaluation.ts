import {
  durableRuntimeEvaluationExitCode,
  runDurableRuntimeEvaluation,
} from './durable-runtime.evaluation';

/** 运行 EVAL-103、输出单一 JSON，并用退出码暴露硬门槛结果。 */
async function main(): Promise<void> {
  const report = await runDurableRuntimeEvaluation();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = durableRuntimeEvaluationExitCode(report.gates);
}

void main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    evaluationId: 'EVAL-103',
    passed: false,
    error: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
});
