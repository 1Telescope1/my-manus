# COMPAT-101 — 让新 Runtime 继续服务现有 UI

> 本目录是该任务的独立工作记录。总体设计以 [SDD](../../../agent-core-modernization-sdd.md) 为准，总体状态以 [TASKS.md](../../TASKS.md) 为准。

| 字段 | 值 |
| --- | --- |
| Workstream | `Compatibility` |
| Status | `done` |
| Dependencies | — |
| Started | `2026-07-16` |
| Last Updated | `2026-07-18` |
| Working Session | `Codex：开始执行 COMPAT-101` |

## Intent

在新 Runtime 与现有 Session/SSE/UI 之间建立明确的事件适配边界，让执行内核可以演进而不迫使现有前端同步改造。

## 本任务做了什么

### 一句话说明

> 把新 Runtime 产生的事件翻译成现有 UI 已经认识的 SSE 事件，让后端替换执行内核时不必同时重写前端。

### 为什么需要这个任务

现有 UI 只认识 legacy 的 `title`、`message`、`plan`、`step`、`tool`、`wait`、`error`、`done` 事件。如果新 Runtime 直接输出自己的事件结构，前端会无法展示，后端和前端就必须在同一时间整体切换，迁移风险很高。

COMPAT-101 在两者之间增加 `RuntimeEventAdapter`，把“内核怎样表达事件”和“UI 怎样消费事件”解耦。

### 主要事件映射

| Runtime Event | legacy Event | UI 看到的结果 |
| --- | --- | --- |
| Plan 创建或更新 | `plan` | 展示计划和步骤列表 |
| Step 开始或结束 | `step` | 更新步骤状态 |
| Tool 调用或结果 | `tool` | 展示工具名称、调用 ID 和状态 |
| 普通文本 | `message` | 展示 Agent 消息 |
| 等待输入 | `wait` | 停止本轮并等待用户 |
| 运行失败 | `error` | 展示错误并结束当前流程 |
| 完成或取消 | `done` | 让旧 UI 正常结束流 |

新 Runtime 的 `runId`、`sequence`、`checkpointId`、`metadata` 会转换为可选的 `run_id`、`sequence`、`checkpoint_id`、`metadata`。legacy 事件没有这些字段时，序列化结果保持原样，不强迫旧客户端理解新字段。

### 事件转换流程

```text
新 Runtime 产生 Runtime Event
  ↓
RuntimeEventAdapter 检查 runId 和 sequence
  ↓
重复或过期？──────→ 丢弃
  ↓ 否
转换成现有领域 Event
  ↓
复用 EventMapper 输出原有 SSE 格式
  ↓
现有 UI 按原逻辑消费
```

### sequence 去重例子

假设同一个 Run 已经输出 `sequence = 7`：

```text
再次收到 sequence 7 → 重复事件，过滤
收到 sequence 6       → 过期事件，过滤
收到 sequence 8       → 新事件，正常输出
另一个 Run 的 sequence 1 → 独立处理，不受影响
```

取消事件仍然映射为旧 UI 认识的 `done`，同时在 `metadata.terminal_status` 中记录 `cancelled`。这样旧 UI 能正常结束，新客户端和诊断系统又能识别真实终态。

### 当前接入边界

事件类型、适配器、可选字段和进程内 sequence 去重已经完成，并使用模拟 v2 事件验证。sequence 水位尚未持久化，真实请求也仍由 legacy 流程执行；运行模式开关和正式接线属于 COMPAT-102、RUNTIME-105、RUNTIME-108。

## Scope

### In scope

- 定义适配器所需的最小 Runtime Event 联合类型。
- 将 Runtime 的 Plan、Step、Tool、Message、Wait、Error、Done 和 Title 事件转换成现有领域 Event。
- 将 `run_id`、`sequence`、`checkpoint_id`、`metadata` 作为可选兼容字段传递到 SSE。
- 按 Run 记录最后接收的 `sequence`，过滤重复或过期事件。
- 使用 v2 模拟事件验证现有 SSE 数据结构和事件顺序。

### Out of scope

- 实现 AgentRun、RunStep、Checkpoint 的持久化和状态机；这些属于 RUNTIME-101 及其后续任务。
- 接入 `legacy/v2/shadow` 运行模式；该工作属于 COMPAT-102。
- 修改现有 UI 的事件处理逻辑。

