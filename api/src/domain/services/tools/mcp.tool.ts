import { Logger } from '@nestjs/common';
import {
  MCPConfig,
  MCPServerConfig,
  MCPTransport,
} from '../../models/app-config';
import { ToolDescriptor, ToolExecutionContext, ToolRegistration } from '../../models/tool';
import { ToolResult } from '../../models/tool-result';
import { BaseTool } from './base-tool';

export type MCPToolSchema = {
  name: string;
  description?: string;
  inputSchema?: Record<string, any>;
};

/** MCP manager 实际依赖的最小客户端能力，便于隔离 SDK 与契约测试。 */
export type MCPClientConnection = {
  client: {
    listTools: (
      params?: Record<string, never>,
      options?: { signal?: AbortSignal },
    ) => Promise<{ tools?: MCPToolSchema[] }>;
    callTool: (input: {
      name: string;
      arguments: Record<string, any>;
    }, resultSchema?: undefined, options?: { signal?: AbortSignal }) => Promise<{ content?: any[] }>;
    close?: () => Promise<void>;
  };
  transport?: { close?: () => Promise<void> };
};

/** SDK list changed 回调在成功时提供新快照，失败时提供错误。 */
export type MCPToolsChangedHandler = (
  error: unknown,
  tools: readonly MCPToolSchema[] | null,
) => void;

/** 每个 MCP 服务独立建立连接的注入边界。 */
export type MCPServerConnector = (
  serverName: string,
  config: MCPServerConfig,
  onToolsChanged: MCPToolsChangedHandler,
) => Promise<MCPClientConnection>;

/** MCP manager 的可测试连接配置。 */
export type MCPClientManagerOptions = {
  connector?: MCPServerConnector;
};

/** 一次主动刷新每个目标服务的结果。 */
export type MCPToolRefreshResult = {
  serverName: string;
  outcome: 'refreshed' | 'failed' | 'not_connected';
  error?: string;
};

export class MCPClientManager {
  private readonly logger = new Logger(MCPClientManager.name);
  private readonly clients: Record<string, MCPClientConnection> = {};
  private readonly cachedTools: Record<string, MCPToolSchema[]> = {};
  private readonly connector: MCPServerConnector;
  private initialized = false;

  /** 保存配置并选择生产 SDK connector 或测试注入 connector。 */
  constructor(
    private readonly mcpConfig: MCPConfig,
    options: MCPClientManagerOptions = {},
  ) {
    this.connector = options.connector ?? ((serverName, config, onToolsChanged) =>
      this.connectMcpServer(serverName, config, onToolsChanged));
  }

  /** 返回与内部缓存隔离的每服务工具快照。 */
  get tools(): Record<string, MCPToolSchema[]> {
    return Object.fromEntries(
      Object.entries(this.cachedTools).map(([serverName, tools]) => [
        serverName,
        tools.map(cloneMcpToolSchema),
      ]),
    );
  }

  /** 只初始化 enabled 服务；每个服务连接失败均被独立隔离。 */
  async initialize(signal?: AbortSignal): Promise<void> {
    if (this.initialized) {
      return;
    }

    signal?.throwIfAborted();
    await this.connectMcpServers(signal);
    const enabledCount = Object.values(this.mcpConfig.mcpServers)
      .filter((config) => config.enabled).length;
    this.logger.log(`已连接${Object.keys(this.clients).length}/${enabledCount}个已启用MCP服务器`);
    this.initialized = true;
  }

  /** 把所有已发现 MCP 工具转换为带服务器命名空间的领域描述。 */
  getAllTools(): ToolDescriptor[] {
    const allTools: ToolDescriptor[] = [];

    for (const [serverName, tools] of Object.entries(this.cachedTools)) {
      for (const mcpTool of tools) {
        const name = namespacedToolName(serverName, mcpTool.name);
        allTools.push({
          id: `mcp:${serverName}:${mcpTool.name}`,
          name,
          source: 'mcp',
          description: `[${serverName}] ${mcpTool.description || mcpTool.name}`,
          inputSchema: mcpTool.inputSchema ?? { type: 'object', properties: {} },
          capabilities: [`mcp:${serverName}`, `mcp:${serverName}:${mcpTool.name}`],
          // MCP Schema 不提供本系统的副作用语义，先按外部通信保守分类。
          risk: 'external_communication',
          requiresApproval: true,
          timeoutMs: 60_000,
        });
      }
    }

    return allTools;
  }

  /** 主动刷新一个或全部已连接服务，单服务失败保留其最后成功快照。 */
  async refreshTools(
    serverName?: string,
    signal?: AbortSignal,
  ): Promise<MCPToolRefreshResult[]> {
    const serverNames = serverName ? [serverName] : Object.keys(this.clients);
    const results: MCPToolRefreshResult[] = [];

    for (const target of serverNames) {
      signal?.throwIfAborted();
      const record = this.clients[target];
      if (!record) {
        results.push({ serverName: target, outcome: 'not_connected' });
        continue;
      }
      const refreshed = await this.fetchAndCacheTools(target, record.client, false, signal);
      results.push(refreshed.ok
        ? { serverName: target, outcome: 'refreshed' }
        : { serverName: target, outcome: 'failed', error: refreshed.error });
    }
    return results;
  }

  /** 只解析当前已连接且仍存在于最新缓存的命名空间工具。 */
  async invoke(
    toolName: string,
    arguments_: Record<string, any>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    try {
      let originalServerName: string | undefined;
      let originalToolName: string | undefined;

      // 用缓存中的完整命名空间名称精确匹配，避免 server 名互为前缀时路由错误。
      for (const [serverName, tools] of Object.entries(this.cachedTools)) {
        const matched = tools.find((tool) => namespacedToolName(serverName, tool.name) === toolName);
        if (matched) {
          originalServerName = serverName;
          originalToolName = matched.name;
          break;
        }
      }

      if (!originalServerName || !originalToolName) {
        return { success: false, message: `MCP工具已不可用: ${toolName}` };
      }

      const record = this.clients[originalServerName];
      if (!record?.client) {
        return { success: false, message: `MCP服务器[${originalServerName}]未连接` };
      }

      const result = await record.client.callTool({
        name: originalToolName,
        arguments: arguments_,
      }, undefined, { signal });
      const content = Array.isArray(result?.content)
        ? result.content.map((item: any) => item.text ?? String(item)).join('\n')
        : undefined;

      return { success: true, data: content || '工具执行成功' };
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(`调用MCP工具[${toolName}]失败: ${err.message}`);
      return {
        success: false,
        message: `调用MCP工具[${toolName}]失败: ${err.message}`,
      };
    }
  }

  /** 独立关闭全部已连接服务，并清空连接与工具快照。 */
  async cleanup(): Promise<void> {
    for (const [serverName, record] of Object.entries(this.clients)) {
      await this.closeConnectionResources(serverName, record);
    }
    Object.keys(this.clients).forEach((key) => delete this.clients[key]);
    Object.keys(this.cachedTools).forEach((key) => delete this.cachedTools[key]);
    this.initialized = false;
  }

  /** 按配置顺序连接 enabled 服务，disabled 服务不创建任何连接资源。 */
  private async connectMcpServers(signal?: AbortSignal): Promise<void> {
    for (const [serverName, serverConfig] of Object.entries(this.mcpConfig.mcpServers)) {
      signal?.throwIfAborted();
      if (!serverConfig.enabled) {
        continue;
      }
      try {
        const record = await this.connector(
          serverName,
          serverConfig,
          (error, tools) => this.handleToolsChanged(serverName, error, tools),
        );
        this.clients[serverName] = record;
        await this.fetchAndCacheTools(serverName, record.client, true, signal);
      } catch (error) {
        if (signal?.aborted) {
          throw error;
        }
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger.error(`连接MCP服务器[${serverName}]出错: ${err.message}`);
        continue;
      }
    }
  }

