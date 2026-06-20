import { Injectable } from '@nestjs/common';
import {
  AgentConfig,
  AppConfig,
  LLMConfig,
  MCPConfig,
} from '../../domain/models/app-config';
import { NotFoundError } from '../../core/errors/app-exception';
import { FileAppConfigRepository } from '../../infrastructure/repositories/file-app-config.repository';
import { ListMCPServerItem } from '../../interfaces/dto/app-config.dto';
import { MCPClientManager } from '../../domain/services/tools/mcp.tool';

@Injectable()
export class AppConfigService {
  constructor(private readonly appConfigRepository: FileAppConfigRepository) {}

  private async loadAppConfig(): Promise<AppConfig> {
    return this.appConfigRepository.load();
  }

  async getLlmConfig(): Promise<Omit<LLMConfig, 'api_key'>> {
    const appConfig = await this.loadAppConfig();
    const { api_key: _apiKey, ...safeConfig } = appConfig.llm_config;
    return safeConfig;
  }

  async updateLlmConfig(llmConfig: LLMConfig): Promise<Omit<LLMConfig, 'api_key'>> {
    const appConfig = await this.loadAppConfig();

    const nextConfig = { ...llmConfig };
    if (!nextConfig.api_key.trim()) {
      nextConfig.api_key = appConfig.llm_config.api_key;
    }

    appConfig.llm_config = nextConfig;
    await this.appConfigRepository.save(appConfig);

    const { api_key: _apiKey, ...safeConfig } = appConfig.llm_config;
    return safeConfig;
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
}
