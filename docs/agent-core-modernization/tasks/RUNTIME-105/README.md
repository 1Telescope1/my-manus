# RUNTIME-105 — 提供多种执行路径

> 本目录是该任务的独立工作记录。总体设计以 [SDD](../../../agent-core-modernization-sdd.md) 为准，总体状态以 [TASKS.md](../../TASKS.md) 为准。

| 字段 | 值 |
| --- | --- |
| Workstream | `Runtime` |
| Status | `done` |
| Dependencies | `RUNTIME-101, RUNTIME-104` |
| Started | `2026-07-18` |
| Last Updated | `2026-07-18` |
| Working Session | `Codex：执行 runtime-105` |

## Intent

把已经确定的 `RouteDecision` 转换为可执行路径，让 Direct、Single Tool、Workflow 和 Planned Agent 使用同一执行器边界并产生统一 `RuntimeEvent`，同时不提前接入真实 Session 流程。

## 实施前证据表

| 确定结论 | 证据路径 | 不确定项 | 建议改动范围 |
| --- | --- | --- | --- |
| 四类 `RouteKind` 和严格 `RouteDecision` 已存在 | `api/src/domain/models/agent-run.ts`、`api/src/domain/models/route-decision.ts` | 无 | 复用现有领域模型，不重复定义 |
| 统一 `RuntimeEvent` 和事件适配器已存在 | `api/src/domain/models/runtime-event.ts`、`api/src/application/services/runtime-event.adapter.ts` | 尚无统一事件生产器 | 在执行器层集中分配事件基础字段和 sequence |
| Router 只做无副作用决策 | `api/src/domain/services/runtime/router.service.ts`、`RUNTIME-104` 任务证据 | 无 | Dispatcher 只消费已校验的决策 |
| Tool Registry 与统一可靠调用策略尚未实现 | `TASKS.md` 中 `TOOL-101`、`TOOL-103` | 具体工具发现、重试、审批由后续任务决定 | 本任务定义注入端口并约束 Single Tool 只调用一次 |
| 真实请求切换属于 `RUNTIME-108` | SDD 10.2、`RUNTIME-104` 当前边界 | 无 | 不修改 legacy `AgentTaskRunner`、Session API 或 UI |

## 本任务做了什么

### 一句话说明

> 把 Router 的四种决策变成四条真正可运行的路径，并让它们无论如何执行，都用同一种事件语言报告过程和结果。

### 为什么需要这个任务

RUNTIME-104 已经能判断请求应该走 `direct`、`single_tool`、`workflow` 还是 `planned_agent`，但判断结果此前没有对应执行入口。若各路径各自生成 ID、sequence 和终态，兼容层会面对四套行为；若直接复用 legacy Planner，简单请求仍无法获得更轻的执行方式。

本任务建立一层供应商中立的执行边界：路径负责最小编排，具体模型、工具、Workflow 和 Planned Agent 由注入端口实现；统一基类负责输入保护、事件 envelope、等待、成功和失败语义。

### 核心对象和四条路径

| 对象或路径 | 职责 | 例子 |
| --- | --- | --- |
| `RuntimeExecutionRequest` | 携带 `AgentRun`、严格 `RouteDecision`、用户消息、恢复后的事件水位和元数据 | 从 Checkpoint 恢复时传入 `nextEventSequence: 7` |
| `RuntimeExecutor` | 四条路径共用的异步事件流接口 | 调用方只消费 `AsyncIterable<RuntimeEvent>`，不关心内部能力 |
| `DirectRuntimeExecutor` | 不获得工具端口，只调用一次文本回答能力 | “解释什么是 CAS”产生 `message.created → run.completed` |
| `SingleToolRuntimeExecutor` | 固定执行 select、一次 invoke、summarize | 天气查询产生 calling、called、message、completed 四个事件 |
| `WorkflowRuntimeExecutor` | 执行 `RouteDecision.workflowName` 指定的代码流程 | `daily-report` Workflow 产生标题和报告消息 |
| `PlannedAgentRuntimeExecutor` | 承载计划、步骤、工具循环和总结事件 | 研究任务产生 plan、step、tool、message 事件 |
| `RuntimeEventFactory` | 集中生成 ID、时间、`runId`、单调 sequence 和路径元数据 | 四条路径都不能自行设置 envelope |
| `RuntimeExecutorDispatcher` | 要求四条路径完整且无重复注册，再按决策分发 | 服务启动时缺少 Workflow 执行器会立即失败 |

