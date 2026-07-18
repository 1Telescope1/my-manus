# RUNTIME-101 — 建立可持久化的运行语义

> 本目录是该任务的独立工作记录。总体设计以 [SDD](../../../agent-core-modernization-sdd.md) 为准，总体状态以 [TASKS.md](../../TASKS.md) 为准。

| 字段 | 值 |
| --- | --- |
| Workstream | `Runtime` |
| Status | `done` |
| Dependencies | — |
| Started | `2026-07-17` |
| Last Updated | `2026-07-18` |
| Working Session | `Codex：开始执行 RUNTIME-101` |

## Intent

建立与 Session 对话数据分离的运行领域语义，为后续持久化、恢复、取消和副作用去重提供稳定边界。

## 本任务做了什么

### 一句话说明

> 为一次 Agent 执行建立统一的领域模型和状态规则，让“任务现在处于什么状态、能否继续变化”成为代码可以严格判断的事实。

### 为什么需要这个任务

改造前，执行进度主要存在于 `PlannerReActFlow` 的进程内状态、消息和 Session JSON 中。系统能运行任务，但没有一个独立对象完整表达“这是哪次运行、现在执行到哪一步、工具是否已经调用、为什么暂停、崩溃后从哪里继续”。不同模块如果各自判断状态，很容易出现非法跳转、取消被误认为已经完成、工具结果无法复用等问题。

RUNTIME-101 先不考虑数据库和执行器，而是从问题本质出发，定义一套所有后续模块都必须遵守的运行语言。

### 五类核心对象

| 对象 | 负责什么 | 例子 |
| --- | --- | --- |
| `AgentRun` | 一次完整 Agent 任务的聚合根，保存路径、状态、游标和版本 | 用户发起“调研市场”后创建一个 Run |
| `RunStep` | Run 内一个可重试的模型、工具、Workflow 或 Handoff 步骤 | “搜索资料”是一个 Tool Step |
| `ToolCallRecord` | 记录一次工具请求、风险、幂等键、执行状态和结果 | `send_email` 是否已经发送成功 |
| `Checkpoint` | 记录重启后应执行的下一节点、状态快照和事件水位 | 从 `planner.apply_result` 继续 |
| `Interruption` | 记录等待用户输入或等待审批的原因和处理结果 | 删除文件前等待用户批准 |

### Run 状态怎样变化

```text
CREATED
  ↓ 开始执行
RUNNING
  ├─→ WAITING ──用户补充输入──→ RUNNING
  ├─→ PAUSED  ──审批或风险解除→ RUNNING
  ├─→ COMPLETED
  ├─→ FAILED
  └─→ CANCELLED
```

状态机只允许 SDD 中定义的转换。例如 `RUNNING → WAITING` 合法，但 `COMPLETED → RUNNING`、状态自环和跨级跳转都会被拒绝。进入 `FAILED` 必须携带错误；进入 `CANCELLED` 必须先有取消请求和执行器确认，避免“用户点了停止”就被错误记录为所有后台操作都已停止。

### 一个完整例子

用户要求“搜索资料并发送邮件”时，可以形成以下运行记录：

```text
AgentRun：整个任务正在 RUNNING
  ↓
RunStep 1：搜索资料
  ↓
ToolCallRecord：search 已完成，结果已保存
  ↓
RunStep 2：发送邮件
  ↓
Interruption：等待用户批准外部通信
  ↓
Checkpoint：批准后从 send_email 节点继续
```

这些对象让系统不再依赖聊天文本推断执行事实，也为并发更新、崩溃恢复和工具幂等提供统一接口。

### 保护规则和当前边界

- Run 更新接口要求 `expectedVersion`，为后续数据库 CAS 提供明确契约。
- 工具占用使用幂等键和请求指纹，防止同一个键被不同请求错误复用。
- Checkpoint 明确区分重复提交、内容冲突、序号跳跃和事件水位回退。
- 本任务只完成领域类型、状态机和仓储端口；数据库表属于 RUNTIME-102，恢复协调属于 RUNTIME-103，实际请求接线属于 RUNTIME-108。

## Scope

### In scope

- 定义 AgentRun、RunStep、ToolCallRecord、Checkpoint 和 Interruption 领域类型及其状态。
- 实现 SDD 约定的 AgentRun 状态机，显式拒绝非法、自环和终态外跳转换。
- 定义支持版本条件更新、检查点恢复和工具调用复用的领域仓储端口。
- 用自动化测试覆盖合法与非法状态转换以及关键生命周期字段。

### Out of scope

