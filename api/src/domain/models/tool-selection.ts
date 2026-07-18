import { ToolDescriptor, ToolRisk, ToolSource } from './tool';

/** Workflow、Agent 或单个 Skill 可提供的授权上界与相关性请求。 */
export type ToolSelectionScope = {
  allowedToolIds?: readonly string[];
  allowedToolNames?: readonly string[];
  allowedSources?: readonly ToolSource[];
  requestedToolIds?: readonly string[];
  requestedToolNames?: readonly string[];
  requestedCapabilities?: readonly string[];
};

/** Policy 已计算出的允许与拒绝约束；本类型不负责执行审批。 */
export type ToolPolicyConstraints = {
  allowedToolIds?: readonly string[];
  allowedToolNames?: readonly string[];
  allowedSources?: readonly ToolSource[];
  deniedToolIds?: readonly string[];
  deniedToolNames?: readonly string[];
  deniedSources?: readonly ToolSource[];
  deniedRisks?: readonly ToolRisk[];
};

/** 除 Router capability 外，由后续 Registry 或 Policy 注入的选择约束。 */
export type ToolSelectionConstraints = {
  workflow?: ToolSelectionScope;
  agent?: ToolSelectionScope;
  skills?: readonly ToolSelectionScope[];
  policy?: ToolPolicyConstraints;
};

/** 一次模型调用的完整工具选择输入。 */
export type ToolSelectionRequest = ToolSelectionConstraints & {
  routerCapabilities: readonly string[];
};

/** 最终模型可见工具及无法由最终集合覆盖的 capability。 */
export type ToolSelectionResult = {
  tools: ToolDescriptor[];
  uncoveredCapabilities: string[];
};