## Acceptance Checklist

- [x] Runtime Event 到现有 Event 的映射覆盖 UI 当前消费的事件类型。
- [x] 新增兼容字段均为可选，legacy SSE 数据结构不变。
- [x] 同一 Run 的重复或过期 `sequence` 可被过滤，不同 Run 互不影响。
- [x] 现有 UI 无需修改即可消费 v2 模拟事件。
- [x] EVAL-102 契约测试继续通过。
- [x] 类型检查和构建通过。
- [x] “本任务做了什么”已详细说明事件映射、转换流程、sequence 去重和接入边界。
- [x] “改造前后对比”已填写，并说明实际影响。
- [x] [evidence.md](./evidence.md) 已填写。
- [x] 总任务清单和本目录工作记录已更新。

## 改造前后对比

| 对比项 | 改造前 | 完成后 | 实际影响 |
| --- | --- | --- | --- |
| 新旧事件边界 | 系统只有 legacy Event，新 Runtime 即使产出自己的事件，也没有转换到现有 Session/SSE 的统一入口。 | 新增 Runtime Event 联合类型和 `RuntimeEventAdapter`，统一转换为现有领域 Event，再复用 `EventMapper` 输出 SSE。 | 新 Runtime 可以沿用现有 API 和 UI 事件通道，不需要另写一套前端协议。 |
| UI 兼容性 | 新事件格式如果直接输出，现有 UI 无法识别，后端与前端必须同时改造。 | v2 事件被转换为现有的 `title/message/plan/step/tool/wait/error/done`，旧字段和状态值保持不变。 | 后端可以逐步替换执行内核，现有 UI 无需同步修改；legacy 契约测试继续通过。 |
| 运行标识 | 旧事件只有事件 ID 和时间戳，无法区分事件属于哪个 Run，也没有顺序号。 | v2 事件可额外携带 `run_id`、`sequence`、`checkpoint_id` 和 `metadata`；legacy 事件不提供这些值时，JSON 输出不增加字段。 | 后续可以按 Run 追踪、恢复和诊断，同时不破坏旧客户端。 |
| 重复事件 | 没有基于 Run 顺序号的去重能力，重放同一事件可能造成 UI 重复展示。 | 适配器为每个 Run 保存 sequence 水位，相同或更旧的事件不再输出，不同 Run 相互独立。 | 同一适配器生命周期内，断线重放或重复投递不会产生重复事件。 |
| 取消终态 | 现有 UI 只认识 `done`，无法判断任务是正常完成还是被取消。 | Runtime 的取消仍映射为 `done`，并附加 `metadata.terminal_status=cancelled`。 | 旧 UI 继续正常结束流程，新客户端或诊断系统可以识别真实终态。 |
| 实际接入状态 | 不存在适配器，也不存在 v2 接入点。 | 适配能力和模拟事件验证已经完成，但真实请求仍由 legacy `PlannerReActFlow` 执行。 | 本任务搭好了转换桥梁；运行模式切换和真实 v2 接线仍需 COMPAT-102、RUNTIME-105、RUNTIME-108 完成。 |

## Current State

- 当前进展：Runtime Event 类型、适配器、可选字段透传和 sequence 去重均已完成。
- 当前阻塞：无。
- 下一步：RUNTIME-105 完成后可在 COMPAT-102 中接入运行模式开关。

## Task Files

- [worklog.md](./worklog.md)：实施与验证过程。
- [evidence.md](./evidence.md)：验收项、测试结果和完成证据。

## Decisions and Risks

- Runtime 内部使用 camelCase，适配到 legacy Event 时转换为现有 snake_case 字段。
- 适配器实例按消费流保存 sequence 水位；它不负责持久化，重连后的持久水位属于后续 Runtime/Session 接入任务。
- 适配器输出现有领域 Event，再复用 `EventMapper` 生成 SSE，避免领域执行器直接依赖接口层 DTO。

## Latest Session State

- Current state: `done`，16 项契约测试、API 构建和 UI 构建均通过。
- Remaining work: 无。
- Blockers: 无。
- Recommended next action: 推进 RUNTIME-101/RUNTIME-105，为 COMPAT-102 提供可接入的新执行器。
