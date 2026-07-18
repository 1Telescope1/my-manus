import assert from 'node:assert/strict';
import test from 'node:test';
import { JSONParser } from '../../src/domain/external/json-parser';
import { LLM, LLMMessage } from '../../src/domain/external/llm';
import { SearchEngine } from '../../src/domain/external/search-engine';
import { createAgentRun, RouteKind } from '../../src/domain/models/agent-run';
import { Event } from '../../src/domain/models/event';
import { Memory } from '../../src/domain/models/memory';
import { createPlan } from '../../src/domain/models/plan';
import { createMessage } from '../../src/domain/models/message';
import { RouteDecision } from '../../src/domain/models/route-decision';
import { UnitOfWork } from '../../src/domain/repositories/unit-of-work';
import { PlannerAgent } from '../../src/domain/services/agents/planner-agent';
import { ReActAgent } from '../../src/domain/services/agents/react-agent';
import { LLMSingleToolProvider } from '../../src/domain/services/runtime/adapters';
import { RuntimeExecutionContext } from '../../src/domain/services/runtime/executor.service';
import { MessageTool } from '../../src/domain/services/tools/message.tool';
import { SearchTool } from '../../src/domain/services/tools/search.tool';

/** 记录模型输入并依次返回预设响应。 */
class RecordingLLM extends LLM {
  readonly modelName = 'tool-visibility-test';
  readonly temperature = 0;
  readonly maxTokens = 256;
  readonly calls: Array<Parameters<LLM['invoke']>[0]> = [];

  /** 保存响应队列。 */
  constructor(private readonly responses: LLMMessage[]) {
    super();
  }

  /** 记录输入并返回下一条响应。 */
  async invoke(input: Parameters<LLM['invoke']>[0]): Promise<LLMMessage> {
    this.calls.push(input);
    const response = this.responses.shift();
    if (!response) {
      throw new Error('测试 LLM 缺少预设响应');
    }
    return response;
  }
}

/** 解析测试模型返回的 JSON。 */
class ParseJson extends JSONParser {
  /** 解析失败时返回调用方默认值。 */
  async invoke<T>(text: string, defaultValue?: T): Promise<T> {
    try {
      return JSON.parse(text) as T;
    } catch {
      return defaultValue as T;
    }
  }
}

/** 返回固定搜索结果并记录查询。 */
class RecordingSearchEngine extends SearchEngine {
  readonly queries: string[] = [];

  /** 保存查询并返回空结果集。 */
  async invoke(query: string): Promise<{
    success: true;
    data: { query: string; total_results: number; results: [] };
  }> {
    this.queries.push(query);
    return {
      success: true,
      data: { query, total_results: 0, results: [] },
    };
  }
}

/** 创建只支持 Agent Memory 的最小 UnitOfWork。 */
function createMemoryUow(): UnitOfWork {
  const memories = new Map<string, Memory>();
  const uow = {
    session: {
      getMemory: async (_sessionId: string, agentName: string) => {
        const memory = memories.get(agentName) ?? new Memory();
        memories.set(agentName, memory);
        return memory;
      },
      saveMemory: async (_sessionId: string, agentName: string, memory: Memory) => {
        memories.set(agentName, memory);
      },
    },
    run: async <T>(handler: (active: UnitOfWork) => Promise<T>): Promise<T> =>
      handler(uow as unknown as UnitOfWork),
  };
  return uow as unknown as UnitOfWork;
}

/** 创建只批准 search capability 的 Single Tool 执行上下文。 */
function createSingleToolContext(): RuntimeExecutionContext {
  const decision: RouteDecision = {
    route: RouteKind.SINGLE_TOOL,
    reason: '只允许搜索',
    requiredCapabilities: ['search'],
    requestedSkills: [],
    confidence: 1,
  };
  return {
    run: createAgentRun({
      id: 'run-tool-visibility',
      sessionId: 'session-tool-visibility',
      route: RouteKind.SINGLE_TOOL,
    }),
    decision,
    message: '搜索资料',
    metadata: {},
    privateContext: {},
    toolSelection: {},
  };
}

