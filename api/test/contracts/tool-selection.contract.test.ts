import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolRegistration, ToolRisk, ToolSource } from '../../src/domain/models/tool';
import { ToolSelectionRequest } from '../../src/domain/models/tool-selection';
import { InMemoryToolRegistry } from '../../src/domain/services/tools/tool-registry';
import { ToolSelectionService } from '../../src/domain/services/tools/tool-selection.service';

/** 创建只用于选择测试的工具注册项。 */
function registration(input: {
  id: string;
  name: string;
  source?: ToolSource;
  capabilities: string[];
  risk?: ToolRisk;
}): ToolRegistration {
  return {
    descriptor: {
      id: input.id,
      name: input.name,
      source: input.source ?? 'builtin',
      description: `测试工具 ${input.name}`,
      inputSchema: { type: 'object', properties: {} },
      capabilities: input.capabilities,
      risk: input.risk ?? 'read',
      requiresApproval: false,
      timeoutMs: 60_000,
    },
    groupName: 'test',
    invoke: async () => ({ success: true }),
  };
}

/** 创建包含读、写、搜索、MCP 和 Agent 能力的测试选择器。 */
function createSelector(): ToolSelectionService {
  const registry = new InMemoryToolRegistry();
  registry.registerAll([
    registration({
      id: 'builtin:file-read',
      name: 'read_file',
      capabilities: ['file.read'],
    }),
    registration({
      id: 'builtin:file-write',
      name: 'write_file',
      capabilities: ['file.write'],
      risk: 'write',
    }),
    registration({
      id: 'builtin:search',
      name: 'search_web',
      capabilities: ['search', 'web.search'],
    }),
    registration({
      id: 'mcp:crm:lookup',
      name: 'mcp_crm_lookup',
      source: 'mcp',
      capabilities: ['crm.read'],
      risk: 'external_communication',
    }),
    registration({
      id: 'agent:researcher',
      name: 'delegate_research',
      source: 'agent',
      capabilities: ['research'],
      risk: 'external_communication',
    }),
  ]);
  return new ToolSelectionService(registry);
}

/** 只返回工具名称，缩短组合约束断言。 */
function selectedNames(
  selector: ToolSelectionService,
  request: ToolSelectionRequest,
): string[] {
  return selector.select(request).tools.map((tool) => tool.name);
}

test('Router capability 应只选择相关工具', () => {
  assert.deepEqual(selectedNames(createSelector(), {
    routerCapabilities: ['search'],
  }), ['search_web']);
});

test('Agent 授权上界应阻止未授权工具进入结果', () => {
  const selector = createSelector();
  const result = selector.select({
    routerCapabilities: ['file.write'],
    agent: { allowedToolNames: ['read_file'] },
  });

  assert.deepEqual(result.tools, []);
  assert.deepEqual(result.uncoveredCapabilities, ['file.write']);
});

test('Workflow 与 Agent 允许范围应取交集', () => {
  assert.deepEqual(selectedNames(createSelector(), {
    routerCapabilities: ['file.read', 'file.write'],
    workflow: { allowedToolNames: ['read_file', 'write_file'] },
    agent: { allowedToolNames: ['read_file', 'search_web'] },
  }), ['read_file']);
});

test('多个 Skill 请求应合并但不能越过 Agent 上界', () => {
  assert.deepEqual(selectedNames(createSelector(), {
    routerCapabilities: [],
    agent: { allowedSources: ['builtin', 'mcp'] },
    skills: [
      { requestedToolNames: ['read_file'], allowedToolNames: ['read_file'] },
      {
        requestedToolNames: ['mcp_crm_lookup', 'delegate_research'],
        allowedToolNames: ['mcp_crm_lookup', 'delegate_research'],
      },
    ],
  }), ['read_file', 'mcp_crm_lookup']);
});

test('Policy deny 应覆盖 Router 和 Skill 的显式请求', () => {
  assert.deepEqual(selectedNames(createSelector(), {
    routerCapabilities: ['file.write'],
    skills: [{ requestedToolNames: ['mcp_crm_lookup'] }],
    policy: {
      deniedRisks: ['write'],
      deniedToolNames: ['mcp_crm_lookup'],
    },
  }), []);
});

test('没有任何相关性信号时应返回零工具', () => {
  assert.deepEqual(selectedNames(createSelector(), {
    routerCapabilities: [],
    agent: { allowedSources: ['builtin', 'mcp', 'agent'] },
  }), []);
});

test('显式工具请求应选择无 capability 请求的指定工具', () => {
  assert.deepEqual(selectedNames(createSelector(), {
    routerCapabilities: [],
    workflow: { requestedToolIds: ['builtin:file-read'] },
  }), ['read_file']);
});

test('多 capability 应选择各自匹配工具并报告未覆盖项', () => {
  const result = createSelector().select({
    routerCapabilities: ['file.read', 'research', 'missing.capability'],
  });

  assert.deepEqual(result.tools.map((tool) => tool.name), [
    'read_file',
    'delegate_research',
  ]);
  assert.deepEqual(result.uncoveredCapabilities, ['missing.capability']);
});
