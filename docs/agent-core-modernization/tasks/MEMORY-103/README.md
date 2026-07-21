# MEMORY-103 — 生成可溯源的结构化摘要

> 本目录是该任务的独立工作记录。总体设计以 [SDD](../../../agent-core-modernization-sdd.md) 为准，总体状态以 [TASKS.md](../../TASKS.md) 为准。

| 字段 | 值 |
| --- | --- |
| Workstream | `Memory 与 Context` |
| Status | `done` |
| Dependencies | `MEMORY-101` |
| Started | `2026-07-21` |
| Last Updated | `2026-07-21` |
| Working Session | 当前 Codex 任务 |

## 现状证据表

| 确定结论 | 证据路径 | 不确定项 | 建议改动范围 |
| --- | --- | --- | --- |
| 现有 `compact()` 只删除浏览器结果正文和 `reasoning_content`，既不保留语义摘要，也没有来源边界。 | `api/src/domain/models/conversation-memory.ts`；`api/src/domain/services/flows/planner-react-flow.ts` | 无 | 用独立摘要服务替换删除式压缩；压缩失败时保留原消息。 |
| MEMORY-102 会在调用前省略放不下的早期历史，但 `WorkingContext` 没有摘要输入。 | `api/src/domain/services/context/context-selector.service.ts`；`api/src/domain/services/agents/base-agent.ts` | 摘要大小仍需受同一输入预算约束。 | 将持久化摘要作为受保护的会话背景交给 Context Selector，并限制其最大预算。 |
| `Session.memories[agentName]` 当前只保存 `messages`，旧 JSON 会长期存在。 | `api/src/infrastructure/repositories/db-conversation-memory.repository.ts`；`api/src/infrastructure/prisma/session.mapper.ts` | 无数据库列迁移需求。 | 在同一 JSON 对象增加可选 `summary`；稳定计数由来源区间终点推导，缺失时使用兼容默认值。 |
| 当前计划已结构化保存步骤状态和附件，比让模型从聊天文本猜测待办和 Artifact 更可靠。 | `api/src/domain/models/plan.ts`；`api/src/domain/services/agents/react-agent.ts` | 大型 Tool Result 的正式 Artifact Store 属于 TOOL-106。 | 压缩时从当前 `Plan` 覆盖 `pendingWork` 和附件引用；本任务不创建 Artifact 存储。 |
| 当前 Run 的激活 Skill 已由 `SkillDisclosure` 提供名称和内容摘要，但 Planner Flow 只收到格式化字符串。 | `api/src/domain/models/skill-disclosure.ts`；`api/src/domain/services/runtime/adapters.ts` | Checkpoint 恢复时重新激活 Skill 属于 MEMORY-104。 | 将结构化 disclosure 传入压缩上下文，只保存名称和内容摘要标识，不保存指令正文。 |
| 成功工具结果具有 `success: true` 的稳定结构；用户消息和 assistant 文本不构成外部事实证据。 | `api/src/domain/models/tool-result.ts`；`api/src/domain/services/agents/base-agent.ts` | 工具结果本身的来源质量由工具负责。 | `confirmedFacts` 仅接受成功工具结果中的连续原文片段，并记录稳定消息引用。 |

## Intent

把早期原始消息压缩成有结构、可持久化、可追溯的语义摘要，使长会话在受控窗口内继续执行，同时不把假设升级为已确认事实。

## 本任务做了什么

### 一句话说明

> 用带来源和生成时间的摘要替代“删掉旧内容”，并用当前计划而不是模型猜测来保存尚未完成的工作。

### 为什么需要这个任务

MEMORY-102 已能在模型调用前控制窗口，并从最近向过去选择消息；但早期消息一旦放不下就不会再进入模型。原有 `compact()` 也不能补足这部分语义，它只把少量浏览器结果改成 `(removed)` 并删除 `reasoning_content`。因此长会话虽然可能不再超窗，仍会逐渐忘记早期目标、已经确认的事实和尚未执行的步骤。

直接让模型写一段自由文本摘要同样不够：模型可能把用户假设写成事实，删除消息后又无法追查来源；它还可能从旧聊天文本错误推断当前待办。本任务把“语义归纳”和“可信状态”拆开：模型归纳目标、约束和决策，领域服务校验事实，当前 `Plan` 与 `SkillDisclosure` 提供待办、附件和 Skill 的权威值。

### 与 MEMORY-102 的关系

[MEMORY-102](../MEMORY-102/README.md) 负责控制每次 LLM 调用的输入上限，但不会修改持久化的 Conversation Memory。MEMORY-103 负责在历史持续增长时生成可持久化摘要，从而避免 MEMORY-102 只能省略早期原文却无法保留其语义。

