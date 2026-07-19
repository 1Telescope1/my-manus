import { ToolDescriptor, ToolRegistry } from '../../models/tool';
import {
  ToolPolicyConstraints,
  ToolSelectionRequest,
  ToolSelectionResult,
  ToolSelectionScope,
} from '../../models/tool-selection';

/** 根据相关性和多层授权边界计算模型可见工具的纯领域服务。 */
export class ToolSelectionService {
  /** 注入当前运行上下文使用的 Tool Registry。 */
  constructor(private readonly registry: ToolRegistry) {}

  /** 按相关性、允许范围和 Policy 拒绝规则计算稳定有序的最终集合。 */
  select(request: ToolSelectionRequest): ToolSelectionResult {
    const scopes = [request.workflow, request.agent, ...(request.skills ?? [])]
      .filter((scope): scope is ToolSelectionScope => scope !== undefined);
    const requestedCapabilities = uniqueStrings([
      ...request.routerCapabilities,
      ...scopes.flatMap((scope) => scope.requestedCapabilities ?? []),
    ]);
    const requestedToolIds = uniqueStrings(
      scopes.flatMap((scope) => scope.requestedToolIds ?? []),
    );
    const requestedToolNames = uniqueStrings(
      scopes.flatMap((scope) => scope.requestedToolNames ?? []),
    );

    // 没有任何相关性信号时 fail closed，不能把“未指定”解释为允许全部工具。
    const hasRelevanceSignal = requestedCapabilities.length > 0
      || requestedToolIds.length > 0
      || requestedToolNames.length > 0;
    const tools = hasRelevanceSignal
      ? this.registry.list().filter((descriptor) => (
        matchesRelevance(
          descriptor,
          requestedCapabilities,
          requestedToolIds,
          requestedToolNames,
        )
        && matchesAllowScope(descriptor, request.workflow)
        && matchesAllowScope(descriptor, request.agent)
        && matchesSkillScopes(descriptor, request.skills ?? [])
        && matchesAllowScope(descriptor, request.policy)
        && !matchesPolicyDeny(descriptor, request.policy)
      ))
      : [];

    return {
      tools,
      uncoveredCapabilities: requestedCapabilities.filter(
        (capability) => !tools.some((tool) => tool.capabilities.includes(capability)),
      ),
    };
  }
}

/** 只保留非空字符串并保持首次出现顺序。 */
function uniqueStrings(values: readonly string[]): string[] {
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  return [...new Set(normalized)];
}

/** 判断工具是否命中 capability 或显式工具请求。 */
function matchesRelevance(
  descriptor: ToolDescriptor,
  capabilities: readonly string[],
  toolIds: readonly string[],
  toolNames: readonly string[],
): boolean {
  return toolIds.includes(descriptor.id)
    || toolNames.includes(descriptor.name)
    || descriptor.capabilities.some((capability) => capabilities.includes(capability));
}

/** 判断工具是否位于一个 Workflow 或 Agent 授权上界内。 */
function matchesAllowScope(
  descriptor: ToolDescriptor,
  scope: ToolSelectionScope | undefined,
): boolean {
  if (!scope) {
    return true;
  }
  return matchesIdentityAllow(descriptor, scope.allowedToolIds, scope.allowedToolNames)
    && (scope.allowedSources === undefined || scope.allowedSources.includes(descriptor.source));
}

/** 将多个已激活 Skill 的授权范围按并集合并，再作为一个整体上界。 */
function matchesSkillScopes(
  descriptor: ToolDescriptor,
  skills: readonly ToolSelectionScope[],
): boolean {
  const constrained = skills.filter(hasAllowConstraint);
  return constrained.length === 0
    || constrained.some((scope) => matchesAllowScope(descriptor, scope));
}

/** 判断一个范围是否真的声明了 allow，而不是只声明相关性请求。 */
function hasAllowConstraint(scope: ToolSelectionScope): boolean {
  return scope.allowedToolIds !== undefined
    || scope.allowedToolNames !== undefined
    || scope.allowedSources !== undefined;
}

/** Policy 任一 deny 条件命中即移除工具，并覆盖其他来源的显式请求。 */
function matchesPolicyDeny(
  descriptor: ToolDescriptor,
  policy: ToolPolicyConstraints | undefined,
): boolean {
  if (!policy) {
    return false;
  }
  return Boolean(
    policy.deniedToolIds?.includes(descriptor.id)
    || policy.deniedToolNames?.includes(descriptor.name)
    || policy.deniedSources?.includes(descriptor.source)
    || policy.deniedRisks?.includes(descriptor.risk),
  );
}

/** id/name 是同一身份轴的两种表达，声明后至少命中其中一种。 */
function matchesIdentityAllow(
  descriptor: ToolDescriptor,
  allowedIds: readonly string[] | undefined,
  allowedNames: readonly string[] | undefined,
): boolean {
  if (allowedIds === undefined && allowedNames === undefined) {
    return true;
  }
  return Boolean(
    allowedIds?.includes(descriptor.id)
    || allowedNames?.includes(descriptor.name),
  );
}
