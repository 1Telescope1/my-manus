# EVAL-101 — 建立可重复的 Agent 质量基线

> 本目录是该任务的独立工作记录。总体设计以 [SDD](../../../agent-core-modernization-sdd.md) 为准，总体状态以 [TASKS.md](../../TASKS.md) 为准。

| 字段 | 值 |
| --- | --- |
| Workstream | `Evaluation` |
| Status | `done` |
| Dependencies | — |
| Started | `2026-07-20` |
| Last Updated | `2026-07-20` |
| Working Session | 当前 Codex 任务 |

## Intent

把 Agent 质量要求从散落的测试场景变成一份版本化、可机器读取的固定任务集，并用统一运行器执行当前可用 evaluator、计算结果和指标，为后续版本比较提供稳定基线。

## 证据表

| 确定结论 | 证据路径 | 不确定项 | 建议改动范围 |
| --- | --- | --- | --- |
| SDD 固定任务集包含简单问答、单工具、复杂研究、文件 Artifact、用户输入恢复、三类可靠性故障、崩溃、多个取消表面、Skill 边界和 Multi-Agent。 | `docs/agent-core-modernization-sdd.md` §11.1 | 部分能力尚未实现，不能产出真实成功结果。 | 数据集完整收录；未具备 evaluator 的项明确输出 `not_evaluated`。 |
| EVAL-103 已有机器可读耐久执行报告、场景 ID、指标和退出码。 | `api/test/evaluation/durable-runtime.evaluation.ts` | EVAL-101 是否应复制故障注入。 | 通过 evaluator 适配复用 EVAL-103 结果，不重写恢复逻辑。 |
| 当前没有版本化任务数据文件，也没有跨正常路径、耐久路径和未来专项的统一结果 Schema。 | `api/test/evaluation/` | 未来真实模型运行器的部署方式尚未确定。 | 定义与模型厂商无关的 task/observation/report Schema 和 evaluator 端口。 |
| SDD 指标包括任务成功率、工具选择、调用次数、Token、延迟、恢复、取消和重复副作用。 | `docs/agent-core-modernization-sdd.md` §11.2 | 当前 LLM 端口不返回 Token usage。 | 可获得指标必须记录；不可获得值使用 `null`，禁止伪造估算。 |
| EVAL-104/105 分别负责 Skill/Tool 选择和 Multi-Agent 专项。 | `docs/agent-core-modernization/TASKS.md` | 两项尚未完成。 | 数据集预留 evaluator ID，EVAL-101 不提前实现其业务断言。 |

## 本任务做了什么

### 一句话说明

> 用一份有版本号的任务数据和一个统一评分器，固定“要测什么、期待什么、实际测到了什么”。

### 为什么需要这个任务

此前的契约测试能回答某个接口有没有回归，EVAL-103 能回答耐久执行是否安全，但项目没有一份独立数据说明“Agent 质量究竟要覆盖哪些用户任务”。新增场景只能继续写进不同测试文件，无法确认是否遗漏 SDD 约定，也无法用同一结构比较任务成功率、工具选择、调用次数和恢复结果。

另一个风险是把未实现能力当作已经通过：Artifact 返回、同一 Run 用户输入恢复、Skill 专项和 Multi-Agent 还没有完整 evaluator。如果只统计当前能运行的任务，会制造虚假的全覆盖结论。因此本任务把“数据集是否覆盖需求”和“当前版本实际执行了多少”分开记录。

### 核心对象或能力

