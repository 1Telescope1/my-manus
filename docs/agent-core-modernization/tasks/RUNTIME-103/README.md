# RUNTIME-103 — 支持进程重启后继续执行

> 本目录是该任务的独立工作记录。总体设计以 [SDD](../../../agent-core-modernization-sdd.md) 为准，总体状态以 [TASKS.md](../../TASKS.md) 为准。

| 字段 | 值 |
| --- | --- |
| Workstream | `Runtime` |
| Status | `done` |
| Dependencies | `RUNTIME-102` |
| Started | `2026-07-17` |
| Last Updated | `2026-07-17` |
| Working Session | `Codex：执行 RUNTIME-103` |

## Intent

在 RUNTIME-102 的持久化基础上建立明确的 Checkpoint 提交边界和恢复解析流程，使新 Runtime 在进程中断后能从精确下一节点继续，并延续事件序号。

## Scope

### In scope

- 定义路由、模型、步骤、工具、中断、Handoff 和终态的 Checkpoint 边界。
- 在同一 UnitOfWork 中原子提交 Run 游标/version 与 Checkpoint。
- 实现恢复解析器，重建恢复节点、状态和事件序号。
- 分类可复用、可安全重试和状态不确定的 ToolCall。
- 未知副作用或待审批操作返回 PAUSE，禁止盲目重放。
- 用故障注入覆盖模型调用前后、工具结果持久化前后和等待状态。

### Out of scope

- 查询外部系统确认未知副作用及自动复用外部结果；这些属于 RUNTIME-107。
- Working Context、Skill 和 Artifact 的完整重建；这些属于 MEMORY-104。
- 将恢复流程接入当前 legacy AgentTaskRunner 和运行模式切换；这些属于 RUNTIME-108。
- AbortSignal 取消传播；这属于 RUNTIME-106。

## Acceptance Checklist

- [x] 所有 SDD 必需位置拥有明确的 Checkpoint 边界类型。
- [x] Run 游标/version 与 Checkpoint 在同一事务中提交，任一冲突整体回滚。
- [x] 恢复结果包含精确 `resumeNode`、`nextEventSequence` 和状态快照。
- [x] 已完成工具结果可复用；安全调用可重试；未知副作用进入 PAUSE。
- [x] 待用户输入和待审批中断分别恢复为 WAIT 与 PAUSE。
- [x] 模型调用前后和工具结果持久化后的故障注入从预期节点恢复。
- [x] 类型检查、测试和构建成功。
- [x] “改造前后对比”已填写，并说明实际影响。
- [x] [evidence.md](./evidence.md) 已填写。
- [x] 总任务清单和本目录工作记录已更新。

## 改造前后对比

| 对比项 | 改造前 | 完成后 | 实际影响 |
| --- | --- | --- | --- |
| Checkpoint 边界 | 已能持久化任意 Checkpoint，但调用方没有稳定名称表达路由、模型、步骤、工具、中断、Handoff 和终态边界。 | `RuntimeCheckpointBoundary` 为全部 SDD 必需位置提供稳定值，Checkpoint 状态同时记录实际边界。 | 后续执行路径可以统一落点，故障测试能精确说明崩溃发生在调用前还是调用后。 |
| 原子提交 | Run 游标/version 与 Checkpoint 需要调用方自行组合，遗漏事务会产生不一致。 | `RuntimeCheckpointService` 在一个 UnitOfWork 中执行 Run CAS 和 Checkpoint 追加，任何冲突均抛错并整体回滚。 | 不会出现 Run 已推进但恢复快照缺失，或快照存在但 Run version 未推进。 |
| 恢复游标 | 没有服务把最新 Checkpoint 转换成可调度的下一节点和事件水位。 | `RuntimeRecoveryService` 返回 `resumeNode`、`nextEventSequence`、状态快照及明确恢复动作。 | 重启后的执行器可直接从精确下一节点继续，事件 sequence 不从头开始。 |
| 工具恢复 | 仓储能查询工具调用，但没有区分结果复用、安全重试和未知副作用。 | completed 进入复用集合；pending 和 running/unknown 的只读调用可重试；running/unknown 的副作用调用进入未解析集合并 PAUSE。 | 已完成结果不会重复调用，无法确认的外部写操作也不会被盲目重放。 |
| 中断和终态 | 重启后需要调用方自行解释 WAITING、PAUSED、Interruption 和终态。 | 待输入返回 WAIT，待审批或持久 PAUSED 返回 PAUSE，终态返回 TERMINAL，无快照返回 NO_CHECKPOINT。 | 调度器不会在重启时意外越过用户输入、审批或终态边界。 |
| 实际接入状态 | legacy PlannerReActFlow 继续从进程内状态执行。 | 新恢复服务和边界已完成，但按任务划分尚未接入 legacy/v2 模式选择。 | 当前用户流程不变；RUNTIME-105 可调用边界，RUNTIME-108 再完成实际请求接线。 |

## Current State

- 当前进展：Checkpoint 边界、原子提交、恢复解析、工具分类和故障注入测试全部完成。
- 当前阻塞：无。
- 下一步：执行 RUNTIME-104 路由决策，再由 RUNTIME-105 的执行路径调用本任务提供的 Checkpoint 服务。

## Task Files

- [worklog.md](./worklog.md)：实施与验证过程。
- [evidence.md](./evidence.md)：验收项、故障注入结果和完成证据。

## Decisions and Risks

- 本任务提供新 Runtime 可直接调用的恢复协调能力，不提前修改 legacy 执行路径。
- `resumeNode` 始终表示精确下一节点；Checkpoint 不记录“刚完成的节点”。
- 对无法确认结果的副作用调用只返回 PAUSE；外部状态查询留给 RUNTIME-107。
- pending 工具尚未提交，可安全重试；running/unknown 的只读工具也可重试；只有有副作用的 running/unknown 调用要求外部解析。
- Checkpoint 状态暂按不透明 JSON 快照返回；完整上下文语义由 MEMORY-104 扩展。

## Latest Session State

- Current state: `done`，9 项专项故障/恢复测试、43 项全量合同测试和真实 PostgreSQL 集成测试通过。
- Remaining work: 无 RUNTIME-103 范围内工作。
- Blockers: 无。
- Recommended next action: 执行 RUNTIME-104 和 RUNTIME-105，让新执行路径实际调用 Checkpoint 边界。
