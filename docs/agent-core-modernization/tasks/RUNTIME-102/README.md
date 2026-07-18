# RUNTIME-102 — 将运行状态从 Session JSON 中分离

> 本目录是该任务的独立工作记录。总体设计以 [SDD](../../../agent-core-modernization-sdd.md) 为准，总体状态以 [TASKS.md](../../TASKS.md) 为准。

| 字段 | 值 |
| --- | --- |
| Workstream | `Runtime` |
| Status | `done` |
| Dependencies | `RUNTIME-101` |
| Started | `2026-07-17` |
| Last Updated | `2026-07-18` |
| Working Session | `Codex：执行 RUNTIME-102` |

## Intent

将 RUNTIME-101 定义的运行聚合落到独立 PostgreSQL 模型和仓储中，使运行状态不再依赖 Session JSON，并为恢复、取消和幂等副作用提供可查询的持久化基础。

## 本任务做了什么

### 一句话说明

> 把 RUNTIME-101 定义的运行状态真正保存到 PostgreSQL，并保证并发更新、工具幂等和 Checkpoint 追加不会互相覆盖。

### 为什么需要这个任务

RUNTIME-101 只定义了“正确的运行状态应该长什么样”，数据仍然可能只存在于内存。进程一旦退出，Run 当前节点、工具调用结果和等待原因都会消失；多个进程同时推进同一个 Run 时，也没有数据库约束阻止迟到写入覆盖新状态。

RUNTIME-102 的目标是让运行事实脱离 Session JSON，成为可以独立查询、事务提交和回滚的数据。

### 五张运行表

| 数据表 | 保存内容 | 关键约束 |
| --- | --- | --- |
| `agent_runs` | Run 路径、状态、当前节点、version 和生命周期时间 | ID 唯一，version 用于 CAS |
| `run_steps` | 每个步骤的类型、状态、attempt、输入和输出 | Run 内 step key 与 attempt 唯一 |
| `tool_call_records` | 工具参数、风险、幂等键、指纹、结果和状态 | `(run_id, idempotency_key)` 唯一 |
| `checkpoints` | 恢复节点、Checkpoint 序号、事件水位和状态快照 | `(run_id, sequence)` 唯一且只追加 |
| `interruptions` | 用户输入或审批请求及其解决结果 | 可查询 pending 中断 |

领域对象通过 Mapper 转换成 Prisma 记录，再由 `AgentRunRepository` 提供创建、查询、条件更新和冲突结果；`DbUnitOfWork` 保证同一业务操作使用同一个 Prisma 事务。

### 一次写入怎样完成

```text
领域服务提交 AgentRun
  ↓
DbUnitOfWork 开启事务
  ↓
Repository 检查状态和 expectedVersion
  ↓
Mapper 转换领域对象与 Prisma 数据
  ↓
PostgreSQL 执行条件更新或插入
  ↓
成功：提交事务
失败：回滚事务并返回明确冲突结果
```

### Run CAS 例子

假设进程 A 和进程 B 同时读到：

```text
Run.version = 3
```

两者更新时都要求数据库仍然是 `version = 3`：

```text
进程 A：更新成功，version 变成 4
进程 B：影响 0 行，返回 version_conflict
```

这样 B 不会用旧数据覆盖 A 的结果。类似地，相同工具幂等键和相同请求指纹会复用已有记录；同一个键对应不同指纹则返回 `key_conflict`，不会误把另一请求的结果当成自己的结果。

### Checkpoint 和事务保护

- Checkpoint 首个序号必须是 `0`，后续严格 `+1`，不能跳号。
- `nextEventSequence` 不能倒退，避免恢复后重新发送旧事件。
- 同序号、相同内容属于幂等重试；同序号、不同内容属于冲突。
- Run 更新和子记录写入可以放在同一个 UnitOfWork 中，回调抛错时全部回滚。
- 提供前向迁移和 `rollback.sql`，撤销运行表时不会删除原有 `sessions`。

### 当前接入边界

数据库结构、仓储和事务能力已经可用，但 legacy `AgentTaskRunner` 还没有自动创建这些运行记录。Checkpoint 写入和恢复判断由 RUNTIME-103 完成，真正接入用户请求仍需要 RUNTIME-108。

## Scope

### In scope

- 为 AgentRun、RunStep、ToolCallRecord、Checkpoint、Interruption 增加 Prisma 模型、约束和索引。
- 提供前向迁移及显式回滚 SQL。
- 实现领域模型与 Prisma 记录之间的校验映射。
- 完整实现 `AgentRunRepository`，包括乐观锁、状态条件更新、工具原子占用和 Checkpoint 冲突语义。
- 将仓储接入依赖注入和 UnitOfWork 事务。
- 验证创建、查询、更新、并发冲突、事务回滚和迁移回滚。

### Out of scope

