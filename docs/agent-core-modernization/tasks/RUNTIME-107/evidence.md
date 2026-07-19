# RUNTIME-107 验收证据

## 自动化验证

| 验证项 | 命令 | 结果 |
| --- | --- | --- |
| 生产类型检查 | `cd api && npm run typecheck` | 通过。 |
| 测试类型检查 | `cd api && npm run test:contract:typecheck` | 通过。 |
| RUNTIME-107 故障注入 | `cd api && node --import tsx --test test/contracts/runtime-idempotency.contract.test.ts` | 3/3 通过：跨实例结果复用、写后崩溃暂停、只读安全重试。 |
| Single Tool 稳定身份 | `cd api && node --import tsx --test test/contracts/runtime-executor.contract.test.ts` | 9/9 通过；同一 Run 重建后保持调用 ID 和幂等键稳定。 |
| 真实 Runtime 接线 | `cd api && node --import tsx --test test/contracts/runtime-wiring.contract.test.ts` | 5/5 通过；Single Tool 真实路径写入 COMPLETED ToolCall 和 TOOL Step。 |
| 完整契约测试 | `cd api && npm run test:contract` | 123/123 通过。 |
| 生产构建 | `cd api && npm run build` | 通过。 |
| PostgreSQL 集成测试 | `cd api && npm run test:integration:runtime` | 未执行到业务断言；环境缺少必需的 `DATABASE_URL`。 |
| Diff 格式检查 | `git diff --check` | 通过。 |

## Acceptance 对应证据

| Acceptance | 证据 |
| --- | --- |
| 已完成副作用跨实例复用，外部写不重复 | `副作用结果持久化后应跨服务实例复用，且同键不同请求必须冲突`：新建第二个 store/service 后 `replayed=true`，外部写计数保持 1。 |
| 不同请求不能复用同一键 | 同一故障注入契约用不同参数再次调用，返回 `idempotency_conflict`，外部写计数不增加。 |
| 提交后、结果落库前崩溃进入 UNKNOWN | `副作用发生后结果未持久化时，恢复必须标记 unknown、暂停 Run 且禁止重放` 在真实工具返回后让 `complete` 故障，断言恢复前为 RUNNING、恢复后为 UNKNOWN。 |
| UNKNOWN 使 Run PAUSED 且禁止重放 | 同一契约断言恢复计划为 `PAUSE/UNCERTAIN_SIDE_EFFECT`、Run 为 `PAUSED`；新实例调用返回 `uncertain_side_effect`，外部写计数仍为 1。 |
| 只读和未提交调用可安全恢复 | `只读调用崩溃后可由新实例重新打开并安全重试`；持久化 store 对 PENDING 允许新进程接管。 |
| Single Tool 恢复使用同一幂等键 | `Single Tool 默认调用 ID 在同一 Run 重建后应保持稳定`。 |

## 可复核代码路径

- 持久化幂等状态机：`api/src/domain/services/runtime/persistent-tool-idempotency.store.ts`
- 可靠调用生命周期：`api/src/domain/services/tools/tool-invocation.service.ts`
- Single Tool 稳定身份：`api/src/domain/services/runtime/executor.service.ts`
- Single Tool / Planned Agent 真实接线：`api/src/domain/services/runtime/agent-task-runner.ts`、`adapters.ts`、`agents/base-agent.ts`
- UNKNOWN 与 PAUSED 恢复收敛：`api/src/domain/services/runtime/recovery.service.ts`
- 故障注入契约：`api/test/contracts/runtime-idempotency.contract.test.ts`

## 已知验证边界

当前工作区没有 `DATABASE_URL`，因此未运行 PostgreSQL 集成测试。本任务没有修改 Prisma Schema、迁移或数据库仓储；所复用的唯一约束、reserve-or-get、状态条件更新和事务行为已由 `agent-run-persistence.contract.test.ts` 覆盖，新增的跨进程状态机由带事务回滚的内存契约仓储覆盖。

外部系统是否支持按幂等键查询已提交结果由具体适配器决定，当前没有统一查询端口；因此 UNKNOWN 副作用采用 fail-closed 的人工暂停语义，不声明绝对 exactly-once。
