# MEMORY-102 — 主动控制上下文窗口

> 本目录是该任务的独立工作记录。总体设计以 [SDD](../../../agent-core-modernization-sdd.md) 为准，总体状态以 [TASKS.md](../../TASKS.md) 为准。

| 字段 | 值 |
| --- | --- |
| Workstream | `Memory 与 Context` |
| Status | `done` |
| Dependencies | `MEMORY-101` |
| Started | `2026-07-20` |
| Last Updated | `2026-07-20` |
| Working Session | 当前 Codex 任务 |

## 现状证据表

| 确定结论 | 证据路径 | 不确定项 | 建议改动范围 |
| --- | --- | --- | --- |
| `WorkingContext` 目前只把受保护指令插入消息，没有预算、计量、选择或超限失败语义。 | `api/src/domain/models/working-context.ts` | 厂商 tokenizer 不在当前依赖中。 | 在领域层增加保守 Token 估算、窗口预算和可测试的选择结果，不绑定单一厂商 tokenizer。 |
| `max_tokens` 被直接发送为模型最大输出长度，不能代表模型总上下文窗口。 | `api/src/domain/external/llm.ts`；`api/src/infrastructure/external/llm/openai-llm.ts`；`api/src/domain/models/app-config.ts` | 不同模型的窗口大小不同，无法从模型名稳定推导。 | 新增独立 `context_window_tokens` 配置，保持 `max_tokens` 原语义。 |
| Planned Agent 仅在模型调用前拼接完整 Conversation Memory；旧 `compact()` 是执行步骤后的轻量删除。 | `api/src/domain/services/agents/base-agent.ts`；`api/src/domain/models/conversation-memory.ts`；`api/src/domain/services/flows/planner-react-flow.ts` | 结构化摘要尚未实现。 | 调用前选择上下文；不在本任务替换持久化压缩，摘要留给 MEMORY-103。 |
| Direct、Single Tool 与 Router 直接构造消息调用 LLM，没有进入 `WorkingContext`。 | `api/src/domain/services/runtime/adapters.ts`；`api/src/infrastructure/external/llm/llm-runtime-route-model.ts` | Browser 内部抽取模型不是 Agent Working Context。 | 收敛 Runtime 的 Direct、Single Tool、Router 和 Planned Agent 调用；Browser 抽取保持工具内部边界。 |
| 当前用户请求与计划/步骤状态位于当次 user message，活跃 Skill 位于临时 system context，均可显式标为受保护内容。 | `api/src/domain/services/agents/planner-agent.ts`；`api/src/domain/services/agents/react-agent.ts`；`api/src/domain/models/skill-disclosure.ts` | Checkpoint 恢复后的完整 Working Context 尚未重建。 | 保护基础 system、临时 system、当前 user request；恢复重建留给 MEMORY-104。 |

## Intent

在模型调用前主动计算可用输入预算，从候选历史中选择不超过窗口上限的 Working Context，并保证当前请求、系统约束与活跃 Skill 不因裁剪丢失。

## 本任务做了什么

### 一句话说明

> 在每次 Agent 模型调用发出前，先用独立的模型总窗口计算输入上限，再只选择能安全放入窗口的受保护内容和最近历史。

### 为什么需要这个任务

改造前，系统只知道 OpenAI 请求里的 `max_tokens`，它表示最大输出长度，不是模型输入与输出共享的总上下文窗口。Planned Agent 会把完整 Conversation Memory 直接交给模型；Direct、Single Tool 和 Router 则各自拼接消息。上下文是否超限完全依赖模型 API 报错，活跃 Skill 与当前目标也没有统一的裁剪保护。

旧 `ConversationMemory.compact()` 无法解决这个根因：它发生在执行步骤之后，只删除少量 reasoning 和浏览器结果，既不知道目标模型的窗口，也不能在每次调用前证明输入已受控。本任务因此把控制点放到 LLM 调用之前，并保持持久化 Memory 不变。

### 核心对象或能力