  /** 根据 transport 创建一个已连接客户端，并为 Tools list changed 注册自动刷新。 */
  private async connectMcpServer(
    serverName: string,
    serverConfig: MCPServerConfig,
    onToolsChanged: MCPToolsChangedHandler,
  ): Promise<MCPClientConnection> {
    if (serverConfig.transport === MCPTransport.STDIO) {
      return this.connectStdioServer(serverName, serverConfig, onToolsChanged);
    } else if (serverConfig.transport === MCPTransport.SSE) {
      return this.connectSseServer(serverName, serverConfig, onToolsChanged);
    } else if (serverConfig.transport === MCPTransport.STREAMABLE_HTTP) {
      return this.connectStreamableHttpServer(serverName, serverConfig, onToolsChanged);
    } else {
      throw new Error(`MCP服务[${serverName}]使用了不支持的传输协议: ${serverConfig.transport}`);
    }
  }

  /** 创建 stdio transport 并交给统一客户端连接逻辑。 */
  private async connectStdioServer(
    serverName: string,
    serverConfig: MCPServerConfig,
    onToolsChanged: MCPToolsChangedHandler,
  ): Promise<MCPClientConnection> {
    if (!serverConfig.command) {
      throw new Error('连接stdio-mcp服务器需要配置command命令');
    }

    const [{ Client }, { StdioClientTransport }] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/stdio.js'),
    ]);

    const transport = new StdioClientTransport({
      command: serverConfig.command,
      args: serverConfig.args ?? [],
      env: { ...process.env, ...(serverConfig.env ?? {}) } as Record<string, string>,
    });
    return this.connectClient(serverName, Client, transport, onToolsChanged);
  }

  /** 创建 legacy SSE transport 并交给统一客户端连接逻辑。 */
  private async connectSseServer(
    serverName: string,
    serverConfig: MCPServerConfig,
    onToolsChanged: MCPToolsChangedHandler,
  ): Promise<MCPClientConnection> {
    if (!serverConfig.url) {
      throw new Error('连接sse-mcp服务器需要配置url');
    }

    const [{ Client }, { SSEClientTransport }] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/sse.js'),
    ]);

    const transport = new SSEClientTransport(new URL(serverConfig.url), {
      requestInit: { headers: serverConfig.headers as HeadersInit },
    } as any);
    return this.connectClient(serverName, Client, transport, onToolsChanged);
  }

  /** 创建 Streamable HTTP transport 并交给统一客户端连接逻辑。 */
  private async connectStreamableHttpServer(
    serverName: string,
    serverConfig: MCPServerConfig,
    onToolsChanged: MCPToolsChangedHandler,
  ): Promise<MCPClientConnection> {
    if (!serverConfig.url) {
      throw new Error('连接streamable-http-mcp服务器需要配置url');
    }

    const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    ]);

    const transport = new StreamableHTTPClientTransport(new URL(serverConfig.url), {
      requestInit: { headers: serverConfig.headers as HeadersInit },
    } as any);
    return this.connectClient(serverName, Client, transport, onToolsChanged);
  }

  /** 创建带 list changed 配置的 SDK Client，连接失败时立即回收局部资源。 */
  private async connectClient(
    serverName: string,
    Client: any,
    transport: any,
    onToolsChanged: MCPToolsChangedHandler,
  ): Promise<MCPClientConnection> {
    const client = new Client(
      { name: 'manus-ts', version: '0.1.0' },
      {
        listChanged: {
          tools: {
            autoRefresh: true,
            debounceMs: 100,
            onChanged: onToolsChanged,
          },
        },
      },
    );
    try {
      await client.connect(transport);
      return { client, transport };
    } catch (error) {
      await this.closeConnectionResources(serverName, { client, transport });
      throw error;
    }
  }

  /** 依次尝试关闭 client 和 transport，任一失败不阻止另一个资源回收。 */
  private async closeConnectionResources(
    serverName: string,
    record: MCPClientConnection,
  ): Promise<void> {
    const closers = [
      () => record.client.close?.(),
      () => record.transport?.close?.(),
    ];
    for (const close of closers) {
      try {
        await close();
      } catch (error) {
        this.logger.warn(`清理MCP服务器[${serverName}]失败: ${errorMessage(error)}`);
      }
    }
  }

  /** 拉取一个服务的工具并原子替换该服务缓存；刷新失败时可保留旧快照。 */
  private async fetchAndCacheTools(
    serverName: string,
    client: MCPClientConnection['client'],
    clearOnFailure: boolean,
    signal?: AbortSignal,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const toolsResponse = await client.listTools(undefined, { signal });
      this.cachedTools[serverName] = (toolsResponse?.tools ?? []).map(cloneMcpToolSchema);
      this.logger.log(`MCP服务器[${serverName}]提供了${this.cachedTools[serverName].length}个工具`);
      return { ok: true };
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(`获取MCP服务器[${serverName}]工具列表失败: ${err.message}`);
      if (clearOnFailure) {
        this.cachedTools[serverName] = [];
      }
      return { ok: false, error: err.message };
    }
  }

  /** 应用 SDK 自动刷新结果；通知失败或无结果时保留旧快照并尝试主动刷新。 */
  private handleToolsChanged(
    serverName: string,
    error: unknown,
    tools: readonly MCPToolSchema[] | null,
  ): void {
    if (error) {
      this.logger.warn(`刷新MCP服务器[${serverName}]工具通知失败: ${errorMessage(error)}`);
      return;
    }
    if (tools) {
      this.cachedTools[serverName] = tools.map(cloneMcpToolSchema);
      return;
    }
    void this.refreshTools(serverName);
  }
}

