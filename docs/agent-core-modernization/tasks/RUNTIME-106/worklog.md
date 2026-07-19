# RUNTIME-106 Worklog

## 2026-07-19

- 开始实施；完成现状证据收集并确定根取消链路。
- 修正 Task 生命周期：取消先通知 Runner 持久化，再触发根 `AbortController`，停止接口等待执行退出。
- Runtime 执行器新增取消短路与 `run.cancelled`；协调器写取消请求、终态 Checkpoint 和 `CANCELLED(confirmed)`。
- 将 Signal 贯穿 Router/Direct/Single Tool/Planner/ReAct/Summary LLM 和 BaseTool 注册桥。
- 接入 Shell、Browser、Search、MCP、A2A 底层取消；Shell 执行取消时额外终止沙箱进程。
- 新增 7 个取消契约；完整契约 119/119、类型检查和构建通过。
- PostgreSQL 集成测试因环境未配置 `DATABASE_URL` 未启动，已记录为验证边界。
- 修复实机停止回归：MCP SDK 将 `AbortError` 包装为普通 `Error` 时，Runner 改以根 Signal 的 `aborted` 状态识别取消。
- 取消分支不再继续抛出预期异常，只写入 `done(metadata.terminal_status=cancelled)` 并完成 Session 收敛。
- 新增 SDK 包装异常和 Runner 启动阶段取消契约；完整契约 128/128、API 生产构建通过。
- 只重建并重启 API 容器；`manus-api-1` 健康检查通过，Nginx 继续在 `8088` 对外提供服务。

## 2026-07-19 — 取消状态精简

- 删除与 `cancellation` Promise 重复的 `cancelled` 布尔值。
- 重复 `cancel()` 复用同一个取消流程，执行器统一通过 `isCancellationError(error, signal)` 识别根取消。
- 新增 Redis Task 重复取消顺序契约，确认只持久化一次请求并保持 `request → abort → done → release`。
- RUNTIME-106 专项 9/9、全量契约 159/159、测试类型检查和生产构建通过。