| 对象或能力 | 职责 | 例子 |
| --- | --- | --- |
| `context_window_tokens` | 独立声明模型输入与输出共享的总窗口，不再与 `max_tokens` 混用。 | 默认总窗口 32768、最大输出 8192。 |
| `ModelContextBudget` | 至少预留窗口的 25%，且当 `max_tokens` 更大时为输出预留更多。 | 32768 总窗口得到 24576 输入上限；1000 总窗口、400 最大输出只允许 600 输入。 |
| `ContextSelector` | 保护必需消息，并从最近向过去选择完整消息组直到预算边界。 | 旧研究历史放不下时，仍保留 system、当前目标、活跃 Skill 和最近可容纳的工具调用组。 |
| 工具原子组 | 把 assistant `tool_calls` 和随后 tool result 视为不可拆分单元。 | 空间不足时整组移除，不会只留下 `tool_call_id` 的一半协议。 |
| `ProtectedContextBudgetExceededError` | 当不可裁剪内容本身已经超限时，在厂商请求前明确失败。 | 巨大当前用户请求或 Tool Schema 挤满窗口时，LLM 调用次数保持 0。 |

Token 预算使用 UTF-8 字节数加结构开销作为保守上界。它用于防止输入超限，不冒充模型供应商返回的真实 usage；EVAL 报告中的账单 Token 仍保持 `null`，直到 LLM 端口获得真实 usage。

### 主要流程

```text
模型 context_window_tokens + max_tokens
  -> 至少预留 25%，计算 inputTokenLimit
  -> 构造 Working Context 候选
     - 基础 system：受保护
     - Run 级 system / Active Skill：受保护
     - 当前 user request / 当前计划步骤：受保护
     - Conversation Memory 历史：可选择
  -> 把 Tool Schema、response format 计入固定输入
  -> 受保护内容 + 固定输入超限？
     - 是：调用前失败，不截断目标或安全指令
     - 否：从最近向过去加入可容纳的工具原子组/消息
  -> 仅将选择结果交给 LLM
```

Planned Agent 在 `BaseAgent` 内执行这条流程，并持续保护本次 `invoke()` 的原始请求和最新 user 控制消息。Direct、Single Tool 选择、Single Tool 总结和 Router 使用同一个 `ContextSelector`；因此不会再出现某条 Runtime 路径绕过预算的情况。

### 例子

模型总窗口为 32768、`max_tokens` 为 8192 时，输入上限为 24576。一次长会话包含基础系统指令、一个激活 Skill、当前任务“继续比较两个方案”、最近一次搜索工具调用，以及更早的多轮研究历史：

- system、Skill 和当前任务先进入受保护集合；
- 搜索的 assistant tool call 与 tool result 成组估算；
- 剩余空间从最近历史向过去填充；
- 第一个放不下的旧消息组成为历史边界，更早内容不会反过来挤掉新证据。

反例是当前用户请求本身已经大于输入预算。选择器不会静默截断用户目标，也不会先调用模型再等待厂商返回超限，而是抛出包含 `requiredTokens` 与 `inputTokenLimit` 的确定性错误。

### 保护规则和当前边界

- `max_tokens` 与 `context_window_tokens` 分开校验，最大输出不得占满总窗口。
- 旧 YAML 缺少新字段时由 Schema 补为 32768；旧 UI 更新请求省略字段时沿用当前值。
- Conversation Memory 的 Session JSON 结构没有变化；选择只生成单次调用快照，不删除持久消息。
- 活跃 Skill 继续以 Run 级临时 system message 注入，既受保护也不会写回 Session Memory。
- Tool Schema 和 response format 计入输入估算；固定输入过大时同样调用前失败。
- 结构化摘要尚未生成，放不下的早期原文当前直接省略；由 MEMORY-103 补齐语义摘要。
- Checkpoint 恢复后的 Working Context 重建属于 MEMORY-104；大型 Tool Result 转 Artifact 属于 TOOL-106。
- Browser 工具内部的网页抽取 LLM 不是 Agent Working Context，本任务未改变该工具内部边界。

## Scope

### In scope

- 独立配置模型上下文窗口和最大输出 Token。
- 建立 75% 输入上限、保守 Token 估算和 Context Selector。
- 保护基础系统指令、Run 级临时指令、当前用户请求和当前任务状态。
- 近期历史优先，工具调用与结果按原子消息组保留或移除。
- 接入 Direct、Single Tool、Router 和 Planned Agent 模型路径。
- 返回可测试的选择结果，并在受保护内容本身超限时调用前失败。

