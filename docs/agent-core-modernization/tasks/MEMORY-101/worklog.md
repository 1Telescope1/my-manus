# MEMORY-101 Worklog

## 2026-07-20 — 边界调查与首次实现

### Goal

- 明确四类数据的现有归属，以最小兼容改造完成领域边界和仓储拆分。

### Investigation

- `AgentRun/Checkpoint/Interruption` 已持久化运行状态和恢复游标，无需重复建模。
- `SessionRepository` 同时维护 Session 资料、Event、File 关联和 Agent 模型记忆。
- `Memory` 直接持有厂商兼容消息字典，并包含后续应被结构化摘要替换的轻量压缩。
- Run 级 Skill 指令当前临时注入模型且不写 Session Memory，已具备 Working Context 的正确生命周期，但缺少显式类型。
- `FileModel` 不能覆盖大型 Tool Result、截图和结构化数据等 Artifact 类别。

### Changes

| 文件 | 变更原因 |
| --- | --- |
| `docs/agent-core-modernization/TASKS.md` | 将任务标记为 `in_progress` 并链接工作目录。 |
| `docs/agent-core-modernization/tasks/MEMORY-101/*` | 建立任务范围、证据、日志和验收记录。 |
| `api/src/domain/models/conversation-memory.ts` | 将通用 `Memory` 收敛为只保存 Session 语义历史的领域对象。 |
| `api/src/domain/models/working-context.ts` | 定义单次模型调用输入，并提供不回写持久消息的简单组装函数。 |
| `api/src/domain/models/artifact.ts` | 只定义四类 Artifact 元数据，不提前设计引用和持久化行为。 |
| `api/src/domain/repositories/conversation-memory.repository.ts` | 从 Session 仓储拆出会话记忆端口。 |
| `api/src/infrastructure/repositories/db-conversation-memory.repository.ts` | 兼容现有 `Session.memories` JSON 的 Prisma 适配器。 |
| `api/src/domain/repositories/session.repository.ts`、`db-session.repository.ts` | 删除不属于 Session 资料仓储的模型记忆方法。 |
| `api/src/domain/services/agents/base-agent.ts` | 改用专用仓储，并通过 Working Context 注入 Run 级受保护指令。 |
| `api/test/contracts/memory-boundaries.contract.test.ts` | 覆盖游标隔离、临时上下文和旧 JSON 兼容。 |
| 既有 Memory 测试替身 | 改为实现 `conversationMemory` 仓储边界。 |

### Verification

- `node --import tsx --test test/contracts/memory-boundaries.contract.test.ts`：3/3 通过。
- `npm run test:contract`：162/162 通过。
- `npm run typecheck`：通过。
- `npm run build`：通过。
- `node --env-file=../.env --import tsx --test test/integration/agent-run-persistence.integration.test.ts`：环境未运行 `postgres:5432`，未执行到测试逻辑。

### Findings

- 最短路径不是再创建一套 `RunState` 数据结构，而是承认并复用已经正式接入的 AgentRun 聚合。
- Conversation Memory 可先保持现有 JSON 物理格式，只移动仓储责任，从而降低兼容风险。
- Working Context 先接入现有 Planner/ReAct 的受保护指令组装；统一预算和全路径选择应由 MEMORY-102 完成。
- Artifact 在出现真实存储消费者前不加入 UnitOfWork，避免注册没有生产实现的空端口。
- 收尾审阅删除了零消费者的 `ArtifactRepository`、Artifact 工厂与防御性校验，也删除了 Working Context 中尚未接入的 Evidence/Artifact 字段和双重对象复制。

### Next

- MEMORY-101 已完成；下一步可执行 MEMORY-102。