### 主要执行流程

```text
AgentRun + RouteDecision + message
  ↓
Dispatcher 校验四路径注册完整，并按 decision.route 选择执行器
  ↓
校验 Run / Decision / Executor 路径一致、Run 可运行、消息和 sequence 有效
  ↓
具体路径调用注入端口，产生不带 envelope 和终态的业务事件
  ↓
接收受 TypeScript 契约约束的业务事件，统一补齐 id / runId / sequence / createdAt / metadata
  ├─ 产生 run.waiting：停止本次调度，不追加 completed
  ├─ 正常结束：追加 run.completed
  └─ 路径内部异常：追加 run.failed，不追加 completed
```

Single Tool 路径没有循环和第二个调用入口：

```text
select 一次 → tool.calling → invoke 一次 → tool.called → summarize → message.created
```

重试、审批、风险和幂等必须由后续统一工具层显式实现，本执行器不会在异常后偷偷重放调用。

### 例子

Direct 路径从事件水位 `7` 启动时，生成：

```text
sequence 7  message.created  “这是直接回答”
sequence 8  run.completed
```

Single Tool 查询成功时，四个事件共享同一 `toolCallId`，且工具端口只收到一次调用。若工具端口抛出异常，已经产生的事件保持原 sequence，下一条是 `run.failed`；不会追加 `run.completed`，也不会自动调用第二次。

Planned Agent 如果产生 `run.waiting`，执行器会立即结束当前事件流。即使驱动器后面还有逻辑，也不会继续消费，避免同时向调用方声明“等待”和“完成”。

### 保护规则和当前边界

- `AgentRun.route`、`RouteDecision.route` 和执行器 `route` 必须三方一致；不一致视为调用配置错误，不执行任何能力。
- 只允许 `created` 或 `running` Run 启动路径；等待、暂停和终态必须先由外部生命周期协调器处理。
- `RuntimeExecutionEventPayload` 在类型层排除 envelope 和终态；事件工厂统一覆盖 `id`、`runId`、`sequence`、`createdAt`，`metadata.route` 始终由执行器确定。内部端口不再重复逐字段运行时校验。
- Dispatcher 在创建时要求四条路径完整注册并拒绝重复，避免请求到达后才发现路径缺失。
- `nextEventSequence` 可直接使用 RUNTIME-103 恢复计划给出的水位；具体 Checkpoint 提交、Run 状态持久化和恢复调度仍由接线层协调。
- 具体 LLM、Tool Registry、Workflow Registry 和 Planned Agent 尚未绑定；当前实现可用假实现或后续适配器独立运行。
- legacy `AgentTaskRunner`、Session API、SSE 和 UI 未改变；把 Router、执行器、Checkpoint 与兼容适配器接入真实请求属于 `RUNTIME-108`。

## Scope

### In scope

- 定义四类路径共用的执行请求、执行器接口和 Dispatcher。
- 为 Direct、Single Tool、Workflow、Planned Agent 提供可独立运行的执行器。
- 集中生成带 `runId`、单调 `sequence` 和时间戳的统一 `RuntimeEvent`。
- 验证路径匹配、单工具调用上限、终态和失败事件。

### Out of scope

- 将 v2 Runtime 接入真实 Session 与 SSE；属于 `RUNTIME-108`。
- 实现 Tool Registry、Tool Policy、重试、审批和幂等；属于 `TOOL-101`、`TOOL-103`、`RUNTIME-107`。
- 实现 Workflow、Skill 或 Specialist 的业务注册表。
- 改变 legacy `PlannerReActFlow` 的现有行为。

## Acceptance Checklist

