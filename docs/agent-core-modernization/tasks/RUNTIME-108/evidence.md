# RUNTIME-108 Evidence

## 验收状态

| 验收项 | 状态 | 证据 |
| --- | --- | --- |
| 唯一 Runtime 入口 | 通过 | `AgentTaskRunner.runRuntime()` 是唯一消息执行路径；`SettingsService` 不再读取内核运行模式 |
| Run/Checkpoint 持久化 | 通过 | Runner 接线测试覆盖 completed/waiting、`route_completed`、`entering_terminal` 和 `entering_wait` |
| 路由分支覆盖 | 通过 | Direct、Single Tool、Workflow 回退和 Planned Agent 等待路径均有契约测试 |
| 生产 Direct 规则 | 通过 | “解释一下什么是乐观锁”跳过路由模型并创建 Direct Run；实时外部数据请求不命中 |
| 历史 Session | 通过 | 既有历史事件保持原引用和顺序，新 Run 从独立事件 sequence 开始 |
| UI 事件边界 | 通过 | Runtime 输出映射为 `tool/message/wait/done` 等 Session Event，并附加可选运行字段 |
| 首条消息标题 | 通过 | 默认会话产生 `message → title`；已命名会话不覆盖，Unicode 标题安全截断 |
| 附件隐私边界 | 通过 | `privateContext` 只供执行器读取；附件路径不进入 Runtime Event metadata |
| 实现精简 | 通过 | 删除重复 Prisma 字段类型、客户端双重断言、附件外层异常吞噬和不可达状态分支；保留 JSON、CAS、Checkpoint 与副作用恢复校验 |
| 过渡命名清理 | 通过 | `api/src`、`api/test` 无内核运行模式、版本化 Runtime 或旧入口命名残留 |
| 全量验证 | 通过 | 159 项契约测试、测试类型检查、API 生产构建和 Diff 检查通过 |

## 验证命令

在 `api/` 目录执行：

| 命令 | 结果 |
| --- | --- |
| `npm run test:contract:typecheck` | 通过 |
| `node --import tsx --test test/contracts/runtime-router.contract.test.ts test/contracts/runtime-event-adapter.contract.test.ts test/contracts/runtime-wiring.contract.test.ts test/contracts/planner-event-order.contract.test.ts` | 通过，24/24 |
| `npm run test:contract` | 通过，159/159 |
| `npm run typecheck` | 通过 |
| `npm run build` | 通过 |
| `node --import tsx --test test/contracts/agent-service-session-title.contract.test.ts` | 通过，3/3 |
| `git diff --check` | 通过 |
| `docker compose up -d --build --no-deps api` | 通过；API 容器 healthy |
| `curl -fsS http://localhost:8088/api/status` | 通过；PostgreSQL、Redis 均为 `ok` |

## 代码证据

- `api/src/application/services/agent.service.ts`：向真实 Runner 注入 Router 和 Event Adapter。
- `api/src/domain/services/runtime/agent-task-runner.ts`：唯一 Runtime 入口及共用 Session、文件和事件后处理。
- `api/src/domain/services/runtime/runtime.service.ts`：Run 创建、状态转换、路由及停止 Checkpoint。
- `api/src/domain/services/runtime/route-rules.ts`：生产默认 Direct 概念解释规则和外部上下文排除条件。
- `api/src/domain/services/runtime/router.service.ts`：规则优先级、模型回退和 Schema 错误详情。
- `api/src/domain/services/runtime/persistent-tool-idempotency.store.ts`：持久化工具占用、终态复用和不确定副作用处理。
- `api/src/domain/services/runtime/adapters.ts`：现有 LLM、工具和 Planner 能力适配。
- `api/src/domain/services/tools/agent-toolset.ts`：正式 Runtime 共用工具集合。
- `api/src/infrastructure/prisma/agent-run.mapper.ts`：从 Prisma 类型派生持久化字段，并在 JSON 边界保留必要校验。
- `api/src/infrastructure/repositories/db-agent-run.repository.ts`：以最小 Prisma 客户端接口同时支持根连接和事务连接。
- `api/test/contracts/runtime-wiring.contract.test.ts`：历史 Session、Direct、Single Tool、Workflow 回退和 waiting 验证。
- `api/test/contracts/agent-service-session-title.contract.test.ts`：路由无关的首消息标题、不覆盖和 Unicode 截断验证。

## 未解决限制

- 真实取消、工具幂等和完整 Registry 不在本任务范围。
- Direct/Single Tool 的长期会话上下文、waiting 后同一 Run 恢复和进程启动自动恢复调度由后续任务实现。
- PostgreSQL 集成测试需要可从宿主访问的 `DATABASE_URL`。
