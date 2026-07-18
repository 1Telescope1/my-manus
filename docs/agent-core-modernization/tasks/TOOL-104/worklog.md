# TOOL-104 Worklog

## 2026-07-18 — 修复 MCP 动态管理

### Goal

- 让 MCP enabled、故障和工具列表变化成为真实运行边界。

### Investigation

- 当前 manager 连接全部配置服务，忽略 `enabled`。
- 连接循环已有基础 try/catch，但缺少可测试连接边界和刷新结果。
- `MCPTool` 只在初始化复制 Descriptor，之后不会更新。
- Agent Tool Registry 只增量注册，无法删除或替换动态工具。
- 当前 MCP SDK 已提供 `listChanged.tools.onChanged` 自动刷新入口。

### Changes

| 文件 | 变更原因 |
| --- | --- |
| `docs/agent-core-modernization/TASKS.md` | 将 TOOL-104 标记为进行中并链接证据。 |
| `docs/agent-core-modernization/tasks/TOOL-104/*` | 建立范围、证据表和执行记录。 |
| `api/src/domain/services/tools/mcp.tool.ts` | 实现 enabled 过滤、connector、故障隔离、通知/主动刷新、实时注册和精确调用。 |
| `api/src/domain/models/tool.ts` | 为 Registry 增加完整快照原子替换端口。 |
| `api/src/domain/services/tools/tool-registry.ts` | 实现校验后 `replaceAll`。 |
| `api/src/domain/services/tools/agent-toolset.ts` | 将增量同步改为完整 Toolset reconciliation。 |
| `api/src/domain/services/runtime/agent-task-runner.ts` | 每条用户消息路由前刷新 MCP Tools。 |
| `api/test/contracts/mcp-dynamic-management.contract.test.ts` | 覆盖 enabled、故障、namespace、刷新、删除与清理。 |
| `api/test/contracts/tool-registry.contract.test.ts` | 更新 MCP 测试并增加快照替换原子性。 |

### Verification

- 起始工作区干净；基线提交为 `326fc7d`。
- TOOL-104 专项测试：8/8。
- MCP、Registry、Runtime 相关测试：23/23。
- `npm run test:contract`：109/109，类型检查通过。
- `npm run build`：通过。
- `git diff --check`：通过。

### Findings

- 只更新 MCP 缓存不够；Registry 也必须支持删除与替换，否则模型仍会看到旧 Schema。
- 刷新失败不能清空最后成功缓存，否则单服务瞬时故障会扩大成能力抖动。
- 旧工具必须同时从 MCPTool 与 Registry 消失，并在实际调用前再次按当前缓存检查。
- SDK 已原生支持按 server capability 注册 list changed handler，无需手写底层 notification schema。

### Next

- TOOL-104 已完成；后续 TOOL-105 接入 MCP Resources、Prompts 和其他 Notifications。
