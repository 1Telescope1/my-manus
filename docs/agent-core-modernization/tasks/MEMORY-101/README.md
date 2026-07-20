# MEMORY-101 — 分离执行状态和对话上下文

> 本目录是该任务的独立工作记录。总体设计以 [SDD](../../../agent-core-modernization-sdd.md) 为准，总体状态以 [TASKS.md](../../TASKS.md) 为准。

| 字段 | 值 |
| --- | --- |
| Workstream | `Memory 与 Context` |
| Status | `done` |
| Dependencies | — |
| Started | `2026-07-20` |
| Last Updated | `2026-07-20` |
| Working Session | 当前 Codex 任务 |

## Intent

让运行恢复信息、会话语义历史、单次模型输入和大内容引用各自拥有明确的数据类型、生命周期和仓储责任，避免聊天消息继续充当执行游标或通用状态容器。

## 证据表

| 确定结论 | 证据路径 | 不确定项 | 建议改动范围 |
| --- | --- | --- | --- |
| `AgentRun.currentNode`、`Checkpoint.resumeNode` 和 `Interruption` 已由独立运行聚合与仓储持久化。 | `api/src/domain/models/agent-run.ts`；`api/src/domain/repositories/agent-run.repository.ts` | 后续 Working Context 的恢复快照尚未建模。 | 复用现有 Run State，不建立第二套游标。 |
| 会话记忆仍由 `SessionRepository.saveMemory/getMemory` 负责，Session 业务资料与模型历史职责混杂。 | `api/src/domain/repositories/session.repository.ts`；`api/src/infrastructure/repositories/db-session.repository.ts` | 暂时仍需兼容现有 `Session.memories` JSON。 | 抽出 `ConversationMemoryRepository`，存储格式本任务保持不变。 |
| `Memory` 同时保存模型消息并执行轻量删除式压缩。 | `api/src/domain/models/memory.ts` | 结构化摘要和预算策略属于 MEMORY-102/103。 | 更名并收窄为 `ConversationMemory`；保留现有压缩行为，避免扩大范围。 |
| Run 级 Skill 指令通过临时参数注入模型，但没有显式 `WorkingContext` 类型。 | `api/src/domain/services/agents/base-agent.ts` | 全路径 Context Selector 尚未实现。 | 建立不可持久化的 `WorkingContext`，先接住现有 Planner/ReAct 模型组装。 |
| 现有 `FileModel/FileRepository` 只描述文件元数据，不能表达大型 Tool Result、截图和结构化数据的统一引用。 | `api/src/domain/models/file.ts`；`api/src/domain/repositories/file.repository.ts` | Artifact 的数据库迁移和内容存储策略属于后续任务。 | 只定义 `Artifact` 数据边界；等真实消费者出现后再建立仓储。 |

## 本任务做了什么

### 一句话说明

> 把“任务执行到哪里”“会话说过什么”“这次模型实际看到什么”和“可按需读取的大内容”拆成四个不能互相冒充的边界。

### 为什么需要这个任务

原来的 `Memory` 是一个含任意字典消息的通用容器，读取和保存方法挂在 `SessionRepository` 上，模型历史与会话资料共享同一个仓储职责。与此同时，Run 级 Skill 指令虽然已经临时注入模型，但没有类型明确说明它只属于单次调用；文件之外的大型工具结果、截图和结构化数据也没有统一引用边界。

如果继续在这个结构上增加预算、摘要和恢复，执行节点、受保护指令和大内容很容易继续被塞进聊天消息。这样既无法可靠恢复，也会让无关或过大的内容进入模型。本任务先拆清所有权和生命周期，让后续任务只在正确边界上增加策略。

### 核心对象或能力

| 对象或能力 | 生命周期与职责 | 不负责什么 |
| --- | --- | --- |
| Run State | 继续由 `AgentRun`、`RunStep`、`ToolCallRecord`、`Checkpoint` 和 `Interruption` 保存一次 Run 的状态、节点和恢复游标。 | 不直接作为聊天消息进入模型。 |
| `ConversationMemory` | 保存 Session 内某个 Agent 可跨 Run 复用的系统、用户、助手和必要工具语义消息。 | 不保存 `currentNode`、`resumeNode`、重试、临时 Skill 指令或 Artifact 原文。 |
| `ConversationMemoryRepository` | 单独读取和合并保存 Agent 会话记忆；Prisma 适配器暂时复用原 `Session.memories` JSON 列。 | 不负责 Session 标题、Event、File 关联或运行游标。 |
| `WorkingContext` | 描述本次模型调用使用的会话消息和受保护指令。 | 没有仓储端口，不允许直接持久化；证据、Artifact 和预算选择属于后续任务。 |
| `Artifact` | 用统一元数据描述文件、大型 Tool Result、截图和结构化数据。 | 本任务不实现引用、数据库表、内容存储或自动读取。 |

### 主要流程

```text
Session + Agent
  → ConversationMemoryRepository.get()
  → 追加稳定的用户/助手/必要工具语义消息
  → toWorkingContextMessages() 合并当前 Run 的受保护 Skill 指令
  → 生成单次模型输入
  → 模型响应中的稳定语义写回 ConversationMemoryRepository

执行节点与恢复：AgentRun/Checkpoint 独立更新
大内容：Artifact 只定义元数据边界，实际接入留给后续任务
```

`BaseAgent` 已使用 `WorkingContext` 组装 Planner/ReAct 模型消息。Direct、Single Tool 的统一 Context Selector、证据选择和 Artifact 展开仍由后续 Context 任务接入。

### 例子

