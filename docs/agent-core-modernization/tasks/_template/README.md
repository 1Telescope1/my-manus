# <TASK-ID> — <任务标题>

> 本目录是该任务的独立工作记录。总体设计以 [SDD](../../../agent-core-modernization-sdd.md) 为准，总体状态以 [TASKS.md](../../TASKS.md) 为准。

| 字段 | 值 |
| --- | --- |
| Workstream | `<workstream>` |
| Status | `in_progress` |
| Dependencies | `<TASK-ID 或 —>` |
| Started | `YYYY-MM-DD` |
| Last Updated | `YYYY-MM-DD` |
| Working Session | `<会话说明或链接>` |

## Intent

说明本任务解决的问题。引用总任务清单和 SDD，不复制整套总体设计。

## Scope

### In scope

- 本任务明确实施的行为。

### Out of scope

- 容易被顺手扩展、但属于其他任务的内容。

## Acceptance Checklist

- [ ] 从总任务清单复制并细化验收条件。
- [ ] 主要实现完成。
- [ ] 失败路径和兼容性已检查。
- [ ] 所有验证命令成功。
- [ ] [evidence.md](./evidence.md) 已填写。
- [ ] 总任务清单和本目录工作记录已更新。

## Current State

- 当前进展：尚未开始。
- 当前阻塞：无。
- 下一步：填写任务范围并开始首次实现记录。

## Task Files

- [worklog.md](./worklog.md)：按时间追加工作过程，保留历史。
- [evidence.md](./evidence.md)：验收项、测试结果和完成证据。
- `artifacts/`：可选；仅在任务需要保存设计草图、测试输出或其他长期材料时创建。

## Decisions and Risks

- 新的架构决定应写入 SDD 的 ADR；这里仅链接对应 ADR。
- 记录尚未消除的实现风险和兼容限制。

## Latest Session State

- Current state:
- Remaining work:
- Blockers:
- Recommended next action:
