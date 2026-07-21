# MEMORY-103 Evidence

## Acceptance Results

| 验收项 | 状态 | 证据 |
| --- | --- | --- |
| 结构化摘要替代轻量删除并进入 Working Context | Pass | `ConversationMemory.replaceHistoryWithSummary()`；`BaseAgent.invokeLlm()`；专项“摘要应写入 Working Context”通过。 |
| 未验证内容不会升级为 `confirmedFacts` | Pass | 专项长会话同时注入用户假设、成功工具和失败工具，仅成功工具原文 `message:2` 被接受。 |
| Pending Work、Skill 和 Artifact 引用可保留 | Pass | `createPlanMemoryCompactionContext()` 从 Plan、Message 和 Skill Disclosure 取权威值；两项专项通过。 |
| 来源区间和生成时间可持久化恢复 | Pass | 重复压缩保持 `message:0..6` 连续；仓储恢复后摘要和值一致。 |
| 压缩不会过早触发 | Pass | 历史未超过输入预算 70% 时不调用摘要生成器，超过后才执行压缩。 |
| 旧 Session JSON 保持兼容 | Pass | `summary` 为可选字段，`messages`-only JSON 恢复为空摘要；其他 Agent 记录保持不变。 |
| 压缩失败和工具原子性受保护 | Pass | 生成器失败和根取消均保持快照不变；assistant tool call 与 tool result 成组压缩。 |

## Verification Commands

| 命令或场景 | 结果 | 备注 |
| --- | --- | --- |
| `node --import tsx --test test/contracts/memory-structured-summary.contract.test.ts` | Pass | 8/8。 |
| `npm run test:contract` | Pass | 182/182。 |
| `npm run typecheck` | Pass | `tsc --noEmit` 无错误。 |
| `npm run build` | Pass | Nest build 成功。 |
| `npm run eval:agent-quality` | Pass | EVAL-101 已启用任务 9/9，失败 0。 |
| `npm run test:integration:runtime` | Not run | 环境未提供 `DATABASE_URL`，在测试前置断言停止；本任务无数据库 Schema 变更。 |

## Compatibility and Failure Cases

| 场景 | 预期 | 实际结果 |
| --- | --- | --- |
| 读取旧 `messages`-only JSON | 使用空摘要和计数零恢复 | Pass |
| 摘要生成失败或 JSON 无效 | 保留全部原始消息 | Pass |
| 用户假设或失败工具结果被列为事实 | 从 `confirmedFacts` 丢弃 | Pass |
| 多次压缩 | 来源消息序号和区间保持稳定 | Pass |
| 根取消在摘要前或摘要中发生 | 传播取消且不写回迟到结果 | Pass |
| 核心摘要字段超过预算 | 返回失败并保留原始消息 | 代码路径与失败原子性契约覆盖 |

## Completion Evidence

- 相关提交或 PR：当前工作树，尚未提交。
- 评测或运行报告：专项长会话回归 8/8；EVAL-101 已启用任务 9/9。
- 未解决限制：正式 Artifact Store、超大 Tool Result 外置和 Checkpoint 上下文重建分别属于 TOOL-106、MEMORY-104；单条超大消息无法安全摘要时保留原文。
- 最终结论：`pass`，MEMORY-103 验收完成。