- 在执行器节点自动写入 Checkpoint 和进程恢复解析；这些属于 RUNTIME-103。
- 实现新的执行路径和路由；这些属于 RUNTIME-104、RUNTIME-105。
- AbortSignal 传播和真实取消；这些属于 RUNTIME-106。
- 外部副作用查询与已完成结果复用流程；这些属于 RUNTIME-107。
- 将 v2 Runtime 接入 AgentTaskRunner；这属于 RUNTIME-108。

## Acceptance Checklist

- [x] 五类运行记录拥有独立 Prisma 模型、关系、唯一约束和查询索引。
- [x] 前向迁移与回滚 SQL 完整且顺序安全。
- [x] AgentRun 可创建、按 ID/Session 查询和更新。
- [x] AgentRun 更新使用 expectedVersion，成功递增版本，并显式拒绝并发覆盖。
- [x] 子状态更新、工具幂等占用和 Checkpoint 追加符合 RUNTIME-101 端口契约。
- [x] AgentRunRepository 已接入依赖注入和 UnitOfWork 事务。
- [x] 类型检查、测试和构建成功。
- [x] “本任务做了什么”已详细说明数据表、写入流程、CAS 例子和事务边界。
- [x] “改造前后对比”已填写，并说明实际影响。
- [x] [evidence.md](./evidence.md) 已填写。
- [x] 总任务清单和本目录工作记录已更新。

## 改造前后对比

| 对比项 | 改造前 | 完成后 | 实际影响 |
| --- | --- | --- | --- |
| 运行记录 | Run、步骤、工具调用、检查点和中断没有独立数据库模型，只能依赖进程内状态或 Session JSON。 | 五类记录分别落入 `agent_runs`、`run_steps`、`tool_call_records`、`checkpoints`、`interruptions`，通过外键和级联删除组成持久化聚合。 | 恢复、诊断和后续执行器可以按 Run 查询精确状态，不必从聊天数据反推执行进度。 |
| 并发更新 | 没有数据库级 Run 版本条件更新，迟到写入可能覆盖更新后的状态。 | `AgentRunRepository.update` 同时匹配 ID、状态和 `expectedVersion`，成功原子递增版本；真实 PostgreSQL 并发测试证明两个写者仅一个成功。 | 并发调度和重试会收到明确 `version_conflict`，不会静默丢失更新。 |
| 副作用幂等 | 工具调用没有独立唯一键和请求身份校验。 | `(run_id, idempotency_key)` 唯一约束配合原子 reserve-or-get；相同指纹复用记录，不同指纹返回 `key_conflict`。 | RUNTIME-107 可以在该基础上安全复用结果或解析未知副作用。 |
| 恢复游标 | Checkpoint 只存在于领域契约，没有数据库追加规则。 | `(run_id, sequence)` 唯一约束、连续序号和事件水位校验共同实现只追加检查点。 | RUNTIME-103 可以查询最新检查点，并区分重复提交、内容冲突、跳号和事件回退。 |
| 事务边界 | UnitOfWork 只暴露 Session/File 仓储。 | 根 UoW 和事务 UoW 均暴露 `AgentRunRepository`，同一回调内共享 Prisma 事务客户端。 | Run CAS 与子记录写入可原子提交；集成测试确认回调抛错后新增 Run 不存在。 |
| 迁移与兼容 | 无运行表，也无独立回滚路径。 | 提供前向迁移和按依赖逆序删除五张运行表的 `rollback.sql`；真实数据库验证回滚后 `sessions` 仍保留。 | 可单独部署或撤销新持久化结构；legacy Session/SSE 执行路径未被接线或改变。 |

## Current State

- 当前进展：Prisma 模型、迁移、严格映射器、完整仓储、DI/UoW 接线和真实 PostgreSQL 验收全部完成。
- 当前阻塞：无。
- 下一步：执行 RUNTIME-103，在约定节点写入 Checkpoint 并实现恢复解析器。

## Task Files

- [worklog.md](./worklog.md)：实施与验证过程。
- [evidence.md](./evidence.md)：验收项、测试结果和完成证据。

## Decisions and Risks

- 数据库存储继续使用 RUNTIME-101 约定的小写字符串状态，领域映射负责拒绝未知值。
- Run CAS 与子记录写入的真正原子组合由 UnitOfWork 事务保证。
- nullable JSON 使用 SQL `NULL` 表示领域 `null`，非空 JSON 进入数据库前必须可序列化。
- 工具幂等占用与 Checkpoint 追加使用唯一索引加 `createMany(skipDuplicates)`，避免唯一冲突使 PostgreSQL 事务进入失败状态。
- 本任务不改变当前 legacy Session/SSE 执行路径。

## Latest Session State

- Current state: `done`，34 项契约测试和 1 项真实 PostgreSQL 集成测试通过。
- Remaining work: 无 RUNTIME-102 范围内工作。
- Blockers: 无。
- Recommended next action: 开始 RUNTIME-103，接入 Checkpoint 写入时机和进程恢复。
