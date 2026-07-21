import assert from 'node:assert/strict';
import test from 'node:test';
import { JSONParser } from '../../src/domain/external/json-parser';
import { LLM, LLMMessage } from '../../src/domain/external/llm';
import { ConversationMemory } from '../../src/domain/models/conversation-memory';
import { MemorySummaryDraft } from '../../src/domain/models/memory-summary';
import { createMessage } from '../../src/domain/models/message';
import { createPlan, ExecutionStatus } from '../../src/domain/models/plan';
import { UnitOfWork } from '../../src/domain/repositories/unit-of-work';
import { BaseAgent } from '../../src/domain/services/agents/base-agent';
import { createPlanMemoryCompactionContext } from '../../src/domain/services/flows/planner-react-flow';
import {
  MemoryCompactionContext,
  MemoryCompactionService,
  MemorySummaryGenerator,
} from '../../src/domain/services/memory/memory-compaction.service';
import { DbConversationMemoryRepository } from '../../src/infrastructure/repositories/db-conversation-memory.repository';

/** 返回包含成功、失败和非工具陈述的长会话，便于验证事实边界。 */
function createLongMemory(): ConversationMemory {
  return new ConversationMemory([
    { role: 'system', content: 'BASE-SYSTEM' },
    { role: 'user', content: `用户假设${'用户假设'.repeat(800)}` },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'success-call', function: { name: 'inspect', arguments: '{}' } }],
    },
    {
      role: 'tool',
      tool_call_id: 'success-call',
      function_name: 'inspect',
      content: JSON.stringify({ success: true, data: { status: '项目状态为完成' } }),
    },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'failed-call', function: { name: 'inspect', arguments: '{}' } }],
    },
    {
      role: 'tool',
      tool_call_id: 'failed-call',
      function_name: 'inspect',
      content: JSON.stringify({ success: false, message: '失败工具声称项目已发布' }),
    },
    { role: 'user', content: '继续完成剩余工作' },
    { role: 'assistant', content: `近期结果${'近期'.repeat(800)}` },
  ]);
}

/** 创建四组等长纯文本历史，用可预测的规模验证压缩触发阈值。 */
function createSizedMemory(messageLength: number): ConversationMemory {
  return new ConversationMemory([
    { role: 'system', content: 'BASE-SYSTEM' },
    { role: 'user', content: 'x'.repeat(messageLength) },
    { role: 'assistant', content: 'x'.repeat(messageLength) },
    { role: 'user', content: 'x'.repeat(messageLength) },
    { role: 'assistant', content: 'x'.repeat(messageLength) },
  ]);
}

/** 创建字段完整的摘要候选，测试只覆盖需要变化的字段。 */
function createDraft(input: Partial<MemorySummaryDraft> = {}): MemorySummaryDraft {
  return {
    userGoal: input.userGoal ?? '交付 MEMORY-103',
    constraints: input.constraints ?? [],
    confirmedFacts: input.confirmedFacts ?? [],
    decisions: input.decisions ?? [],
  };
}

/** 创建字段完整的权威运行态摘要上下文。 */
function createCompactionContext(
  input: Partial<MemoryCompactionContext> = {},
): MemoryCompactionContext {
  return {
    userGoal: input.userGoal ?? '',
    completedWork: input.completedWork ?? [],
    pendingWork: input.pendingWork ?? [],
    activeSkills: input.activeSkills ?? [],
    artifacts: input.artifacts ?? [],
  };
}

/** 按顺序返回预设候选，并记录生成器实际看到的稳定来源。 */
class QueueSummaryGenerator implements MemorySummaryGenerator {
  readonly calls: Array<Parameters<MemorySummaryGenerator['generate']>[0]> = [];

  /** 保存候选队列。 */
  constructor(private readonly drafts: MemorySummaryDraft[]) {}

  /** 返回下一份候选；队列耗尽时暴露测试配置错误。 */
  async generate(
    input: Parameters<MemorySummaryGenerator['generate']>[0],
  ): Promise<MemorySummaryDraft> {
    this.calls.push(structuredClone(input));
    const next = this.drafts.shift();
    if (!next) {
      throw new Error('没有可用的摘要候选');
    }
    return structuredClone(next);
  }
}

