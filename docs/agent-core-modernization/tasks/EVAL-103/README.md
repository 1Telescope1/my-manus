# EVAL-103 — 验证耐久执行

> 本目录是该任务的独立工作记录。总体设计以 [SDD](../../../agent-core-modernization-sdd.md) 为准，总体状态以 [TASKS.md](../../TASKS.md) 为准。

| 字段 | 值 |
| --- | --- |
| Workstream | `Evaluation` |
| Status | `done` |
| Dependencies | `RUNTIME-103`, `RUNTIME-106`, `RUNTIME-107` |
| Started | `2026-07-19` |
| Last Updated | `2026-07-19` |
| Working Session | `Codex：执行 EVAL-103` |

## Intent

建立可重复、可机器判定的耐久执行评测：实际注入进程崩溃、工具超时、根取消和不确定副作用，统一计算恢复成功率、重复副作用和取消后新工具调用数，并把 SDD 发布门槛变成失败即非零退出的命令。

## 证据表

| 确定结论 | 证据路径 | 不确定项 | 建议改动范围 |
| --- | --- | --- | --- |
| Checkpoint、恢复、取消和副作用幂等已有独立契约，但结果散落在不同 test 文件中。 | `api/test/contracts/runtime-recovery.contract.test.ts`、`runtime-cancellation.contract.test.ts`、`runtime-idempotency.contract.test.ts` | 单独测试通过不能产出一份统一耐久性结论。 | 新增场景化 Evaluation runner，直接驱动真实领域服务并汇总统一结果。 |
| 当前 `api/package.json` 只有 contract、build 和数据库 integration 命令，没有耐久执行评测入口。 | `api/package.json` | CI 尚未约定报告落盘目录。 | 本任务提供稳定 npm 命令并向 stdout 输出单一 JSON；长期报告持久化留给 EVAL-106。 |
| SDD 已明确 Recovery Success、Cancellation Latency、Duplicate Side Effects 指标，以及恢复成功率 100%、重复副作用 0、取消后不得调度新 ToolCall 的门槛。 | `docs/agent-core-modernization-sdd.md` §11.2、§11.3 | 当前没有历史延迟基线，不能为取消耗时设置发布阈值。 | 本任务记录取消耗时但只对功能门槛做硬判定；P95 基线属于 EVAL-101/EVAL-106。 |
| 现有内存 UnitOfWork 契约可稳定模拟事务、进程重建和状态竞争，不依赖外部服务。 | RUNTIME-103/106/107 contract tests | PostgreSQL 真实连接依赖 `DATABASE_URL`。 | 评测使用带事务回滚的内存持久化状态；数据库实现继续由 integration suite 验证。 |

## 本任务做了什么

### 一句话说明

> 把“系统应该能从故障中安全恢复”从分散测试变成一条可重复执行、输出 JSON、门槛不达标就失败的发布检查。

### 为什么需要这个任务

RUNTIME-103、RUNTIME-106 和 RUNTIME-107 已分别证明 Checkpoint 恢复、真实取消和副作用幂等，但这些证据分散在不同 contract test 中。发布前仍需要人工找到测试、阅读日志并判断“恢复是否全部成功、是否发生重复写入”。

EVAL-103 将这些能力组合在同一评测中。场景不会在第一个错误处停止，而是完成全部故障注入，统一输出每条检查、指标、硬门槛和总判定；CI 可以只依据退出码阻止不安全版本发布。

### 固定场景

| 场景 | 故障注入 | 必须满足的结果 |
| --- | --- | --- |
| `checkpoint_before_model_crash` | 模型调用前进程重建 | 从 `planner.invoke_model` 恢复，事件水位继续为 7。 |
| `completed_side_effect_replay` | 工具结果落库后进程重建 | 恢复计划携带可复用结果，新实例不重复外部写。 |
| `side_effect_result_persistence_crash` | 外部写完成、ToolResult 落库前退出 | ToolCall=`UNKNOWN`、Run=`PAUSED`，再次调用被拒绝。 |
| `side_effect_timeout_pause` | 写工具提交后超时 | Signal 中止，ToolCall=`UNKNOWN`、Run=`PAUSED`，不再次提交。 |
| `root_cancellation` | LLM 执行中根取消 | 取消请求先落库，只产生 `run.cancelled`，终态为 `CANCELLED`。 |
| `cancellation_blocks_late_tool_call` | 取消后 Planned runner 故意产出工具载荷 | Runtime 不发布工具事件、不持久化 ToolCall，只保留取消终态。 |

### 指标与硬门槛

每个场景输出统一 `checks` 和 `metrics`，报告汇总以下硬门槛：

| 门槛 | 阈值 | 本次结果 |
| --- | --- | --- |
| 全部场景通过 | `6/6` | `6/6` |
| Recovery Success | `>= 100%` | `4/4 = 100%` |
| Duplicate Side Effects | `<= 0` | `0` |
| Tool Calls After Cancellation | `<= 0` | `0` |

