import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { RouteKind } from '../../src/domain/models/agent-run';

const outcomeSchema = z.enum(['completed', 'waiting', 'failed', 'cancelled']);
/** SDD §11.1 必须由固定任务集覆盖的十类场景。 */
export const AGENT_QUALITY_REQUIRED_SDD_SCENARIOS = [
  'simple_question',
  'single_tool_query',
  'complex_research',
  'file_artifact',
  'user_input_resume',
  'reliability_failures',
  'process_crashes',
  'cancellation_surfaces',
  'skill_boundaries',
  'multi_agent_boundaries',
] as const;

const sddScenarioSchema = z.enum(AGENT_QUALITY_REQUIRED_SDD_SCENARIOS);

/** 固定任务集文档的严格 Schema。 */
export const AgentQualityDatasetSchema = z.object({
  schemaVersion: z.literal(1),
  datasetId: z.string().trim().min(1),
  datasetVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  description: z.string().trim().min(1),
  tasks: z.array(z.object({
    id: z.string().regex(/^[a-z0-9_.-]+$/),
    sddScenario: sddScenarioSchema,
    description: z.string().trim().min(1),
    input: z.object({ message: z.string().trim().min(1) }).strict(),
    expected: z.object({
      outcome: outcomeSchema,
      route: z.nativeEnum(RouteKind).optional(),
      responseIncludes: z.array(z.string().min(1)).default([]),
      toolCalls: z.array(z.string().min(1)).optional(),
      activatedSkills: z.array(z.string().min(1)).optional(),
      artifactKinds: z.array(z.string().min(1)).optional(),
      recoverySucceeded: z.boolean().optional(),
      maxDuplicateSideEffects: z.number().int().nonnegative().optional(),
      maxToolCallsAfterCancellation: z.number().int().nonnegative().optional(),
    }).strict(),
    execution: z.object({
      evaluatorId: z.string().regex(/^[a-z0-9_-]+$/),
      scenarioId: z.string().regex(/^[a-z0-9_-]+$/),
      enabled: z.boolean(),
    }).strict(),
  }).strict()).min(1),
}).strict().superRefine((dataset, context) => {
  const ids = new Set<string>();
  for (const [index, task] of dataset.tasks.entries()) {
    if (ids.has(task.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `任务 ID 重复：${task.id}`,
        path: ['tasks', index, 'id'],
      });
    }
    ids.add(task.id);
  }
  const covered = new Set(dataset.tasks.map((task) => task.sddScenario));
  for (const scenario of AGENT_QUALITY_REQUIRED_SDD_SCENARIOS) {
    if (!covered.has(scenario)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `缺少 SDD 固定场景：${scenario}`,
        path: ['tasks'],
      });
    }
  }
});

export type AgentQualityDataset = z.infer<typeof AgentQualityDatasetSchema>;
export type AgentQualityTask = AgentQualityDataset['tasks'][number];
export type AgentQualityOutcome = z.infer<typeof outcomeSchema>;
export type AgentQualitySddScenario = z.infer<typeof sddScenarioSchema>;

/** evaluator 对一次任务执行的厂商无关观测。 */
export type AgentQualityObservation = {
  outcome: AgentQualityOutcome;
  route: RouteKind | null;
  response: string;
  toolCalls: string[];
  activatedSkills: string[];
  artifactKinds: string[];
  metrics: {
    modelCalls: number | null;
    toolCalls: number;
    inputTokens: number | null;
    outputTokens: number | null;
    latencyMs: number;
    recoverySucceeded: boolean | null;
    cancellationLatencyMs: number | null;
    duplicateSideEffects: number;
    toolCallsAfterCancellation: number;
  };
};

/** 一类可插入统一运行器的任务 evaluator。 */
export interface AgentQualityEvaluator {
  readonly id: string;
  /** 执行一个由自身 evaluatorId 选中的固定任务。 */
  evaluate(task: AgentQualityTask): Promise<AgentQualityObservation>;
}

