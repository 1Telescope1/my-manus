# RUNTIME-101 Evidence

## Acceptance Results

| 验收项 | 状态 | 证据 |
| --- | --- | --- |
| 五类运行实体及状态类型 | Pass | `agent-run.ts` 定义 AgentRun、RunStep、ToolCallRecord、Checkpoint、Interruption 及其枚举；创建工厂只产生合法初态。 |
| 合法状态转换 | Pass | 专项测试逐条覆盖 SDD 的 11 条合法边，并验证 startedAt、completedAt、error 和 version 语义。 |
| 非法状态转换被拒绝 | Pass | 7×7 完整矩阵覆盖 38 条未定义转换；自环、跳态、逆向和所有终态外跳均抛出 `InvalidRunStatusTransitionError`，输入快照不变。 |
| 失败与取消不变量 | Pass | FAILED 必须有非空错误；CANCELLED 必须先请求并提供 confirmed，或提供含未知操作 ID 的 timed_out 确认。 |
| 仓储接口评审 | Pass | 端口显式区分 Run 版本/状态冲突、子状态冲突、工具键冲突、Checkpoint 序号/内容/事件水位冲突；两轮独立复审最终均无阻断项。 |
| 恢复所需查询和游标 | Pass | Checkpoint 使用 `resumeNode`、`sequence`、`nextEventSequence`；端口提供最新 Checkpoint、未完成 ToolCall、待处理中断和幂等键查询。 |

## Verification Commands

| 命令或场景 | 结果 | 备注 |
| --- | --- | --- |
| `npm run test:contract`（`api/`） | Pass | 27 tests passed，0 failed；包含 11 项 RUNTIME-101 测试和 16 项既有回归。 |
| `npm run test:contract:typecheck`（`api/`） | Pass | 产品代码与合同测试 TypeScript 检查成功。 |
| `npm run typecheck`（`api/`） | Pass | API 产品代码 TypeScript 检查成功。 |
| `npm run build`（`api/`） | Pass | NestJS 生产构建成功。 |
| `git diff --check` | Pass | 无空白或补丁格式错误。 |
| 领域语义复审 | Pass | 初审问题全部修复；最终复审无阻断项。 |
| 仓储端口复审 | Pass | 初审问题全部修复；最终复审无阻断项。 |

## Compatibility and Failure Cases

| 场景 | 预期 | 实际结果 |
| --- | --- | --- |
| 11 条合法 Run 转换 | 全部成功 | Pass。 |
| 38 条未定义 Run 转换 | 全部拒绝且不修改输入 | Pass。 |
| FAILED 缺少错误或仅有空白错误 | 拒绝 | Pass，类型与运行时双重约束。 |
| 未请求取消就进入 CANCELLED | 拒绝 | Pass。 |
| timed_out 未记录未知活动操作 | 拒绝 | Pass。 |
| 取消请求 | 只写 `cancelRequestedAt`，不直接进入终态 | Pass。 |
| 仓储版本或状态冲突 | 返回可区分的判别结果 | Pass，端口合同与类型测试覆盖；数据库行为留给 RUNTIME-102。 |
| 相同幂等键、不同请求指纹 | 返回 `key_conflict`，不得复用 | Pass，端口合同覆盖；唯一约束留给 RUNTIME-102。 |
| 同序号不同 Checkpoint 或事件水位回退 | 返回明确冲突 | Pass，端口合同覆盖；原子追加留给 RUNTIME-102/103。 |
| legacy Session/SSE | 行为不变 | Pass，16 项既有合同回归继续通过；本任务未接入执行器或修改 UI。 |

## Repository Interface Review

- AgentRun 更新要求 `expectedVersion`，成功原子递增一次并返回新快照；不存在、版本冲突和非法状态变化可区分。
- Step、ToolCall、Interruption 更新要求 expectedStatus，迟到写入不能静默覆盖新状态。
- ToolCall 按 `(runId, idempotencyKey)` 原子 reserve-or-get，并使用 `requestFingerprint` 区分合法重试与键冲突。
- Checkpoint 只追加，首个序号为 0，之后严格加 1；完全相同的重试、同序号内容冲突和事件水位回退分别建模。
- 同一次聚合变更中的 Run CAS 与子记录写入必须在一个 UnitOfWork 事务内提交；具体接线和并发集成测试属于 RUNTIME-102。

## Completion Evidence

- 相关提交或 PR：未创建。
- 评测或运行报告：`npm run test:contract` 本地运行 27/27 通过。
- 未解决限制：本任务只定义领域语义和端口；Prisma 表、迁移、唯一索引、CAS/事务实现属于 RUNTIME-102，恢复执行器属于 RUNTIME-103，真实取消和副作用复用分别属于 RUNTIME-106、RUNTIME-107。
- 最终结论：`pass`，RUNTIME-101 验收条件全部满足。
