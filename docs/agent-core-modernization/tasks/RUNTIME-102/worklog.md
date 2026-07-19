# RUNTIME-102 Worklog

## 2026-07-17 — 落地运行状态持久化

### Goal

- 完成五类运行记录的数据库模型、仓储实现、事务接线和并发验证。

### Investigation

- 当前 Prisma 只有 Session 和 File；Session 的 events、files、memories 仍为 JSON 字段。
- 现有 DbUnitOfWork 已支持 Prisma 交互式事务，但尚未暴露 AgentRunRepository。
- RUNTIME-101 已定义 Run CAS、子状态 CAS、工具 reserve-or-get 和 Checkpoint 冲突契约。

### Changes

| 文件 | 变更原因 |
| --- | --- |
| `docs/agent-core-modernization/TASKS.md` | 领取任务并标记为实施中。 |
| `docs/agent-core-modernization/tasks/RUNTIME-102/*` | 建立任务范围、日志和证据记录。 |
| `api/prisma/schema.prisma` | 增加五类运行记录、关系、级联策略、唯一约束和查询索引。 |
| `api/prisma/migrations/20260717000000_runtime_persistence/*` | 提供可部署的前向迁移和显式回滚 SQL。 |
| `api/src/infrastructure/prisma/agent-run.mapper.ts` | 在数据库字符串/JSON/时间字段和领域快照之间做严格校验映射。 |
| `api/src/infrastructure/repositories/db-agent-run.repository.ts` | 实现完整仓储端口、Run CAS、子状态 CAS、工具原子占用和 Checkpoint 冲突语义。 |
| `api/src/domain/repositories/unit-of-work.ts`、`api/src/infrastructure/repositories/db-uow.ts` | 将 AgentRunRepository 纳入根 UoW 和事务 UoW。 |
| `api/src/interfaces/repository-dependencies.ts` | 注册数据库仓储及领域端口映射。 |
| `api/test/contracts/agent-run-persistence.contract.test.ts` | 覆盖映射、并发 CAS、工具幂等、Checkpoint 和迁移结构。 |
| `api/test/integration/agent-run-persistence.integration.test.ts` | 在真实 PostgreSQL 上覆盖 CRUD、并发、事务回滚、级联删除和迁移回滚。 |
| `api/package.json` | 增加可重复运行的 Runtime 持久化集成测试命令。 |

### Verification

- Prisma schema 校验和 Client 生成成功。
- `npm run test:contract`：34/34 通过，包含 7 项新增持久化契约测试和全部既有回归。
- `npm run test:integration:runtime`：1/1 通过；使用一次性 PostgreSQL 16 容器。
- 真实并发场景中两个相同 `expectedVersion=0` 的更新只有一个 `updated`，另一个返回 `version_conflict`。
- UnitOfWork 内创建 Run 后故意抛错，事务结束后查询不到该 Run。
- 回滚 SQL 删除五张运行表后，`to_regclass('public.agent_runs')` 为空而 `sessions` 仍存在。
- `npm run build` 和产品/测试 TypeScript 检查成功。

### Findings

- 工具幂等占用应使用数据库唯一约束和无异常的原子插入，避免事务因唯一冲突进入失败状态。
- 迁移回滚必须先删除子表，再删除 AgentRun 表。
- Prisma nullable JSON 必须区分 SQL `NULL` 与 JSON `null`；映射器统一使用 `Prisma.DbNull` 写入领域空值。
- Checkpoint 的完全相同重试需要比较 ID、序号、恢复节点、事件水位、状态和创建时间；同序号不同内容必须报告冲突。
- 运行状态使用字符串列而非数据库 enum，保留后续状态扩展能力，同时由映射器拒绝未知值。

### Next

- RUNTIME-102 已完成；RUNTIME-103 可直接使用最新 Checkpoint、未完成 ToolCall 和待处理 Interruption 查询实现恢复解析。

## 2026-07-19 — 持久化实现精简

- Mapper 从 Prisma 生成类型派生普通字段，仅对 JSON 边界保留 `unknown`。
- Repository 直接依赖最小 Prisma 客户端接口，删除 union、getter 和双重断言。
- UnitOfWork 删除“记录日志后原样抛出”的重复异常层，事务回滚继续由 Prisma 保证。
- Checkpoint 完全相同重试改为完整快照深比较，不再手工逐字段维护。
- 持久化专项、全量契约 159/159、测试类型检查和生产构建通过。