```text
早期原文 + 最近原文
  -> MEMORY-103：早期原文变为结构化摘要
  -> 摘要 + 最近原文 + 当前请求 + 当前 Skill
  -> MEMORY-102：按本次模型预算进行最终选择
  -> LLM
```

MEMORY-103 复用 MEMORY-102 的 `inputTokenLimit` 和保守 token 估算确定压缩触发点、摘要生成输入上限与摘要大小。生成后的摘要会作为受保护背景进入 MEMORY-102，因此早期目标、约束、事实和待办可以继续参与模型调用。

职责边界是：MEMORY-103 决定哪些早期消息可以被摘要替代，并保证替换可信且可恢复；MEMORY-102 决定一次调用最终能发送哪些内容，并保证请求不超过目标模型窗口。任一层都不能单独替代另一层。

### 核心对象或能力

| 对象或能力 | 职责 | 关键边界 |
| --- | --- | --- |
| `MemorySummary` | 保存用户目标、约束、事实、决策、完成工作、待办、Skill 和 Artifact 引用。 | 同时保存 `sourceMessageRange` 和 `generatedAt`；不保存 Run 游标、Skill 正文或 Artifact 正文。 |
| `LLMMemorySummaryGenerator` | 只归纳用户目标、约束、事实候选和决策。 | 消息内容只作为数据；有权威来源的运行态字段不交给模型生成。 |
| `MemoryCompactionService` | 选择可压缩前缀、验证候选、限制摘要大小并原子替换消息。 | 任一步失败都不删除原始消息；assistant tool call 与随后 tool result 不拆分。 |
| 稳定消息来源 | system 之外的会话消息使用连续 `message:N` 编号。 | 重复压缩后序号不重置；来源区间始终从 0 连续到最新压缩终点。 |
| 权威压缩上下文 | 从 `Plan`、原始请求附件和 `SkillDisclosure` 生成目标、完成工作、Pending Work、Artifact 和 Skill。 | 直接写入摘要；只保存 Skill 名称与 `contentDigest`。 |
| 摘要 Working Context | 把持久化摘要作为受保护背景插入基础 system 之后。 | 仍经过 MEMORY-102 的 Context Selector；历史 Skill 元数据不能替代当前 Run 指令。 |

### 主要流程

```text
执行步骤完成
  -> 读取 ReAct Conversation Memory
  -> 历史 + 旧摘要未超过输入预算 70%？
     - 是：跳过，不产生额外模型调用
     - 否：继续
  -> 以工具协议原子组划分消息
  -> 至少保留最近两个消息组，目标保留最近 25% 输入预算
  -> 最早连续前缀放入摘要生成请求，来源输入最多使用 70% 输入预算
  -> 模型只返回目标、约束、事实候选和决策
  -> 领域校验
     - confirmedFacts 必须来自 success=true 的 tool message
     - fact 必须是来源正文中的连续原文
     - Pending Work / Skill / Artifact 使用当前运行态覆盖
     - 摘要最多使用输入预算的 20%
  -> 校验全部通过：写入 summary 并删除对应消息前缀
  -> 失败或取消：保留原消息；取消继续向根 Run 传播
```

下一次模型调用时，`BaseAgent` 把摘要格式化为只读会话背景，与当前 Run 的 Skill system context 一起交给 `ContextSelector`。因此模型既能看到被压缩的早期语义，又不会把历史 Skill 元数据当作当前指令。

### 例子

一个长研究会话中存在三种陈述：用户说“项目应该已经发布”、成功工具返回 `项目状态为完成`、失败工具返回“项目已发布”。摘要模型即使把三条都列进 `confirmedFacts`，领域服务也只接受成功工具正文中的 `项目状态为完成`，并保存 `source: message:2`。用户假设和失败工具结果不会进入事实集合。

同一时刻，计划还有“编写回归测试”未完成，并产生 `artifact://report`。摘要中的 `pendingWork` 和 `artifacts` 不采用模型文本，而是直接来自当前计划；原始消息前缀删除后，下一步仍能从摘要看到待办和引用。

反例是摘要模型超时、返回无效 JSON，或目标、待办、事实等核心字段在预算内无法容纳。服务返回失败状态，不改写 `messages`，主执行流可以继续使用原始历史。若根 Run 已取消，则停止摘要并拒绝迟到写回。

### 保护规则和当前边界

- 摘要是 Conversation Memory 的派生数据，不是 Run 游标或 Artifact 正文。
- `confirmedFacts` 必须有成功工具结果来源，且事实文本必须能在来源正文中直接找到。
- `pendingWork`、附件和激活 Skill 使用结构化运行态来源覆盖模型输出。
- 摘要生成失败、Schema 无效或完整摘要超预算时不删除原消息。
- 重复压缩继承旧的已验证事实，并以来源区间终点推导下一个消息序号。
- Session JSON 只增加可选 `summary`；旧 `messages`-only 数据自然读取为无摘要。
- 摘要进入 Working Context 后仍受 MEMORY-102 的统一窗口预算控制。
- 正式 Artifact Store 和大型 Tool Result 外置由 TOOL-106 完成；本任务只保存已有附件 ID 与描述。
- Checkpoint 恢复时重建激活 Skill、摘要版本和 Artifact 由 MEMORY-104 完成。

