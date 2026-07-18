# TOOL-103 — 统一 Tool 调用可靠性和错误语义

> 本目录是该任务的独立工作记录。总体设计以 [SDD](../../../agent-core-modernization-sdd.md) 为准，总体状态以 [TASKS.md](../../TASKS.md) 为准。

| 字段 | 值 |
| --- | --- |
| Workstream | `Tool 与 MCP` |
| Status | `done` |
| Dependencies | `TOOL-101` |
| Started | `2026-07-18` |
| Last Updated | `2026-07-18` |
| Working Session | `Codex：执行 TOOL-103` |

## Intent

在 Tool Registry 与具体工具实现之间建立唯一可靠调用边界，使审批、输入校验、幂等、超时、取消、重试和结果归一化按固定顺序执行，并让 Single Tool 与 ReAct 共用同一语义。

## 证据表

| 确定结论 | 证据路径 | 不确定项 | 建议改动范围 |
| --- | --- | --- | --- |
| SDD 要求所有工具接受 `AbortSignal`，默认 60 秒超时；只有只读、幂等工具可自动重试，副作用工具必须有幂等保证。 | `docs/agent-core-modernization-sdd.md` §7.2 | 根 Run 级取消与恢复后副作用判定分别属于 RUNTIME-106/107。 | 本任务建立单次调用服务与 Signal 传播契约，不提前实现根控制器或持久化恢复。 |
| Registry 已保存 `risk`、`requiresApproval`、`timeoutMs`，但注册项 `invoke` 只接收参数。 | `api/src/domain/models/tool.ts`、`tool-registry.ts` | 现有底层 Browser/Sandbox 端口多数暂不接受 Signal。 | 扩展注册调用上下文；不能中止的旧适配器由上层停止消费迟到结果并记录能力限制。 |
| Single Tool 与 ReAct 分别直接调用 `ToolRegistration.invoke()`，且 ReAct 对所有异常按 Agent 重试次数重试。 | `runtime/adapters.ts`、`agents/base-agent.ts` | 两条路径现有事件格式必须兼容。 | 两条路径都改用同一个可靠调用服务，去除路径内重试策略。 |
| `ToolResult` 目前只有 `success/message/data`，不能稳定区分校验、审批、超时、取消和执行错误。 | `api/src/domain/models/tool-result.ts` | 大结果 Artifact 化属于 TOOL-106。 | 兼容保留 `message`，新增结构化 `error` 与 `metadata`，统一所有可靠调用输出。 |
| AgentRun Repository 已有幂等占用接口，但完整的恢复复用与未知副作用处理属于 RUNTIME-107。 | `agent-run.repository.ts`、TASKS 中 RUNTIME-107 | 直接把本任务绑定数据库会把 Tool 领域层耦合到 Runtime 聚合。 | 定义可替换幂等存储端口并提供进程内实现；持久化实现留给 RUNTIME-107。 |

## 本任务做了什么

### 一句话说明

> 工具不再由各条 Agent 路径直接调用；每次调用都先经过同一套安全检查和可靠性策略，再返回可机器判断的结果。

### 为什么需要这个任务

当前工具虽有风险、审批和超时元数据，但调用者会绕过这些字段直接执行函数；同一个异常在 Single Tool 中导致 Run 失败，在 ReAct 中又可能被无条件重试。结果是描述层表达了安全意图，执行层却没有兑现。

### 核心对象或能力

