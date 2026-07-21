import assert from 'node:assert/strict';
import test from 'node:test';
import { JSONParser } from '../../src/domain/external/json-parser';
import { LLM, LLMMessage } from '../../src/domain/external/llm';
import { LLMConfigSchema } from '../../src/domain/models/app-config';
import { createAgentRun, RouteKind } from '../../src/domain/models/agent-run';
import { ConversationMemory } from '../../src/domain/models/conversation-memory';
import { RouteDecision } from '../../src/domain/models/route-decision';
import { UnitOfWork } from '../../src/domain/repositories/unit-of-work';
import { BaseAgent } from '../../src/domain/services/agents/base-agent';
import {
  ContextSelector,
  createModelContextBudget,
  estimateContextValueTokens,
  modelFixedInput,
  ProtectedContextBudgetExceededError,
} from '../../src/domain/services/context/context-selector.service';
import {
  LLMDirectResponseProvider,
  LLMSingleToolProvider,
} from '../../src/domain/services/runtime/adapters';
import { RuntimeExecutionContext } from '../../src/domain/services/runtime/executor.service';
import { SearchTool } from '../../src/domain/services/tools/search.tool';
import { LLMRuntimeRouteModel } from '../../src/infrastructure/external/llm/llm-runtime-route-model';

/** 记录实际模型调用，并允许测试精确声明总窗口和输出上限。 */
class RecordingWindowLLM extends LLM {
  readonly modelName = 'context-window-test';
  readonly temperature = 0;
  readonly calls: Array<Parameters<LLM['invoke']>[0]> = [];

  /** 固定窗口参数和预设响应。 */
  constructor(
    private readonly windowTokens: number,
    readonly maxTokens: number,
    private readonly response: LLMMessage = { role: 'assistant', content: 'ok' },
  ) {
    super();
  }

  /** 返回测试声明的模型总上下文窗口。 */
  override get contextWindowTokens(): number {
    return this.windowTokens;
  }

  /** 保存模型实际收到的输入并返回独立响应。 */
  async invoke(input: Parameters<LLM['invoke']>[0]): Promise<LLMMessage> {
    this.calls.push(structuredClone(input));
    return structuredClone(this.response);
  }
}

/** 提供标准 JSON 解析行为。 */
class ParseJson extends JSONParser {
  /** 解析失败时沿用调用方默认值。 */
  async invoke<T>(text: string, defaultValue?: T): Promise<T> {
    try {
      return JSON.parse(text) as T;
    } catch {
      return defaultValue as T;
    }
  }
}

/** 创建只实现 Conversation Memory 的最小事务边界。 */
function createMemoryUow(memory: ConversationMemory): UnitOfWork {
  const unit = {
    conversationMemory: {
      /** 返回同一测试记忆实例。 */
      async get() {
        return memory;
      },
      /** BaseAgent 已就地更新实例，无需额外复制。 */
      async save() {},
    },
    /** 在同一内存事务边界执行回调。 */
    async run<T>(handler: (active: UnitOfWork) => Promise<T>): Promise<T> {
      return handler(unit as unknown as UnitOfWork);
    },
  };
  return unit as unknown as UnitOfWork;
}

/** 暴露 BaseAgent 的无工具调用，用于验证 Planned Agent 共用路径。 */
class ProbeAgent extends BaseAgent {
  readonly name = 'context-probe';
  protected override systemPrompt = 'BASE-SYSTEM';

  /** 执行一次带 Run 级受保护指令的请求。 */
  async run(query: string, protectedContext: string): Promise<void> {
    for await (const _event of this.invoke(query, undefined, {
      protectedSystemContext: protectedContext,
    })) {
      // 消费完整事件流，使模型响应写回 Conversation Memory。
    }
  }
}

/** 创建 Single Tool 路径需要的最小 Runtime 上下文。 */
function createSingleToolContext(message: string): RuntimeExecutionContext {
  const decision: RouteDecision = {
    route: RouteKind.SINGLE_TOOL,
    reason: '测试上下文预算',
    requiredCapabilities: ['search'],
    requestedSkills: [],
    confidence: 1,
  };
  return {
    run: createAgentRun({
      id: 'run-context-window',
      sessionId: 'session-context-window',
      route: RouteKind.SINGLE_TOOL,
    }),
    decision,
    message,
    metadata: {},
    privateContext: {},
    toolSelection: {},
  };
}

test('模型输入预算应至多使用窗口的百分之七十五并为更大输出上限让出空间', () => {
  const ordinary = createModelContextBudget(new RecordingWindowLLM(1000, 100));
  assert.equal(ordinary.inputTokenLimit, 750);

  const outputHeavy = createModelContextBudget(new RecordingWindowLLM(1000, 400));
  assert.equal(outputHeavy.inputTokenLimit, 600);
});

