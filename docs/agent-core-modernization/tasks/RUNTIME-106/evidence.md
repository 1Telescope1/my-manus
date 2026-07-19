# RUNTIME-106 验收证据

## 自动化验证

| 验证项 | 命令 | 结果 |
| --- | --- | --- |
| 生产类型检查 | `cd api && npm run typecheck` | 通过。 |
| 测试类型检查 | `cd api && npm run test:contract:typecheck` | 通过。 |
| RUNTIME-106 专项 | `cd api && node --import tsx --test test/contracts/runtime-cancellation.contract.test.ts` | 9/9 通过：覆盖 SDK 包装取消和 Redis Task 重复取消顺序。 |
| Runner 取消回归 | `cd api && node --import tsx --test test/contracts/runtime-wiring.contract.test.ts` | 通过：启动阶段取消只输出 `done(metadata.terminal_status=cancelled)`，不抛异常。 |
| 完整契约测试 | `cd api && npm run test:contract` | 159/159 通过。 |
| 生产构建 | `cd api && npm run build` | 通过。 |
| API 镜像部署 | `docker compose up -d --build --no-deps api` | 通过；`manus-api-1` 重建并启动。 |
| 容器健康检查 | `docker compose ps api nginx` | API `healthy`，Nginx 继续监听 `8088`。 |
| PostgreSQL 集成测试 | `cd api && npm run test:integration:runtime` | 未执行到业务断言；环境缺少必需的 `DATABASE_URL`。 |
| Diff 格式检查 | `git diff --check` | 通过。 |

## Acceptance 对应证据

| Acceptance | 证据 |
| --- | --- |
| LLM 取消 | `LLM 取消应产生 run.cancelled 且不输出迟到消息`、`OpenAI 适配器应使用请求 Signal 中止厂商 HTTP 调用`。 |
| Shell 取消 | `Shell 取消应把 Signal 传到底层并停止消费命令结果`。 |
| Browser 取消 | `Browser 取消应把 Signal 传到底层并停止消费页面结果`。 |
| MCP 取消 | `MCP 取消应把 Signal 交给 SDK callTool`。 |
| A2A 取消 | `A2A 取消应中止远程 fetch`。 |
| 停止新调度并进入 CANCELLED | `根取消应先记录请求再收敛到 CANCELLED，且不调度后续事件`；断言首次请求时间、唯一 `run.cancelled` 事件、Run 状态和 `confirmed` metadata。 |
| SDK 包装取消 | `SDK 包装取消异常后应以根 Signal 的终止状态为准`；不依赖被 SDK 改写后的 `Error.name`。 |
| 重复取消幂等 | `Redis Task 重复取消应共用一次取消流程并保持请求先于根 Signal`；断言两次 `cancel()` 只产生一次请求，顺序为 `request → abort → done → release`。 |
| Session/SSE 取消终止 | `Runner 应将启动阶段取消视为正常终止而非错误`；断言无 `error`、不抛异常且保留 cancelled metadata。 |

## 可复核代码路径

- 根 Task 生命周期：`api/src/infrastructure/external/task/redis-stream-task.ts`
- 取消请求与终态持久化：`api/src/domain/services/runtime/runtime.service.ts`
- 停止调度与取消事件：`api/src/domain/services/runtime/executor.service.ts`
- LLM 传播：`api/src/domain/external/llm.ts`、`api/src/infrastructure/external/llm/openai-llm.ts`
- Tool context 传播：`api/src/domain/services/tools/base-tool.ts`
- Shell/Browser/MCP/A2A 适配器：`api/src/domain/services/tools/`、`api/src/infrastructure/external/`
- 专项测试：`api/test/contracts/runtime-cancellation.contract.test.ts`

## 已知验证边界

当前工作区没有 `DATABASE_URL`，因此 PostgreSQL 集成测试无法连接数据库。Run 的取消 CAS、Checkpoint 和终态转换已由内存契约仓储覆盖；真实数据库的通用 CAS/事务/迁移行为此前由 `RUNTIME-102` 集成测试负责，本任务没有修改 Prisma Schema、迁移或仓储实现。
