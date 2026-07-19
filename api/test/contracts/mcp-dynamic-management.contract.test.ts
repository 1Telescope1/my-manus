import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MCPConfig,
  MCPServerConfig,
  MCPTransport,
} from '../../src/domain/models/app-config';
import {
  MCPClientConnection,
  MCPClientManager,
  MCPServerConnector,
  MCPTool,
  MCPToolSchema,
  MCPToolsChangedHandler,
} from '../../src/domain/services/tools/mcp.tool';
import {
  createAgentToolRegistry,
  synchronizeAgentToolRegistry,
} from '../../src/domain/services/tools/agent-toolset';
import { MessageTool } from '../../src/domain/services/tools/message.tool';

type FakeServerState = {
  tools: MCPToolSchema[];
  listError?: Error;
  callCount: number;
  closeCount: number;
  closeError?: Error;
};

/** 创建包含 enabled 与 disabled 标志的最小 HTTP MCP 配置。 */
function serverConfig(enabled: boolean): MCPServerConfig {
  return {
    transport: MCPTransport.STREAMABLE_HTTP,
    enabled,
    url: 'https://mcp.example.test',
  };
}

/** 根据服务名集合创建完整 MCPConfig。 */
function mcpConfig(servers: Record<string, MCPServerConfig>): MCPConfig {
  return { mcpServers: servers };
}

/** 创建可动态修改工具快照、列表故障和清理故障的假连接。 */
function fakeConnection(state: FakeServerState): MCPClientConnection {
  return {
    client: {
      /** 返回当前工具快照或预设列表错误。 */
      async listTools() {
        if (state.listError) {
          throw state.listError;
        }
        return { tools: state.tools };
      },
      /** 记录调用并返回固定文本内容。 */
      async callTool(input) {
        state.callCount += 1;
        return { content: [{ type: 'text', text: `called:${input.name}` }] };
      },
      /** 记录关闭次数并模拟可选清理异常。 */
      async close() {
        state.closeCount += 1;
        if (state.closeError) {
          throw state.closeError;
        }
      },
    },
  };
}

/** 创建按服务状态返回连接并记录 list changed 回调的测试 connector。 */
function createConnector(
  states: Record<string, FakeServerState>,
  connected: string[],
  notifications: Map<string, MCPToolsChangedHandler>,
  failures: ReadonlySet<string> = new Set(),
): MCPServerConnector {
  return async (serverName, _config, onToolsChanged) => {
    connected.push(serverName);
    if (failures.has(serverName)) {
      throw new Error(`连接失败:${serverName}`);
    }
    notifications.set(serverName, onToolsChanged);
    return fakeConnection(states[serverName]);
  };
}

/** 创建测试状态并填充必须的计数字段。 */
function state(tools: MCPToolSchema[]): FakeServerState {
  return { tools, callCount: 0, closeCount: 0 };
}

test('disabled MCP 服务不应连接也不应暴露工具', async () => {
  const states = {
    enabled: state([{ name: 'search' }]),
    disabled: state([{ name: 'delete' }]),
  };
  const connected: string[] = [];
  const notifications = new Map<string, MCPToolsChangedHandler>();
  const manager = new MCPClientManager(mcpConfig({
    enabled: serverConfig(true),
    disabled: serverConfig(false),
  }), {
    connector: createConnector(states, connected, notifications),
  });

  await manager.initialize();

  assert.deepEqual(connected, ['enabled']);
  assert.deepEqual(Object.keys(manager.tools), ['enabled']);
  assert.deepEqual(manager.getAllTools().map((tool) => tool.name), ['mcp_enabled_search']);
  assert.equal(manager.getAllTools().some((tool) => tool.name.includes('delete')), false);
});

test('单个 MCP 连接失败不应影响其他服务和内置工具', async () => {
  const states = {
    broken: state([]),
    crm: state([{ name: 'lookup', description: '查询 CRM' }]),
  };
  const connected: string[] = [];
  const notifications = new Map<string, MCPToolsChangedHandler>();
  const config = mcpConfig({
    broken: serverConfig(true),
    crm: serverConfig(true),
  });
  const connector = createConnector(states, connected, notifications, new Set(['broken']));
  const mcpTool = new MCPTool((input) => new MCPClientManager(input, { connector }));

  await mcpTool.initialize(config);
  const registry = createAgentToolRegistry([new MessageTool(), mcpTool]);

  assert.deepEqual(connected, ['broken', 'crm']);
  assert.equal(registry.getByName('message_notify_user')?.source, 'builtin');
  assert.equal(registry.getByName('mcp_crm_lookup')?.source, 'mcp');
  assert.equal(registry.list({ sources: ['mcp'] }).length, 1);
});

