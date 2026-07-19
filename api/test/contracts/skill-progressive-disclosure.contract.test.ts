import assert from 'node:assert/strict';
import test from 'node:test';
import { JSONParser } from '../../src/domain/external/json-parser';
import { LLM, LLMMessage } from '../../src/domain/external/llm';
import {
  LoadedSkillContent,
  SkillContentLoader,
  SkillResourceKind,
} from '../../src/domain/models/skill-content';
import { SkillCatalogDiscovery, SkillCatalogSnapshot } from '../../src/domain/models/skill';
import {
  formatRuntimeSkillContext,
  SkillActivationError,
  skillToolSelectionScopes,
} from '../../src/domain/models/skill-disclosure';
import { UnitOfWork } from '../../src/domain/repositories/unit-of-work';
import { BaseAgent } from '../../src/domain/services/agents/base-agent';
import { SkillProgressiveDisclosureService } from '../../src/domain/services/skills/skill-progressive-disclosure.service';

type LLMInvokeInput = Parameters<LLM['invoke']>[0];

const catalog: SkillCatalogSnapshot = {
  entries: [
    {
      id: 'project:alpha-skill',
      name: 'alpha-skill',
      description: '处理 Alpha 文件。',
    },
    {
      id: 'project:beta-skill',
      name: 'beta-skill',
      description: '处理 Beta 数据。',
    },
  ],
  diagnostics: [],
};

/** 返回固定 Catalog，便于验证发现与正文读取分层。 */
class StaticCatalog implements SkillCatalogDiscovery {
  /** 每次返回独立快照。 */
  async discover(): Promise<SkillCatalogSnapshot> {
    return structuredClone(catalog);
  }
}

/** 记录每个 stable ID 的读取次数，并禁止资源读取。 */
class RecordingLoader implements SkillContentLoader {
  readonly loads: string[] = [];
  resourceReads = 0;

  /** 返回包含唯一正文标记和可选工具上界的完整 Skill。 */
  async load(skillId: string): Promise<LoadedSkillContent> {
    this.loads.push(skillId);
    const descriptor = catalog.entries.find((entry) => entry.id === skillId);
    if (!descriptor) {
      throw new Error(`未知测试 Skill：${skillId}`);
    }
    return {
      descriptor,
      content: `---\nname: ${descriptor.name}\ndescription: ${descriptor.description}\n---\n${descriptor.name}-BODY`,
      contentDigest: `${descriptor.name}-digest`,
      ...(descriptor.name === 'alpha-skill'
        ? { allowedTools: ['search_web'] }
        : {}),
      resources: [{
        path: 'references/guide.md',
        kind: SkillResourceKind.REFERENCE,
        sizeBytes: 10,
      }],
    };
  }

  /** 本任务不允许自动读取资源；若发生即让测试失败。 */
  async readResource(): Promise<never> {
    this.resourceReads += 1;
    throw new Error('不应自动读取 Skill 资源');
  }
}

/** 记录完整模型输入并返回普通文本回答。 */
class RecordingLLM extends LLM {
  readonly modelName = 'skill-disclosure-test';
  readonly temperature = 0;
  readonly maxTokens = 256;
  readonly calls: LLMInvokeInput[] = [];

  /** 保存请求快照，避免后续 Memory 变化影响断言。 */
  async invoke(input: LLMInvokeInput): Promise<LLMMessage> {
    this.calls.push(structuredClone(input));
    return { role: 'assistant', content: 'ok' };
  }
}

/** 只实现 BaseAgent 当前测试会访问的 Memory 仓储。 */
function createMemoryUnitOfWork() {
  const memories = new Map<string, import('../../src/domain/models/memory').Memory>();
  const session = {
    /** 返回 Agent 自己的持久 Memory。 */
    async getMemory(_sessionId: string, agentName: string) {
      const { Memory } = await import('../../src/domain/models/memory');
      return memories.get(agentName) ?? new Memory();
    },
    /** 保存 Memory 的当前对象。 */
    async saveMemory(
      _sessionId: string,
      agentName: string,
      memory: import('../../src/domain/models/memory').Memory,
    ) {
      memories.set(agentName, memory);
    },
  };
  const uow = {
    session,
    /** 测试不访问其他仓储。 */
    async run<T>(handler: (active: UnitOfWork) => Promise<T>): Promise<T> {
      return handler(uow as unknown as UnitOfWork);
    },
  };
  return uow as unknown as UnitOfWork;
}

/** 公开 BaseAgent 的最小无工具调用，用于验证 protected context 不入 Memory。 */
class ProbeAgent extends BaseAgent {
  readonly name = 'probe';
  protected override systemPrompt = 'BASE-SYSTEM';

