import { ToolResult } from './tool-result';

/** 工具来源；分别表示本地内置能力、MCP 服务能力和 Agent-as-Tool。 */
export type ToolSource = 'builtin' | 'mcp' | 'agent';

/** 工具风险；按调用可能产生的最高外部影响分类。 */
export type ToolRisk = 'read' | 'write' | 'destructive' | 'external_communication';

/** 不绑定特定模型厂商的通用工具描述，供 Registry、Policy 和模型适配器共同使用。 */
export type ToolDescriptor = {
  id: string;
  name: string;
  source: ToolSource;
  description: string;
  inputSchema: Record<string, unknown>;
  capabilities: string[];
  risk: ToolRisk;
  requiresApproval: boolean;
  timeoutMs: number;
};

/** 可执行工具注册项；groupName 保留当前事件协议中的工具包名称。 */
export type ToolRegistration = {
  descriptor: ToolDescriptor;
  groupName: string;
  invoke: (arguments_: Record<string, unknown>) => Promise<ToolResult>;
};

/** Registry 查询条件；同一字段内任一匹配，capabilities 要求全部具备。 */
export type ToolQuery = {
  ids?: readonly string[];
  names?: readonly string[];
  sources?: readonly ToolSource[];
  capabilities?: readonly string[];
  risks?: readonly ToolRisk[];
};

/** Tool Registry 的领域端口，不包含任何模型厂商或 MCP SDK 类型。 */
export interface ToolRegistry {
  /** 注册一个工具；冲突或描述无效时不改变 Registry。 */
  register(registration: ToolRegistration): void;

  /** 原子注册一批工具；任一冲突或描述无效时不得写入部分结果。 */
  registerAll(registrations: readonly ToolRegistration[]): void;

  /** 按稳定 id 查询工具描述。 */
  getById(id: string): ToolDescriptor | undefined;

  /** 按模型可见 name 查询工具描述。 */
  getByName(name: string): ToolDescriptor | undefined;

  /** 按组合条件列出工具描述，未提供条件时返回全部工具。 */
  list(query?: ToolQuery): ToolDescriptor[];

  /** 按模型可见 name 解析可执行注册项。 */
  resolve(name: string): ToolRegistration | undefined;
}
