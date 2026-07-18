# RUNTIME-103 Worklog

## 2026-07-17 — 建立可恢复运行协调能力

### Goal

- 完成原子 Checkpoint 提交、恢复解析和关键故障点验收。

### Investigation

- SDD 要求路由完成、Step 前后、副作用工具前后、WAIT/PAUSE、Handoff 前后和终态前写 Checkpoint。
- RUNTIME-102 已提供最新 Checkpoint、未完成 ToolCall、待处理中断查询和事务 UnitOfWork。
- 当前 legacy PlannerReActFlow 尚未使用 AgentRun；按任务边界不在本任务提前接线。

### Changes

| 文件 | 变更原因 |
| --- | --- |
| `docs/agent-core-modernization/TASKS.md` | 领取任务并标记为实施中。 |
| `docs/agent-core-modernization/tasks/RUNTIME-103/*` | 建立任务范围、日志和证据记录。 |
| `api/src/domain/services/runtime-checkpoint.service.ts` | 定义全部持久化边界，并原子提交 Run 游标/version 与 Checkpoint。 |
| `api/src/domain/services/runtime-recovery.service.ts` | 把持久化现场解析为恢复动作、游标、工具分类和中断集合。 |
| `api/test/contracts/runtime-recovery.contract.test.ts` | 覆盖模型/工具故障注入、暂停/等待、事务回滚和缺失快照。 |
| `api/test/integration/agent-run-persistence.integration.test.ts` | 在真实 PostgreSQL 上验证原子提交和未知副作用恢复分类。 |

### Verification

- 9 项 RUNTIME-103 专项契约测试通过。
- `npm run test:contract`：43/43 通过，包含全部 legacy/SSE 回归。
- 真实 PostgreSQL 16 容器中，Run version 1→2、currentNode 更新和 Checkpoint sequence 1 在同一事务提交。
- 真实数据库恢复解析确认 running 只读调用可重试，UNKNOWN 写调用返回 PAUSE。
- Checkpoint 追加冲突测试确认 Run version/currentNode 整体回滚。
- TypeScript、Nest 构建和补丁格式检查通过。

### Findings

- Checkpoint 与 Run 游标必须共用事务，否则可能出现“游标已推进但快照未写入”。
- running/unknown 的有副作用 ToolCall 不能直接重放，应返回需要人工或外部解析的暂停决策。
- 已完成 ToolCall 不属于 incomplete 查询，恢复解析还需读取全部工具调用以提供结果复用集合。
- Run 已持久化为 WAITING/PAUSED 时，即使没有待处理中断记录，也不能被重启流程自动恢复为运行。
- UNKNOWN 的只读调用没有副作用，可安全重试；UNKNOWN 的写入、删除或外部通信必须先解析。

### Next

- RUNTIME-103 已完成；RUNTIME-104/105 可将路由和执行节点接到 `RuntimeCheckpointService`，RUNTIME-107 再实现未知副作用的外部查询与结果复用。
