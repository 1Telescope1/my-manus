# EVAL-102 — 固化现有 API/Event 行为

> 本目录是该任务的独立工作记录。总体设计以 [SDD](../../../agent-core-modernization-sdd.md) 为准，总体状态以 [TASKS.md](../../TASKS.md) 为准。

| 字段 | 值 |
| --- | --- |
| Workstream | `Evaluation` |
| Status | `done` |
| Dependencies | — |
| Started | `2026-07-16` |
| Last Updated | `2026-07-18` |
| Working Session | `Codex：开始执行 EVAL-102` |

## Intent

以可重复执行的契约测试记录 legacy Session API 和 SSE 事件的当前外部行为，为后续 Runtime/Event Adapter 改造提供兼容基线。

## 本任务做了什么

### 一句话说明

> 把现有 API 和 SSE 的外部行为固定成自动化契约，作为后续 Runtime 重构不能突破的兼容底线。

### 为什么需要这个任务

改造前，Session API 返回什么字段、SSE 怎样分帧、Plan 和 Tool 事件按什么顺序发送，主要存在于实现代码和前端的隐含假设中。重构 Runtime 时即使 TypeScript 编译成功，也可能悄悄改变字段名、时间格式或事件顺序，直到 UI 出现问题才被发现。

EVAL-102 不改变生产逻辑，而是先回答“现在系统对外承诺了什么”，让后续任务拥有可重复执行的兼容基线。

### 固化了哪些契约

| 契约范围 | 验证内容 | 防止的回归 |
| --- | --- | --- |
| Session API | 创建、列表、详情、404 和响应字段 | ID、状态或响应包装被意外修改 |
| SSE framing | `event`、`data`、事件 ID 和时间戳格式 | 前端无法解析事件流 |
| Plan Event | 步骤列表、完成状态和字段名 | 计划面板无法更新 |
| Step Event | Step ID、描述和执行状态 | 步骤状态乱跳 |
| Tool Event | 调用 ID、工具内容和调用阶段 | 工具结果无法对应原调用 |
| Wait/Done | 等待和终止字段 | UI 提前结束或无法结束 |
| 事件顺序 | 工具路径、询问用户路径、计划完成路径 | Done 提前、Step 提前完成或消息乱序 |

### 契约测试怎样工作

```text
构造内存 Session / Flow / Repository fake
  ↓
调用真实 Controller、EventMapper 或 PlannerReActFlow 边界
  ↓
收集 API 响应或 SSE 事件
  ↓
对公开字段、状态和顺序做精确断言
  ↓
后续重构改变外部行为时测试立即失败
```

测试不依赖 PostgreSQL、Redis、Sandbox 或真实 LLM，因此本地和 CI 可以快速、稳定地重复执行。

### 一个回归例子

当前工具步骤的关键事件顺序是：

```text
Step running
  ↓
Tool calling
  ↓
Tool completed
  ↓
Step completed
```

如果新执行器把 `Step completed` 提前到工具结果之前，业务代码可能仍能运行，但契约测试会失败，提醒开发者这会破坏现有 UI 对事件顺序的假设。

### 契约不等于理想设计

本任务记录的是 legacy 当前可观察行为，不代表所有现状都是未来最佳方案。例如 v2 的 `run_id`、`sequence` 和 `checkpoint_id` 在当时尚未接入，就不会被写成 legacy 必填字段；这些新能力由 COMPAT-101 以可选字段引入。

### 当前接入边界

Session、SSE 和关键事件顺序契约已经成为 `npm run test:contract` 的回归门禁。它不测试真实数据库、Redis、Sandbox 或模型服务，也不证明完整用户任务成功；端到端质量和新旧 Runtime 比较属于后续 Evaluation 任务。

## Scope

### In scope

- Session 创建、列表、详情和聊天流的公开响应契约。
- SSE framing，以及 Plan、Step、Tool、Wait、Done 的事件名、必填字段和时间戳格式。
- legacy 正常执行路径和等待路径的关键事件顺序。

### Out of scope

- 修改 legacy 运行时行为或修复契约测试暴露的既有语义问题。
- 新 Runtime Event Adapter、sequence 字段和 v2 兼容实现；这些分别属于 Runtime/Compatibility 工作流。
- 依赖 PostgreSQL、Redis、Sandbox 或真实 LLM 的端到端测试。

## Acceptance Checklist

- [x] 当前 legacy Session API 行为有可执行基线。
- [x] Plan、Step、Tool、Wait、Done 的必填字段被验证。
- [x] 正常完成和等待用户输入的关键事件顺序被验证。
- [x] 失败路径和兼容性已检查。
- [x] 所有验证命令成功。
- [x] “本任务做了什么”已详细说明契约范围、测试流程、回归例子和能力边界。
- [x] “改造前后对比”已填写，并说明实际影响。
- [x] [evidence.md](./evidence.md) 已填写。
- [x] 总任务清单和本目录工作记录已更新。

## 改造前后对比

| 对比项 | 改造前 | 完成后 | 实际影响 |
| --- | --- | --- | --- |
| API/Event 基线 | Session API 和 SSE 行为只存在于实现代码和 UI 假设中，没有可重复执行的契约。 | 通过契约测试固定 Session 创建、列表、详情、404、聊天流和会话列表流。 | 后续重构一旦改变公开响应结构，测试会立即提示回归。 |
| 事件字段 | Plan、Step、Tool、Wait、Done 的必填字段依赖人工阅读代码确认。 | 测试对实际 JSON 输出做精确断言，包括事件 ID、秒级时间戳、状态和业务字段。 | 新适配器或新执行器必须继续满足现有 UI 所依赖的字段。 |
| 事件顺序 | Planner/ReAct 的完成路径、工具路径和等待路径没有自动化顺序验证。 | 测试覆盖普通工具调用、询问用户和完整计划完成顺序。 | 防止重构后出现工具事件乱序、步骤提前完成或 Done 提前发送。 |
| 运行依赖 | 验证现有行为通常需要准备数据库、Redis、Sandbox 或真实模型。 | 契约测试使用内存 fake，可通过单条命令稳定运行。 | 本地和 CI 都能快速执行兼容检查，不受外部服务波动影响。 |
| 能力边界 | 缺少基线，无法明确区分“当前行为”和“未来设计”。 | 明确记录 legacy Plan SSE、Tool SSE、ask-user 等现状，并把 sequence 等 v2 能力留给 Compatibility 工作流。 | 后续任务不会把尚未实现的设计误写成 legacy 契约。 |

## Current State

- 当前进展：契约测试已完成，11 项测试全部通过。
- 当前阻塞：无。
- 下一步：后续 Runtime/Compatibility 任务把本套测试作为兼容门禁。

## Task Files

- [worklog.md](./worklog.md)：实施与验证过程。
- [evidence.md](./evidence.md)：验收项、测试结果和完成证据。

## Decisions and Risks

- 契约测试断言当前可观察行为，不把 SDD 中尚未实现的 `sequence` 等 v2 字段倒灌进 legacy 基线。
- 控制器测试使用内存 fake 隔离基础设施，以便在 CI 中稳定重复执行。
- legacy Plan SSE 仅暴露展示步骤，Tool SSE 仅暴露 `tool_content`，询问用户工具在外部事件中折叠为 `message -> wait`；这些均已按现状固化。

## Latest Session State

- Current state: `done`，契约测试、类型检查和构建均通过。
- Remaining work: 无。
- Blockers: 无。
- Recommended next action: 在 COMPAT-101/EVAL-106 中复用 `npm run test:contract`。
