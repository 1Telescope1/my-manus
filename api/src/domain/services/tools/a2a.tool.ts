import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { ServerRequestsError } from '../../../core/errors/app-exception';
import { A2AConfig } from '../../models/app-config';
import { ToolResult } from '../../models/tool-result';
import { BaseTool, tool } from './base-tool';

export type A2AAgentCard = Record<string, any> & {
  enabled?: boolean;
};

const REQUEST_TIMEOUT_MS = 600_000;

/*
A2A 客户端管理器的设计思路：
1. Agent 执行过程中可能多次调用远程 Agent，agent-card.json 属于网络 IO，初始化时统一加载并缓存。
2. 配置展示需要包含所有 A2A 服务；执行规划阶段再由调用方决定传入哪些已启用服务。
3. 多个远程 Agent 的 name 可能重复，因此使用配置中的 id 作为唯一标识。
4. fetch 不需要显式关闭连接，但仍需要在 cleanup 中清理缓存和初始化状态。
5. A2A 配置来自 config.yaml，运行时按当前配置动态初始化。
6. 当前只实现获取远程 Agent 卡片和调用远程 Agent 两类能力。
*/
export class A2AClientManager {
  private readonly logger = new Logger(A2AClientManager.name);
  private readonly cachedAgentCards: Record<string, A2AAgentCard> = {};
  private initialized = false;

  constructor(private readonly a2aConfig: A2AConfig = { a2a_servers: [] }) {}

  get agentCards(): Record<string, A2AAgentCard> {
    return this.cachedAgentCards;
  }

  /** 异步初始化所有已配置的 A2A 服务。 */
  async initialize(): Promise<void> {
    // 1. 检测是否已经初始化，避免同一个管理器重复请求远程 Agent 卡片。
    if (this.initialized) {
      return;
    }

    try {
      // 2. 记录当前配置数量并开始拉取 AgentCard。
      this.logger.log(`加载${this.a2aConfig.a2a_servers.length}个A2A服务`);
      await this.getA2aAgentCards();
      this.initialized = true;
      this.logger.log('A2A客户端加载成功');
    } catch (error) {
      this.logger.error(`A2A客户端管理器加载失败: ${errorMessage(error)}`);
      throw new ServerRequestsError('A2A客户端管理器加载失败');
    }
  }

  /** 根据配置连接所有 A2A 服务器获取 AgentCard 信息。 */
  private async getA2aAgentCards(): Promise<void> {
    // 1. 循环遍历所有 A2A 服务，不在这里过滤 enabled。
    for (const a2aServerConfig of this.a2aConfig.a2a_servers) {
      try {
        // 2. 按 A2A 约定请求远程 Agent 卡片。
        const agentCard = await this.fetchJson<A2AAgentCard>(
          `${a2aServerConfig.base_url}/.well-known/agent-card.json`,
        );

        // 3. 将配置中的 enabled 状态补充到 AgentCard 缓存里。
        agentCard.enabled = a2aServerConfig.enabled;
        this.cachedAgentCards[a2aServerConfig.id] = agentCard;
      } catch (error) {
        this.logger.warn(`加载A2A服务[${a2aServerConfig.id}]失败: ${errorMessage(error)}`);
        continue;
      }
    }
  }

  /** 根据传递的智能体 id 和 query 调用远程 Agent。 */
  async invoke(agentId: string, query: string): Promise<ToolResult> {
    // 1. 判断传递的 agentId 是否存在。
    if (!(agentId in this.cachedAgentCards)) {
      return { success: false, message: '该远程Agent不存在' };
    }

    // 2. Agent 存在则取出调用端点。
    const agentCard = this.cachedAgentCards[agentId] ?? {};
    const url = typeof agentCard.url === 'string' ? agentCard.url : '';

    // 3. 判断调用端点是否存在。
    if (!url) {
      return { success: false, message: '该远程Agent调用端点不存在' };
    }

    try {
      // 4. 使用 JSON-RPC message/send 结构调用远程 Agent。
      const result = await this.fetchJson(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: randomUUID(),
          jsonrpc: '2.0',
          method: 'message/send',
          params: {
            message: {
              messageId: randomUUID(),
              role: 'user',
              parts: [{ kind: 'text', text: query }],
            },
          },
        }),
      });

      return { success: true, message: '调用远程Agent成功', data: result };
    } catch (error) {
      const message = `调用远程Agent[${agentId}:${url}]出错: ${errorMessage(error)}`;
      this.logger.error(message);
      return { success: false, message };
    }
  }

  /** 清理 A2A 客户端管理器缓存。 */
  async cleanup(): Promise<void> {
    try {
      // fetch 无需显式关闭连接，这里只清空缓存和初始化状态。
      Object.keys(this.cachedAgentCards).forEach((key) => delete this.cachedAgentCards[key]);
      this.initialized = false;
      this.logger.log('清除A2A客户端管理器成功');
    } catch (error) {
      this.logger.error(`清理A2A客户端管理器失败: ${errorMessage(error)}`);
    }
  }

  private async fetchJson<T = unknown>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response.json() as Promise<T>;
  }
}

export class A2ATool extends BaseTool {
  readonly name = 'a2a';
  private initialized = false;
  private manager?: A2AClientManager;

  /** 初始化 A2A 工具包。 */
  async initialize(a2aConfig?: A2AConfig): Promise<void> {
    // 1. 判断是否已经初始化。
    if (this.initialized) {
      return;
    }

    // 2. 初始化 A2A 客户端管理器。
    this.manager = new A2AClientManager(a2aConfig);
    await this.manager.initialize();
    this.initialized = true;
  }

  @tool({
    name: 'get_remote_agent_cards',
    description: '获取可远程调用的Agent卡片信息, 包含Agent id、名称、描述、技能、请求端点等。',
    parameters: {},
    required: [],
  })
  async getRemoteAgentCards(): Promise<ToolResult> {
    if (!this.manager) {
      return { success: false, message: 'A2A工具包尚未初始化' };
    }

    // 1. 重组结构，将 id 填充到 agent_card 中。
    const agentCards = Object.entries(this.manager.agentCards).map(([id, agentCard]) => ({
      id,
      ...agentCard,
    }));

    // 2. 组装 ToolResult 响应。
    return {
      success: true,
      message: '获取Agent卡片信息列表成功',
      data: agentCards,
    };
  }

  @tool({
    name: 'call_remote_agent',
    description: '根据传递的id+query(分配给远程Agent完成的任务query)调用远程Agent完成对应需求',
    parameters: {
      id: {
        type: 'string',
        description: '需要调用远程agent的id, 格式参考get_remote_agent_cards()返回的数据结构',
      },
      query: {
        type: 'string',
        description: '需要分配给该远程Agent实现的任务/需求query',
      },
    },
    required: ['id', 'query'],
  })
  async callRemoteAgent(id: string, query: string): Promise<ToolResult> {
    if (!this.manager) {
      return { success: false, message: 'A2A工具包尚未初始化' };
    }
    return this.manager.invoke(id, query);
  }

  /** 清理 A2A 工具包资源。 */
  async cleanup(): Promise<void> {
    await this.manager?.cleanup();
    this.initialized = false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
