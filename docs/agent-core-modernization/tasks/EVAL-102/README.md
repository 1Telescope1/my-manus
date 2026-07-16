# EVAL-102 — 固化现有 API/Event 行为

> 本目录是该任务的独立工作记录。总体设计以 [SDD](../../../agent-core-modernization-sdd.md) 为准，总体状态以 [TASKS.md](../../TASKS.md) 为准。

| 字段 | 值 |
| --- | --- |
| Workstream | `Evaluation` |
| Status | `done` |
| Dependencies | — |
| Started | `2026-07-16` |
| Last Updated | `2026-07-17` |
| Working Session | `Codex：开始执行 EVAL-102` |

## Intent

以可重复执行的合同测试记录 legacy Session API 和 SSE 事件的当前外部行为，为后续 Runtime/Event Adapter 改造提供兼容基线。

## Scope

### In scope

- Session 创建、列表、详情和聊天流的公开响应合同。
- SSE framing，以及 Plan、Step、Tool、Wait、Done 的事件名、必填字段和时间戳格式。
- legacy 正常执行路径和等待路径的关键事件顺序。

### Out of scope

- 修改 legacy 运行时行为或修复合同测试暴露的既有语义问题。
- 新 Runtime Event Adapter、sequence 字段和 v2 兼容实现；这些分别属于 Runtime/Compatibility 工作流。
- 依赖 PostgreSQL、Redis、Sandbox 或真实 LLM 的端到端测试。

## Acceptance Checklist

- [x] 当前 legacy Session API 行为有可执行基线。
- [x] Plan、Step、Tool、Wait、Done 的必填字段被验证。
- [x] 正常完成和等待用户输入的关键事件顺序被验证。
- [x] 失败路径和兼容性已检查。
- [x] 所有验证命令成功。
- [x] “改造前后对比”已填写，并说明实际影响。
- [x] [evidence.md](./evidence.md) 已填写。
- [x] 总任务清单和本目录工作记录已更新。

## 改造前后对比

| 对比项 | 改造前 | 完成后 | 实际影响 |
| --- | --- | --- | --- |
| API/Event 基线 | Session API 和 SSE 行为只存在于实现代码和 UI 假设中，没有可重复执行的合同。 | 通过合同测试固定 Session 创建、列表、详情、404、聊天流和会话列表流。 | 后续重构一旦改变公开响应结构，测试会立即提示回归。 |
| 事件字段 | Plan、Step、Tool、Wait、Done 的必填字段依赖人工阅读代码确认。 | 测试对实际 JSON 输出做精确断言，包括事件 ID、秒级时间戳、状态和业务字段。 | 新适配器或新执行器必须继续满足现有 UI 所依赖的字段。 |
| 事件顺序 | Planner/ReAct 的完成路径、工具路径和等待路径没有自动化顺序验证。 | 测试覆盖普通工具调用、询问用户和完整计划完成顺序。 | 防止重构后出现工具事件乱序、步骤提前完成或 Done 提前发送。 |
| 运行依赖 | 验证现有行为通常需要准备数据库、Redis、Sandbox 或真实模型。 | 合同测试使用内存 fake，可通过单条命令稳定运行。 | 本地和 CI 都能快速执行兼容检查，不受外部服务波动影响。 |
| 能力边界 | 缺少基线，无法明确区分“当前行为”和“未来设计”。 | 明确记录 legacy Plan SSE、Tool SSE、ask-user 等现状，并把 sequence 等 v2 能力留给 Compatibility 工作流。 | 后续任务不会把尚未实现的设计误写成 legacy 合同。 |

## Current State

- 当前进展：合同测试已完成，11 项测试全部通过。
- 当前阻塞：无。
- 下一步：后续 Runtime/Compatibility 任务把本套测试作为兼容门禁。

## Task Files

- [worklog.md](./worklog.md)：实施与验证过程。
- [evidence.md](./evidence.md)：验收项、测试结果和完成证据。

## Decisions and Risks

- 合同测试断言当前可观察行为，不把 SDD 中尚未实现的 `sequence` 等 v2 字段倒灌进 legacy 基线。
- 控制器测试使用内存 fake 隔离基础设施，以便在 CI 中稳定重复执行。
- legacy Plan SSE 仅暴露展示步骤，Tool SSE 仅暴露 `tool_content`，询问用户工具在外部事件中折叠为 `message -> wait`；这些均已按现状固化。

## Latest Session State

- Current state: `done`，合同测试、类型检查和构建均通过。
- Remaining work: 无。
- Blockers: 无。
- Recommended next action: 在 COMPAT-101/EVAL-106 中复用 `npm run test:contract`。
