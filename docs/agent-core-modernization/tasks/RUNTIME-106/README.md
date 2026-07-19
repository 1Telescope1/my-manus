# RUNTIME-106 — 实现真实取消

> 本目录是该任务的独立工作记录。总体设计以 [SDD](../../../agent-core-modernization-sdd.md) 为准，总体状态以 [TASKS.md](../../TASKS.md) 为准。

| 字段 | 值 |
| --- | --- |
| Workstream | `Runtime` |
| Status | `done` |
| Dependencies | `RUNTIME-101`, `TOOL-103` |
| Started | `2026-07-19` |
| Last Updated | `2026-07-19` |
| Working Session | `Codex：实现 RUNTIME-106` |

## Intent

让停止请求从“移除进程内 Task 引用”升级为 Run 级真实取消：先持久化取消请求，再触发根 `AbortController`，把同一 `AbortSignal` 传播到模型和外部活动，停止后续调度，并在活动结束后把 Run 收敛为 `CANCELLED`。

## 证据表

| 确定结论 | 证据路径 | 不确定项 | 建议改动范围 |
| --- | --- | --- | --- |
| 当前停止接口调用 `task.cancel()` 后立即把 Session 标为完成，但 `RedisStreamTask.cancel()` 只移除 Task 注册，不中止 `taskRunner.invoke()`。 | `api/src/application/services/agent.service.ts`、`api/src/infrastructure/external/task/redis-stream-task.ts` | 无。 | 修正 Task 生命周期，使取消先通知 Runner 落库，再 abort，并允许 API 等待执行确认。 |
| `RuntimeRequest`、执行上下文和可靠工具调用层已有可选 `AbortSignal`，但 `AgentTaskRunner` 没有根 Signal 来源。 | `api/src/domain/services/runtime/runtime.service.ts`、`executor.service.ts`、`tool-invocation.service.ts` | 无。 | 复用现有 Signal 契约，不建立第二套取消通道。 |
| Runtime 执行器只会产生 `run.completed`/`run.failed`，`RuntimeService` 也不会持久化 `run.cancelled`。 | `api/src/domain/services/runtime/executor.service.ts`、`runtime.service.ts` | 无。 | 在统一执行器识别取消并短路，在协调器提交取消检查点和 `CANCELLED` 终态。 |
| LLM 端口不接收 Signal；BaseTool 注册桥丢弃 `ToolExecutionContext`，导致 Shell、Browser、MCP、A2A 无法获得可靠调用层传入的 Signal。 | `api/src/domain/external/llm.ts`、`api/src/domain/services/tools/base-tool.ts` | Browser 的部分 Playwright 动作没有原生 AbortSignal 参数。 | 扩展厂商无关端口并贯穿适配器；无法原生中止的动作至少停止结果消费，导航关闭活动 Page，Shell 取消时请求终止进程。 |
| `run.cancelled` 已能被 Event Adapter 转成兼容 `done`，并附加 `metadata.terminal_status=cancelled`。 | `api/src/application/services/runtime-event.adapter.ts` | 无。 | 保持 UI/SSE 兼容，不新增前端必填字段。 |

## 本任务做了什么

### 一句话本质

停止请求现在会先成为可持久化的 Run 事实，再中止同一执行树中的活动操作；Runtime 只在执行链确认退出后发布取消终态。

### 改造前的问题

改造前的 `Task.cancel()` 只把 Task 从进程内管理器移除。已经开始的模型、Shell、Browser、MCP 或 A2A 请求仍可继续，`RuntimeRequest.signal` 虽已定义却没有根 Signal 来源；停止接口还会立即把 Session 标为完成，导致“UI 显示停止”和“后台真正停止”不是同一件事。

此外，可靠工具层已经会把 `ToolExecutionContext.signal` 交给注册项，但 `BaseTool` 的注册桥没有把 context 继续传给具体工具，因此适配器无法获得 Signal。Runtime 执行器也只认识完成和失败，会把底层取消错误错误地收敛为 `FAILED`。

### 核心对象和能力

| 对象或能力 | 职责 | 例子 |
| --- | --- | --- |
| Task 根 `AbortController` | 每次 Task 执行创建一个根 Signal；停止时先请求持久化，再 abort。 | 用户停止正在运行的会话。 |
| `TaskRunner.requestCancellation()` | 连接 Task 生命周期与当前活动 Runtime，不让基础设施层直接操作 Run 仓储。 | `RedisStreamTask` 在 `abort()` 前调用 Runner。 |
| `RuntimeService.requestCancellation()` | 用 Run 版本 CAS 幂等写入首次 `cancelRequestedAt`。 | 两次停止请求不会覆盖首次时间。 |
| `RuntimeCancelledError` / `throwIfAborted()` | 统一识别 SDK AbortError，并在新 Step、ToolCall 或模型阶段前短路。 | 工具取消后不再调用总结 LLM。 |
| `run.cancelled` | 执行器统一产生的取消终态事件。 | Event Adapter 转成既有 `done` 并附带 `terminal_status=cancelled`。 |
| 适配器 Signal 传播 | LLM、Shell、Browser、Search、MCP、A2A 接收同一根 Signal。 | OpenAI request options、MCP RequestOptions、fetch 和沙箱 HTTP 请求都收到 Signal。 |

### 主要执行流程