/** 提供标准 JSON 解析行为。 */
class ParseJson extends JSONParser {
  /** 解析 JSON，失败时返回调用方默认值。 */
  async invoke<T>(text: string, defaultValue?: T): Promise<T> {
    try {
      return JSON.parse(text) as T;
    } catch {
      return defaultValue as T;
    }
  }
}

/** 记录模型输入并返回固定 assistant 消息。 */
class RecordingLLM extends LLM {
  readonly modelName = 'memory-summary-test';
  readonly temperature = 0;
  readonly maxTokens = 1_000;
  readonly calls: Array<Parameters<LLM['invoke']>[0]> = [];

  /** 使用足够大的窗口观察摘要和当前请求同时进入模型。 */
  override get contextWindowTokens(): number {
    return 64_000;
  }

  /** 保存请求并返回成功响应。 */
  async invoke(input: Parameters<LLM['invoke']>[0]): Promise<LLMMessage> {
    this.calls.push(structuredClone(input));
    return { role: 'assistant', content: 'ok' };
  }
}

/** 创建只实现 Conversation Memory 的最小事务边界。 */
function createMemoryUow(memory: ConversationMemory): UnitOfWork {
  const unit = {
    conversationMemory: {
      /** 返回同一测试实例。 */
      async get() {
        return memory;
      },
      /** BaseAgent 已原地更新实例，无需复制。 */
      async save() {},
    },
    /** 在同一内存事务边界执行回调。 */
    async run<T>(handler: (active: UnitOfWork) => Promise<T>): Promise<T> {
      return handler(unit as unknown as UnitOfWork);
    },
  };
  return unit as unknown as UnitOfWork;
}

/** 暴露 Planned Agent 的普通调用以检查最终 Working Context。 */
class ProbeAgent extends BaseAgent {
  readonly name = 'memory-summary-probe';
  protected override systemPrompt = 'BASE-SYSTEM';

  /** 完整消费一次无工具模型调用。 */
  async run(query: string): Promise<void> {
    for await (const _event of this.invoke(query)) {
      // 消费事件流，使模型响应正常写回记忆。
    }
  }
}

test('会话历史未超过输入预算七成时不应提前压缩', async () => {
  const generator = new QueueSummaryGenerator([createDraft()]);
  const service = new MemoryCompactionService(generator, 8_000);

  const belowThreshold = await service.compact(
    createSizedMemory(1_000),
    createCompactionContext(),
  );
  assert.equal(belowThreshold, false);
  assert.equal(generator.calls.length, 0);

  const aboveThreshold = await service.compact(
    createSizedMemory(1_600),
    createCompactionContext(),
  );
  assert.equal(aboveThreshold, true);
  assert.equal(generator.calls.length, 1);
});

test('结构化摘要只应确认成功工具原文并保留权威待办 Skill 和 Artifact', async () => {
  const memory = createLongMemory();
  const generator = new QueueSummaryGenerator([createDraft({
    confirmedFacts: [
      { fact: '用户假设', source: 'message:0' },
      { fact: '项目状态为完成', source: 'message:2' },
      { fact: '失败工具声称项目已发布', source: 'message:4' },
    ],
  })]);
  const service = new MemoryCompactionService(generator, 16_000);

  const compacted = await service.compact(memory, createCompactionContext({
    userGoal: '完成 MEMORY-103',
    completedWork: ['已建立 MemorySummary'],
    pendingWork: ['编写回归测试'],
    activeSkills: [{ name: 'memory-design', version: 'sha256:skill-v1' }],
    artifacts: [{ id: 'artifact://report', description: '评测报告' }],
  }));

  assert.equal(compacted, true);
  assert.deepEqual(memory.getMessages().map((message) => message.role), [
    'system',
    'user',
    'assistant',
  ]);
  assert.equal(memory.getMessages().some((message) => message.tool_calls), false);
  const summary = memory.getSummary();
  assert.ok(summary);
  const { generatedAt, ...summaryWithoutTime } = summary;
  assert.deepEqual(summaryWithoutTime, {
    userGoal: '完成 MEMORY-103',
    constraints: [],
    confirmedFacts: [{ fact: '项目状态为完成', source: 'message:2' }],
    decisions: [],
    completedWork: ['已建立 MemorySummary'],
    pendingWork: ['编写回归测试'],
    activeSkills: [{ name: 'memory-design', version: 'sha256:skill-v1' }],
    artifacts: [{ id: 'artifact://report', description: '评测报告' }],
    sourceMessageRange: { startInclusive: 0, endInclusive: 4 },
  });
  assert.equal(Number.isNaN(Date.parse(generatedAt)), false);
  assert.deepEqual(generator.calls[0].sources.map((source) => source.reference), [
    'message:0',
    'message:1',
    'message:2',
    'message:3',
    'message:4',
  ]);
});

