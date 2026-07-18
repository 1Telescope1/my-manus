# RUNTIME-105 Evidence

## 验收状态

| 验收项 | 状态 | 证据 |
| --- | --- | --- |
| 四种路径可独立运行 | 通过 | `runtime-executor.contract.test.ts` 分别直接运行 Direct、Single Tool、Workflow、Planned Agent |
| 每种路径产生统一 Runtime Event | 通过 | `runtime-executor.service.ts` 的 `BaseRuntimeExecutor` 与 `RuntimeEventFactory`；专项测试检查事件类型、envelope 和终态 |
| sequence 单调且可从恢复水位继续 | 通过 | Direct 从水位 7 产生 sequence 7、8；其余路径检查 0 起连续序号 |
| Single Tool 至多一次主要调用 | 通过 | 固定编排只有一个 `invoker.invoke()` 调用点；测试确认 selector、invoker、responder 各调用一次 |
| 等待和失败终态明确 | 通过 | `run.waiting` 短路且无 completed；依赖异常转换为 `run.failed` |
| 路径与注册保护明确 | 通过 | 测试覆盖四路径缺失、重复注册及 Run/Decision 路径不一致 |
| legacy 行为未被改变 | 通过 | 未修改 `AgentTaskRunner`、Session、SSE 或 UI；原有契约测试全部通过 |

## 验证命令

在 `api/` 目录执行：

| 命令 | 结果 |
| --- | --- |
| `npm run test:contract` | 通过，61/61；其中 RUNTIME-105 专项 8/8 |
| `npm run typecheck` | 通过 |
| `npm run build` | 通过 |
| `git diff --check` | 通过，无空白错误 |

本任务未修改数据库、Prisma Schema 或仓储实现，因此没有重复运行 PostgreSQL 集成测试；持久化契约仍包含在通过的全量契约测试中。

## 代码证据

- `api/src/domain/services/runtime-executor.service.ts`
  - 公共请求、执行器与能力端口。
  - `RuntimeEventFactory` 和 `BaseRuntimeExecutor`。
  - 四类路径执行器与完整注册 Dispatcher。
  - 路径、状态、载荷、Single Tool 和 sequence 校验。
- `api/test/contracts/runtime-executor.contract.test.ts`
  - 四路径独立执行、统一事件、一次工具调用、等待、失败、注册和路径一致性测试。

## 未解决限制

- 真实 Session/SSE 接线属于 `RUNTIME-108`。
- Tool Registry、统一可靠调用、重试、审批和副作用幂等属于后续 Tool/Runtime 任务。
- 具体 Workflow、Planned Agent 和模型适配器由后续能力注册与接线任务提供。
- 本执行器接受恢复后的 `nextEventSequence`，但 Checkpoint 提交、Run 状态持久化和恢复调度仍需接线层协调。
