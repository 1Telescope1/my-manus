import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolDescriptor, ToolRegistration, ToolSource } from '../../src/domain/models/tool';
import { ToolResult } from '../../src/domain/models/tool-result';
import { createAgentToolRegistry } from '../../src/domain/services/tools/agent-toolset';
import { MCPClientManager } from '../../src/domain/services/tools/mcp.tool';
import { MessageTool } from '../../src/domain/services/tools/message.tool';
import {
  InMemoryToolRegistry,
  InvalidToolDescriptorError,
  ToolConflictError,
} from '../../src/domain/services/tools/tool-registry';
import { toOpenAIToolSchema } from '../../src/infrastructure/external/llm/openai-llm';

/** 创建指定来源的最小可执行注册项。 */
function registration(
  id: string,
  name: string,
  source: ToolSource,
  capabilities: string[] = [name],
): ToolRegistration {
  return {
    descriptor: {
      id,
      name,
      source,
      description: `${source} ${name}`,
      inputSchema: {
        type: 'object',
        properties: {
          value: { type: 'string' },
        },
        required: ['value'],
      },
      capabilities,
      risk: source === 'builtin' ? 'read' : 'external_communication',
      requiresApproval: source !== 'builtin',
      timeoutMs: 60_000,
    },
    groupName: source,
    invoke: async (arguments_): Promise<ToolResult> => ({ success: true, data: arguments_ }),
  };
}

test('Registry 应注册并查询 builtin、MCP 和 agent 三类工具', () => {
  const registry = new InMemoryToolRegistry();
  registry.registerAll([
    registration('builtin:read', 'read_local', 'builtin', ['data.read']),
    registration('mcp:crm:read', 'mcp_crm_read', 'mcp', ['data.read', 'crm']),
    registration('agent:researcher', 'delegate_research', 'agent', ['research']),
  ]);

  assert.equal(registry.list().length, 3);
  assert.equal(registry.getById('builtin:read')?.source, 'builtin');
  assert.equal(registry.getByName('mcp_crm_read')?.source, 'mcp');
  assert.deepEqual(
    registry.list({ sources: ['agent'] }).map((descriptor) => descriptor.name),
    ['delegate_research'],
  );
  assert.deepEqual(
    registry.list({ capabilities: ['data.read', 'crm'] }).map((descriptor) => descriptor.name),
    ['mcp_crm_read'],
  );
});

test('Registry 应拒绝重复 id', () => {
  const registry = new InMemoryToolRegistry();
  registry.register(registration('shared:id', 'first_name', 'builtin'));

  assert.throws(
    () => registry.registerAll([registration('shared:id', 'second_name', 'agent')]),
    (error) => error instanceof ToolConflictError
      && error.field === 'id'
      && error.value === 'shared:id',
  );
});

test('Registry 应拒绝跨来源的重复 name', () => {
  const registry = new InMemoryToolRegistry();
  registry.registerAll([registration('builtin:shared', 'shared_name', 'builtin')]);

  assert.throws(
    () => registry.registerAll([registration('agent:shared', 'shared_name', 'agent')]),
    (error) => error instanceof ToolConflictError
      && error.field === 'name'
      && error.value === 'shared_name',
  );
});

test('批量注册冲突时不应留下部分结果', () => {
  const registry = new InMemoryToolRegistry();
  registry.registerAll([registration('builtin:existing', 'existing_name', 'builtin')]);

  assert.throws(() => registry.registerAll([
    registration('mcp:new', 'new_name', 'mcp'),
    registration('agent:collision', 'existing_name', 'agent'),
  ]), ToolConflictError);

  assert.equal(registry.getById('mcp:new'), undefined);
  assert.equal(registry.list().length, 1);
});

test('Registry 应拒绝无效超时且不写入描述', () => {
  const registry = new InMemoryToolRegistry();
  const invalid = registration('builtin:invalid', 'invalid_timeout', 'builtin');
  invalid.descriptor.timeoutMs = 0;

  assert.throws(() => registry.registerAll([invalid]), InvalidToolDescriptorError);
  assert.equal(registry.list().length, 0);
});

test('Registry 查询结果不应修改内部描述', () => {
  const registry = new InMemoryToolRegistry();
  registry.registerAll([registration('builtin:safe', 'safe_read', 'builtin', ['safe'])]);

  const descriptor = registry.getById('builtin:safe') as ToolDescriptor;
  descriptor.capabilities.push('mutated');
  (descriptor.inputSchema.properties as Record<string, unknown>).extra = { type: 'string' };

  assert.deepEqual(registry.getById('builtin:safe')?.capabilities, ['safe']);
  assert.equal(
    Object.hasOwn(
      registry.getById('builtin:safe')?.inputSchema.properties as Record<string, unknown>,
      'extra',
    ),
    false,
  );
});

test('内置装饰器应生成 Descriptor 并通过 Registry 调用', async () => {
  const registry = createAgentToolRegistry([new MessageTool()]);
  const descriptor = registry.getByName('message_notify_user');
  const result = await registry.resolve('message_notify_user')?.invoke({ text: 'hello' });

  assert.deepEqual(descriptor, {
    id: 'builtin:message_notify_user',
    name: 'message_notify_user',
    source: 'builtin',
    description:
      '向用户发送消息，且无需用户回复。用于确认收到消息、提供进度更新、报告任务完成情况，或解释处理方式的变更。',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: '要显示给用户的消息文本',
        },
      },
      required: ['text'],
    },
    capabilities: ['user.communication'],
    risk: 'external_communication',
    requiresApproval: false,
    timeoutMs: 60_000,
  });
  assert.deepEqual(result, { success: true, data: 'Continue' });
});

test('MCP 描述应保留服务器命名空间并采用保守风险', async () => {
  const manager = new MCPClientManager({ mcpServers: {} });
  manager.tools.crm = [{
    name: 'lookup',
    description: '查询 CRM',
    inputSchema: { type: 'object', properties: {} },
  }];

  const descriptors = await manager.getAllTools();

  assert.deepEqual(descriptors[0], {
    id: 'mcp:crm:lookup',
    name: 'mcp_crm_lookup',
    source: 'mcp',
    description: '[crm] 查询 CRM',
    inputSchema: { type: 'object', properties: {} },
    capabilities: ['mcp:crm', 'mcp:crm:lookup'],
    risk: 'external_communication',
    requiresApproval: true,
    timeoutMs: 60_000,
  });
});

test('OpenAI 适配器只应在基础设施边界生成 function schema', () => {
  const descriptor = registration(
    'agent:researcher',
    'delegate_research',
    'agent',
    ['research'],
  ).descriptor;

  assert.deepEqual(toOpenAIToolSchema(descriptor), {
    type: 'function',
    function: {
      name: 'delegate_research',
      description: 'agent delegate_research',
      parameters: descriptor.inputSchema,
    },
  });
});
