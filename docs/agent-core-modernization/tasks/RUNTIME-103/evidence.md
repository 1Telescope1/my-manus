# RUNTIME-103 Evidence

## Acceptance Results

| 验收项 | 状态 | 证据 |
| --- | --- | --- |
| Checkpoint 边界 | Pass | 路由、模型前后、Step 前后、副作用提交前、工具结果后、WAIT/PAUSE、Handoff 前后和终态前均有稳定枚举值。 |
| 原子提交 | Pass | Checkpoint 服务在同一 UoW 中执行 Run CAS 和 append；Checkpoint 冲突会回滚已更新的 version/currentNode。 |
| 恢复解析 | Pass | 恢复计划包含精确 resumeNode、nextEventSequence、状态快照、Run 和最新 Checkpoint。 |
| 工具状态分类 | Pass | completed 可复用；pending 和只读 running/unknown 可重试；有副作用 running/unknown 进入 unresolved 并 PAUSE。 |
| 中断和运行状态 | Pass | 用户输入→WAIT，审批/PAUSED→PAUSE，终态→TERMINAL，无快照→NO_CHECKPOINT。 |
| 故障注入 | Pass | 模型前、模型后、工具结果持久化后重建新服务实例，均从预期精确节点恢复。 |

## Verification Commands

| 命令或场景 | 结果 | 备注 |
| --- | --- | --- |
| `node --import tsx --test test/contracts/runtime-recovery.contract.test.ts` | Pass | 9 tests passed，0 failed。 |
| `npm run test:contract`（`api/`） | Pass | 43 tests passed，0 failed；包含全部既有回归。 |
| `npm run test:contract:typecheck`（`api/`） | Pass | 产品、合同和集成测试 TypeScript 检查成功。 |
| `npm run typecheck`（`api/`） | Pass | 产品代码 TypeScript 检查成功。 |
| `npm run build`（`api/`） | Pass | NestJS 生产构建成功。 |
| `npm run test:integration:runtime`（一次性 PostgreSQL 16） | Pass | 真实事务 Checkpoint 提交、恢复分类及 RUNTIME-102 数据库验收通过。 |
| `git diff --check` | Pass | 无空白或补丁格式错误。 |

## Compatibility and Failure Cases

| 场景 | 预期 | 实际结果 |
| --- | --- | --- |
| 模型调用前崩溃 | 从模型调用节点继续 | Pass，恢复为 `planner.invoke_model` 和持久化事件水位。 |
| 模型完成后崩溃 | 从模型后的下一节点继续，不重复模型调用 | Pass，恢复为 `planner.apply_result` 并取得模型输出状态。 |
| 工具结果持久化后崩溃 | 复用结果并从工具后的下一节点继续 | Pass，completed 调用进入 reusable 集合，恢复到结果消费节点。 |
| 有副作用工具状态未知 | PAUSE，不自动重放 | Pass，UNKNOWN 外部通信/写调用进入 unresolved 集合。 |
| 只读工具状态 running/unknown | 可安全重试 | Pass，进入 retryable 集合且保持 RESUME。 |
| Checkpoint 追加冲突 | Run 游标/version 与 Checkpoint 整体回滚 | Pass，冲突后 version=0、currentNode 未推进且无快照。 |
| Run version 冲突 | 不追加 Checkpoint | Pass，错误阶段为 run 且快照数量为 0。 |
| 待用户输入或审批 | 分别 WAIT/PAUSE | Pass。 |
| 终态或无 Checkpoint | 不作为普通可恢复 Run 调度 | Pass，分别返回 TERMINAL/NO_CHECKPOINT。 |
| legacy Session/SSE | 行为不变 | Pass，既有合同测试全部通过；本任务未修改 legacy 流。 |

## Completion Evidence

- 相关提交或 PR：未创建。
- 评测或运行报告：RUNTIME-103 专项 9/9、全量合同 43/43、真实 PostgreSQL 集成 1/1 通过。
- 未解决限制：外部副作用查询属于 RUNTIME-107，完整上下文重建属于 MEMORY-104，实际执行路径和 legacy/v2 接线分别属于 RUNTIME-105、RUNTIME-108。
- 最终结论：`pass`，RUNTIME-103 验收条件全部满足。
