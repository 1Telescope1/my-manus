# RUNTIME-107 — 防止恢复时重复副作用

> 本目录是该任务的独立工作记录。总体设计以 [SDD](../../../agent-core-modernization-sdd.md) 为准，总体状态以 [TASKS.md](../../TASKS.md) 为准。

| 字段 | 值 |
| --- | --- |
| Workstream | `Runtime` |
| Status | `done` |
| Dependencies | `RUNTIME-101`, `TOOL-103` |
| Started | `2026-07-19` |
| Last Updated | `2026-07-19` |
| Working Session | `Codex：实现 RUNTIME-107` |

## Intent

让真实 Runtime 工具调用使用持久化 ToolCallRecord 作为幂等事实源：相同请求恢复后复用终态结果，提交后无法确认结果的副作用进入 `UNKNOWN` 并暂停 Run，禁止自动重放。

## 证据表

| 确定结论 | 证据路径 | 不确定项 | 建议改动范围 |
| --- | --- | --- | --- |
| PostgreSQL 已有 ToolCallRecord、`(run_id, idempotency_key)` 唯一约束、请求指纹和原子 reserve-or-get。 | `api/prisma/schema.prisma`、`db-agent-run.repository.ts` | 无。 | 复用现有仓储，不新增重复表或迁移。 |
| `ToolInvocationService` 的安全顺序和指纹逻辑已经稳定，但默认幂等存储仍是进程内 Map。 | `tool-invocation.service.ts`、`tool-invocation.ts` | 持久化存储还需要 toolName、risk、arguments、stepId。 | 扩展可替换 `ToolIdempotencyStore` 上下文，实现 AgentRun 仓储适配器。 |
| 真实 Single Tool 与 Planned Agent 都使用可靠调用层，但没有为调用创建或推进持久化 ToolCallRecord。 | `runtime/adapters.ts`、`agents/base-agent.ts` | Runtime 没有预先提供工具 RunStep ID。 | 由持久化 store 按 Run 和幂等键为实际调用创建专属 TOOL Step，避免无工具路径产生空步骤。 |
| 恢复解析器已经分类 completed、pending、running/unknown，但只返回决策，不把崩溃时 running 副作用收敛为 UNKNOWN，也不把 Run 持久化为 PAUSED。 | `runtime/recovery.service.ts` | 外部系统查询协议因工具而异。 | 本任务先做保守安全收敛：running 副作用写 UNKNOWN，Run 写 PAUSED；外部查询能力保留可扩展边界。 |
| ToolCall 终态结果包含完整 ToolResult，可直接作为同指纹请求的恢复结果。 | `agent-run.ts`、`tool-result.ts` | 大结果 Artifact 化属于 TOOL-106。 | 完整结果先按现有 JSON 字段复用，不提前引入 Artifact。 |

## 本任务做了什么

### 一句话本质

工具调用现在先以稳定幂等身份落库，再提交外部请求；恢复时要么复用已保存结果，要么对无法确认的副作用暂停 Run，绝不把“未知”当成“可以再试一次”。

### 持久化状态边界

```text
reserve ToolCall(PENDING) + TOOL Step(PENDING)
  → 外部提交前：ToolCall/Step = RUNNING
  → 明确成功：ToolCall/Step = COMPLETED，保存完整 ToolResult
  → 明确失败或取消：ToolCall/Step = FAILED/CANCELLED，保存结构化错误
  → 副作用结果无法确认：ToolCall = UNKNOWN，Step 保留 RUNNING
  → 进程恢复：Run = PAUSED，禁止自动重放
```

`PersistentToolIdempotencyStore` 复用现有 `AgentRunRepository` 和 `(runId, idempotencyKey)` 唯一约束。每次实际工具调用都有一个由 Run 与幂等键摘要得到的专属 TOOL Step；Step 和 ToolCall 的开始、完成状态在同一 UnitOfWork 中条件更新。

### 真实调用接线

- Single Tool 和 Planned Agent 共用同一个持久化 store，不再使用各自的进程内 Map。
- `ToolInvocationService` 在调用前执行 `reserve → start`，调用后保存完整 `ToolResult`；同指纹终态直接重放，不进入工具适配器。
- Single Tool 的唯一逻辑调用 ID 由 Run ID 确定性生成，执行器重建后仍使用同一幂等键。
- Planned Agent 继续使用模型 `toolCallId` 作为 Run 内幂等身份；ToolCallRecord 使用独立 UUID，避免不同 Run 的模型调用 ID 发生全局主键碰撞。
- 同一键对应不同工具名或参数时，请求指纹不一致，返回 `idempotency_conflict`。

### 恢复与安全策略

- 已完成、已失败或已取消且保存了完整结果的调用可跨服务实例复用。
- `PENDING` 表示外部请求尚未提交，新进程可以安全接管。
- `RUNNING`/`UNKNOWN` 的只读调用可以重新打开并重试。
- `RUNNING` 的写入、破坏性或外部通信调用在恢复时先固化为 `UNKNOWN`；Run 使用版本 CAS 进入 `PAUSED`。
- 再次遇到 `UNKNOWN` 副作用时返回 `uncertain_side_effect`，不会调用外部工具。
- 当前没有统一的外部状态查询协议，因此无法确认时采用保守暂停；本任务不承诺外部系统绝对 exactly-once。

## 验证

详细命令和结果见 [验收证据](./evidence.md)。

## Acceptance

- [x] 已完成副作用调用在新进程中复用持久化结果，外部写操作不重复。
- [x] 相同幂等键但不同请求指纹拒绝执行。
- [x] 工具提交后、结果持久化前崩溃时记录为 UNKNOWN。
- [x] UNKNOWN 副作用使 Run 进入 PAUSED，恢复不重放工具。
- [x] 只读与明确未提交调用仍保持安全恢复语义。

## Recommended next action

执行 `EVAL-103`：其依赖的 `RUNTIME-103`、`RUNTIME-106`、`RUNTIME-107` 已全部完成，可以把崩溃、超时、取消和不确定副作用组合成统一耐久执行评测。