- Prisma 模型、数据库迁移、仓储实现和 UnitOfWork 接线；这些属于 RUNTIME-102。
- Checkpoint 写入时机和进程恢复执行器；这些属于 RUNTIME-103。
- 真实取消传播和副作用幂等执行；这些分别属于 RUNTIME-106、RUNTIME-107。
- 将新 Runtime 接入现有 AgentTaskRunner；这属于 RUNTIME-108。

## Acceptance Checklist

- [x] 五类运行实体及其状态类型已定义。
- [x] SDD 中所有合法 AgentRun 状态边均有测试。
- [x] 自环、跳态、逆向转换和终态外跳均被拒绝。
- [x] 状态转换正确维护 startedAt、completedAt 和 error，持久化 version 只由条件更新递增。
- [x] 仓储端口显式表达 expectedVersion 冲突、恢复查询和幂等调用查询。
- [x] 类型检查、测试和构建成功。
- [x] “本任务做了什么”已详细说明背景、核心对象、状态流程、例子和接入边界。
- [x] “改造前后对比”已填写，并说明实际影响。
- [x] [evidence.md](./evidence.md) 已填写。
- [x] 总任务清单和本目录工作记录已更新。

## 改造前后对比

| 对比项 | 改造前 | 完成后 | 实际影响 |
| --- | --- | --- | --- |
| 运行实体 | 执行游标和工具调用主要存在于进程内，Session JSON 同时承担对话与部分执行信息。 | AgentRun、RunStep、ToolCallRecord、Checkpoint、Interruption 拥有独立、只读的领域类型和固定初始状态。 | 后续可以将执行状态落到独立表，不再依赖聊天消息推断运行进度。 |
| Run 状态转换 | 没有统一 Run 状态机，调用方无法判断等待、暂停、失败和取消之间的合法关系。 | 11 条合法边由纯函数集中控制；所有自环、跳态、逆向和终态外跳均抛出明确领域错误。 | 执行器和仓储实现可以共享同一套状态规则，非法状态不会被当成正常流程继续。 |
| 失败与取消 | 取消请求和实际终止没有领域边界，失败原因和取消确认可能缺失。 | FAILED 强制非空错误；CANCELLED 强制先记录请求，再记录 confirmed 或带未知操作列表的 timed_out 确认。 | UI 停止请求不会被误记为已经安全终止，恢复和诊断能区分真实结果。 |
| 恢复游标 | 没有明确的下一恢复节点或事件序号水位。 | Checkpoint 明确 `resumeNode`、逐次递增的 `sequence` 和 `nextEventSequence`。 | RUNTIME-103 可以从精确节点恢复，同时延续 Runtime Event 序号。 |
| 并发与幂等端口 | 没有 Run 乐观锁、原子工具占用或 Checkpoint 冲突语义。 | 仓储端口定义 expectedVersion CAS、子状态 CAS、reserve-or-get、请求指纹、Checkpoint 内容/序号/水位冲突以及 UoW 原子边界。 | RUNTIME-102/107 有明确的数据库实现契约，避免静默覆盖和错误复用副作用结果。 |
| 实际接入状态 | 现有请求使用 legacy PlannerReActFlow。 | 领域模型和端口已经完成，但没有提前增加 Prisma 表或接入执行器。 | 当前用户流程不变；持久化由 RUNTIME-102、恢复由 RUNTIME-103、执行接线由 RUNTIME-108 继续完成。 |

## Current State

- 当前进展：领域模型、状态机、仓储端口、设计澄清和验收测试全部完成。
- 当前阻塞：无。
- 下一步：执行已转为 `ready` 的 RUNTIME-102，实现 Prisma 模型、迁移、仓储和 UnitOfWork 接线。

## Task Files

- [worklog.md](./worklog.md)：按时间追加工作过程，保留历史。
- [evidence.md](./evidence.md)：验收项、测试结果和完成证据。

## Decisions and Risks

- 领域层保持基础设施无关，不依赖 Prisma 或模型厂商类型。
- AgentRun 是乐观版本控制的聚合根；数据库实现与事务接线留给 RUNTIME-102。
- RunStep 不复用 legacy Plan 的 Step，避免把运行游标与 UI 展示模型重新耦合。
- 状态转换使用调用方显式时间，保证相同输入得到相同结果；持久化版本只在仓储 CAS 成功后递增。
- ToolCall 的请求指纹与 Checkpoint 的冲突结果是端口契约，唯一索引和事务行为仍需 RUNTIME-102 用集成测试证明。

## Latest Session State

- Current state: `done`，11 项专项测试和 27 项全量契约测试通过，两轮复审无阻断项。
- Remaining work: 无 RUNTIME-101 范围内工作。
- Blockers: 无。
- Recommended next action: 开始 RUNTIME-102，把当前端口实现为独立持久化模型和事务仓储。
