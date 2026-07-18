# TOOL-101 — 统一 Tool 描述与注册表

> 本目录是该任务的独立工作记录。总体设计以 [SDD](../../../agent-core-modernization-sdd.md) 为准，总体状态以 [TASKS.md](../../TASKS.md) 为准。

| 字段 | 值 |
| --- | --- |
| Workstream | `Tool 与 MCP` |
| Status | `done` |
| Dependencies | `—` |
| Started | `2026-07-18` |
| Last Updated | `2026-07-18` |
| Working Session | `Codex：执行 TOOL-101` |

## Intent

把内置、MCP 和未来 Agent-as-Tool 的描述与定位方式收敛为供应商中立的领域契约，使 Runtime 不再依赖分散的工具数组和模型厂商 Schema 来查找能力。

## 证据表

| 确定结论 | 证据路径 | 不确定项 | 建议改动范围 |
| --- | --- | --- | --- |
| SDD 已固定 `ToolDescriptor` 的 id、name、source、inputSchema、capabilities、risk、requiresApproval 和 timeoutMs 字段。 | `docs/agent-core-modernization-sdd.md` §7.1 | 无。 | 严格建立领域模型，不增加厂商 SDK 类型。 |
| 当前内置工具元数据只保存在 `@tool` 的 OpenAI-compatible function 外形中，缺少 capability、risk 和稳定 id。 | `api/src/domain/services/tools/base-tool.ts` | 现有字段必须兼容当前模型调用。 | 装饰器直接生成领域 Descriptor，再由 LLM 基础设施适配模型请求。 |
| 当前 Agent 和 Single Tool Runtime 都遍历 `BaseTool[]` 查找函数，没有统一冲突检查。 | `api/src/domain/services/agents/base-agent.ts`、`api/src/domain/services/runtime/adapters.ts` | 无。 | 建立 Registry 并让两条真实路径共用注册和解析契约。 |
| MCP 已用服务器前缀生成模型可见名称，可以作为跨服务器唯一 name 的基础。 | `api/src/domain/services/tools/mcp.tool.ts` | MCP 没有提供本系统的风险元数据。 | 保留命名空间；本任务采用保守默认描述，动态刷新留给 TOOL-104。 |
| Agent-as-Tool 尚未实现，但 TOOL-101 必须提供 `source: agent` 的可注册契约。 | `TASKS.md` 中 AGENT-102 依赖 TOOL-101。 | 具体 Specialist 生命周期和结果 Schema 由 AGENT-102 决定。 | 用通用 ToolRegistration 验证 agent source，不提前实现 Specialist。 |

## 本任务做了什么

### 一句话说明

> 把不同来源的工具变成同一种可查询、可冲突检查、可执行的领域对象，并让当前运行路径真正使用它。

### 为什么需要这个任务

改造前，`@tool` 直接保存 OpenAI-compatible `function` 外形，只有 name、description 和 parameters。系统不知道一个工具来自本地、MCP 还是 Agent，也不能表达它能做什么、风险多高、是否需要审批和默认超时。Planner/ReAct 与 Single Tool 又分别遍历 `BaseTool[]` 找函数：两个来源若暴露同名函数，只会在模型选择或调用时产生不确定行为，装配阶段无法发现。

本任务把“工具是什么”和“某模型 API 怎样接收工具”分开。领域层只维护统一 Descriptor 与 Registry；OpenAI-compatible function schema 只在基础设施适配器发请求前生成。

### 核心对象或能力

| 对象 | 职责 | 例子 |
| --- | --- | --- |
| `ToolDescriptor` | 描述稳定 id、模型可见 name、source、inputSchema、capabilities、risk、审批和超时。 | `search_web` 的 source 是 `builtin`，capabilities 包含 `search` 和 `web.search`，risk 是 `read`。 |
| `ToolRegistration` | 把 Descriptor、兼容事件需要的 groupName 和执行函数绑定在一起。 | `builtin:search_web` 绑定到 `SearchTool.searchWeb()`。 |
| `ToolRegistry` | 注册、按 id/name 查询、组合过滤、解析调用目标，并拒绝冲突。 | 查询同时具备 `data.read` 与 `crm` 的工具；按 `delegate_research` 解析 Agent 工具。 |
| OpenAI 基础设施转换 | 把领域 Descriptor 转成 `{ type: 'function', function: ... }`。 | risk、approval 等领域策略字段不会泄漏进厂商请求 Schema。 |

