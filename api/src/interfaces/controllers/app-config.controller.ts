import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { AppConfigService } from '../../application/services/app-config.service';
import { ResponseEnvelope } from '../../core/response/api-response';
import { AgentConfig, LLMConfig, MCPConfig } from '../../domain/models/app-config';
import { SetMcpServerEnabledBody } from '../dto/app-config.dto';

@Controller('app-config')
export class AppConfigController {
  constructor(private readonly appConfigService: AppConfigService) {}

  @Get('llm')
  async getLlmConfig() {
    const llmConfig = await this.appConfigService.getLlmConfig();
    return ResponseEnvelope.success(llmConfig);
  }

  @Post('llm')
  async updateLlmConfig(@Body() body: LLMConfig) {
    const llmConfig = await this.appConfigService.updateLlmConfig(body);
    return ResponseEnvelope.success(llmConfig, '更新LLM信息配置成功');
  }

  @Get('agent')
  async getAgentConfig() {
    const agentConfig = await this.appConfigService.getAgentConfig();
    return ResponseEnvelope.success(agentConfig);
  }

  @Post('agent')
  async updateAgentConfig(@Body() body: AgentConfig) {
    const agentConfig = await this.appConfigService.updateAgentConfig(body);
    return ResponseEnvelope.success(agentConfig, '更新Agent信息配置成功');
  }

  @Get('mcp-servers')
  async getMcpServers() {
    const mcpServers = await this.appConfigService.getMcpServers();
    return ResponseEnvelope.success(
      { mcp_servers: mcpServers },
      '获取mcp服务器列表成功',
    );
  }

  @Post('mcp-servers')
  async createMcpServers(@Body() body: MCPConfig) {
    await this.appConfigService.updateAndCreateMcpServers(body);
    return ResponseEnvelope.success(undefined, '新增MCP服务配置成功');
  }

  @Post('mcp-servers/:serverName/delete')
  async deleteMcpServer(@Param('serverName') serverName: string) {
    await this.appConfigService.deleteMcpServer(serverName);
    return ResponseEnvelope.success(undefined, '删除MCP服务配置成功');
  }

  @Post('mcp-servers/:serverName/enabled')
  async setMcpServerEnabled(
    @Param('serverName') serverName: string,
    @Body() body: SetMcpServerEnabledBody,
  ) {
    await this.appConfigService.setMcpServerEnabled(serverName, body.enabled);
    return ResponseEnvelope.success(undefined, '更新MCP服务启用状态成功');
  }
}