## Scope

### In scope

- 定义并持久化 `MemorySummary`、来源消息区间和生成时间。
- 生成、校验并限制结构化摘要大小。
- 保留用户目标、约束、已确认事实、决策、完成工作、待办、Skill 和 Artifact 引用。
- 用结构化摘要替换 Planner/ReAct 的轻量删除式压缩。
- 兼容旧 `messages`-only Session JSON。

### Out of scope

- Checkpoint 恢复时重建摘要版本、Skill 和 Artifact；属于 MEMORY-104。
- 建立 Artifact Store 或把大型 Tool Result 外置；属于 TOOL-106。
- 为 Direct、Single Tool 建立跨 Run Conversation Memory。

## Acceptance Checklist

- [x] 长会话中的早期语义通过结构化摘要继续进入 Working Context。
- [x] 用户假设、模型推测和失败工具结果不会进入 `confirmedFacts`。
- [x] 当前计划中的 Pending Work 在压缩后仍可继续执行。
- [x] 摘要保留来源消息区间、生成时间、Skill 和 Artifact 引用。
- [x] 旧 Session Memory JSON 可读取，新摘要可持久化并恢复。
- [x] 压缩失败不删除原始消息，工具调用消息不被拆分。
- [x] 新增或修改的自动化测试标题使用中文。
- [x] 新增或修改的函数有头部中文注释，重要步骤有中文说明。
- [x] 专项测试、全量契约、typecheck 和 build 全部成功。
- [x] 总任务清单、任务说明、工作日志和验收证据已更新。

## 改造前后对比

| 对比项 | 改造前 | 完成后 | 实际影响 |
| --- | --- | --- | --- |
| 早期历史 | 超预算时由 Context Selector 直接省略。 | 先生成有界结构化摘要，再把摘要作为受保护背景选择。 | 长会话在不恢复全部原文的前提下保留目标、约束、事实和待办。 |
| 压缩方式 | 删除浏览器正文和 reasoning，没有语义替代。 | 生成成功并校验后才原子删除消息前缀。 | 压缩失败不会造成不可逆记忆损失。 |
| 事实可信度 | 没有摘要事实边界。 | 只接受成功工具结果中的连续原文，并保存 `message:N`。 | 用户假设、assistant 推测和失败工具结果不会升级为已确认事实。 |
| Pending Work | 依赖剩余聊天文本和当前 Prompt。 | 从当前 Plan 状态覆盖摘要候选。 | 压缩后仍能继续尚未完成的步骤。 |
| Skill / Artifact | Skill 只有临时格式化字符串；附件没有摘要字段。 | 保存 Skill 名称/内容摘要和附件 ID/描述。 | 支持后续恢复设计，同时不持久化 Skill 指令或大内容。 |
| 持久化 | `Session.memories[agent]` 只有 `messages`。 | 同一 JSON 对象可选增加 `summary`。 | 无数据库迁移；旧会话继续可读。 |
| 取消 | 旧压缩同步执行，无异步取消问题。 | 摘要 LLM 继承根 Signal，取消后禁止写回。 | 新增模型阶段不会拖延或污染已取消 Run。 |

## Current State

- 当前进展：实现、真实链路接入、8 项专项长会话契约、182 项全量契约、类型检查、构建和 EVAL-101 回归均已完成。
- 当前阻塞：无。
- 下一步：开始 MEMORY-104，使用 Checkpoint 恢复摘要版本、激活 Skill 和 Artifact 引用。

## Task Files

- [worklog.md](./worklog.md)：实施调查和变更记录。
- [evidence.md](./evidence.md)：验收项、测试结果和完成证据。

## Decisions and Risks

- 不把 LLM 输出直接视为事实或运行态；事实必须可定位到成功工具原文，待办等字段使用现有结构化来源。
- 摘要核心字段无法放入预算时宁可保留原始消息，不静默删除目标、约束、事实、待办、Skill 或 Artifact。
- PostgreSQL 集成测试需要外部 `DATABASE_URL`，当前环境未提供；本任务没有 Schema migration，JSON Mapper 与仓储兼容性由契约测试覆盖。
- 大型单条消息可能无法安全送入摘要模型；正式大结果外置由 TOOL-106 解决。

## Latest Session State

- Current state: `done`，专项 8/8、全量契约 182/182、EVAL-101 9/9 已启用任务通过。
- Remaining work: 无 MEMORY-103 范围内工作。
- Blockers: 无。
- Recommended next action: 开始 MEMORY-104。