`source` 支持三类值：

- `builtin`：文件、Shell、Browser、Search、Message 等本地工具。
- `mcp`：从 MCP 服务器发现的远程工具，name 保留 `mcp_<server>_<tool>` 命名空间。
- `agent`：为后续 AGENT-102 的 Specialist Agent-as-Tool 保留的注册来源；本任务已验证注册、查询和冲突契约，不提前实现 Specialist 生命周期。

### 主要流程

```text
内置 @tool 元数据 / MCP listTools / Agent 注册器
  ↓ 生成 ToolDescriptor + invoke
ToolRegistry.register / registerAll
  ↓ 先验证整批 id、name 和描述不变量
  ├─ 有冲突：整批拒绝，Registry 不改变
  └─ 无冲突：写入 id 与 name 双索引
  ↓
Planner/ReAct 或 Single Tool 查询 Descriptor
  ↓
LLM 基础设施将 Descriptor 转为厂商 function schema
  ↓ 模型返回 function name
Registry.resolve(name) → 调用已绑定 invoke
```

MCP 在 `AgentTaskRunner` 启动后才完成发现，因此现有执行路径会在读取或解析工具前增量同步本轮新出现的注册项。动态删除、描述更新和通知刷新仍由 TOOL-104 统一解决。

### 例子

正常路径：MCP 服务器 `crm` 提供 `lookup` 时，系统注册：

```ts
{
  id: 'mcp:crm:lookup',
  name: 'mcp_crm_lookup',
  source: 'mcp',
  capabilities: ['mcp:crm', 'mcp:crm:lookup'],
  risk: 'external_communication',
  requiresApproval: true,
  timeoutMs: 60000
}
```

模型只能看到转换后的 name、description 和 inputSchema；Runtime 收到 `mcp_crm_lookup` 后由 Registry 精确解析到 `crm` 服务器调用。

失败路径：如果一个 Agent 注册项也使用 `mcp_crm_lookup`，即使它的 id 不同，Registry 仍抛出 `ToolConflictError(field: 'name')`。批量注册中更早的合法项也不会被写入，不会留下半完成状态。

### 保护规则和当前边界

- id 和模型可见 name 都全局唯一；冲突在装配/同步阶段确定性失败。
- `registerAll` 先验证整批再写入，避免部分成功。
- 查询和解析返回 Descriptor 深拷贝，调用方不能修改 Registry 内部 capability 或 inputSchema。
- 内置写入、破坏性和外部通信工具已标记 risk；MCP 未提供本系统风险语义时保守标记为 `external_communication` 且 `requiresApproval: true`。
- 审批、超时执行、重试、取消和幂等本任务只提供元数据，不执行策略；由 TOOL-103 接入。
- 当前 Planner/ReAct 与 Single Tool 已使用 Registry；按 Router/Workflow/Skill/Policy 收窄最终工具集合属于 TOOL-102。
- MCP 当前只增量加入新发现工具；enabled、连接隔离、删除/更新和通知刷新属于 TOOL-104。

## Scope

### In scope

- 定义供应商中立的 `ToolDescriptor`、source、risk、capability 和注册项。
- 实现按 id、name、source、capability 查询的 Tool Registry。
- 注册内置、MCP 和 Agent 三类来源并检测 id/name 冲突。
- 让当前 Planner/ReAct 与 Single Tool 路径通过 Registry 获取描述和调用目标。
- 在基础设施边界把领域 Descriptor 转换为 OpenAI-compatible Tool Schema。

### Out of scope