test('MCP 工具应始终保留服务命名空间并隔离同名工具', async () => {
  const states = {
    crm: state([{ name: 'lookup' }]),
    billing: state([{ name: 'lookup' }]),
  };
  const manager = new MCPClientManager(mcpConfig({
    crm: serverConfig(true),
    billing: serverConfig(true),
  }), {
    connector: createConnector(states, [], new Map()),
  });

  await manager.initialize();

  assert.deepEqual(
    manager.getAllTools().map((tool) => ({ id: tool.id, name: tool.name })),
    [
      { id: 'mcp:crm:lookup', name: 'mcp_crm_lookup' },
      { id: 'mcp:billing:lookup', name: 'mcp_billing_lookup' },
    ],
  );
});

test('服务名互为前缀时 MCP 调用仍应精确路由', async () => {
  const states = {
    crm: state([{ name: 'status' }]),
    crm_archive: state([{ name: 'lookup' }]),
  };
  const manager = new MCPClientManager(mcpConfig({
    crm: serverConfig(true),
    crm_archive: serverConfig(true),
  }), {
    connector: createConnector(states, [], new Map()),
  });
  await manager.initialize();

  const result = await manager.invoke('mcp_crm_archive_lookup', {});

  assert.equal(result.success, true);
  assert.equal(states.crm.callCount, 0);
  assert.equal(states.crm_archive.callCount, 1);
});

test('服务端工具变化通知应让 Registry 新增删除并替换 Schema', async () => {
  const states = {
    crm: state([{
      name: 'old_lookup',
      description: '旧查询',
      inputSchema: { type: 'object', properties: { old: { type: 'string' } } },
    }]),
  };
  const notifications = new Map<string, MCPToolsChangedHandler>();
  const connector = createConnector(states, [], notifications);
  const mcpTool = new MCPTool((input) => new MCPClientManager(input, { connector }));
  await mcpTool.initialize(mcpConfig({ crm: serverConfig(true) }));
  const tools = [new MessageTool(), mcpTool];
  const registry = createAgentToolRegistry(tools);

  notifications.get('crm')?.(null, [{
    name: 'new_lookup',
    description: '新查询 v1',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  }]);
  synchronizeAgentToolRegistry(registry, tools);

  assert.equal(registry.getByName('mcp_crm_old_lookup'), undefined);
  assert.equal(registry.getByName('mcp_crm_new_lookup')?.description, '[crm] 新查询 v1');
  assert.equal(registry.getByName('message_notify_user')?.source, 'builtin');

  notifications.get('crm')?.(null, [{
    name: 'new_lookup',
    description: '新查询 v2',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'number' } },
    },
  }]);
  synchronizeAgentToolRegistry(registry, tools);

  assert.equal(registry.getByName('mcp_crm_new_lookup')?.description, '[crm] 新查询 v2');
  assert.deepEqual(
    registry.getByName('mcp_crm_new_lookup')?.inputSchema,
    {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'number' } },
    },
  );
});

test('主动刷新应隔离单服务错误并保留最后成功快照', async () => {
  const states = {
    stable: state([{ name: 'before' }]),
    flaky: state([{ name: 'cached' }]),
  };
  const manager = new MCPClientManager(mcpConfig({
    stable: serverConfig(true),
    flaky: serverConfig(true),
  }), {
    connector: createConnector(states, [], new Map()),
  });
  await manager.initialize();

  states.stable.tools = [{ name: 'after' }];
  states.flaky.listError = new Error('临时列表故障');
  await manager.refreshTools();

  assert.deepEqual(manager.getAllTools().map((tool) => tool.name), [
    'mcp_stable_after',
    'mcp_flaky_cached',
  ]);
});

test('工具删除后即使模型持有旧名称也不应继续调用', async () => {
  const states = { crm: state([{ name: 'lookup' }]) };
  const notifications = new Map<string, MCPToolsChangedHandler>();
  const manager = new MCPClientManager(mcpConfig({ crm: serverConfig(true) }), {
    connector: createConnector(states, [], notifications),
  });
  await manager.initialize();

  notifications.get('crm')?.(null, []);
  const result = await manager.invoke('mcp_crm_lookup', {});

  assert.equal(result.success, false);
  assert.equal(result.message, 'MCP工具已不可用: mcp_crm_lookup');
  assert.equal(states.crm.callCount, 0);
});

test('MCP 清理错误应隔离并继续关闭其他服务', async () => {
  const states = {
    broken: state([]),
    healthy: state([]),
  };
  states.broken.closeError = new Error('关闭失败');
  const manager = new MCPClientManager(mcpConfig({
    broken: serverConfig(true),
    healthy: serverConfig(true),
  }), {
    connector: createConnector(states, [], new Map()),
  });
  await manager.initialize();

  await manager.cleanup();

  assert.equal(states.broken.closeCount, 1);
  assert.equal(states.healthy.closeCount, 1);
  assert.deepEqual(manager.tools, {});
});