test('Context Selector 应保护目标与 Skill 并按最近工具原子组裁剪旧历史', () => {
  const llm = new RecordingWindowLLM(2000, 300);
  const toolDescriptor = new SearchTool({} as never).getRegistrations()[0].descriptor;
  const budget = createModelContextBudget(llm);
  const fixedInput = modelFixedInput([toolDescriptor]);
  const selection = new ContextSelector().select({
    context: {
      conversationMessages: [
        { role: 'system', content: 'BASE' },
        { role: 'user', content: `OLD-USER-${'旧'.repeat(500)}` },
        { role: 'assistant', content: `OLD-ASSISTANT-${'旧'.repeat(500)}` },
        { role: 'user', content: 'CURRENT-GOAL' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call-1', function: { name: 'search_web', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'call-1', content: 'RECENT-EVIDENCE' },
      ],
      protectedInstructions: ['ACTIVE-SKILL'],
      protectedConversationMessageIndexes: [3],
    },
    budget,
    fixedInput,
  });
  const serialized = JSON.stringify(selection);
  const estimatedInputTokens = [...selection, ...fixedInput].reduce<number>(
    (total, value) => total + estimateContextValueTokens(value),
    0,
  );

  assert.ok(estimatedInputTokens <= budget.inputTokenLimit);
  assert.match(serialized, /BASE|ACTIVE-SKILL|CURRENT-GOAL/);
  assert.doesNotMatch(serialized, /OLD-USER|OLD-ASSISTANT/);
  assert.match(serialized, /call-1/);
  assert.match(serialized, /RECENT-EVIDENCE/);
});

test('Context Selector 放不下工具原子组时不应只保留调用或结果的一半', () => {
  const selection = new ContextSelector().select({
    context: {
      conversationMessages: [
        { role: 'system', content: 'BASE' },
        { role: 'user', content: 'CURRENT-GOAL' },
        {
          role: 'assistant',
          tool_calls: [{ id: 'call-large', function: { name: 'search_web', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'call-large', content: '证据'.repeat(200) },
      ],
      protectedInstructions: ['ACTIVE-SKILL'],
      protectedConversationMessageIndexes: [1],
    },
    budget: createModelContextBudget(new RecordingWindowLLM(500, 100)),
  });
  const serialized = JSON.stringify(selection);

  assert.doesNotMatch(serialized, /call-large/);
  assert.match(serialized, /BASE|ACTIVE-SKILL|CURRENT-GOAL/);
});

test('受保护内容本身超限时应在模型调用前明确失败', async () => {
  const llm = new RecordingWindowLLM(500, 100);
  const provider = new LLMDirectResponseProvider(llm);
  const context = createSingleToolContext('目标'.repeat(500));
  context.decision = { ...context.decision, route: RouteKind.DIRECT };
  context.run = { ...context.run, route: RouteKind.DIRECT };

  await assert.rejects(
    () => provider.respond(context),
    ProtectedContextBudgetExceededError,
  );
  assert.equal(llm.calls.length, 0);
});

test('Router 与 Single Tool 应在调用模型前执行相同预算保护', async () => {
  const routerLlm = new RecordingWindowLLM(4000, 500);
  const router = new LLMRuntimeRouteModel(routerLlm);
  await assert.rejects(
    () => router.decide({
      message: '路由目标'.repeat(2000),
      requestedSkills: [],
      availableSkills: [],
      availableCapabilities: [],
    }),
    ProtectedContextBudgetExceededError,
  );
  assert.equal(routerLlm.calls.length, 0);

  const singleToolLlm = new RecordingWindowLLM(1000, 200);
  const singleTool = new LLMSingleToolProvider(
    singleToolLlm,
    new ParseJson(),
    [new SearchTool({} as never)],
  );
  await assert.rejects(
    () => singleTool.select(createSingleToolContext('搜索目标'.repeat(500))),
    ProtectedContextBudgetExceededError,
  );
  assert.equal(singleToolLlm.calls.length, 0);
});

test('Planned Agent 裁剪旧历史后仍应保留系统约束、当前目标和活跃 Skill', async () => {
  const memory = new ConversationMemory([
    { role: 'system', content: 'BASE-SYSTEM' },
    { role: 'user', content: `OLD-USER-${'旧'.repeat(500)}` },
    { role: 'assistant', content: `OLD-ANSWER-${'旧'.repeat(500)}` },
  ]);
  const llm = new RecordingWindowLLM(1000, 100);
  const agent = new ProbeAgent(
    () => createMemoryUow(memory),
    'session-context-window',
    { max_iterations: 2, max_retries: 2, max_search_results: 5 },
    llm,
    new ParseJson(),
    [],
  );

  await agent.run('CURRENT-GOAL', 'ACTIVE-SKILL');

  assert.equal(llm.calls.length, 1);
  const serialized = JSON.stringify(llm.calls[0].messages);
  assert.match(serialized, /BASE-SYSTEM|CURRENT-GOAL|ACTIVE-SKILL/);
  assert.doesNotMatch(serialized, /OLD-USER|OLD-ANSWER/);
});

test('旧 LLM 配置应补全窗口默认值并拒绝输出上限占满总窗口', () => {
  const legacy = LLMConfigSchema.parse({ max_tokens: 8192 });
  assert.equal(legacy.context_window_tokens, 32768);
  assert.throws(
    () => LLMConfigSchema.parse({ max_tokens: 1024, context_window_tokens: 1024 }),
    /max_tokens 必须小于 context_window_tokens/,
  );
});
