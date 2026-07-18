# RUNTIME-101 Worklog

## 2026-07-17 — 建立运行领域模型和状态机

### Goal

- 完成 RUNTIME-101 的领域类型、状态转换、仓储端口和验收测试。

### Investigation

- 检查了 SDD 5.2、5.3、5.4、ADR-001、ADR-007 和 Runtime 后续任务边界。
- 当前 Session JSON 只保存对话事件和 Memory，没有独立 Run、Step、ToolCall、Checkpoint 或 Interruption 模型。
- RUNTIME-102 才负责 Prisma、迁移、仓储实现和乐观锁落库，本任务保持纯领域边界。

### Changes

| 文件 | 变更原因 |
| --- | --- |
| `docs/agent-core-modernization/TASKS.md` | 领取任务并标记为实施中。 |
| `docs/agent-core-modernization/tasks/RUNTIME-101/*` | 建立任务范围、日志和验收记录。 |
| `docs/agent-core-modernization-sdd.md` | 明确状态枚举、失败/取消不变量、Checkpoint 游标和仓储并发契约。 |
| `api/src/domain/models/agent-run.ts` | 定义五类运行实体、固定初始工厂、Run 状态机和取消请求/确认语义。 |
| `api/src/domain/repositories/agent-run.repository.ts` | 定义 Run CAS、子状态 CAS、工具原子占用、恢复查询和 Checkpoint 冲突端口。 |
| `api/test/contracts/agent-run.contract.test.ts` | 覆盖实体默认值、完整状态矩阵、生命周期不变量、取消/失败反例和仓储结果契约。 |

### Verification

- `npm run test:contract`：通过，27/27 tests passed，其中 11 项为 RUNTIME-101 专项测试。
- `npm run typecheck`：通过。
- `npm run build`：通过。
- `git diff --check`：通过。
- 两轮领域语义和仓储端口交叉复审：发现项均已修复，最终无阻断项。

### Findings

- SDD 明确规定 AgentRun 的 11 条合法状态边；其余转换均应拒绝。
- 仓储更新必须显式携带 expectedVersion 并区分版本冲突，才能支撑 RUNTIME-102 的并发验收。
- `cancelRequestedAt` 不能代表已停止；CANCELLED 还需要 confirmed 或 timed_out 确认。
- 幂等键本身不足以安全复用结果，还必须比较规范化请求指纹。
- Checkpoint 必须记录精确下一节点和下一事件序号，并拒绝同序号不同内容或事件水位回退。
- Run CAS 与子记录写入只有置于同一 UnitOfWork 事务，才能避免失败执行器留下孤立记录。

### Next

- RUNTIME-101 已完成；后续由 RUNTIME-102 落地 Prisma、迁移、唯一约束、CAS 和事务集成测试。
