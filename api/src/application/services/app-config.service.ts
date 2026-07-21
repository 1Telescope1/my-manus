import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  A2AConfig,
  AgentConfig,
  AppConfig,
  LLMConfigSchema,
  LLMConfig,
  MCPConfig,
} from '../../domain/models/app-config';
import { NotFoundError } from '../../core/errors/app-exception';
import { FileAppConfigRepository } from '../../infrastructure/repositories/file-app-config.repository';
import {
  LLMConfigResponse,
  ListA2AServerItem,
  ListMCPServerItem,
  UpdateLLMConfigBody,
} from '../../interfaces/dto/app-config.dto';
import { A2AClientManager } from '../../domain/services/tools/a2a.tool';
import { MCPClientManager } from '../../domain/services/tools/mcp.tool';

@Injectable()
export class AppConfigService {
  constructor(private readonly appConfigRepository: FileAppConfigRepository) {}

  /** 加载获取所有的应用配置。 */
  private async loadAppConfig(): Promise<AppConfig> {
    return this.appConfigRepository.load();
  }

  /** 获取 LLM 提供商配置。 */
  async getLlmConfig(): Promise<LLMConfigResponse> {
    const appConfig = await this.loadAppConfig();
    return this.toLlmConfigResponse(appConfig.llm_config);
  }

  /** 根据传递的 llmConfig 更新语言模型提供商配置。 */
  async updateLlmConfig(llmConfig: UpdateLLMConfigBody): Promise<LLMConfigResponse> {
    // 1. 获取应用配置。
    const appConfig = await this.loadAppConfig();

    // 2. 判断 api_key 是否为空，空值表示沿用原 api_key。
    const nextConfig: LLMConfig = LLMConfigSchema.parse({
      ...llmConfig,
      api_key: llmConfig.api_key?.trim()
        ? llmConfig.api_key
        : appConfig.llm_config.api_key,
      // 旧版 UI 不认识窗口字段时沿用当前值，不能因一次设置保存退回默认值。
      context_window_tokens:
        llmConfig.context_window_tokens ?? appConfig.llm_config.context_window_tokens,
    });

    // 3. 更新配置并写回配置仓库。
    appConfig.llm_config = nextConfig;
    await this.appConfigRepository.save(appConfig);

    return this.toLlmConfigResponse(appConfig.llm_config);
  }

  /** 返回可安全暴露给前端的 LLM 配置，只说明密钥是否存在。 */
  private toLlmConfigResponse(llmConfig: LLMConfig): LLMConfigResponse {
    const { api_key: apiKey, ...safeConfig } = llmConfig;
    return {
      ...safeConfig,
      has_api_key: apiKey.trim().length > 0,
    };
  }

  async getAgentConfig(): Promise<AgentConfig> {
    const appConfig = await this.loadAppConfig();
    return appConfig.agent_config;
  }

  async updateAgentConfig(agentConfig: AgentConfig): Promise<AgentConfig> {
    const appConfig = await this.loadAppConfig();
    appConfig.agent_config = agentConfig;
    await this.appConfigRepository.save(appConfig);
    return appConfig.agent_config;
  }

  async getMcpServers(): Promise<ListMCPServerItem[]> {
    const appConfig = await this.loadAppConfig();
    const manager = new MCPClientManager(appConfig.mcp_config);

    try {
      await manager.initialize();
      const tools = manager.tools;

      return Object.entries(appConfig.mcp_config.mcpServers).map(([serverName, serverConfig]) => ({
        server_name: serverName,
        enabled: serverConfig.enabled,
        transport: serverConfig.transport,
        tools: (tools[serverName] ?? []).map((tool) => tool.name),
      }));
    } finally {
      await manager.cleanup();
    }
  }

  async updateAndCreateMcpServers(mcpConfig: MCPConfig): Promise<MCPConfig> {
    const appConfig = await this.loadAppConfig();
    appConfig.mcp_config.mcpServers = {
      ...appConfig.mcp_config.mcpServers,
      ...mcpConfig.mcpServers,
    };
    await this.appConfigRepository.save(appConfig);
    return appConfig.mcp_config;
  }