| 对象或能力 | 职责 | 当前行为 |
| --- | --- | --- |
| `agent-quality.v1.json` | 版本化固定任务集。 | 23 个稳定任务覆盖 SDD 的 10 类场景，每项包含输入、期望、evaluator、scenario 和启用状态。 |
| `AgentQualityDatasetSchema` | 拒绝未知字段、重复 ID、非法版本和场景遗漏。 | 缺少任一 SDD 类别时整个任务集无效。 |
| `AgentQualityEvaluator` | 将不同执行后端转换成统一 observation。 | 当前注册 `runtime_core` 和 `eval_103`；后续 EVAL-104/105 可直接插入。 |
| `RuntimeCoreQualityEvaluator` | 用受控模型/工具依赖驱动真实 Runtime Executor。 | 覆盖 Direct、Single Tool 和两个来源的 Planned Agent 正常路径，不访问真实网络。 |
| `DurableRuntimeQualityEvaluator` | 复用 EVAL-103 的真实故障注入结果。 | 一次执行六个耐久场景，再按 `scenarioId` 映射为统一 observation。 |
| 统一 grader | 对终态、路由、回答、工具序列、Skill、Artifact、恢复和副作用上限逐项检查。 | 单项失败或已启用 evaluator 缺失都会令报告失败并返回非零退出码。 |
| `AgentQualityEvaluationReport` | 为 EVAL-106 提供机器可读输入。 | 包含数据集 SHA-256、执行覆盖、任务结果和 SDD 指标；缺失 Token usage 明确为 `null`。 |

### 主要流程

```text
读取 agent-quality.v1.json
  → Zod 校验版本、唯一 ID 和 10 类 SDD 覆盖
  → enabled=false：记录 not_evaluated 和原因
  → enabled=true：按 evaluatorId 查找 evaluator
      → runtime_core：驱动真实 Runtime Executor
      → eval_103：复用耐久执行报告
  → 将 observation 与 expected 逐项比较
  → 汇总成功率、工具准确率、调用、Token、延迟、恢复和副作用
  → 输出 schemaVersion=1 / evaluationId=EVAL-101 的单一 JSON
  → 任一已启用任务失败时退出码为 1
```

### 例子

`core.single_tool_query` 期望 `single_tool` 路径、一次 `search_web` 和包含 “Runtime” 的回答。evaluator 实际驱动 `SingleToolRuntimeExecutor`，grader 同时比较终态、路由、回答和完整工具序列；如果改成 `browser_navigate`，即使任务仍返回 completed，基线也会失败。

`skill.correct_activation` 已存在于数据集，但 `enabled=false`。报告将它标为 `not_evaluated`，不把它算进当前成功率；EVAL-104 完成后只需注册 `eval_104` evaluator 并启用任务，不需要重新定义目标。

### 保护规则和当前边界

- 数据集中的 disabled 任务是明确待覆盖项；它们不算失败，也绝不算成功。
- 已启用任务找不到 evaluator 属于配置错误，必须失败，不能静默降级为跳过。
- 当前正常路径使用受控依赖，避免网络、在线模型随机性和真实外部写操作进入提交门禁。
- EVAL-103 仍是恢复、超时、取消和副作用判断的唯一实现；统一 runner 不复制业务逻辑。
- `totalModelCalls=7` 只覆盖有测量能力的 3 个核心任务，并同时记录 `modelCallsMeasuredTasks=3`。
- 当前 LLM 端口没有 usage 数据，因此 `tokenUsage=null`；不能以字符长度伪造 Token。
- 延迟是本地受控执行耗时，只建立字段和首份观测，不作为真实模型 P95 发布阈值。

## Scope

### In scope

- 建立 `schemaVersion` 和 `datasetVersion` 明确的 JSON 固定任务集。
- 覆盖 SDD §11.1 的全部场景类别，并为每项记录输入、期望、evaluator 和启用状态。
- 建立统一 evaluator 端口、结果检查、聚合指标、JSON 报告和退出码。
- 当前核心路径使用受控依赖驱动真实 Runtime Executor；耐久场景复用 EVAL-103。
- 未接入能力输出 `not_evaluated` 和原因，不进入已执行任务成功率分母。
- 提供 npm 命令、中文契约测试和可归档基线 JSON。

### Out of scope