| 对象或能力 | 职责 | 例子 |
| --- | --- | --- |
| `ToolInvocationRequest` | 携带函数名、参数、调用作用域、幂等键和可选 `AbortSignal`。 | Run `run-1` 用 `call-7` 调用 `search_web`。 |
| `ToolApprovalGate` | 对声明 `requiresApproval` 的具体工具和参数给出批准或拒绝；缺失审批器时 fail closed。 | 删除工具未配置审批器时返回 `approval_required`，不会执行。 |
| `ToolIdempotencyStore` | 原子区分首次占用、完成结果重放、执行中重复和键冲突。 | 相同 Run、key 和参数直接复用结果；相同 key 换参数返回冲突。 |
| `InMemoryToolIdempotencyStore` | 提供当前进程内的默认幂等实现和并发保护。 | 两个并发请求只有一个进入实际工具。 |
| `ToolInvocationService` | 固定执行校验、审批、幂等、Signal/Timeout、风险重试和结果归一化。 | 只读工具瞬时失败最多重试两次，普通写工具只尝试一次。 |
| `ToolError` / `ToolResultMetadata` | 让调用方稳定区分错误原因，并记录次数、耗时、风险、幂等键和 Signal 能力。 | 超时结果的 code 为 `timeout`，`attempts` 表示实际尝试次数。 |
| 注册项执行能力 | `ToolRegistration` 接收每次尝试的 Signal、attempt 和 idempotencyKey，并声明是否真正支持中止/适配器幂等。 | 旧适配器不支持底层中止时标记 `signalPropagation: guarded`。 |

### 主要流程

```text
按 functionName 解析注册项
  ↓
按 inputSchema 校验 required 和基础 JSON 类型
  ↓
requiresApproval ? 审批通过 : 继续
  ↓
按 scopeId + idempotencyKey 原子占用
  ├─ 已完成且指纹相同：直接重放
  ├─ 正在执行：返回 duplicate_in_progress
  └─ 指纹不同：返回 idempotency_conflict
  ↓
把外部 Signal 与 descriptor.timeoutMs 组合成尝试 Signal
  ↓
执行工具；按 risk、supportsIdempotency 和 key 决定是否重试
  ↓
归一化 success/data/error/metadata，并保存幂等终态
```

重试不是由 Agent 的 `max_retries` 决定，而是由工具副作用语义决定：

- `read` 工具最多三次尝试，即首次加两次自动重试。
- `write`、`destructive`、`external_communication` 默认只尝试一次。
- 副作用工具只有同时声明 `supportsIdempotency` 且收到 idempotencyKey 时，才允许按相同上限重试。
- 外部取消、审批失败、参数错误、幂等冲突都不可重试。

### 例子

正常路径：`search_web` 是 `read` 工具，第一次抛出瞬时网络错误，第二次成功。可靠调用层向两次尝试传递同一个幂等键，最终返回：

```ts
{
  success: true,
  data: { results: [] },
  metadata: {
    attempts: 2,
    risk: 'read',
    idempotencyKey: 'call-search',
    signalPropagation: 'guarded'
  }
}
```

失败反例：一个 `destructive` 工具声明 `requiresApproval: true`，但运行时没有审批器。调用层直接返回 `approval_required`，实际工具调用次数为零。另一个写工具即使抛出“响应丢失”，只要适配器没有声明幂等支持，也不会自动执行第二次。

### 保护规则和当前边界

- Schema 校验和审批发生在幂等占用、实际执行之前，失败不会产生工具副作用。
- 幂等指纹对对象键排序，同一语义参数不会因 JSON 键顺序不同而误判。
- 同一 scope/key 的并发调用只放行一个；已完成结果以快照重放，不再次执行工具。
- 超时会中止本次尝试的 Signal；底层暂不支持中止时，上层仍停止消费迟到结果并记录 `guarded`。
- Single Tool 使用 `toolCallId` 作为幂等键；ReAct 把 Runtime runId 作为作用域并沿用模型 tool call ID。
- 现有 `success/message/data` 消费者保持兼容；经过可靠调用层的失败额外获得结构化 `error`，成功和失败都获得 `metadata`。
- 根 Run 级取消控制器属于 RUNTIME-106；本任务保证调用边界接收并遵守传入 Signal。
- 跨进程幂等恢复和未知副作用状态属于 RUNTIME-107；默认实现只覆盖当前进程，已预留持久化端口。
- 大结果 Artifact 化属于 TOOL-106。

## Scope

### In scope

- 统一调用输入、审批端口、幂等端口、重试策略和结构化结果。
- 把 Single Tool 与 ReAct 接到同一调用服务。
- 覆盖超时、取消、输入校验、审批、幂等、重试与副作用保护测试。

### Out of scope