/** 单条期望检查的机器可读结果。 */
export type AgentQualityCheck = {
  name: string;
  passed: boolean;
  expected: unknown;
  actual: unknown;
};

/** 单个固定任务的统一结果。 */
export type AgentQualityTaskResult = {
  taskId: string;
  sddScenario: AgentQualitySddScenario;
  evaluatorId: string;
  status: 'passed' | 'failed' | 'not_evaluated';
  taskSucceeded: boolean;
  checks: AgentQualityCheck[];
  observation: AgentQualityObservation | null;
  error: string | null;
};

/** 可归档并供 EVAL-106 比较的 EVAL-101 报告。 */
export type AgentQualityEvaluationReport = {
  schemaVersion: 1;
  evaluationId: 'EVAL-101';
  generatedAt: string;
  durationMs: number;
  passed: boolean;
  dataset: {
    id: string;
    version: string;
    sha256: string;
    totalTasks: number;
    sddScenarios: number;
  };
  summary: {
    enabledTasks: number;
    evaluatedTasks: number;
    passedTasks: number;
    failedTasks: number;
    notEvaluatedTasks: number;
  };
  metrics: {
    taskSuccessRate: number;
    toolSelectionAccuracy: number | null;
    totalModelCalls: number;
    modelCallsMeasuredTasks: number;
    totalToolCalls: number;
    tokenUsage: { input: number; output: number; total: number } | null;
    latencyP95Ms: number | null;
    recoverySuccessRate: number | null;
    cancellationLatencyP95Ms: number | null;
    duplicateSideEffects: number;
    toolCallsAfterCancellation: number;
  };
  results: AgentQualityTaskResult[];
};

export type AgentQualityEvaluationOptions = {
  now?: () => Date;
  monotonicNow?: () => number;
};

/** 解析并冻结任务集的结构边界，拒绝重复 ID 和未知字段。 */
export function parseAgentQualityDataset(input: unknown): AgentQualityDataset {
  return AgentQualityDatasetSchema.parse(input);
}

/** 执行全部启用任务、保留未启用项并统一计算质量指标。 */
export async function runAgentQualityEvaluation(
  input: unknown,
  evaluators: readonly AgentQualityEvaluator[],
  options: AgentQualityEvaluationOptions = {},
): Promise<AgentQualityEvaluationReport> {
  const dataset = parseAgentQualityDataset(input);
  const startedAt = (options.monotonicNow ?? Date.now)();
  const registry = evaluatorRegistry(evaluators);
  const results: AgentQualityTaskResult[] = [];
  for (const task of dataset.tasks) {
    if (!task.execution.enabled) {
      results.push(notEvaluated(task, '任务已收录，但对应能力尚未进入当前基线'));
      continue;
    }
    const evaluator = registry.get(task.execution.evaluatorId);
    if (!evaluator) {
      results.push(failedWithoutObservation(task, `已启用 evaluator 未注册：${task.execution.evaluatorId}`));
      continue;
    }
    results.push(await evaluateTask(task, evaluator));
  }

  const evaluated = results.filter((result) => result.status !== 'not_evaluated');
  const passedTasks = evaluated.filter((result) => result.status === 'passed').length;
  const failedTasks = evaluated.length - passedTasks;
  return {
    schemaVersion: 1,
    evaluationId: 'EVAL-101',
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    durationMs: Math.max(0, (options.monotonicNow ?? Date.now)() - startedAt),
    passed: evaluated.length > 0 && failedTasks === 0,
    dataset: {
      id: dataset.datasetId,
      version: dataset.datasetVersion,
      sha256: createHash('sha256').update(JSON.stringify(dataset)).digest('hex'),
      totalTasks: dataset.tasks.length,
      sddScenarios: new Set(dataset.tasks.map((task) => task.sddScenario)).size,
    },
    summary: {
      enabledTasks: dataset.tasks.filter((task) => task.execution.enabled).length,
      evaluatedTasks: evaluated.length,
      passedTasks,
      failedTasks,
      notEvaluatedTasks: results.length - evaluated.length,
    },
    metrics: aggregateMetrics(results),
    results,
  };
}

