import assert from 'node:assert/strict';
import test from 'node:test';
import { LLM, LLMMessage } from '../../src/domain/external/llm';
import { RuntimeRouteModel } from '../../src/domain/external/runtime-route-model';
import { RouteKind } from '../../src/domain/models/agent-run';
import {
  NormalizedRuntimeRouteRequest,
  RouteDecision,
  RouteDecisionSchema,
} from '../../src/domain/models/route-decision';
import {
  DeterministicRouteRule,
  RuntimeRouterService,
} from '../../src/domain/services/runtime/router.service';
import { createDefaultRuntimeRouteRules } from '../../src/domain/services/runtime/route-rules';
import { LLMRuntimeRouteModel } from '../../src/infrastructure/external/llm/llm-runtime-route-model';

type LLMInvokeInput = Parameters<LLM['invoke']>[0];

/** 返回预设候选或异常，并记录路由模型调用次数。 */
class FakeRouteModel extends RuntimeRouteModel {
  readonly requests: NormalizedRuntimeRouteRequest[] = [];

  /** 保存测试需要的模型输出或调用异常。 */
  constructor(
    private readonly output: unknown,
    private readonly failure?: Error,
  ) {
    super();
  }

  /** 记录标准化请求，并按测试场景返回候选或抛错。 */
  async decide(request: NormalizedRuntimeRouteRequest): Promise<unknown> {
    this.requests.push(request);
    if (this.failure) {
      throw this.failure;
    }
    return this.output;
  }
}

/** 提供可控制命中结果的同步确定性规则。 */
class StaticRouteRule implements DeterministicRouteRule {
  evaluations = 0;

  /** 固定规则名称、候选结果和本次是否命中。 */
  constructor(
    readonly name: string,
    private readonly output: unknown,
    private readonly matches = true,
  ) {}

  /** 记录求值次数，并在未命中时返回 null。 */
  evaluate(_request: NormalizedRuntimeRouteRequest): unknown | null {
    this.evaluations += 1;
    return this.matches ? this.output : null;
  }
}

/** 模拟底层 LLM，并保留完整调用参数用于检查工具隔离。 */
class FakeLLM extends LLM {
  readonly modelName = 'router-test-model';
  readonly temperature = 0;
  readonly maxTokens = 256;
  readonly calls: LLMInvokeInput[] = [];

  /** 保存模型要返回的消息对象。 */
  constructor(private readonly response: LLMMessage) {
    super();
  }

  /** 记录调用参数并返回固定消息。 */
  async invoke(input: LLMInvokeInput): Promise<LLMMessage> {
    this.calls.push(input);
    return this.response;
  }
}

/** 为四种路径创建满足领域约束的标准测试决策。 */
function createDecision(
  route: RouteKind,
  overrides: Partial<RouteDecision> = {},
): RouteDecision {
  const decision: RouteDecision = {
    route,
    reason: `选择 ${route} 路径`,
    requiredCapabilities: route === RouteKind.SINGLE_TOOL ? ['search'] : [],
    requestedSkills: [],
    confidence: 0.95,
    ...(route === RouteKind.WORKFLOW ? { workflowName: 'fixed-report' } : {}),
    ...overrides,
  };
  return decision;
}

// Schema 必须拒绝未知字段、非法置信度和不符合路径语义的字段组合。
test('RouteDecision Schema 应严格校验路由结构和路径约束', () => {
  assert.equal(RouteDecisionSchema.safeParse(createDecision(RouteKind.DIRECT)).success, true);
  assert.equal(RouteDecisionSchema.safeParse({
    ...createDecision(RouteKind.DIRECT),
    unexpected: true,
  }).success, false);
  assert.equal(RouteDecisionSchema.safeParse({
    ...createDecision(RouteKind.WORKFLOW),
    workflowName: undefined,
  }).success, false);
  assert.equal(RouteDecisionSchema.safeParse(createDecision(RouteKind.DIRECT, {
    requiredCapabilities: ['search'],
  })).success, false);
  assert.equal(RouteDecisionSchema.safeParse({
    ...createDecision(RouteKind.PLANNED_AGENT),
    confidence: 1.1,
  }).success, false);
});

// Direct 确定性规则命中后必须立即返回，路由模型不应收到请求。
test('确定性规则应把简单请求路由到 direct 且不调用模型', async () => {
  const model = new FakeRouteModel(createDecision(RouteKind.PLANNED_AGENT));
  const router = new RuntimeRouterService(model, {
    rules: createDefaultRuntimeRouteRules(),
  });

  const result = await router.route({ message: '解释什么是乐观锁' });

  assert.equal(result.route, RouteKind.DIRECT);
  assert.equal(result.reason, '命中无需外部能力的概念解释规则');
  assert.equal(model.requests.length, 0);
});

// 含实时外部上下文的解释句不能被概念规则误判，必须继续交给模型判断。
test('Direct 解释规则应跳过需要实时外部数据的请求', async () => {
  const model = new FakeRouteModel(createDecision(RouteKind.SINGLE_TOOL));
  const router = new RuntimeRouterService(model, {
    rules: createDefaultRuntimeRouteRules(),
  });

  const result = await router.route({ message: '解释一下今天北京天气的数据' });

  assert.equal(result.route, RouteKind.SINGLE_TOOL);
  assert.equal(model.requests.length, 1);
});