- 创建根 Run `AbortController` 并贯穿 LLM 等非 Tool 端口。
- 实现 ToolCallRecord 的完整持久化恢复状态机。
- 大型结果转 Artifact。

## Acceptance Checklist

- [x] Tool 调用支持 Signal、Timeout、Risk、Approval、Idempotency 和统一结果。
- [x] 超时、取消、校验错误、重试和副作用策略测试通过。
- [x] Single Tool 与 ReAct 使用同一个可靠调用边界。
- [x] 新增或修改的自动化测试标题使用中文。
- [x] 本任务未新增或修改枚举；现有枚举注释要求不受影响。
- [x] 新增或修改的函数有头部中文注释，重要或复杂步骤有中文说明。
- [x] 专项测试、全量契约测试、类型检查、构建和 diff 检查成功。
- [x] “本任务做了什么”和“改造前后对比”完整。
- [x] [evidence.md](./evidence.md) 和 [worklog.md](./worklog.md) 已填写。
- [x] 总任务清单和本目录工作记录已更新。

## 改造前后对比

| 对比项 | 改造前 | 完成后 | 实际影响 |
| --- | --- | --- | --- |
| 调用入口 | Single Tool 与 ReAct 分别直接执行注册函数。 | 两条真实路径统一调用 `ToolInvocationService`。 | 策略不会因执行路径不同而被绕过。 |
| 输入校验 | 模型参数解析后直接传给具体方法。 | 实际执行前检查 required 和基础 JSON 类型。 | 参数错误不会进入工具或被误判为工具故障。 |
| 审批 | Descriptor 有 `requiresApproval`，执行层不读取。 | 审批通过才执行；审批器缺失默认拒绝。 | 元数据安全意图成为真实执行约束。 |
| 错误语义 | 主要依赖 `success/message` 或抛异常。 | 统一 `ToolError.code/message/retryable`，并兼容原字段。 | Runtime、模型和后续恢复逻辑可稳定分类。 |
| 重试安全 | ReAct 对所有抛错按 Agent 重试次数重试，Single Tool 不重试。 | 只读可受控重试；副作用工具必须有适配器幂等保证。 | 避免重复写入、删除或外部通信。 |
| 超时与取消 | 各底层适配器自行决定，调用者无法统一停止消费结果。 | 每次尝试使用 descriptor 超时和可选外部 Signal。 | 即使旧适配器不能物理中止，也不会把迟到结果继续交给模型。 |
| 幂等 | Runtime 仓储已有基础类型，但当前工具入口不占用或复用。 | 进程内原子占用、重放、冲突和并发执行中判断。 | 同一逻辑调用不会在当前进程重复产生副作用，并为持久化实现提供端口。 |
| 可观测性 | ToolResult 不记录尝试次数、风险或 Signal 能力。 | 统一 metadata 记录 attempts、durationMs、risk、key 和传播状态。 | 事件、日志和测试能解释调用为何重试或停止。 |

## Current State

- 当前进展：统一调用模型、服务、Single Tool/ReAct 接线和全部契约测试已完成。
- 当前阻塞：无。
- 下一步：执行 RUNTIME-106，把根 `AbortController` 贯穿 LLM 和所有工具适配器；或执行 RUNTIME-107，把幂等端口接入持久化 ToolCallRecord。

## Task Files

- [worklog.md](./worklog.md)：按时间追加工作过程。
- [evidence.md](./evidence.md)：验收项、测试结果和完成证据。

## Decisions and Risks

- 本任务不把领域调用服务直接绑定 AgentRun Repository，避免把 Tool 可靠性与 Runtime 持久化混成一个职责。
- 审批能力缺失时对 `requiresApproval` 工具默认拒绝，不能把“未配置审批器”当作批准。
- `signalPropagation: guarded` 明确表示只能停止消费结果，不能声称底层操作已物理停止。

## Latest Session State

- Current state: `done`；专项 12/12、全量契约 100/100、类型检查和构建通过。
- Remaining work: 无 TOOL-103 范围内工作。
- Blockers: 无。
- Recommended next action: RUNTIME-106 或 RUNTIME-107；前者完成根取消传播，后者完成跨进程副作用幂等。