test('重复压缩应保持来源序号连续并继承已验证事实', async () => {
  const memory = createLongMemory();
  const generator = new QueueSummaryGenerator([
    createDraft({
      confirmedFacts: [{ fact: '项目状态为完成', source: 'message:2' }],
    }),
    createDraft({ userGoal: '被旧候选覆盖的目标' }),
  ]);
  const service = new MemoryCompactionService(generator, 16_000);
  await service.compact(memory, createCompactionContext({
    userGoal: '完成 MEMORY-103',
    completedWork: ['已建立模型'],
    pendingWork: ['继续实现'],
  }));

  memory.addMessages([
    { role: 'user', content: `第二段历史${'第二段历史'.repeat(700)}` },
    {
      role: 'assistant',
      tool_calls: [{ id: 'next-call', function: { name: 'inspect', arguments: '{}' } }],
    },
    {
      role: 'tool',
      tool_call_id: 'next-call',
      content: JSON.stringify({ success: true, data: '第二条事实' }),
    },
    { role: 'user', content: '处理最后一步' },
    { role: 'assistant', content: `最新结果${'最新'.repeat(800)}` },
  ]);
  const second = await service.compact(memory, createCompactionContext({
    userGoal: '完成 MEMORY-103',
    completedWork: ['已写入测试'],
    pendingWork: ['处理最后一步'],
  }));

  assert.equal(second, true);
  assert.deepEqual(generator.calls[1].sources.map((source) => source.reference), [
    'message:5',
    'message:6',
  ]);
  assert.deepEqual(memory.getSummary()?.sourceMessageRange, {
    startInclusive: 0,
    endInclusive: 6,
  });
  assert.deepEqual(memory.getSummary()?.confirmedFacts, [
    { fact: '项目状态为完成', source: 'message:2' },
  ]);
  assert.deepEqual(memory.getSummary()?.completedWork, ['已建立模型', '已写入测试']);
  assert.equal(Number.isNaN(Date.parse(memory.getSummary()?.generatedAt ?? '')), false);
});

test('摘要生成失败时不应删除或改写任何原始消息', async () => {
  const memory = createLongMemory();
  const before = structuredClone(memory.toSnapshot());
  const generator: MemorySummaryGenerator = {
    /** 模拟模型故障。 */
    async generate() {
      throw new Error('摘要模型不可用');
    },
  };
  const service = new MemoryCompactionService(generator, 16_000);

  const result = await service.compact(memory, createCompactionContext());

  assert.equal(result, false);
  assert.deepEqual(memory.toSnapshot(), before);
});

test('根取消发生后摘要压缩不应调用生成器或写回迟到结果', async () => {
  const memory = createLongMemory();
  const before = structuredClone(memory.toSnapshot());
  const generator = new QueueSummaryGenerator([createDraft()]);
  const controller = new AbortController();
  controller.abort(new DOMException('用户取消', 'AbortError'));

  await assert.rejects(
    () => new MemoryCompactionService(generator, 16_000).compact(
      memory,
      createCompactionContext(),
      controller.signal,
    ),
    /用户取消/,
  );
  assert.equal(generator.calls.length, 0);
  assert.deepEqual(memory.toSnapshot(), before);
});

