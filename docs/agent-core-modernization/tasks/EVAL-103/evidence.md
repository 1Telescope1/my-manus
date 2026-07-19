# EVAL-103 验收证据

## 专项评测结果

命令：

```bash
cd api
npm run --silent eval:durable-runtime
```

| 指标或门槛 | 阈值 | 实际结果 | 判定 |
| --- | --- | --- | --- |
| 场景通过 | 6/6 | 6/6 | Pass |
| Recovery Success | >= 100% | 4/4，100% | Pass |
| Duplicate Side Effects | <= 0 | 0 | Pass |
| Tool Calls After Cancellation | <= 0 | 0 | Pass |
| 总判定 | 全部门槛通过 | `passed=true`、退出码 0 | Pass |

报告为 `schemaVersion=1`、`evaluationId=EVAL-103` 的单一 JSON，包含 `summary`、`gates`、`scenarios[].checks`、`scenarios[].metrics` 和 `scenarios[].error`。

## 场景证据

| 场景 | 关键证据 |
| --- | --- |
| `checkpoint_before_model_crash` | `RESUME` 到 `planner.invoke_model`，`nextEventSequence=7`。 |
| `completed_side_effect_replay` | 新 store/service 返回 `replayed=true`，外部写次数 1。 |
| `side_effect_result_persistence_crash` | ToolCall=`UNKNOWN`、Run=`PAUSED`，重试返回 `uncertain_side_effect`，外部写次数 1。 |
| `side_effect_timeout_pause` | 结果=`timeout`、Signal 已 abort、恢复=`PAUSE`，外部提交次数 1。 |
| `root_cancellation` | 取消请求在 abort 前落库，事件仅 `run.cancelled`，Run=`CANCELLED(confirmed)`。 |
| `cancellation_blocks_late_tool_call` | runner 在取消后尝试调度一次工具，但发布事件和持久化 ToolCall 均为 0。 |

## 自动化验证

| 验证项 | 命令 | 结果 |
| --- | --- | --- |
| EVAL-103 专项 | `cd api && npm run --silent eval:durable-runtime` | 6/6 场景通过，四项门槛全部通过，退出码 0。 |
| 门槛契约 | `cd api && node --import tsx --test test/contracts/durable-runtime-evaluation.contract.test.ts` | 3/3 通过；正向报告、重复副作用/恢复率负例、取消后 ToolCall 负例。 |
| 测试类型检查 | `cd api && npm run test:contract:typecheck` | 通过。 |
| 生产类型检查 | `cd api && npm run typecheck` | 通过。 |
| 完整契约 | `cd api && npm run test:contract` | 131/131 通过。 |
| 生产构建 | `cd api && npm run build` | 通过。 |
| Diff 格式检查 | `git diff --check` | 通过。 |

## 门槛失效保护

`durable-runtime-evaluation.contract.test.ts` 会对一份真实通过报告注入以下失败：

- 将一个恢复场景改为 `recoverySucceeded=false`，恢复率门槛失败。
- 将重复副作用改为 1，零重复门槛失败。
- 将取消后 ToolCall 改为 1，取消门槛失败。

以上场景均断言 `durableRuntimeEvaluationExitCode(...) = 1`，证明 CLI 不会把越界报告静默当作成功。

## 可复核代码路径

- 场景、指标和 gate：`api/test/evaluation/durable-runtime.evaluation.ts`
- JSON/退出码入口：`api/test/evaluation/run-durable-runtime.evaluation.ts`
- 事务内存状态：`api/test/support/runtime-evaluation-store.ts`
- 门槛契约：`api/test/contracts/durable-runtime-evaluation.contract.test.ts`
- npm 命令：`api/package.json` 的 `eval:durable-runtime`。

## 验证边界

本评测使用可控内存持久化和故障替身，目标是提供确定、快速的领域发布门禁；不替代 PostgreSQL、真实模型、Sandbox、MCP 或 A2A 的 integration tests。取消耗时已采集但没有历史 P95 基线，本任务不设置性能阈值；基线和趋势报告属于 EVAL-101/EVAL-106。
