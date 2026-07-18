# TOOL-104 — 修复 MCP 动态管理

> 本目录是该任务的独立工作记录。总体设计以 [SDD](../../../agent-core-modernization-sdd.md) 为准，总体状态以 [TASKS.md](../../TASKS.md) 为准。

| 字段 | 值 |
| --- | --- |
| Workstream | `Tool 与 MCP` |
| Status | `done` |
| Dependencies | `TOOL-101` |
| Started | `2026-07-18` |
| Last Updated | `2026-07-18` |
| Working Session | `Codex：执行 TOOL-104` |

## Intent

让 MCP 配置中的启用状态成为真实连接与暴露边界，并使单服务连接/刷新故障、服务端工具列表变化不会污染其他 MCP 服务或遗留过期 Registry 项。

## 证据表

| 确定结论 | 证据路径 | 不确定项 | 建议改动范围 |
| --- | --- | --- | --- |
| SDD 要求只连接 `enabled: true` 服务，单服务故障隔离，并支持工具列表通知或主动刷新。 | `docs/agent-core-modernization-sdd.md` §7.3 | Resources、Prompts 和其他 Notifications 属于 TOOL-105。 | 本任务只处理 MCP Tools 的连接、缓存和 list changed。 |
| 当前 `connectMcpServers()` 遍历全部配置，没有读取 `enabled`。 | `api/src/domain/services/tools/mcp.tool.ts` | 无。 | 连接前过滤；disabled 服务不创建 transport/client，也不进入缓存。 |
| 当前单服务连接失败虽会继续循环，但连接创建、缓存、刷新和清理职责混在私有方法中，难以证明资源与故障隔离。 | `mcp.tool.ts` | SDK transport 的底层错误类型不稳定。 | 抽出可注入 connector 和稳定 connection record，用契约测试模拟成功、失败与通知。 |
| 当前工具快照只在 `MCPTool.initialize()` 时复制一次，服务端后续变化不会进入 Toolset。 | `MCPTool.toolDescriptors` | 服务器是否声明 `tools.listChanged` 由握手能力决定。 | 使用 SDK `listChanged.tools` 自动刷新；同时提供显式 `refreshTools()` 回退。 |
| 当前 Agent Registry 同步只增量添加 unseen id，无法删除已移除工具，也无法替换同 id 的新 Schema。 | `api/src/domain/services/tools/agent-toolset.ts` | 未来其他 Registry 是否需要局部 reconciliation。 | 为 Registry 增加原子 `replaceAll`，Agent Toolset 每次以当前完整快照替换。 |
| MCP 名称已经采用 `mcp_<server>_<tool>`，id 为 `mcp:<server>:<tool>`。 | TOOL-101 与 `getAllTools()` | server/tool 名称字符约束尚未单独定义。 | 保持现有 canonical namespace，不在本任务改名。 |

## 本任务做了什么

### 一句话说明

> MCP 配置开关、单服务故障和远端工具变化现在都会真实反映到连接与模型可用工具中，不再留下失效能力。

### 为什么需要这个任务

当前配置即使把服务设为 disabled，运行时仍会连接它；工具列表又只在初始化时复制一次，删除或更新的远程工具可能继续留在 Registry。这样配置开关不是安全边界，动态服务状态也无法被模型正确感知。

### 核心对象或能力

| 对象或能力 | 职责 | 例子 |
| --- | --- | --- |
| `MCPServerConnector` | 为每个 enabled 服务独立建立连接，并注入工具变化回调。 | `crm` 连接失败不会阻止 `billing` 建连。 |
| `MCPClientManager` | 管理每服务连接、工具缓存、调用、主动刷新与清理。 | `refreshTools('crm')` 只刷新 CRM，失败时保留旧快照。 |
| SDK `listChanged.tools` | 服务器声明 capability 时自动刷新 Tools 列表。 | 服务新增 `lookup_v2` 后实时缓存收到新 Schema。 |
| `MCPTool` live registrations | 每次从 manager 当前缓存生成注册项，不复制第二份过期 Descriptor。 | 下一轮模型选择能看到新增工具，不再看到已删除工具。 |
| `ToolRegistry.replaceAll` | 校验完整快照后原子替换 Registry。 | 同一 MCP 工具 Schema 更新、删除与新增一次生效；冲突时保留旧 Registry。 |
| 每消息主动刷新 | Router 执行前刷新一次全部已连接服务，覆盖未声明 list changed 的服务。 | 第二条用户消息路由时使用最新 capability catalog。 |

### 主要流程

```text
读取 MCPConfig
  ↓ 只保留 enabled: true
逐服务 connector 建连
  ├─ 失败：记录该服务错误，继续下一个
  └─ 成功：listTools() 建立初始缓存
  ↓
SDK tools.listChanged 自动更新缓存
或每条用户消息路由前主动 refreshTools()
  ↓
MCPTool 从实时缓存生成 namespaced registrations
  ↓
Agent Toolset 调用 Registry.replaceAll(完整快照)
  ↓
模型与调用器只使用当前仍存在的工具
```

刷新故障只影响对应服务：首次列表失败时该服务暴露零工具；已经存在成功快照后发生瞬时刷新失败，则保留最后成功快照，避免能力抖动。

### 例子

配置中有三个 MCP 服务：

```ts
{
  crm: { enabled: true },
  billing: { enabled: true },
  legacy: { enabled: false }
}
```

`legacy` 不创建 client 或 transport，也不会生成任何 Descriptor。即使 `crm` 连接失败，`billing` 的 `lookup` 仍注册为 `mcp_billing_lookup`，内置 `message_notify_user` 等工具也保持可用。