// 没有规则命中时，合法的单工具模型结果应原样进入 single_tool 路径。
test('路由模型应把单一能力请求路由到 single_tool', async () => {
  const model = new FakeRouteModel(createDecision(RouteKind.SINGLE_TOOL));
  const router = new RuntimeRouterService(model);

  const result = await router.route({ message: '查询今天的天气' });

  assert.equal(result.route, RouteKind.SINGLE_TOOL);
  assert.deepEqual(result.requiredCapabilities, ['search']);
  assert.equal(model.requests.length, 1);
});

// 规则必须按注册顺序求值，并在首个 Workflow 命中后停止后续规则。
test('确定性规则应按顺序选择 workflow 并在首个命中后停止', async () => {
  const model = new FakeRouteModel(createDecision(RouteKind.PLANNED_AGENT));
  const skippedRule = new StaticRouteRule('not-matched', createDecision(RouteKind.DIRECT), false);
  const workflowRule = new StaticRouteRule('daily-report', createDecision(RouteKind.WORKFLOW));
  const laterRule = new StaticRouteRule('later-rule', createDecision(RouteKind.DIRECT));
  const router = new RuntimeRouterService(model, {
    rules: [skippedRule, workflowRule, laterRule],
  });

  const result = await router.route({ message: '生成固定格式日报' });

  assert.equal(result.route, RouteKind.WORKFLOW);
  assert.equal(result.workflowName, 'fixed-report');
  assert.equal(skippedRule.evaluations, 1);
  assert.equal(workflowRule.evaluations, 1);
  assert.equal(laterRule.evaluations, 0);
  assert.equal(model.requests.length, 0);
});

// 开放复杂请求允许模型明确选择 planned_agent，而不是把它视作失败回退。
test('路由模型应把开放复杂请求路由到 planned_agent', async () => {
  const expected = createDecision(RouteKind.PLANNED_AGENT, {
    requiredCapabilities: ['research', 'files'],
  });
  const router = new RuntimeRouterService(new FakeRouteModel(expected));

  const result = await router.route({ message: '研究市场并生成带附件的完整报告' });

  assert.deepEqual(result, expected);
});

// 不可信模型输出无法通过 Schema 时必须回退兼容路径，并保留请求的 Skill。
test('无效模型输出应回退 planned_agent 并保留请求的 Skill', async () => {
  const invalid = {
    ...createDecision(RouteKind.DIRECT),
    route: 'unknown_route',
  };
  const router = new RuntimeRouterService(new FakeRouteModel(invalid));

  const result = await router.route({
    message: '处理这个请求',
    requestedSkills: ['document-review'],
  });

  assert.equal(result.route, RouteKind.PLANNED_AGENT);
  assert.equal(result.confidence, 0);
  assert.deepEqual(result.requestedSkills, ['document-review']);
  assert.match(result.reason, /无效结果/);
  assert.match(result.reason, /route/);
});

// 结构合法但置信度不足的模型结果同样不能进入简单路径。
test('低置信度模型输出应回退 planned_agent', async () => {
  const router = new RuntimeRouterService(
    new FakeRouteModel(createDecision(RouteKind.DIRECT, { confidence: 0.59 })),
  );

  const result = await router.route({ message: '含义不明确的请求' });

  assert.equal(result.route, RouteKind.PLANNED_AGENT);
  assert.match(result.reason, /置信度不足/);
});

// 路由模型不可用时不能使主请求失败，应回到当前 Planner 行为。
test('路由模型调用异常时应回退 planned_agent', async () => {
  const router = new RuntimeRouterService(
    new FakeRouteModel(null, new Error('model unavailable')),
  );

  const result = await router.route({ message: '继续执行任务' });

  assert.equal(result.route, RouteKind.PLANNED_AGENT);
  assert.match(result.reason, /调用失败/);
});

// Router 只能选择当前 Registry 提供的 canonical capability，未知值不得进入执行器。
test('路由模型请求不可用 capability 时应安全回退', async () => {
  const router = new RuntimeRouterService(new FakeRouteModel(
    createDecision(RouteKind.SINGLE_TOOL, { requiredCapabilities: ['weather.lookup'] }),
  ));

  const result = await router.route({
    message: '查询天气',
    availableCapabilities: ['search', 'web.search'],
  });

  assert.equal(result.route, RouteKind.PLANNED_AGENT);
  assert.deepEqual(result.requiredCapabilities, []);
  assert.match(result.reason, /不可用 capability/);
});

// LLM 适配器只能请求 JSON 决策，不得向模型暴露任何可执行工具。
test('路由模型适配器不应携带工具或执行任何副作用', async () => {
  const expected = createDecision(RouteKind.DIRECT);
  const llm = new FakeLLM({
    content: JSON.stringify({ ...expected, workflowName: null }),
  });
  const router = new RuntimeRouterService(new LLMRuntimeRouteModel(llm));

  const result = await router.route({
    message: '你好',
    availableCapabilities: ['search', 'web.search'],
  });

  assert.equal(result.route, RouteKind.DIRECT);
  assert.equal(llm.calls.length, 1);
  assert.equal(Object.hasOwn(llm.calls[0], 'tools'), false);
  assert.equal(Object.hasOwn(llm.calls[0], 'toolChoice'), false);
  assert.deepEqual(llm.calls[0].responseFormat, { type: 'json_object' });
  const userPayload = JSON.parse(String(llm.calls[0].messages[1].content));
  assert.deepEqual(userPayload.availableCapabilities, ['search', 'web.search']);
});

// 错误阈值应在服务创建时立即暴露，不能静默改变全部路由结果。
test('路由服务应拒绝超出范围的置信度阈值', () => {
  assert.throws(
    () => new RuntimeRouterService(new FakeRouteModel(null), {
      minimumConfidence: 2,
    }),
    /0 到 1/,
  );
});