```text
POST /sessions/:id/stop
  → TaskRunner.requestCancellation()
  → AgentRun CAS 写入 cancelRequestedAt
  → 根 AbortController.abort()
  → LLM / ToolInvocation / Shell / Browser / MCP / A2A 停止
  → RuntimeExecutor 停止调度并产生 run.cancelled
  → 写终态 Checkpoint
  → AgentRun 转为 CANCELLED(cancellation=confirmed)
  → Event Adapter 输出兼容 done(metadata.terminal_status=cancelled)
  → stop API 在 Task 退出后返回
```

Single Tool 和 Planned Agent 都在模型、工具及循环边界检查 Signal。工具调用返回 `cancelled` 后不会再产生 `tool.called` 后续消费，也不会启动结果总结模型；迟到的模型或工具结果不会进入 Runtime Event 流。

### 适配器行为

| 适配器 | 取消方式 |
| --- | --- |
| LLM | Signal 进入厂商无关 `LLM.invoke`，OpenAI SDK 通过 request options 中止 HTTP 请求；取消错误不再包装为普通服务错误。 |
| Shell/Sandbox | Signal 进入沙箱 HTTP 请求；执行命令被取消时额外请求 `killProcess(sessionId)`。 |
| Browser | Signal 进入 Browser 端口；Playwright 页面读取或导航取消时关闭活动 Page 并拒绝迟到结果。 |
| Search | 外部 Signal 与 60 秒超时组合后交给 `fetch`。 |
| MCP | Signal 进入 SDK `listTools`、`callTool` 的 `RequestOptions`。 |
| A2A | 外部 Signal 与 10 分钟超时组合后交给 Agent Card 和 JSON-RPC `fetch`。 |

### 失败、安全与兼容保护

- 取消请求与取消确认仍是两个状态：只写 `cancelRequestedAt` 不会直接伪造 `CANCELLED`。
- `CANCELLED` 前会写终态 Checkpoint，并使用领域状态机要求的 `CancellationOutcome.CONFIRMED`。
- 已经取消的 Signal 在每个新调度边界都会立即抛出，取消后不会启动新 ToolCall 或总结 LLM。
- Router 模型取消不会被“安全回退到 planned_agent”吞掉。
- Runner 同时检查异常名和根 Signal；即使 MCP SDK 将 `AbortError` 包装成普通 `Error`，也不会向会话写入红色错误。
- 取消是预期终止：Runner 写入带 `terminal_status=cancelled` 的 `done` 后正常返回，使 stop API 可以成功确认。
- 现有停止 URL、Session 状态和 SSE Event 联合类型不变；取消仍表现为 `done`，新语义只放在可选 metadata。
- MCP 单服务故障隔离、A2A 初始化兼容和 Tool 超时/重试策略保持原行为。

### 后续精简

`RedisStreamTask` 原先同时使用 `cancelled` 布尔值和 `cancellation` Promise 表示“取消已经开始”。由于 Promise 本身既能作为幂等标记，也能供停止 API 等待，因此删除了重复布尔状态；重复调用 `cancel()` 会复用同一个取消流程。

执行器捕获异常时也统一调用 `isCancellationError(error, signal)`，不再在调用点重复判断 `signal.aborted`。Signal 传播链没有减少，取消顺序仍严格保持为“持久化请求 → abort → 等待执行退出”。新增契约直接验证两次 `cancel()` 只调用一次 `requestCancellation()`，且事件顺序为 `request → abort → done → release`。

### 当前接入状态和后续边界

当前 Session 的唯一 `AgentTaskRunner` 已接入根取消，Direct、Single Tool、Workflow 和 Planned Agent 共用执行器取消语义。可确认的本进程活动使用 `confirmed` 收敛。

跨进程恢复后无法判断副作用是否完成、以及 `timed_out + uncertainOperationIds` 的持久化判定属于 `RUNTIME-107`；完整 A2A Task/Cancel 协议升级属于 `AGENT-104`。本任务不会把未知远程副作用错误地声明为已完成。

## 改造前后对比

| 维度 | 改造前 | 改造后 | 实际影响 |
| --- | --- | --- | --- |
| Stop 语义 | 只移除 Task 注册并立即返回。 | 先落取消请求，再 abort，并等待执行退出。 | UI 停止与后台停止使用同一生命周期。 |
| Run 状态 | 取消通常表现为完成或失败。 | 终态为 `CANCELLED`，带确认 metadata。 | 恢复、诊断和评测可区分取消。 |
| LLM | 没有 Signal。 | Router、Direct、Single Tool、Planner、ReAct、Summary 全部传播 Signal。 | 长模型请求可立即中止。 |
| Tool | 可靠调用 context 在 BaseTool 桥丢失。 | context 进入具体适配器，取消结果阻止后续调度。 | Shell/Browser/MCP/A2A 不再继续向模型交付迟到结果。 |
| UI 兼容 | 现有 `done`。 | 仍是 `done`，可选 metadata 标记 cancelled。 | 前端无需同步升级。 |

## 验证

详细命令和结果见 [验收证据](./evidence.md)。

## Acceptance

- [x] LLM 取消测试通过。
- [x] Shell 取消测试通过。
- [x] Browser 取消测试通过。
- [x] MCP 取消测试通过。
- [x] A2A 取消测试通过。
- [x] 取消后不再调度新 Step 或 ToolCall。
- [x] Run 终态为 `CANCELLED`，兼容事件为带取消元数据的 `done`。
- [x] 重复取消共用同一个取消 Promise，且持久化请求先于根 Signal。

## Recommended next action

执行 `RUNTIME-107`，把副作用幂等与未知状态判定接入持久化 ToolCallRecord；或执行 `AGENT-104`，补齐远程 A2A Task/Cancel 协议。