### Out of scope

- 生成或持久化结构化摘要；属于 MEMORY-103。
- 从 Checkpoint 重建完整 Working Context；属于 MEMORY-104。
- 将大型 Tool Result 保存为 Artifact；属于 TOOL-106。
- 改造 Browser 工具内部的网页抽取模型上下文。

## Acceptance Checklist

- [x] Working Context 输入预算不超过模型窗口的 75%。
- [x] 基础系统约束、当前用户请求、活跃 Skill 和当前任务状态不会被历史裁剪移除。
- [x] 近期消息优先于早期消息，工具调用协议消息保持成组。
- [x] 受保护内容本身超限时在调用模型前明确失败。
- [x] Direct、Single Tool、Router 和 Planned Agent 使用统一选择器。
- [x] 现有 Session Memory 存储格式和 API/Event 行为保持兼容。
- [x] 新增或修改的自动化测试标题使用中文。
- [x] 新增或修改的函数有头部中文注释，重要步骤有中文说明。
- [x] 专项测试、全量契约、typecheck 和 build 全部成功。
- [x] “本任务做了什么”“改造前后对比”和 `evidence.md` 已填写。
- [x] 总任务清单和本目录工作记录已更新。

## 改造前后对比

| 对比项 | 改造前 | 完成后 | 实际影响 |
| --- | --- | --- | --- |
| 模型窗口 | 只有最大输出 `max_tokens`，无法知道总窗口。 | 独立配置 `context_window_tokens`，并校验输出小于总窗口。 | 预算基于真实配置语义，不再拿输出上限冒充上下文窗口。 |
| 调用前控制 | Planned Agent 发送完整 Memory；其他路径各自组装。 | 四类 Agent 模型路径统一经过 `ContextSelector`。 | 所有主执行路径都在请求前受控。 |
| 历史裁剪 | 依赖步骤后的轻量删除，超限时由厂商 API 报错。 | 每次调用前按最近优先选择，输入估算不超过 75% 窗口。 | 长会话不会无限把旧原文推入模型。 |
| 关键内容 | Skill 仅被拼接，没有预算中的优先级。 | system、临时 Skill、当前目标/任务消息显式受保护。 | 历史裁剪不会丢掉本轮必须遵守的约束。 |
| 工具协议 | 没有上下文裁剪，因此也没有原子性规则。 | assistant tool call 与 tool result 整组选择或整组省略。 | 不会因裁剪制造残缺模型协议。 |
| 超限失败 | 等模型供应商返回不可控错误。 | 受保护内容或固定 Schema 超限时抛出确定性领域错误，LLM 调用为 0。 | 错误更早、更稳定，也不会产生无意义调用成本。 |
| 持久数据 | Session JSON 保存完整 Conversation Memory。 | 存储结构保持不变，选择结果仅存在于单次调用。 | 旧会话无需数据迁移，可继续读取。 |

## Current State

- 当前进展：实现、接线、专项契约、全量契约、API/UI 构建和 EVAL-101 回归已完成。
- 当前阻塞：无。
- 下一步：执行 MEMORY-103，用结构化摘要替代当前“放不下即省略”的早期历史处理。

## Task Files

- [worklog.md](./worklog.md)：实施调查和变更记录。
- [evidence.md](./evidence.md)：验收项、测试结果和完成证据。

## Decisions and Risks

- 不把 `max_tokens` 误当作模型总窗口；两者已独立配置。
- 没有厂商 tokenizer 时采用保守估算函数，不把近似值伪装成真实账单 Token。
- 受保护内容超过预算时拒绝调用，不静默截断安全指令或用户目标。
- 全量 UI lint 仍有两个与本任务无关的既有错误；本次修改文件的定向 lint 和 UI production build 均通过，详见 `evidence.md`。

## Latest Session State

- Current state: `done`，7 项专项与 174 项全量契约通过。
- Remaining work: 无 MEMORY-102 范围内工作。
- Blockers: 无。
- Recommended next action: 开始 MEMORY-103。
