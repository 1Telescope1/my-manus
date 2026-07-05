import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { AppConfigService } from '../../application/services/app-config.service';
import { ResponseEnvelope } from '../../core/response/api-response';
import { AgentConfig, LLMConfig, MCPConfig } from '../../domain/models/app-config';
import {
  CreateA2AServerBody,
  SetA2AServerEnabledBody,
  SetMcpServerEnabledBody,
} from '../dto/app-config.dto';

@Controller('app-config')
export class AppConfigController {
  constructor(private readonly appConfigService: AppConfigService) {}

  /** 获取 LLM 配置信息。 */
  @Get('llm')
  async getLlmConfig() {
    const llmConfig = await this.appConfigService.getLlmConfig();
    return ResponseEnvelope.success(llmConfig);
  }

  /** 更新 LLM 配置信息。 */
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

  /** 获取 A2A 服务列表。 */
  @Get('a2a-servers')
  async getA2aServers() {
    const a2aServers = await this.appConfigService.getA2aServers();
    return ResponseEnvelope.success(
      { a2a_servers: a2aServers },
      '获取a2a服务列表成功',
    );
  }

  /** 新增 A2A 服务器。 */
  @Post('a2a-servers')
  async createA2aServer(@Body() body: CreateA2AServerBody) {
    await this.appConfigService.createA2aServer(body.base_url);
    return ResponseEnvelope.success(undefined, '新增A2A服务配置成功');
  }

  /** 删除 A2A 服务器。 */
  @Post('a2a-servers/:a2a_id/delete')
  async deleteA2aServer(@Param('a2a_id') a2aId: string) {
    await this.appConfigService.deleteA2aServer(a2aId);
    return ResponseEnvelope.success(undefined, '删除a2a服务器成功');
  }

  /** 更新 A2A 服务的启用状态。 */
  @Post('a2a-servers/:a2a_id/enabled')
  async setA2aServerEnabled(
    @Param('a2a_id') a2aId: string,
    @Body() body: SetA2AServerEnabledBody,
  ) {
    await this.appConfigService.setA2aServerEnabled(a2aId, body.enabled);
    return ResponseEnvelope.success(undefined, '更新a2a服务器启用状态成功');
  }
}