export class MCPTool extends BaseTool {
  readonly name = 'mcp';
  private initialized = false;
  private manager?: MCPClientManager;

  /** 允许契约测试注入受控 manager，生产默认使用 SDK manager。 */
  constructor(
    private readonly managerFactory: (config: MCPConfig) => MCPClientManager =
      (config) => new MCPClientManager(config),
  ) {
    super();
  }

  /** 初始化 MCP manager；重复初始化保持同一连接集合。 */
  async initialize(mcpConfig: MCPConfig, signal?: AbortSignal): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.manager = this.managerFactory(mcpConfig);
    await this.manager.initialize(signal);
    this.initialized = true;
  }

  /** 从 manager 的实时缓存导出注册项，不保留会过期的二次 Descriptor 快照。 */
  override getRegistrations(): ToolRegistration[] {
    return (this.manager?.getAllTools() ?? []).map((descriptor) => ({
      descriptor: {
        ...descriptor,
        inputSchema: structuredClone(descriptor.inputSchema),
        capabilities: [...descriptor.capabilities],
      },
      groupName: this.name,
      invoke: (arguments_, context) => this.invoke(descriptor.name, arguments_, context),
      supportsAbortSignal: true,
    }));
  }

  /** 判断当前 MCP 快照是否包含指定的命名空间工具名。 */
  override hasTool(toolName: string): boolean {
    return (this.manager?.getAllTools() ?? [])
      .some((descriptor) => descriptor.name === toolName);
  }

  /** 把命名空间工具调用交给 manager；未初始化时返回兼容失败结果。 */
  override async invoke(
    toolName: string,
    kwargs: Record<string, any> = {},
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    if (!this.manager) {
      return { success: false, message: 'MCP工具包尚未初始化' };
    }
    return this.manager.invoke(toolName, kwargs, context?.signal);
  }

  /** 主动刷新一个或全部 MCP 服务，供不支持 list changed 的服务按需调用。 */
  async refreshTools(
    serverName?: string,
    signal?: AbortSignal,
  ): Promise<MCPToolRefreshResult[]> {
    if (!this.manager) {
      return serverName
        ? [{ serverName, outcome: 'not_connected' }]
        : [];
    }
    return this.manager.refreshTools(serverName, signal);
  }

  /** 释放全部 MCP 资源并清除实时工具快照。 */
  async cleanup(): Promise<void> {
    await this.manager?.cleanup();
    this.manager = undefined;
    this.initialized = false;
  }
}

/** 复制 MCP Schema 的可变 inputSchema，隔离客户端与 Registry 修改。 */
function cloneMcpToolSchema(tool: MCPToolSchema): MCPToolSchema {
  return {
    ...tool,
    ...(tool.inputSchema ? { inputSchema: structuredClone(tool.inputSchema) } : {}),
  };
}

/** 将未知 MCP 连接或通知错误转换为稳定文本。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 生成模型可见的稳定 MCP 名称，并避免重复添加 mcp_ 前缀。 */
function namespacedToolName(serverName: string, toolName: string): string {
  const prefix = serverName.startsWith('mcp_') ? serverName : `mcp_${serverName}`;
  return `${prefix}_${toolName}`;
}