  async deleteMcpServer(serverName: string): Promise<MCPConfig> {
    const appConfig = await this.loadAppConfig();

    if (!(serverName in appConfig.mcp_config.mcpServers)) {
      throw new NotFoundError(`该MCP服务[${serverName}]不存在，请核实后重试`);
    }

    delete appConfig.mcp_config.mcpServers[serverName];
    await this.appConfigRepository.save(appConfig);
    return appConfig.mcp_config;
  }

  async setMcpServerEnabled(serverName: string, enabled: boolean): Promise<MCPConfig> {
    const appConfig = await this.loadAppConfig();

    if (!(serverName in appConfig.mcp_config.mcpServers)) {
      throw new NotFoundError(`该MCP服务[${serverName}]不存在，请核实后重试`);
    }

    appConfig.mcp_config.mcpServers[serverName].enabled = enabled;
    await this.appConfigRepository.save(appConfig);
    return appConfig.mcp_config;
  }

  /** 根据传递的配置新增 A2A 服务器。 */
  async createA2aServer(baseUrl: string): Promise<A2AConfig> {
    // 1. 获取当前的应用配置。
    const appConfig = await this.loadAppConfig();

    // 2. 往数据中新增 A2A 服务。
    appConfig.a2a_config.a2a_servers.push({
      id: randomUUID(),
      base_url: baseUrl,
      enabled: true,
    });

    // 3. 调用数据仓库更新。
    await this.appConfigRepository.save(appConfig);
    return appConfig.a2a_config;
  }

  /** 获取 A2A 服务列表。 */
  async getA2aServers(): Promise<ListA2AServerItem[]> {
    // 1. 获取当前的应用配置。
    const appConfig = await this.loadAppConfig();

    // 2. 构建 A2A 客户端管理器，对配置信息不过滤。
    const a2aServers: ListA2AServerItem[] = [];
    const a2aClientManager = new A2AClientManager(appConfig.a2a_config);

    try {
      // 3. 初始化 A2A 客户端管理器。
      await a2aClientManager.initialize();

      // 4. 获取 Agent 卡片列表。
      const agentCards = a2aClientManager.agentCards;

      // 5. 组装响应结构。
      for (const [id, agentCard] of Object.entries(agentCards)) {
        a2aServers.push({
          id,
          name: typeof agentCard.name === 'string' ? agentCard.name : '',
          description: typeof agentCard.description === 'string' ? agentCard.description : '',
          input_modes: Array.isArray(agentCard.defaultInputModes) ? agentCard.defaultInputModes : [],
          output_modes: Array.isArray(agentCard.defaultOutputModes) ? agentCard.defaultOutputModes : [],
          streaming: Boolean(agentCard.capabilities?.streaming ?? false),
          push_notifications: Boolean(agentCard.capabilities?.push_notifications ?? false),
          enabled: Boolean(agentCard.enabled ?? false),
        });
      }
    } finally {
      // 6. 清除客户端管理器资源。
      await a2aClientManager.cleanup();
    }

    return a2aServers;
  }

  /** 根据传递的 id 和 enabled 更新 A2A 服务启用状态。 */
  async setA2aServerEnabled(a2aId: string, enabled: boolean): Promise<A2AConfig> {
    // 1. 获取当前的应用配置。
    const appConfig = await this.loadAppConfig();

    // 2. 计算需要更新位置的索引并判断是否存在。
    const index = appConfig.a2a_config.a2a_servers.findIndex((item) => item.id === a2aId);
    if (index === -1) {
      throw new NotFoundError(`该A2A服务[${a2aId}]不存在，请核实后重试`);
    }

    // 3. 如果存在则更新数据。
    appConfig.a2a_config.a2a_servers[index].enabled = enabled;
    await this.appConfigRepository.save(appConfig);
    return appConfig.a2a_config;
  }

  /** 根据传递的 id 删除指定的 A2A 服务。 */
  async deleteA2aServer(a2aId: string): Promise<A2AConfig> {
    // 1. 获取当前的应用配置。
    const appConfig = await this.loadAppConfig();

    // 2. 计算需要操作位置的索引并判断是否存在。
    const index = appConfig.a2a_config.a2a_servers.findIndex((item) => item.id === a2aId);
    if (index === -1) {
      throw new NotFoundError(`该A2A服务[${a2aId}]不存在，请核实后重试`);
    }

    // 3. 删除 A2A 服务器。
    appConfig.a2a_config.a2a_servers.splice(index, 1);
    await this.appConfigRepository.save(appConfig);
    return appConfig.a2a_config;
  }
}