/** 消费 Agent 事件流，使模型调用完整执行。 */
async function consume(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of events) {
    // 测试只关心模型输入，不保存事件。
  }
}

test('Single Tool 模型请求应只包含相关工具并拒绝伪造函数名', async () => {
  const llm = new RecordingLLM([{
    role: 'assistant',
    tool_calls: [{
      id: 'call-forged',
      function: {
        name: 'message_ask_user',
        arguments: JSON.stringify({ text: '绕过选择器' }),
      },
    }],
  }]);
  const provider = new LLMSingleToolProvider(
    llm,
    new ParseJson(),
    [new SearchTool({} as never), new MessageTool()],
  );

  await assert.rejects(
    () => provider.select(createSingleToolContext()),
    /未授权或无关工具/,
  );
  assert.deepEqual(
    llm.calls[0].tools?.map((descriptor) => descriptor.name),
    ['search_web'],
  );
});

test('Planner 与总结模型请求应完全省略工具字段', async () => {
  const uow = createMemoryUow();
  const tools = [new SearchTool({} as never), new MessageTool()];
  const plannerLlm = new RecordingLLM([{
    role: 'assistant',
    content: JSON.stringify({ title: '测试计划', steps: [] }),
  }]);
  const planner = new PlannerAgent(
    () => uow,
    'session-tool-visibility',
    { max_iterations: 2, max_retries: 2, max_search_results: 5 },
    plannerLlm,
    new ParseJson(),
    tools,
  );
  await consume(planner.createPlan({ message: '创建计划', attachments: [] }));

  const summaryLlm = new RecordingLLM([{
    role: 'assistant',
    content: JSON.stringify({ message: '总结完成' }),
  }]);
  const react = new ReActAgent(
    () => uow,
    'session-tool-visibility',
    { max_iterations: 2, max_retries: 2, max_search_results: 5 },
    summaryLlm,
    new ParseJson(),
    tools,
  );
  await consume(react.summarize(createPlan({ title: '测试计划', steps: [] })));

  assert.equal(Object.hasOwn(plannerLlm.calls[0], 'tools'), false);
  assert.equal(Object.hasOwn(plannerLlm.calls[0], 'toolChoice'), false);
  assert.equal(Object.hasOwn(summaryLlm.calls[0], 'tools'), false);
  assert.equal(Object.hasOwn(summaryLlm.calls[0], 'toolChoice'), false);
});

test('ReAct 每轮模型请求应保持 Runtime 选定的最小工具集合', async () => {
  const llm = new RecordingLLM([
    {
      role: 'assistant',
      tool_calls: [{
        id: 'call-search',
        function: {
          name: 'search_web',
          arguments: JSON.stringify({ query: '最小披露' }),
        },
      }],
    },
    {
      role: 'assistant',
      content: JSON.stringify({ success: true, result: '搜索完成' }),
    },
  ]);
  const search = new RecordingSearchEngine();
  const react = new ReActAgent(
    () => createMemoryUow(),
    'session-tool-visibility',
    { max_iterations: 2, max_retries: 2, max_search_results: 5 },
    llm,
    new ParseJson(),
    [new SearchTool(search), new MessageTool()],
  );
  const plan = createPlan({ language: 'zh-CN', steps: ['搜索资料'] });

  const emitted: Event[] = [];
  for await (const event of react.executeStep(
    plan,
    plan.steps[0],
    createMessage({ message: '搜索最小披露资料' }),
    { routerCapabilities: ['search'] },
    { scopeId: 'run-tool-visibility' },
  )) {
    emitted.push(event);
  }

  assert.equal(search.queries.length, 1);
  const called = emitted.find((event) => event.type === 'tool' && event.status === 'called');
  assert.equal(
    called?.type === 'tool' && called.function_result?.metadata?.attempts,
    1,
  );
  assert.equal(
    called?.type === 'tool' && called.function_result?.metadata?.idempotencyKey,
    'call-search',
  );
  assert.ok(llm.calls.length >= 2);
  assert.ok(llm.calls.every((call) => (
    call.tools?.map((descriptor) => descriptor.name).join(',') === 'search_web'
  )));
});