- 根据 Router、Workflow、Skill 和 Policy 计算最终工具集合；属于 TOOL-102。
- 超时、取消、审批、重试、幂等和统一错误语义；属于 TOOL-103。
- MCP enabled 过滤、连接隔离、动态刷新与通知；属于 TOOL-104。
- 实现 Specialist Agent 或 Agent-as-Tool 执行生命周期；属于 AGENT-102。

## Acceptance Checklist

- [x] 内置、MCP、Agent 三类 Descriptor 均可注册和查询。
- [x] 重复 id 或 name 被确定性拒绝，批量注册不留下半完成状态。
- [x] Descriptor 包含 capability、risk、审批和超时元数据。
- [x] 领域层不引用模型厂商 Tool 类型。
- [x] 当前 Planner/ReAct 与 Single Tool 使用 Registry 获取和调用工具。
- [x] 新增或修改测试标题使用中文。
- [x] 新增函数和复杂步骤具有中文注释；本任务未新增枚举。
- [x] 类型检查、专项契约测试、全量契约测试和构建通过。
- [x] “本任务做了什么”和“改造前后对比”完整。
- [x] [evidence.md](./evidence.md) 和 [worklog.md](./worklog.md) 已填写。
- [x] 总任务清单状态和证据链接已更新。

## 改造前后对比

| 对比项 | 改造前 | 完成后 | 实际影响 |
| --- | --- | --- | --- |
| 工具描述 | 领域装饰器保存 OpenAI-compatible function 外形，缺少来源、能力、风险、审批和超时。 | 领域统一使用完整 `ToolDescriptor`；厂商外形只在基础设施生成。 | TOOL-102/103 可以直接依据稳定元数据选择和执行策略。 |
| 工具定位 | Planner/ReAct 与 Single Tool 各自遍历 `BaseTool[]`。 | 两条真实路径均通过 `ToolRegistry.resolve()` 定位调用目标。 | 查找语义一致，Agent 工具可复用同一入口。 |
| 冲突处理 | 不检测跨工具包或跨来源 name 冲突。 | id/name 冲突在注册时拒绝，批量注册原子失败。 | 模型不会收到两个同名、调用目标不确定的工具。 |
| MCP 描述 | MCP 工具只转换成 function schema。 | 保留 server 命名空间，并生成 source、capability 和保守 risk。 | 多 MCP 服务可稳定注册；未来 Policy 不会把未知远程工具默认为只读。 |
| Agent-as-Tool 基础 | 没有统一来源和注册契约。 | `source: agent` 可注册、查询、过滤、冲突检查和解析。 | AGENT-102 可聚焦 Specialist 生命周期，不必重复建设 Tool 边界。 |
| 兼容行为 | 模型收到 function schema，事件使用工具包 name。 | 模型适配器继续发送相同 function schema，Registration 保留 groupName。 | 当前 Session/SSE/UI 和工具调用语义不变。 |

## Current State

- 当前进展：统一 Descriptor、Registry、三来源契约、现有执行路径接入和验证全部完成。
- 当前阻塞：无。
- 下一步：执行 TOOL-102，依据 capability、允许范围和 Policy 计算最小模型工具集合。

## Task Files

- [worklog.md](./worklog.md)：按时间追加工作过程，保留历史。
- [evidence.md](./evidence.md)：验收项、测试结果和完成证据。

## Decisions and Risks

- `ToolDescriptor` 只表达描述和策略输入，不在本任务实现审批、重试或动态选择。
- MCP 未声明本系统风险语义时使用保守默认值，防止未来 Policy 把未知远程能力误判为安全只读。
- Agent source 先建立注册契约，不提前实现 AGENT-102 的 Specialist 生命周期。

## Latest Session State

- Current state: `done`，专项 9/9、全量契约 76/76 和生产构建通过。
- Remaining work: 无 TOOL-101 范围内工作。
- Blockers: 无。
- Recommended next action: 执行 TOOL-102；TOOL-103/104 分别接入调用策略和 MCP 动态管理。
