# RUNTIME-102 Evidence

## Acceptance Results

| 验收项 | 状态 | 证据 |
| --- | --- | --- |
| Prisma 模型与迁移 | Pass | 五张独立运行表已定义；外键、级联删除、两个业务唯一约束和所需查询索引均由 schema 与迁移覆盖。 |
| Run 创建、查询和更新 | Pass | 真实 PostgreSQL 测试覆盖创建、按 ID 查询、按 Session 查询和 expectedVersion 更新。 |
| 乐观并发控制 | Pass | 两个并发写者同时提交版本 0，实际结果为 1 个 `updated`、1 个 `version_conflict`，最终版本为 1。 |
| 子记录与恢复查询 | Pass | Step 状态 CAS、ToolCall reserve-or-get/未完成查询、最新 Checkpoint、待处理 Interruption 均在真实数据库通过。 |
| UnitOfWork 事务 | Pass | 事务内创建 Run 后故意抛错；回调退出后该 Run 不存在。 |
| 迁移回滚 | Pass | `rollback.sql` 在真实数据库执行成功；五张运行表消失，既有 `sessions` 表保留。 |

## Verification Commands

| 命令或场景 | 结果 | 备注 |
| --- | --- | --- |
| `npm run test:contract`（`api/`） | Pass | 34 tests passed，0 failed；新增 7 项 RUNTIME-102 契约测试并保留全部既有回归。 |
| `npm run test:contract:typecheck`（`api/`） | Pass | 产品代码、契约测试和集成测试 TypeScript 检查成功。 |
| `npm run typecheck`（`api/`） | Pass | API 产品代码 TypeScript 检查成功。 |
| `npm run build`（`api/`） | Pass | NestJS 生产构建成功。 |
| `prisma validate`（`api/`） | Pass | PostgreSQL schema 合法。 |
| `npm run prisma:generate`（`api/`） | Pass | Prisma Client 6.19.3 生成成功。 |
| `prisma migrate deploy`（一次性 PostgreSQL 16） | Pass | 初始迁移与 RUNTIME-102 迁移均成功应用。 |
| `npm run test:integration:runtime`（一次性 PostgreSQL 16） | Pass | 1 test passed；覆盖真实 CRUD、并发、UoW 回滚、级联删除和迁移回滚。 |
| `git diff --check` | Pass | 无空白或补丁格式错误。 |

## Compatibility and Failure Cases

| 场景 | 预期 | 实际结果 |
| --- | --- | --- |
| 两个写者使用同一 expectedVersion | 仅一个成功，另一个返回 `version_conflict` | Pass，真实 PostgreSQL 并发验证。 |
| candidate.version 与 expectedVersion 不同 | 不写数据库并返回版本冲突 | Pass，仓储分支与契约测试覆盖。 |
| 非法 Run 状态变化 | 不写数据库并返回 `invalid_status_transition` | Pass，复用 RUNTIME-101 状态机。 |
| 相同幂等键、相同请求指纹 | 返回 `existing`，不创建第二条记录 | Pass，契约和真实数据库均验证。 |
| 相同幂等键、不同请求指纹 | 返回 `key_conflict` | Pass，契约和真实数据库均验证。 |
| Checkpoint 重复、内容冲突、跳号或事件水位回退 | 分别返回可区分结果 | Pass，专项契约测试覆盖所有分支。 |
| UnitOfWork 回调抛错 | Run 与同事务子写入全部回滚 | Pass，故意抛错后 Run 查询为空。 |
| 删除 Session | 五类运行记录级联删除 | Pass，真实数据库逐表计数均为 0。 |
| 回滚迁移 | 按依赖顺序删除五张运行表，不影响既有表 | Pass，运行表为空且 `sessions` 仍存在。 |
| legacy Session/SSE | 行为不变 | Pass，既有契约回归全部通过；本任务没有接入执行器。 |

## Completion Evidence

- 相关提交或 PR：未创建。
- 评测或运行报告：契约测试 34/34、真实 PostgreSQL 集成测试 1/1 通过。
- 未解决限制：Checkpoint 写入时机和真实恢复属于 RUNTIME-103；执行器接线属于 RUNTIME-108；本任务保留 legacy Session JSON 字段以确保兼容。
- 最终结论：`pass`，RUNTIME-102 验收条件全部满足。