例如用户要求“继续整理上次的研究，并遵守当前激活 Skill”。上次的用户目标和助手结论来自 `ConversationMemory`；当前 Skill 指令只复制进这一次 `WorkingContext`；流程恢复位置来自 `Checkpoint.resumeNode`。模型调用完成后，Skill 正文和恢复游标不会写回会话聊天历史。

如果搜索工具返回 256 KiB JSON，未来会把原文保存成 `Artifact`，再由 TOOL-106 定义模型需要的轻量引用和自动落盘逻辑。本任务不提前猜测尚无消费者的引用接口。

### 保护规则和当前边界

- 保持 `Session.memories` 的 `{ agentName: { messages: [...] } }` JSON 结构，不需要数据库迁移，已有会话可以继续读取。
- `SessionRepository` 删除 `saveMemory/getMemory`，模型历史只能通过专用仓储访问。
- `WorkingContext` 只组装新的消息数组，不修改持久 Conversation Memory。
- 现有轻量 `compact()` 行为仅为兼容保留；结构化摘要、来源和预算规则属于 MEMORY-102/103。
- Artifact 当前只有数据类型；仓储、校验和工厂等逻辑等真实存储消费者出现后再实现。

## Scope

### In scope

- 明确复用现有 `AgentRun/Checkpoint/Interruption` 作为 Run State 边界。
- 将 `Memory` 收敛为 `ConversationMemory`，并从 `SessionRepository` 抽出专用仓储端口和 Prisma 适配器。
- 定义单次模型调用使用、不会被持久化的 `WorkingContext`。
- 定义 Artifact 元数据边界，表达文件、大型工具结果、截图和结构化数据引用。
- 通过契约测试证明执行游标独立于聊天消息，现有 Session JSON 与 API/Event 行为保持兼容。

### Out of scope

- Token 预算、Context Selector 和 75% 窗口门槛；属于 MEMORY-102。
- 结构化摘要和替换现有轻量压缩；属于 MEMORY-103。
- 恢复时重建完整 Working Context；属于 MEMORY-104。
- Artifact 数据库迁移、内容存储和大型 Tool Result 接入；属于 TOOL-106 等后续任务。

## Acceptance Checklist

- [x] Run State、Conversation Memory、Working Context 和 Artifact 拥有明确领域类型和生命周期。
- [x] 会话记忆由专用仓储负责，`SessionRepository` 不再暴露模型记忆方法。
- [x] 执行游标只存在于 Run/Checkpoint 边界，不依赖聊天消息。
- [x] 现有 Session `memories` JSON 存储格式和 API/Event 行为兼容。
- [x] 新增或修改的自动化测试标题使用中文。
- [x] 新增或修改的枚举类型及每个枚举项都有中文注释。
- [x] 新增或修改的函数有头部中文注释，重要或复杂步骤有中文说明。
- [x] 专项测试、全量契约测试、typecheck 和 build 通过。
- [x] “本任务做了什么”和“改造前后对比”完整填写。
- [x] [evidence.md](./evidence.md)、[worklog.md](./worklog.md) 和总任务清单已更新。

## 改造前后对比

| 对比项 | 改造前 | 完成后 | 实际影响 |
| --- | --- | --- | --- |
| 运行游标 | 运行聚合已存在，但与通用 `Memory` 的职责关系没有显式契约。 | 契约测试证明游标只属于 `AgentRun/Checkpoint`，Conversation Memory 不包含游标。 | 后续上下文重构不会误用聊天消息恢复执行。 |
| 会话记忆仓储 | `SessionRepository` 同时保存会话资料和模型历史。 | `ConversationMemoryRepository` 独立负责模型语义历史。 | 仓储改动可以按数据生命周期独立演进。 |
| 模型输入 | 持久消息和临时 Skill 指令由辅助参数临时拼接。 | `WorkingContext` 明确承载单次调用输入，并用一个转换函数插入受保护指令。 | 临时约束不会泄漏到下一 Run，也为 Context Selector 提供稳定输入。 |
| 大内容 | 只有面向文件的 `FileModel`，缺少统一大内容概念。 | `Artifact` 只定义四类内容的元数据边界。 | 后续任务可按真实存储和模型消费者设计引用，不受提前抽象约束。 |
| 数据兼容 | 历史 Conversation Memory 位于 `Session.memories` JSON。 | 物理 JSON 格式不变，只拆分领域名称和仓储责任。 | 无迁移即可读取已有 Session，API/SSE/UI 无变化。 |

## Current State

- 当前进展：实现、专项契约、全量契约、typecheck 和 build 已完成。
- 当前阻塞：无。
- 下一步：执行 MEMORY-102，为 Working Context 增加预算和受保护内容选择。

## Task Files

- [worklog.md](./worklog.md)：实施调查和变更记录。
- [evidence.md](./evidence.md)：验收项、测试结果和完成证据。

## Decisions and Risks

- 复用已正式化的 `AgentRun/Checkpoint/Interruption` 作为 Run State，不创建重复状态模型。
- 本任务保持 `Session.memories` JSON 物理格式，先拆职责，避免把数据库迁移与上下文策略混在一起。
- `WorkingContext` 是单次调用快照，不提供仓储端口；持久化它会破坏生命周期边界。
- Artifact 本任务只建立数据边界；具体仓储、持久化和模型按需读取由后续任务在出现真实消费者时接入。
- 真实 PostgreSQL 集成测试在当前环境因 `postgres:5432` 未运行而无法执行；本任务未修改数据库结构，Prisma 兼容由专用仓储契约、全量类型检查和构建覆盖。

## Latest Session State

- Current state: `done`，3 项专项与 162 项全量契约通过。
- Remaining work: 无 MEMORY-101 范围内工作。
- Blockers: 无。
- Recommended next action: 开始 MEMORY-102；在改变上下文选择行为前完成 EVAL-101 基线也可降低质量回归风险。