/** 把报告总判定转换为 CLI 退出码。 */
export function agentQualityEvaluationExitCode(report: AgentQualityEvaluationReport): 0 | 1 {
  return report.passed ? 0 : 1;
}

/** 建立无重复 evaluator ID 的查找表。 */
function evaluatorRegistry(
  evaluators: readonly AgentQualityEvaluator[],
): Map<string, AgentQualityEvaluator> {
  const registry = new Map<string, AgentQualityEvaluator>();
  for (const evaluator of evaluators) {
    if (registry.has(evaluator.id)) {
      throw new Error(`evaluator ID 重复：${evaluator.id}`);
    }
    registry.set(evaluator.id, evaluator);
  }
  return registry;
}

/** 执行并评分单个任务，异常只影响当前任务。 */
async function evaluateTask(
  task: AgentQualityTask,
  evaluator: AgentQualityEvaluator,
): Promise<AgentQualityTaskResult> {
  try {
    const observation = await evaluator.evaluate(task);
    const checks = gradeObservation(task, observation);
    const passed = checks.every((item) => item.passed);
    return {
      taskId: task.id,
      sddScenario: task.sddScenario,
      evaluatorId: evaluator.id,
      status: passed ? 'passed' : 'failed',
      taskSucceeded: passed,
      checks,
      observation,
      error: null,
    };
  } catch (error) {
    return failedWithoutObservation(
      task,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** 将 observation 与任务期望逐项比较。 */
function gradeObservation(
  task: AgentQualityTask,
  observation: AgentQualityObservation,
): AgentQualityCheck[] {
  const expected = task.expected;
  const checks = [check('终态符合期望', expected.outcome, observation.outcome)];
  if (expected.route) {
    checks.push(check('执行路径符合期望', expected.route, observation.route));
  }
  for (const text of expected.responseIncludes) {
    checks.push(check(`回答包含：${text}`, true, observation.response.includes(text)));
  }
  if (expected.toolCalls) {
    checks.push(check('工具调用序列最小且准确', expected.toolCalls, observation.toolCalls));
  }
  if (expected.activatedSkills) {
    checks.push(check('Skill 激活集合符合期望', expected.activatedSkills, observation.activatedSkills));
  }
  if (expected.artifactKinds) {
    checks.push(check('Artifact 类型符合期望', expected.artifactKinds, observation.artifactKinds));
  }
  if (expected.recoverySucceeded !== undefined) {
    checks.push(check(
      '恢复结果符合期望',
      expected.recoverySucceeded,
      observation.metrics.recoverySucceeded,
    ));
  }
  if (expected.maxDuplicateSideEffects !== undefined) {
    checks.push(upperBoundCheck(
      '重复副作用不超过上限',
      expected.maxDuplicateSideEffects,
      observation.metrics.duplicateSideEffects,
    ));
  }
  if (expected.maxToolCallsAfterCancellation !== undefined) {
    checks.push(upperBoundCheck(
      '取消后工具调用不超过上限',
      expected.maxToolCallsAfterCancellation,
      observation.metrics.toolCallsAfterCancellation,
    ));
  }
  return checks;
}

/** 创建相等性检查。 */
function check(name: string, expected: unknown, actual: unknown): AgentQualityCheck {
  return {
    name,
    passed: isDeepStrictEqual(actual, expected),
    expected,
    actual,
  };
}

/** 创建数值上限检查。 */
function upperBoundCheck(name: string, maximum: number, actual: number): AgentQualityCheck {
  return { name, passed: actual <= maximum, expected: { lte: maximum }, actual };
}

/** 记录尚未进入当前基线的任务，不把它算作成功或失败。 */
function notEvaluated(task: AgentQualityTask, reason: string): AgentQualityTaskResult {
  return {
    taskId: task.id,
    sddScenario: task.sddScenario,
    evaluatorId: task.execution.evaluatorId,
    status: 'not_evaluated',
    taskSucceeded: false,
    checks: [],
    observation: null,
    error: reason,
  };
}

/** 记录 evaluator 配置或执行异常。 */
function failedWithoutObservation(
  task: AgentQualityTask,
  error: string,
): AgentQualityTaskResult {
  return {
    taskId: task.id,
    sddScenario: task.sddScenario,
    evaluatorId: task.execution.evaluatorId,
    status: 'failed',
    taskSucceeded: false,
    checks: [],
    observation: null,
    error,
  };
}

/** 汇总所有已执行 observation，缺失 Token 指标时保持 null。 */
function aggregateMetrics(results: readonly AgentQualityTaskResult[]): AgentQualityEvaluationReport['metrics'] {
  const evaluatedResults = results.filter((result) => result.status !== 'not_evaluated');
  const observedResults = evaluatedResults.filter(
    (result): result is AgentQualityTaskResult & { observation: AgentQualityObservation } =>
      result.observation !== null,
  );
  const successful = evaluatedResults.filter((result) => result.taskSucceeded).length;
  const toolSelectionResults = observedResults.filter((result) =>
    result.checks.some((item) => item.name === '工具调用序列最小且准确'));
  const modelCalls = observedResults.map((result) => result.observation.metrics.modelCalls);
  const measuredModelCalls = modelCalls.filter((value): value is number => value !== null);
  const inputTokens = observedResults.map((result) => result.observation.metrics.inputTokens);
  const outputTokens = observedResults.map((result) => result.observation.metrics.outputTokens);
  const recovery = observedResults
    .map((result) => result.observation.metrics.recoverySucceeded)
    .filter((value): value is boolean => value !== null);
  const cancellationLatencies = observedResults
    .map((result) => result.observation.metrics.cancellationLatencyMs)
    .filter((value): value is number => value !== null);
  return {
    taskSuccessRate: evaluatedResults.length > 0 ? successful / evaluatedResults.length : 0,
    toolSelectionAccuracy: toolSelectionResults.length > 0
      ? toolSelectionResults.filter((result) =>
        result.checks.find((item) => item.name === '工具调用序列最小且准确')?.passed)
        .length / toolSelectionResults.length
      : null,
    totalModelCalls: measuredModelCalls.reduce((sum, value) => sum + value, 0),
    modelCallsMeasuredTasks: measuredModelCalls.length,
    totalToolCalls: observedResults.reduce(
      (sum, result) => sum + result.observation.metrics.toolCalls,
      0,
    ),
    tokenUsage: inputTokens.every((value): value is number => value !== null)
      && outputTokens.every((value): value is number => value !== null)
      ? {
        input: inputTokens.reduce((sum, value) => sum + value, 0),
        output: outputTokens.reduce((sum, value) => sum + value, 0),
        total: inputTokens.reduce((sum, value) => sum + value, 0)
          + outputTokens.reduce((sum, value) => sum + value, 0),
      }
      : null,
    latencyP95Ms: percentile95(
      observedResults.map((result) => result.observation.metrics.latencyMs),
    ),
    recoverySuccessRate: recovery.length > 0
      ? recovery.filter(Boolean).length / recovery.length
      : null,
    cancellationLatencyP95Ms: percentile95(cancellationLatencies),
    duplicateSideEffects: observedResults.reduce(
      (sum, result) => sum + result.observation.metrics.duplicateSideEffects,
      0,
    ),
    toolCallsAfterCancellation: observedResults.reduce(
      (sum, result) => sum + result.observation.metrics.toolCallsAfterCancellation,
      0,
    ),
  };
}

/** 使用 nearest-rank 计算小样本 P95；空集合返回 null。 */
function percentile95(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}
