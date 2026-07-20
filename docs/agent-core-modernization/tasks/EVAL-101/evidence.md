# EVAL-101 Evidence

## Acceptance Results

| 验收项 | 状态 | 证据 |
| --- | --- | --- |
| 版本化任务集覆盖 SDD 场景 | Pass | `agent-quality.v1.json` 共 23 项，覆盖 10/10 SDD 场景类别；Schema 强制完整覆盖和唯一 ID。 |
| 统一运行器与结果 Schema | Pass | `AgentQualityEvaluator`、observation、逐项 checks、聚合 metrics 和 report 均为稳定结构。 |
| 结果机器可读且可重复运行 | Pass | CLI 输出单一 JSON；重复运行的数据集 SHA-256、任务判定和检查完全一致。 |
| 未实现能力不伪装成功 | Pass | 14 项 disabled 任务明确为 `not_evaluated`；已启用 evaluator 缺失则基线失败。 |

## Verification Commands

| 命令或场景 | 结果 | 备注 |
| --- | --- | --- |
| `cd api && node --import tsx --test test/contracts/agent-quality-evaluation.contract.test.ts` | Pass | 5/5：数据覆盖、统一报告、重复执行、错误结果和 evaluator 缺失。 |
| `cd api && npm run eval:agent-quality` | Pass | 9/9 启用任务通过，单一 JSON，退出码 0。 |
| `cd api && npm run test:contract` | Pass | 167/167，全量契约无回归。 |
| `cd api && npm run typecheck` | Pass | 生产类型检查通过。 |
| `cd api && npm run build` | Pass | Nest 构建通过。 |

## Compatibility and Failure Cases

| 场景 | 预期 | 实际结果 |
| --- | --- | --- |
| disabled evaluator 未接入 | 任务为 `not_evaluated` 且不计入成功率 | Pass，共 14 项并保留明确原因。 |
| 已启用 evaluator 未注册 | 视为配置失败且进入任务成功率分母 | Pass，专项负例验证失败报告。 |
| 已启用 evaluator 返回错误结果 | 检查失败且 CLI 非零退出 | Pass，错误工具序列使准确率和成功率为 0。 |
| Token usage 不可获得 | 报告为 `null` | Pass，不使用字符数估算。 |
| EVAL-103 场景 | 复用真实耐久报告 | Pass，六个场景只执行一次并按 scenario ID 适配。 |

## Baseline Summary

| 指标 | 当前基线 |
| --- | --- |
| Dataset | `manus-agent-quality@1.0.0`，SHA-256 `ad60834d03071b94af2352b9221238bc9446742d2c5162792f7e874290cecbc0` |
| SDD 数据覆盖 | 10/10 类，23 项任务 |
| 当前执行覆盖 | 9 项启用并执行；14 项 `not_evaluated` |
| Task Success Rate | 100%（9/9 已执行任务） |
| Tool Selection Accuracy | 100%（3/3 有工具序列期望的任务） |
| Model Calls | 7；测量覆盖 3 个核心任务 |
| Tool Calls | 6 |
| Token Usage | `null`，当前端口不可获得 |
| Recovery Success | 100%（4/4 恢复场景） |
| Duplicate Side Effects | 0 |
| Tool Calls After Cancellation | 0 |

## Completion Evidence

- 相关提交或 PR：当前工作区。
- 评测或运行报告：`npm run eval:agent-quality` 通过；关键指标见 Baseline Summary，完整 JSON 可由同一命令重复生成。
- 未解决限制：在线模型评测、Skill/Multi-Agent 专项和跨版本趋势属于后续任务。
- 最终结论：`done`；任务集、统一运行器和当前版本基线均满足验收。
