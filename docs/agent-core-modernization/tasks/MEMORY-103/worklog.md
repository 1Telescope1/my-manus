# MEMORY-103 Worklog

## 2026-07-21 — 可溯源结构化摘要实施

### Goal

- 用结构化摘要替换当前轻量删除式压缩。
- 保证事实不被错误升级，Pending Work、Skill 和 Artifact 引用可继续使用。

### Investigation

- `ConversationMemory.compact()` 只删除部分内容，没有摘要、来源或失败保护。
- MEMORY-102 已控制单次输入预算，但被省略的早期语义当前不会回到 Working Context。
- `Plan.steps` 和 `SkillDisclosure.activated` 是 Pending Work、附件与激活 Skill 的权威结构化来源。
- Session JSON 可通过增加可选字段兼容演进，无需数据库迁移。
- 成功工具结果可以形成严格事实边界；用户和 assistant 文本只能作为目标、约束或决策来源。

### Changes

| 文件 | 变更原因 |
| --- | --- |
| `docs/agent-core-modernization/TASKS.md` | 将 MEMORY-103 置为进行中并链接任务证据。 |
| `docs/agent-core-modernization/tasks/MEMORY-103/*` | 固化现状证据、范围、验收项和执行记录。 |
| `api/src/domain/models/memory-summary.ts` | 定义摘要 Schema、来源范围、生成时间和 Working Context 格式。 |
| `api/src/domain/models/conversation-memory.ts` | 持有可选摘要、推导稳定来源序号并原子替换消息前缀。 |
| `api/src/domain/services/memory/memory-compaction.service.ts` | 实现预算触发、原子分组、LLM 候选生成、事实校验和失败保护。 |
| `api/src/domain/services/agents/base-agent.ts` | 用结构化压缩替换旧 `compact()`，并将摘要注入受保护 Working Context。 |
| `api/src/domain/services/flows/planner-react-flow.ts` | 从 Plan、请求附件和 Skill Disclosure 构造权威摘要上下文。 |
| `api/src/domain/services/runtime/adapters.ts` | 将结构化 Skill Disclosure 传入 Planned Agent 压缩链路。 |
| `api/src/infrastructure/repositories/db-conversation-memory.repository.ts` | 在现有 Session JSON 中保存并恢复可选摘要。 |
| `api/src/infrastructure/prisma/session.mapper.ts` | 保持 Session 聚合路径与独立 Memory 仓储使用同一快照格式。 |
| `api/test/contracts/memory-structured-summary.contract.test.ts` | 覆盖长会话事实边界、待办、重复压缩、取消、Working Context 和兼容性。 |

实施后复审删除了没有生产消费者的三态压缩结果、仅供测试的时钟注入、来源字符串反解析、损坏摘要隔离和逐项淘汰摘要字段。摘要模型也不再生成已有权威来源的完成工作、待办、Skill 和 Artifact；完整摘要放不下时直接保留原消息。

### Verification

- MEMORY-103 专项契约：8/8 通过。
- API 全量契约：182/182 通过。
- API `typecheck`、`build`：通过。
- EVAL-101：9/9 已启用任务通过，数据集指纹保持 `ad60834d...cecbc0`。
- PostgreSQL 集成命令因环境未提供 `DATABASE_URL` 在前置断言停止；本任务无数据库迁移。

### Findings

- 不能让摘要模型自行决定哪些内容是“已确认事实”；必须在生成后用来源类型和原文包含关系校验。
- Pending Work 和 Artifact 引用已有结构化来源，让模型重新提取会降低可靠性。
- 重复压缩需要稳定消息序号，否则删除前缀后来源索引会漂移。
- 事实和约束不能为了满足摘要预算而静默淘汰；核心字段放不下时保留原始消息。
- 摘要引入新的异步模型阶段后必须继承根 Signal，并在写回前再次检查取消状态。

### Next

- 开始 MEMORY-104，设计 Checkpoint 恢复时的摘要版本、Skill 和 Artifact 重建。