  /** 执行一次只生成回答的模型请求。 */
  async run(protectedSystemContext?: string): Promise<void> {
    for await (const _event of this.invoke('用户请求', undefined, {
      protectedSystemContext,
    })) {
      // 消费完整生成器，确保 assistant 消息也被写入持久 Memory。
    }
  }
}

/** 创建满足 ProbeAgent 构造边界的简单 JSON Parser。 */
function createJsonParser(): JSONParser {
  return {
    /** 测试没有工具参数，保留标准 JSON 行为。 */
    async invoke<T>(text: string, defaultValue?: T): Promise<T> {
      try {
        return JSON.parse(text) as T;
      } catch {
        return defaultValue as T;
      }
    },
  } as JSONParser;
}

test('未激活时模型上下文应只包含 Catalog 元数据', async () => {
  const loader = new RecordingLoader();
  const disclosure = await new SkillProgressiveDisclosureService(
    new StaticCatalog(),
    loader,
  ).initialize({ message: '普通请求' });

  const formatted = formatRuntimeSkillContext({
    catalog: disclosure.catalog,
    activated: [],
  });

  assert.match(formatted, /处理 Alpha 文件/);
  assert.match(formatted, /处理 Beta 数据/);
  assert.doesNotMatch(formatted, /alpha-skill-BODY|beta-skill-BODY/);
  assert.deepEqual(loader.loads, []);
  assert.equal(loader.resourceReads, 0);
});

test('显式标记和 Router 重复请求应在 Run 内只激活一次', async () => {
  const loader = new RecordingLoader();
  const disclosure = await new SkillProgressiveDisclosureService(
    new StaticCatalog(),
    loader,
  ).initialize({ message: '请使用 $alpha-skill 完成任务' });

  await disclosure.activate(['alpha-skill', 'project:alpha-skill']);
  const snapshot = await disclosure.activate(['project:alpha-skill']);
  const formatted = formatRuntimeSkillContext(snapshot);

  assert.deepEqual(disclosure.explicitSkillIds, ['project:alpha-skill']);
  assert.deepEqual(loader.loads, ['project:alpha-skill']);
  assert.equal(formatted.match(/alpha-skill-BODY/g)?.length, 1);
  assert.deepEqual(skillToolSelectionScopes(snapshot), [
    { allowedToolNames: ['search_web'] },
  ]);
  assert.equal(loader.resourceReads, 0);
});

test('Router 可按名称激活正文并隔离未知 Skill', async () => {
  const loader = new RecordingLoader();
  const disclosure = await new SkillProgressiveDisclosureService(
    new StaticCatalog(),
    loader,
  ).initialize({ message: '处理数据' });

  const snapshot = await disclosure.activate(['beta-skill', 'invented-skill']);

  assert.deepEqual(loader.loads, ['project:beta-skill']);
  assert.deepEqual(snapshot.activated.map((skill) => skill.descriptor.id), [
    'project:beta-skill',
  ]);
  assert.deepEqual(skillToolSelectionScopes(snapshot), []);
});

test('调用方显式请求未知 Skill 应返回稳定错误', async () => {
  const service = new SkillProgressiveDisclosureService(
    new StaticCatalog(),
    new RecordingLoader(),
  );

  await assert.rejects(
    () => service.initialize({ message: '任务', requestedSkills: ['missing-skill'] }),
    (error: unknown) => (
      error instanceof SkillActivationError
      && error.code === 'explicit_skill_not_found'
      && error.skillRequest === 'missing-skill'
    ),
  );
});

test('Run 级 Skill 正文应进入每次模型请求但不写入 Session Memory', async () => {
  const loader = new RecordingLoader();
  const disclosure = await new SkillProgressiveDisclosureService(
    new StaticCatalog(),
    loader,
  ).initialize({ message: '请使用 $alpha-skill' });
  const snapshot = await disclosure.activate([]);
  const protectedContext = formatRuntimeSkillContext(snapshot);
  const llm = new RecordingLLM();
  const uow = createMemoryUnitOfWork();
  const agent = new ProbeAgent(
    () => uow,
    'session-skill',
    { max_iterations: 2, max_retries: 2, max_search_results: 5 },
    llm,
    createJsonParser(),
    [],
  );

  await agent.run(protectedContext);
  await agent.run();

  const firstMessages = JSON.stringify(llm.calls[0].messages);
  const secondMessages = JSON.stringify(llm.calls[1].messages);
  assert.match(firstMessages, /alpha-skill-BODY/);
  assert.equal(firstMessages.match(/alpha-skill-BODY/g)?.length, 1);
  assert.doesNotMatch(secondMessages, /alpha-skill-BODY/);
  assert.equal(
    llm.calls[0].messages.filter((message) => message.role === 'system').length,
    2,
  );
  assert.equal(
    llm.calls[1].messages.filter((message) => message.role === 'system').length,
    1,
  );
});
