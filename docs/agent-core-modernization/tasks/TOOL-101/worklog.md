# TOOL-101 Worklog

## 2026-07-18 — 建立统一 Tool 描述与注册边界

### Goal

- 完成通用 ToolDescriptor、三来源注册、查询、冲突检测和现有路径接入。

### Investigation

- SDD §7.1 已固定统一描述字段和 capability 驱动的后续选择流程。
- 当前 `BaseTool` 装饰器直接保存模型 function schema，领域对象缺少风险和能力语义。
- Planner/ReAct 与 Single Tool Runtime 分别遍历数组定位工具，无法在装配时发现冲突。
- MCP 已生成服务器命名空间；动态刷新和 enabled 管理由 TOOL-104 处理。
- Agent-as-Tool 尚未实现，本任务只提供 AGENT-102 可复用的 `source: agent` 注册契约。

### Changes

| 文件 | 变更原因 |
| --- | --- |
| `api/src/domain/models/tool.ts` | 定义不绑定特定模型厂商的通用 Descriptor、source、risk、查询和 Registry 端口。 |
| `api/src/domain/services/tools/tool-registry.ts` | 实现双索引查询、原子批量注册、冲突错误和快照隔离。 |
| `api/src/domain/services/tools/base-tool.ts` | 让 `@tool` 生成领域描述和可执行注册项，不再生成厂商 schema。 |
| `api/src/domain/services/tools/*.tool.ts` | 为现有内置工具补充 capability、risk、审批和长任务超时元数据。 |
| `api/src/domain/services/tools/mcp.tool.ts` | 为发现的 MCP 工具生成命名空间 Descriptor 和保守风险。 |
| `api/src/domain/services/agents/base-agent.ts` | Planner/ReAct 改为通过 Registry 暴露和解析工具。 |
| `api/src/domain/services/runtime/adapters.ts` | Single Tool 选择与调用改为通过 Registry。 |
| `api/src/infrastructure/external/llm/openai-llm.ts` | 在基础设施边界生成 OpenAI-compatible function schema。 |
| `api/test/contracts/tool-registry.contract.test.ts` | 覆盖三来源、查询、冲突、原子性、隔离、MCP 和厂商转换。 |
| `api/test/contracts/planner-event-order.contract.test.ts` | 使用真实空 MCP/A2A 工具包适配构造阶段注册检查。 |

### Verification

- TOOL-101 专项契约测试 9/9 通过。
- `npm run test:contract`：76/76 通过。
- `npm run build`：NestJS 生产构建成功。
- `git diff --check`：通过。

### Findings

- Registry 必须对批量注册执行预检查，否则发生中途冲突会留下部分注册状态。
- Descriptor 到模型厂商 Schema 的转换应位于基础设施适配器，而不是领域装饰器。
- MCP 未提供本系统风险语义，默认外部通信并要求审批比误判为只读更安全。
- 当前 MCP 初始化晚于 Agent 构造，因此 Registry 需要增量吸收新发现项；完整刷新由 TOOL-104 统一实现。

### Next

- TOOL-101 已完成；后续执行 TOOL-102 的最小工具选择、TOOL-103 的可靠调用和 TOOL-104 的 MCP 动态管理。