运行中 `billing` 把 `lookup` 替换为 `lookup_v2` 后，list changed 更新实时缓存；下一次 Registry 同步会删除 `mcp_billing_lookup` 并加入 `mcp_billing_lookup_v2`。模型若用旧名称发起迟到调用，manager 返回“工具已不可用”，不会继续请求远端。

### 保护规则和当前边界

- disabled 服务在 connector 之前被过滤，因此不是“连接后隐藏”，而是完全不创建网络或进程资源。
- 每个服务的连接、列表刷新和清理错误分别捕获；一个失败不会终止其他服务处理。
- 刷新结果按服务返回 `refreshed`、`failed` 或 `not_connected`，便于调用方诊断。
- MCP 缓存、getter、Descriptor 和 Registry 之间使用快照复制，外部修改不会污染内部状态。
- 工具调用按缓存中的完整 namespaced name 精确匹配，服务名互为前缀时不会路由到错误服务。
- Registry 在验证完整新快照前不修改旧索引；id/name 冲突不会留下半更新状态。
- AgentTaskRunner 每条用户消息路由前主动刷新；支持通知的服务同时由 SDK 以 100ms debounce 自动刷新。
- 只处理 Tools；Resources、Prompts 和完整 Notifications 属于 TOOL-105。
- 不改变 MCP 工具的保守 risk/approval 语义。
- 不在日志、事件或描述中输出 headers/env 密钥。
- enabled 配置由新建 Task/Runner 读取；本任务不对一个正在执行的 Runner 热替换 transport 配置。

## Scope

### In scope

- enabled 连接过滤和 disabled 零暴露。
- 每服务连接、列表刷新和清理故障隔离。
- 保持 MCP server namespace。
- 支持 SDK tool list changed 和显式刷新。
- Registry 删除过期工具、加入新工具并替换变化 Schema。

### Out of scope

- MCP Resources、Prompts、Resource subscriptions 和通用 Notifications。
- MCP 认证协议扩展和密钥管理。
- 跨进程工具目录缓存。

## Acceptance Checklist

- [x] disabled 服务不连接、不暴露。
- [x] 单服务连接、列表或清理失败不影响其他 MCP 或内置工具。
- [x] 工具名称保留 server namespace，并按完整名称精确调用。
- [x] SDK 通知或主动刷新后新增、删除和更新工具进入 Registry。
- [x] 已删除工具不能通过旧模型调用继续执行。
- [x] Registry 完整快照替换具有冲突原子性。
- [x] 新增或修改测试标题使用中文。
- [x] 本任务未新增或修改枚举。
- [x] 新增或修改函数具有中文责任注释。
- [x] 专项、全量契约、类型检查、构建和 diff 验证通过。
- [x] 证据、执行记录和改造前后对比完整。

## 改造前后对比

| 对比项 | 改造前 | 完成后 | 实际影响 |
| --- | --- | --- | --- |
| enabled | 仅配置层展示，连接层仍遍历全部服务。 | connector 前过滤，disabled 零连接、零缓存、零 Descriptor。 | 配置开关成为真实安全与资源边界。 |
| 连接故障 | 循环有 try/catch，但建连和缓存难以独立验证。 | 每服务 connector、缓存和错误结果隔离。 | 一个坏服务不再影响其他 MCP 和内置能力。 |
| 工具刷新 | `MCPTool.initialize()` 复制一次 Descriptor。 | SDK list changed、显式刷新及每消息刷新共同更新实时缓存。 | 长任务和后续消息能使用远端最新工具。 |
| 刷新失败 | 列表失败直接写空数组。 | 首次失败为空；已有成功快照时保留最后成功值。 | 瞬时网络错误不会让能力突然消失。 |
| Registry 同步 | 只能添加 unseen id，不能删除或更新。 | 完整 Toolset 通过 `replaceAll` 原子替换。 | 删除、Schema/description 更新和新增都能生效。 |
| 迟到旧调用 | 按配置名称前缀解析，已删除工具仍可能到达 client。 | 只按当前缓存完整名称精确匹配。 | 已撤销能力无法被旧模型输出绕过。 |
| namespace | 使用 `mcp_<server>_<tool>`，前缀服务名可能误路由。 | 描述命名保持兼容，调用按缓存完整名称匹配。 | `crm` 与 `crm_archive` 不会互相截获调用。 |
| 清理 | client 关闭失败会跳过同服务 transport 关闭。 | client/transport 分别尝试，且继续清理其他服务。 | 失败资源释放更完整，生命周期更可控。 |

## Current State

- 当前进展：enabled、连接隔离、通知/主动刷新、live registrations、Registry reconciliation 和测试全部完成。
- 当前阻塞：无。
- 下一步：执行 TOOL-105，把 Resources、Prompts 和其余 Notifications 接入各自正确的上下文边界。

## Task Files

- [worklog.md](./worklog.md)：执行记录。
- [evidence.md](./evidence.md)：验收证据。

## Decisions and Risks

- 列表刷新失败保留最后一次成功快照，避免一次瞬时故障让全部工具突然消失；首次加载失败则该服务暴露零工具。
- Registry 只接收当前 Toolset 的完整快照，替换前必须先完成全部冲突校验。
- 当前 namespaced name 继续兼容 `mcp_<server>_<tool>`；如果 server/tool 组合本身生成完全相同名称，Registry 会明确拒绝冲突，而不是覆盖。

## Latest Session State

- Current state: `done`；专项 8/8、相关路径 23/23、全量契约 109/109 和构建通过。
- Remaining work: 无 TOOL-104 范围内工作。
- Blockers: 无。
- Recommended next action: TOOL-105；若优先可靠运行，也可转 RUNTIME-106/107。
