# RUNTIME-103 — 支持进程重启后继续执行

> 本目录是该任务的独立工作记录。总体设计以 [SDD](../../../agent-core-modernization-sdd.md) 为准，总体状态以 [TASKS.md](../../TASKS.md) 为准。

| 字段 | 值 |
| --- | --- |
| Workstream | `Runtime` |
| Status | `done` |
| Dependencies | `RUNTIME-102` |
| Started | `2026-07-17` |
| Last Updated | `2026-07-18` |
| Working Session | `Codex：执行 RUNTIME-103` |

## Intent

在 RUNTIME-102 的持久化基础上建立明确的 Checkpoint 提交边界和恢复解析流程，使新 Runtime 在进程中断后能从精确下一节点继续，并延续事件序号。

## 本任务做了什么

### 一句话说明

> 为 Agent 执行增加可持久化的“书签”和恢复判断，让进程重启后从安全、精确的下一节点继续，而不是整段重跑。

### 为什么需要这个任务

RUNTIME-102 已经能保存 Run 和 Checkpoint，但调用方还不知道应该在哪些位置保存，也没有服务把数据库记录转换成恢复动作。如果模型已经完成却仍从模型调用前重跑，会重复产生费用；如果发送邮件后状态不确定却直接重试，可能产生两封邮件。

RUNTIME-103 因此解决两个问题：怎样原子保存一个可信恢复点，以及重启后怎样判断“继续、等待、暂停还是结束”。

### Checkpoint 保存什么

| 字段 | 含义 | 例子 |
| --- | --- | --- |
| `sequence` | Run 内从 0 开始递增的书签序号 | 第 2 个 Checkpoint 为 `1` |
| `resumeNode` | 重启后要执行的精确下一节点 | `planner.apply_result` |
| `nextEventSequence` | 恢复后下一条 Runtime Event 序号 | 前端已收到 0～6，下一条为 7 |
| `state` | 继续执行需要的状态快照 | 模型输出、工具调用 ID |
| `state.checkpointBoundary` | 崩溃前完成到了哪个语义边界 | `model_completed` |

`checkpointBoundary` 回答“刚完成了什么”，`resumeNode` 回答“下一步执行什么”。例如模型完成后，边界是 `MODEL_COMPLETED`，但恢复节点是 `planner.apply_result`，所以不会重新调用模型。

### Checkpoint 提交流程

```text
执行器到达关键边界
  ↓
读取最新 Checkpoint，计算新 sequence
  ↓
用 expectedVersion CAS 更新 Run 游标和 version
  ↓
追加新的 Checkpoint
  ↓
两步都成功：提交事务
任意一步冲突：整体回滚
```

这保证不会出现“Run 已经向前推进，但对应书签没有保存”，也不会出现“书签存在，但 Run version 没有变化”。

### 重启后的判断顺序

```text
读取 AgentRun
  ↓
终态？────────────→ TERMINAL
  ↓ 否
有不确定副作用？──→ PAUSE
  ↓ 否
待审批？──────────→ PAUSE
  ↓ 否
待用户输入？──────→ WAIT
  ↓ 否
没有 Checkpoint？─→ NO_CHECKPOINT
  ↓ 否
从最新 resumeNode → RESUME
```

| 工具现场 | 恢复处理 | 原因 |
| --- | --- | --- |
| `COMPLETED` | 复用已保存结果 | 避免重复调用 |
| `PENDING` | 可以重试 | 工具尚未提交 |
| `READ + RUNNING/UNKNOWN` | 可以重试 | 只读操作没有外部副作用 |
| 写入、删除、外部通信处于 `RUNNING/UNKNOWN` | `PAUSE` | 无法确认副作用是否已经发生 |

### 两个崩溃例子

模型调用前保存：

```text
boundary = MODEL_CALLING
resumeNode = planner.invoke_model
```

此时崩溃，重启后需要调用模型。模型完成并保存输出后：

```text
boundary = MODEL_COMPLETED
resumeNode = planner.apply_result
state.modelOutput = 已保存的模型结果
```

此时崩溃，重启后直接处理已有输出。对于 `send_email`，如果外部请求已经发出但结果没有确认，恢复服务返回 `PAUSE`，不会冒险再次发送。

### 当前接入边界

Checkpoint 边界、原子提交和恢复解析器已经实现并通过故障注入测试，但当前 legacy `AgentTaskRunner` 还没有调用它们。新执行路径由 RUNTIME-105 使用这些能力，实际请求接线属于 RUNTIME-108；外部副作用确认属于 RUNTIME-107。

### 后续精简

恢复解析器原先在审批、用户输入、Run 暂停、Run 等待、缺少 Checkpoint、未知副作用和正常恢复七个分支中，重复展开相同的 Checkpoint、工具分类、中断集合和 Run。现在这些共享现场只组装一次，局部计划工厂只接收 `disposition` 和 `reason`，使每个分支只表达自己的恢复决策。

这不是把恢复规则合并成模糊的默认行为：未知副作用仍然具有最高优先级，之后依次处理审批、用户输入、持久化 PAUSED/WAITING、缺少 Checkpoint，最后才允许 RESUME。Run 从 RUNNING 转为 PAUSED 的 CAS 更新也保持原样。

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
- [x] “本任务做了什么”已详细说明 Checkpoint 字段、提交与恢复流程、工具分类和崩溃例子。
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
- 恢复现场统一组装，但动作优先级继续由显式分支表达，不使用会掩盖安全顺序的通用规则表。

## Latest Session State

- Current state: `done`，9 项专项故障/恢复测试、43 项全量契约测试和真实 PostgreSQL 集成测试通过。
- Remaining work: 无 RUNTIME-103 范围内工作。
- Blockers: 无。
- Recommended next action: 执行 RUNTIME-104 和 RUNTIME-105，让新执行路径实际调用 Checkpoint 边界。
