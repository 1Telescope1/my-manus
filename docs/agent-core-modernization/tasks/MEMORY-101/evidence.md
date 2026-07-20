# MEMORY-101 Evidence

## Acceptance Results

| 验收项 | 状态 | 证据 |
| --- | --- | --- |
| 四类数据边界明确 | Pass | Run State 复用 `agent-run.ts`；新增 `conversation-memory.ts`、`working-context.ts` 和 `artifact.ts`。 |
| 类型和仓储职责可复核 | Pass | `ConversationMemoryRepository` 从 `SessionRepository` 拆出；Working Context 明确无仓储；Artifact 仓储推迟到真实消费者出现时建立。 |
| 执行游标不依赖聊天消息 | Pass | 专项测试分别创建 Run/Checkpoint 并断言 Conversation Memory 不含 `currentNode/resumeNode`。 |
| Session/API/Event 兼容 | Pass | 旧 JSON 往返专项通过；全量 162 项契约通过。 |

## Verification Commands

| 命令或场景 | 结果 | 备注 |
| --- | --- | --- |
| `cd api && node --import tsx --test test/contracts/memory-boundaries.contract.test.ts` | Pass | 3/3：游标、Working Context、旧 JSON 仓储。 |
| `cd api && npm run test:contract` | Pass | 162/162，全量契约无回归。 |
| `cd api && npm run typecheck` | Pass | 生产代码类型检查通过。 |
| `cd api && npm run build` | Pass | Nest 构建通过。 |
| `cd api && node --env-file=../.env --import tsx --test test/integration/agent-run-persistence.integration.test.ts` | Environment unavailable | 未运行 `postgres:5432`；没有执行到集成测试逻辑。本任务无 schema 变更。 |

## Compatibility and Failure Cases

| 场景 | 预期 | 实际结果 |
| --- | --- | --- |
| 读取旧 `Session.memories` JSON | 仍可恢复 Conversation Memory | Pass，读取原 `{ messages: [...] }` 并合并保存其他 Agent 不丢失。 |
| 更新运行游标 | 不修改 Conversation Memory | Pass，游标只存在于 Run/Checkpoint。 |
| 组装 Working Context | 不回写持久 Conversation Memory | Pass，修改快照后原消息和临时 Skill 指令均未进入持久对象。 |

## Completion Evidence

- 相关提交或 PR：当前工作区。
- 评测或运行报告：3 项专项、162 项全量契约、typecheck、build 全部通过。
- 未解决限制：Token 预算、结构化摘要、恢复重建和 Artifact 持久化属于后续任务。
- 最终结论：`done`；验收目标全部满足。