- [x] Direct、Single Tool、Workflow、Planned Agent 每种路径可独立运行。
- [x] 每种路径产生统一 `RuntimeEvent`，且 sequence 单调递增。
- [x] Single Tool 路径至多执行一次主要工具调用。
- [x] 路径不匹配、依赖缺失和执行失败产生明确结果。
- [x] 新增或修改的自动化测试标题使用中文。
- [x] 本任务未新增或修改枚举；现有四类 `RouteKind` 及枚举项已有中文注释。
- [x] 新增或修改的函数有头部中文注释，重要或复杂步骤有中文说明。
- [x] 所有验证命令成功。
- [x] “本任务做了什么”已按模板详细填写。
- [x] “改造前后对比”已填写并说明实际影响。
- [x] [evidence.md](./evidence.md) 已填写。
- [x] 总任务清单和本目录工作记录已更新。

## 改造前后对比

| 对比项 | 改造前 | 完成后 | 实际影响 |
| --- | --- | --- | --- |
| 执行入口 | Router 只能返回决策，四种路径没有共用执行接口。 | 四个 `RuntimeExecutor` 实现共享相同请求和异步事件流契约。 | RUNTIME-108 可以按决策接线，不再把全部请求塞回 legacy Planner。 |
| Direct | 没有不带工具能力的轻量执行路径。 | Direct 端口只接收上下文并返回文本，执行器生成消息和完成事件。 | 简单请求未来可以绕过工具和完整规划流程。 |
| Single Tool | 没有结构约束保证只调用一个主要工具。 | 编排固定为选择一次、调用一次、结果归纳，不包含循环或隐式重试。 | 工具调用次数可预测；可靠重试必须由统一策略显式提供。 |
| Workflow / Planned Agent | 确定性流程和开放式 Agent 没有清晰的同级执行边界。 | Workflow 按名称运行确定性驱动器；Planned Agent 可流式产生计划、步骤、工具和消息。 | 两者共享事件语义，但自治程度和具体能力保持分离。 |
| Runtime Event | 各路径尚无集中事件生产者。 | `RuntimeEventFactory` 统一生成 envelope、恢复 sequence、路径元数据和终态。 | 兼容适配器只需处理一套事件，断线去重水位可连续。 |
| 失败与等待 | 没有跨路径一致的停止规则。 | 内部异常转 `run.failed`；`run.waiting` 停止本次调度；成功才追加 `run.completed`。 | 调用方不会同时收到互相矛盾的等待、失败和完成结果。 |
| 实际接入状态 | legacy `AgentTaskRunner` 固定使用 `PlannerReActFlow`。 | 四路径执行核心已可独立运行，但尚未接入真实 Session。 | 当前用户行为不变；`RUNTIME-108` 可在已验证边界上完成 v2 接线。 |

## Current State

- 当前进展：四类执行器、统一事件生产、Dispatcher 和契约测试全部完成。
- 当前阻塞：无。
- 下一步：执行 `RUNTIME-108`，接入 Router、运行持久化、Checkpoint、事件适配器和真实 Session 流程。

## Task Files

- [worklog.md](./worklog.md)：按时间追加工作过程，保留历史。
- [evidence.md](./evidence.md)：验收项、测试结果和完成证据。

## Decisions and Risks

- 通过供应商中立的注入端口隔离模型、工具、Workflow 和 Planned Agent，领域执行器不依赖厂商 SDK 或 legacy 类型。
- 终态和事件 envelope 只由执行器基类产生，路径驱动器只提交业务事件，防止多套序号和终态规则。
- Single Tool 不实现本地重试；在 `TOOL-103` 完成前，任何重放都可能绕过风险和幂等策略。
- 当前只能说明四路径执行核心可用，不能说明 v2 已服务真实用户请求。

## Latest Session State

- Current state: `done`，8 项专项测试与 61 项全量契约测试通过，类型检查和生产构建成功。
- Remaining work: 无 RUNTIME-105 范围内工作。
- Blockers: 无。
- Recommended next action: 推进 `RUNTIME-108`，在真实请求接线时注入具体能力并协调 Run/Checkpoint 持久化。