`cancellationLatencyMs` 同时写入场景指标，但当前没有历史性能基线，因此本任务不为它设置虚构阈值。

### 运行方式

```bash
cd api
npm run --silent eval:durable-runtime
```

命令向 stdout 输出一个 `schemaVersion=1`、`evaluationId=EVAL-103` 的 JSON 对象。全部门槛通过时退出码为 0；任一场景失败、恢复率低于 100%、出现重复副作用或取消后新 ToolCall 时退出码为 1。

### 主要流程

```text
加载固定故障场景
  → 每个场景创建独立事务内存状态
  → 驱动真实 Runtime/Checkpoint/Recovery/Tool 服务
  → 收集 checks + metrics，不因单场景失败中断
  → 汇总恢复率、重复副作用、取消后 ToolCall
  → 计算硬门槛
  → 输出单一 JSON + 设置进程退出码
```

### 保护规则和当前边界

- 评测调用真实领域服务，不重新实现恢复或幂等判断；内存 store 只替代 PostgreSQL 存储。
- 每个场景使用独立 store，运行顺序不会污染结果；UoW 抛错时回滚 Run、Step、ToolCall、Checkpoint 和 Interruption。
- 负向契约会主动制造恢复率不足、重复副作用和取消后 ToolCall，证明门槛确实失败而不是固定返回通过。
- 报告只输出到 stdout，不在工作树写动态文件；报告归档和版本趋势属于 EVAL-106。
- 真实 PostgreSQL、LLM、Sandbox、MCP 和 A2A 故障仍由各 integration/adapter suite 负责，本评测追求确定性发布门禁而非基础设施压测。

## Scope

### In scope

- Checkpoint 前崩溃后从精确节点和事件水位恢复。
- 工具结果已持久化后的跨实例复用。
- 副作用提交后、结果持久化前崩溃时进入 UNKNOWN/PAUSED 且不重放。
- 副作用工具超时后的 UNKNOWN/PAUSED 收敛。
- 根取消先落库、停止执行并进入 CANCELLED，取消后不调度新 ToolCall。
- 统一 JSON 报告、发布门槛计算和非零退出码。

### Out of scope

- 真实 LLM、Sandbox、MCP、A2A 或 PostgreSQL 的稳定性压测。
- Direct/Single Tool/Planned Agent 的历史 P95 性能比较。
- 报告历史存储、趋势比较和 UI；属于 EVAL-106。
- Skills 与多 Agent 专项；分别属于 EVAL-104、EVAL-105。

## Acceptance Checklist

- [x] 崩溃、超时、取消和不确定副作用均有独立评测场景。
- [x] 所有可恢复场景 100% 到达预期恢复结果。
- [x] 重复副作用数量为 0。
- [x] 取消后新 ToolCall 数量为 0。
- [x] 报告可机器读取，包含场景结果、指标、门槛和总判定。
- [x] 任一硬门槛失败时评测命令返回非零退出码。
- [x] 新增测试标题、函数注释和重要逻辑说明使用中文。
- [x] 专项、完整契约、类型检查和构建通过。
- [x] [evidence.md](./evidence.md)、[worklog.md](./worklog.md) 和总任务清单已更新。

## 改造前后对比

| 对比项 | 改造前 | 完成后 | 实际影响 |
| --- | --- | --- | --- |
| 耐久性结论 | 恢复、取消、幂等测试分散，需人工组合结论。 | 一条命令执行六个固定故障场景并给出总判定。 | 发布检查可自动化，不再依赖人工阅读多个测试日志。 |
| 结果格式 | Node test 输出主要面向开发者阅读。 | 输出稳定 JSON Schema，包含场景、检查、指标、门槛和错误。 | CI、后续报告或趋势系统可以直接消费。 |
| 重复副作用 | 单个测试断言调用次数，没有统一总指标。 | 每个场景记录逻辑副作用和实际副作用，汇总重复数量。 | 任何重复写都会直接突破零容忍门槛。 |
| 取消保护 | 已有适配器和 Runtime 取消契约，但没有统一发布指标。 | 同时覆盖根取消和取消后晚到工具载荷拦截。 | 可明确证明取消后不会出现新 ToolCall。 |
| 失败门槛 | 测试失败会报错，但没有对恢复率和总重复次数建模。 | 独立 gate 函数计算阈值，CLI 映射为 0/1 退出码，并有负向契约。 | 门槛本身也受到测试保护，不能静默失效。 |

## Current State

- 当前进展：六个场景、JSON 报告、四项硬门槛、CLI 和负向门槛契约已完成。
- 当前阻塞：无。
- 下一步：执行 EVAL-101 建立版本化真实任务集和历史基线，再由 EVAL-106 汇总质量、延迟和耐久性趋势。

## Task Files

- [worklog.md](./worklog.md)：实施与验证过程。
- [evidence.md](./evidence.md)：场景、门槛和自动化验证证据。

## Latest Session State

- Current state: `done`，专项评测全部达到硬门槛。
- Remaining work: 无。
- Blockers: 无。
- Recommended next action: `EVAL-101`。
