import { Logger } from '@nestjs/common';
import {
  MCPConfig,
  MCPServerConfig,
  MCPTransport,
} from '../../models/app-config';
import { ToolResult } from '../../models/tool-result';
import { BaseTool, ToolSchema } from './base-tool';

export type MCPToolSchema = {
  name: string;
  description?: string;
  inputSchema?: Record<string, any>;
};

type MCPClientRecord = {
  client: any;
  transport?: any;
};

export class MCPClientManager {
  private readonly logger = new Logger(MCPClientManager.name);
  private readonly clients: Record<string, MCPClientRecord> = {};
  private readonly cachedTools: Record<string, MCPToolSchema[]> = {};
  private initialized = false;

  constructor(private readonly mcpConfig: MCPConfig) {}

  get tools(): Record<string, MCPToolSchema[]> {
    return this.cachedTools;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.connectMcpServers();
    this.logger.log(`从config.yaml中加载了${Object.keys(this.mcpConfig.mcpServers).length}个MCP服务器`);
    this.initialized = true;
  }

  async getAllTools(): Promise<ToolSchema[]> {
    const allTools: ToolSchema[] = [];

    for (const [serverName, tools] of Object.entries(this.cachedTools)) {
      for (const mcpTool of tools) {
        const expectedPrefix = serverName.startsWith('mcp_') ? serverName : `mcp_${serverName}`;
        allTools.push({
          type: 'function',
          function: {
            name: `${expectedPrefix}_${mcpTool.name}`,
            description: `[${serverName}] ${mcpTool.description || mcpTool.name}`,
            parameters: (mcpTool.inputSchema ?? { type: 'object', properties: {} }) as any,
          },
        });
      }
    }

    return allTools;
  }

  async invoke(toolName: string, arguments_: Record<string, any>): Promise<ToolResult> {
    try {
      let originalServerName: string | undefined;
      let originalToolName: string | undefined;

      for (const serverName of Object.keys(this.mcpConfig.mcpServers)) {
        const expectedPrefix = serverName.startsWith('mcp_') ? serverName : `mcp_${serverName}`;
        if (toolName.startsWith(`${expectedPrefix}_`)) {
          originalServerName = serverName;
          originalToolName = toolName.slice(expectedPrefix.length + 1);
          break;
        }
      }

      if (!originalServerName || !originalToolName) {
        throw new Error(`服务器解析MCP工具不存在: ${toolName}`);
      }

      const record = this.clients[originalServerName];
      if (!record?.client) {
        return { success: false, message: `MCP服务器[${originalServerName}]未连接` };
      }

      const result = await record.client.callTool({
        name: originalToolName,
        arguments: arguments_,
      });
      const content = Array.isArray(result?.content)
        ? result.content.map((item: any) => item.text ?? String(item)).join('\n')
        : undefined;

      return { success: true, data: content || '工具执行成功' };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(`调用MCP工具[${toolName}]失败: ${err.message}`);
      return {
        success: false,
        message: `调用MCP工具[${toolName}]失败: ${err.message}`,
      };
    }
  }

  async cleanup(): Promise<void> {
    for (const [serverName, record] of Object.entries(this.clients)) {
      try {
        await record.client?.close?.();
        await record.transport?.close?.();
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger.warn(`清理MCP服务器[${serverName}]失败: ${err.message}`);
        continue;
      }
    }
    Object.keys(this.clients).forEach((key) => delete this.clients[key]);
    Object.keys(this.cachedTools).forEach((key) => delete this.cachedTools[key]);
    this.initialized = false;
  }

  private async connectMcpServers(): Promise<void> {
    for (const [serverName, serverConfig] of Object.entries(this.mcpConfig.mcpServers)) {
      try {
        await this.connectMcpServer(serverName, serverConfig);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger.error(`连接MCP服务器[${serverName}]出错: ${err.message}`);
        continue;
      }
    }
  }

  private async connectMcpServer(serverName: string, serverConfig: MCPServerConfig): Promise<void> {
    if (serverConfig.transport === MCPTransport.STDIO) {
      await this.connectStdioServer(serverName, serverConfig);
    } else if (serverConfig.transport === MCPTransport.SSE) {
      await this.connectSseServer(serverName, serverConfig);
    } else if (serverConfig.transport === MCPTransport.STREAMABLE_HTTP) {
      await this.connectStreamableHttpServer(serverName, serverConfig);
    } else {
      throw new Error(`MCP服务[${serverName}]使用了不支持的传输协议: ${serverConfig.transport}`);
    }
  }

  private async connectStdioServer(serverName: string, serverConfig: MCPServerConfig): Promise<void> {
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
    const client = new Client({ name: 'manus-ts', version: '0.1.0' });
    await client.connect(transport);
    this.clients[serverName] = { client, transport };
    await this.cacheMcpServerTools(serverName, client);
  }

  private async connectSseServer(serverName: string, serverConfig: MCPServerConfig): Promise<void> {
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
    const client = new Client({ name: 'manus-ts', version: '0.1.0' });
    await client.connect(transport);
    this.clients[serverName] = { client, transport };
    await this.cacheMcpServerTools(serverName, client);
  }

  private async connectStreamableHttpServer(
    serverName: string,
    serverConfig: MCPServerConfig,
  ): Promise<void> {
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
    const client = new Client({ name: 'manus-ts', version: '0.1.0' });
    await client.connect(transport);
    this.clients[serverName] = { client, transport };
    await this.cacheMcpServerTools(serverName, client);
  }

  private async cacheMcpServerTools(serverName: string, client: any): Promise<void> {
    try {
      const toolsResponse = await client.listTools();
      this.cachedTools[serverName] = toolsResponse?.tools ?? [];
      this.logger.log(`MCP服务器[${serverName}]提供了${this.cachedTools[serverName].length}个工具`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(`获取MCP服务器[${serverName}]工具列表失败: ${err.message}`);
      this.cachedTools[serverName] = [];
    }
  }
}

export class MCPTool extends BaseTool {
  readonly name = 'mcp';
  private initialized = false;
  private toolSchemas: ToolSchema[] = [];
  private manager?: MCPClientManager;

  async initialize(mcpConfig: MCPConfig): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.manager = new MCPClientManager(mcpConfig);
    await this.manager.initialize();
    this.toolSchemas = await this.manager.getAllTools();
    this.initialized = true;
  }

  override getTools(): ToolSchema[] {
    return this.toolSchemas;
  }

  override hasTool(toolName: string): boolean {
    return this.toolSchemas.some((schema) => schema.function.name === toolName);
  }

  override async invoke(toolName: string, kwargs: Record<string, any> = {}): Promise<ToolResult> {
    if (!this.manager) {
      return { success: false, message: 'MCP工具包尚未初始化' };
    }
    return this.manager.invoke(toolName, kwargs);
  }

  async cleanup(): Promise<void> {
    await this.manager?.cleanup();
    this.toolSchemas = [];
    this.initialized = false;
  }
}
