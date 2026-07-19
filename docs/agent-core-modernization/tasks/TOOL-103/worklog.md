# TOOL-103 Worklog

## 2026-07-18 — 建立统一可靠调用边界

### Goal

- 让全部真实工具路径统一执行审批、校验、幂等、超时、取消、重试和结果归一化。

### Investigation

- SDD §7.2 已固定默认超时、重试与 Signal 原则。
- Registry 已携带策略元数据，但 `ToolRegistration.invoke` 没有调用上下文。
- Single Tool 与 ReAct 当前分别直接调用工具，错误和重试语义不一致。
- AgentRun Repository 已有持久化幂等基础，但完整恢复属于 RUNTIME-107。

### Changes

| 文件 | 变更原因 |
| --- | --- |
| `docs/agent-core-modernization/TASKS.md` | 将 TOOL-103 置为进行中并链接任务证据。 |
| `docs/agent-core-modernization/tasks/TOOL-103/*` | 建立任务范围、证据表和执行记录。 |
| `api/src/domain/models/tool-invocation.ts` | 定义调用、审批和幂等端口。 |
| `api/src/domain/models/tool.ts` | 让注册项接收 Signal、attempt 和 key，并声明底层能力。 |
| `api/src/domain/models/tool-result.ts` | 增加结构化错误与可靠调用 metadata。 |
| `api/src/domain/services/tools/tool-invocation.service.ts` | 实现固定安全顺序、风险重试、超时取消和进程内幂等。 |
| `api/src/domain/services/runtime/*` | Single Tool 接入统一调用，并预留 Runtime Signal。 |
| `api/src/domain/services/agents/base-agent.ts` | 删除 Agent 内无差别工具重试，改用统一服务。 |
| `api/src/domain/services/agents/react-agent.ts`、`flows/planner-react-flow.ts` | 将 run scope 与 Signal 传入每轮 ReAct 工具调用。 |
| `api/test/contracts/tool-invocation.contract.test.ts` | 固定 12 个可靠性与安全策略场景。 |
| `api/test/contracts/runtime-wiring.contract.test.ts`、`tool-visibility.contract.test.ts` | 验证两条真实路径输出统一 metadata。 |

### Verification

- 工作区开始时干净；基线提交为 `d0093ec`。
- TOOL-103 专项契约测试：12/12。
- 相关路径联合测试：20/20。
- `npm run test:contract`：100/100，类型检查通过。
- `npm run build`：通过。
- `git diff --check`：通过。

### Findings

- 可靠调用必须位于 Registry 与调用者之间；否则新增策略字段仍可被路径绕过。
- 进程内幂等可以验证调用语义，但不能冒充 RUNTIME-107 的跨进程恢复能力。
- 现有底层适配器多数尚未接受 AbortSignal；调用层已停止消费迟到结果并用 `guarded` 明确限制。
- 未配置审批实现时 fail closed 会让 `requiresApproval` 工具返回结构化失败，这是安全边界而非兼容回退。

### Next

- TOOL-103 已完成；后续由 RUNTIME-106 接根取消，由 RUNTIME-107 接持久化幂等恢复。

## 2026-07-19 — 删除无消费者的防御性抽象

### Goal

- 在不改变可靠调用边界的前提下，删除重复状态、死 API 和无人消费的结果包装。

### Changes

- 删除 `supportsAbortSignal/signalPropagation`；取消行为直接由适配器契约验证。
- 删除无人调用的 `BaseTool.hasTool` 和无人消费的 MCP 刷新结果。
- 固定现有三次只读尝试策略，删除未使用的次数与时钟配置入口。
- 合并 Tool 选择约束收集逻辑，删除重复 Registry 同步和快照复制循环。

### Verification

- `npm run typecheck`：通过。
- `npm run test:contract`：159/159。
- `npm run build`：通过。
- `git diff --check`：通过。