- 真实模型供应商的在线质量评测和费用消耗。
- Skill Precision/Recall 专项；属于 EVAL-104。
- Agent-as-Tool、Handoff 和远程 A2A 专项；属于 EVAL-105。
- 多版本筛选、趋势和统一发布比较页面；属于 EVAL-106。

## Acceptance Checklist

- [x] 版本化任务集覆盖 SDD §11.1 全部场景类别。
- [x] 每个任务都有稳定 ID、输入、期望结果、evaluator 和启用状态。
- [x] 统一运行器输出机器可读报告并支持失败退出码。
- [x] 当前可执行任务可重复运行；未实现能力不伪装成通过。
- [x] 报告包含任务成功率、工具选择、模型/工具调用、Token、延迟、恢复、取消和重复副作用字段。
- [x] 新增或修改的自动化测试标题使用中文。
- [x] 新增或修改的枚举类型及每个枚举项都有中文注释。
- [x] 新增或修改的函数有头部中文注释，重要步骤有中文说明。
- [x] 专项测试、全量契约测试、typecheck、build 和基线命令通过。
- [x] “本任务做了什么”和“改造前后对比”完整填写。
- [x] [evidence.md](./evidence.md)、[worklog.md](./worklog.md) 和总任务清单已更新。

## 改造前后对比

| 对比项 | 改造前 | 完成后 | 实际影响 |
| --- | --- | --- | --- |
| 任务定义 | 场景散落在契约和评测代码中，没有独立版本。 | `manus-agent-quality@1.0.0` 用 23 个 JSON 任务覆盖 10 类 SDD 场景。 | 新能力必须显式增加或启用任务，不会因测试文件分散而遗漏。 |
| 执行后端 | 每套评测各自定义结果。 | evaluator 统一返回 outcome、路径、回答、工具、Skill、Artifact 和指标。 | 正常路径、耐久路径和未来专项可进入同一 grader。 |
| 未实现能力 | 没有统一方式区分“没测”和“失败”。 | 14 项显示为 `not_evaluated`；只有 9 项当前启用。 | 报告不会把未来能力伪装成成功。 |
| 当前基线 | 没有可机器比较的 Agent 质量报告。 | 启用任务 9/9 通过，成功率和工具准确率 100%，恢复率 100%，重复副作用和取消后工具调用均为 0。 | 后续版本有明确的最低比较点。 |
| 自动化入口 | 只有分散的测试与 EVAL-103 命令。 | `npm run eval:agent-quality` 输出单一 JSON，失败时非零退出。 | 本地和 CI 可使用同一个命令。 |

## Current State

- 当前进展：数据集、运行器、当前 evaluators、CLI、契约和首份基线全部完成。
- 当前阻塞：无。
- 下一步：EVAL-104 接入 Skill/Tool 专项，或 EVAL-106 开始跨版本比较报告。

## Task Files

- [worklog.md](./worklog.md)：实施调查和变更记录。
- [evidence.md](./evidence.md)：验收项、基线结果和完成证据。

## Decisions and Risks

- 任务集覆盖与当前执行覆盖分开统计；未来场景存在不等于当前能力已通过。
- EVAL-103 是耐久场景事实来源，EVAL-101 只适配其报告，不复制故障逻辑。
- Token usage 缺少供应商响应字段时记录 `null`，不从字符串长度推算虚假 Token。
- 固定任务只使用受控、无真实外部副作用的 evaluator；在线模型和基础设施波动不进入提交门禁。
- 当前 14 项 `not_evaluated` 是已知覆盖缺口：Artifact、同 Run 输入恢复、LLM/MCP/适配器取消、Skill 和 Multi-Agent；它们需要对应能力或专项任务完成后逐项启用。

## Latest Session State

- Current state: `done`，23 项数据覆盖完整，当前启用基线 9/9 通过。
- Remaining work: 无 EVAL-101 范围内工作。
- Blockers: 无。
- Recommended next action: 返回 Memory 主线执行 MEMORY-102；Evaluation 方向可继续 EVAL-104 或 EVAL-106。
