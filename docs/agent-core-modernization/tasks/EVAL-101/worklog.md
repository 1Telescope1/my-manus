# EVAL-101 Worklog

## 2026-07-20 — 固定任务集与统一运行器

### Goal

- 建立覆盖 SDD 场景、可重复执行并输出机器可读质量基线的统一 Evaluation 入口。

### Investigation

- EVAL-103 已提供可复用的耐久执行场景和指标报告。
- 当前缺少独立于测试代码的任务数据、统一 observation、跨 evaluator grader 和基线产物。
- SDD 中 Artifact、Skill 专项和 Multi-Agent 场景尚未全部具备生产实现，必须与“已执行失败”区分。
- LLM 端口尚未返回 Token usage，当前只能显式记录不可用。

### Changes

| 文件 | 变更原因 |
| --- | --- |
| `docs/agent-core-modernization/TASKS.md` | 将 EVAL-101 标记为 `in_progress` 并链接任务目录。 |
| `docs/agent-core-modernization/tasks/EVAL-101/*` | 建立范围、证据、日志和验收记录。 |
| `api/test/evaluation/datasets/agent-quality.v1.json` | 保存 23 项版本化任务、期望和 evaluator 路由。 |
| `api/test/evaluation/agent-quality.evaluation.ts` | 定义严格 Schema、统一 evaluator/observation、grader、指标和报告。 |
| `api/test/evaluation/current-agent-quality.evaluators.ts` | 驱动真实 Runtime Executor，并复用 EVAL-103 六个耐久场景。 |
| `api/test/evaluation/run-agent-quality.evaluation.ts` | 输出单一 JSON 并把总判定映射为退出码。 |
| `api/test/contracts/agent-quality-evaluation.contract.test.ts` | 覆盖任务集完整性、重复执行、负例和 evaluator 配置失败。 |
| `api/package.json` | 新增 `eval:agent-quality` 命令。 |

### Verification

- `node --import tsx --test test/contracts/agent-quality-evaluation.contract.test.ts`：5/5 通过。
- `npm run eval:agent-quality`：9/9 启用任务通过，退出码 0。
- `npm run test:contract`：167/167 通过。
- `npm run typecheck`：通过。
- `npm run build`：通过。

### Findings

- 数据集覆盖率与当前 evaluator 执行覆盖率必须分开，否则未实现场景会被静默遗漏或伪装成成功。
- EVAL-103 可作为统一 runner 的一个 evaluator，而不是被 EVAL-101 复制。
- 工具选择准确率必须只看工具序列检查，不能被回答文本等其他失败误伤。
- evaluator 异常或缺失仍要进入任务成功率分母，否则失败任务会被错误排除。
- 模型调用次数只有 3 个核心任务可测；报告同时记录数值 7 和测量覆盖 3，避免把缺失当作 0。

### Next

- EVAL-101 已完成；下一步可执行 MEMORY-102、EVAL-104 或 EVAL-106。