test('摘要应写入 Working Context 但不伪装成原始会话消息', async () => {
  const memory = createLongMemory();
  const service = new MemoryCompactionService(
    new QueueSummaryGenerator([createDraft({
      confirmedFacts: [{ fact: '项目状态为完成', source: 'message:2' }],
    })]),
    16_000,
  );
  await service.compact(memory, createCompactionContext({
    userGoal: '完成 MEMORY-103',
    pendingWork: ['继续验证'],
  }));
  const llm = new RecordingLLM();
  const agent = new ProbeAgent(
    () => createMemoryUow(memory),
    'session-memory-summary',
    { max_iterations: 2, max_retries: 2, max_search_results: 5 },
    llm,
    new ParseJson(),
    [],
  );

  await agent.run('执行当前请求');

  assert.equal(llm.calls.length, 1);
  const modelInput = JSON.stringify(llm.calls[0].messages);
  assert.match(modelInput, /早期会话的结构化摘要|完成 MEMORY-103|继续验证|项目状态为完成/);
  assert.match(modelInput, /执行当前请求/);
  assert.doesNotMatch(JSON.stringify(memory.getMessages()), /早期会话的结构化摘要/);
});

test('Conversation Memory 仓储应兼容旧 JSON 并恢复新摘要来源区间', async () => {
  let memories: Record<string, unknown> = {
    planner: { messages: [{ role: 'system', content: '旧记录' }] },
  };
  const prisma = {
    session: {
      /** 返回当前测试 JSON。 */
      async findUnique() {
        return { memories };
      },
      /** 捕获仓储保存的新 JSON。 */
      async update(input: { data: { memories: Record<string, unknown> } }) {
        memories = structuredClone(input.data.memories);
      },
    },
  };
  const repository = new DbConversationMemoryRepository(prisma as never);
  const legacy = await repository.get('session-1', 'planner');
  assert.equal(legacy.getSummary(), undefined);

  const memory = createLongMemory();
  await new MemoryCompactionService(
    new QueueSummaryGenerator([createDraft()]),
    16_000,
  ).compact(memory, createCompactionContext({ pendingWork: ['保存后继续'] }));
  await repository.save('session-1', 'react', memory);
  const restored = await repository.get('session-1', 'react');

  assert.equal((memories.planner as { messages: unknown[] }).messages.length, 1);
  assert.deepEqual(restored.getSummary(), memory.getSummary());
  assert.deepEqual(restored.getMessages(), memory.getMessages());
});

test('计划压缩上下文应以步骤状态、用户附件和结构化 Skill 为准', () => {
  const plan = createPlan({
    goal: '完成长会话任务',
    steps: [
      {
        description: '收集证据',
        status: ExecutionStatus.COMPLETED,
        success: true,
        result: '已收集',
        attachments: ['artifact://evidence'],
      },
      {
        description: '生成报告',
        status: ExecutionStatus.PENDING,
        attachments: [],
      },
      {
        description: '已失败步骤',
        status: ExecutionStatus.FAILED,
        success: false,
        attachments: [],
      },
    ],
  });
  const context = createPlanMemoryCompactionContext(
    plan,
    createMessage({ message: '继续', attachments: ['artifact://input'] }),
    {
      catalog: [],
      activated: [{
        descriptor: { id: 'memory-design', name: 'memory-design', description: '设计记忆' },
        content: '指令正文不得进入摘要',
        contentDigest: 'sha256:skill-v1',
        resources: [],
      }],
    },
  );

  assert.deepEqual(context, {
    userGoal: '完成长会话任务',
    completedWork: ['收集证据：已收集'],
    pendingWork: ['生成报告'],
    activeSkills: [{ name: 'memory-design', version: 'sha256:skill-v1' }],
    artifacts: [
      { id: 'artifact://input', description: '当前用户请求的附件' },
      { id: 'artifact://evidence', description: '计划步骤“收集证据”的附件' },
    ],
  });
  assert.doesNotMatch(JSON.stringify(context), /指令正文不得进入摘要/);
});
