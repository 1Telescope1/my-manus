# MEMORY-102 Worklog

## 2026-07-20 — 上下文预算与选择器实施

### Goal

- 建立模型窗口预算、受保护内容和统一 Context Selector。
- 接入 Runtime/Agent 的主要模型调用路径并完成回归验证。

### Investigation

- `WorkingContext` 当前只有消息拼接，没有预算和裁剪。
- `max_tokens` 是 OpenAI 请求的输出上限，不能用作总上下文窗口。
- Direct、Single Tool、Router 直接调用 LLM；Planned Agent 通过 `BaseAgent` 拼接完整 Conversation Memory。
- 当前 user message 已包含用户目标或计划/步骤状态，Run 级 Skill 以临时 system message 注入。
- 结构化摘要、恢复重建和大型 Tool Result Artifact 分别属于 MEMORY-103、MEMORY-104、TOOL-106。

### Changes

| 文件 | 变更原因 |
| --- | --- |
| `docs/agent-core-modernization/TASKS.md` | 将任务置为 `in_progress` 并链接任务证据。 |
| `docs/agent-core-modernization/tasks/MEMORY-102/*` | 固化范围、现状证据和实施记录。 |
| `api/src/domain/services/context/context-selector.service.ts` | 增加窗口预算、保守估算、受保护内容和工具原子分组；后续删除无生产消费者的报告结构与低收益防御。 |
| `api/src/domain/models/working-context.ts` | 为单次上下文增加显式受保护会话消息索引。 |
| `api/src/domain/external/llm.ts`；`api/src/infrastructure/external/llm/openai-llm.ts` | 让 LLM 端口声明总上下文窗口，并由 OpenAI 兼容配置提供真实值。 |
| `api/src/domain/models/app-config.ts`；配置仓储、DTO、Settings | 独立配置并校验 `context_window_tokens`，兼容旧配置和旧更新请求。 |
| `api/src/domain/services/agents/base-agent.ts` | Planned Agent 每次模型请求前选择上下文，并持续保护当前 Run 原始请求。 |
| `api/src/domain/services/runtime/adapters.ts` | Direct 和 Single Tool 选择/总结路径接入同一 Context Selector。 |
| `api/src/infrastructure/external/llm/llm-runtime-route-model.ts` | Router 在请求模型前计入 response format 并执行预算保护。 |
| `ui/src/components/manus-settings.tsx`；`ui/src/lib/api/types.ts` | 提供模型总窗口设置入口。 |
| `.env.example`；`docker-compose.yml` | 提供 `LLM_CONTEXT_WINDOW_TOKENS` 部署配置。 |
| `api/test/contracts/context-window-budget.contract.test.ts` | 覆盖预算、裁剪、保护、原子性、四路径和旧配置兼容。 |

### Verification

- MEMORY-102 专项契约：7/7 通过。
- API 全量契约：174/174 通过。
- API `typecheck`、`build`：通过。
- EVAL-101：9/9 已启用任务通过，数据集指纹不变。
- 本次 UI 文件定向 lint：通过；UI production build：通过。
- 全库 UI lint：被两个既有、非本任务文件错误阻塞，已写入 evidence。

### Findings

- 必须显式建模 `context_window_tokens`；从模型名或 `max_tokens` 推导都会混淆输入窗口与输出上限。
- 选择器需要把工具调用与对应结果作为原子组，否则裁剪会制造无效模型协议。
- Token 估算必须与真实 usage 明确分离；当前使用 UTF-8 字节上界换取调用前安全性。
- 受保护内容和已选择 Tool Schema 本身超限时没有安全裁剪方案，应确定性失败而不是重试。
- 完成后复审发现 `ContextSelectionReport` 没有生产消费者，专用无效预算异常、索引逐项校验和循环引用静默降级也没有足够收益；已删除并保持核心契约不变。

### Next

- 开始 MEMORY-103，为被省略的早期历史生成带来源的结构化摘要。
