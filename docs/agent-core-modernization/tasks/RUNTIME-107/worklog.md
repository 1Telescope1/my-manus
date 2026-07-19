# RUNTIME-107 Worklog

## 2026-07-19

- 开始实施；确认数据库幂等底座已存在，缺口位于真实调用接线和恢复状态收敛。
- 扩展 `ToolIdempotencyStore` 生命周期为 reserve、start、complete，并增加 unresolved 结果语义。
- 实现 `PersistentToolIdempotencyStore`：为实际调用创建 TOOL Step，持久化 ToolCall 占用、状态和完整 ToolResult。
- 将持久化 store 接入 Single Tool 与 Planned Agent；Single Tool 改用基于 Run 的确定性调用 ID。
- 恢复时把进行中的副作用调用固化为 UNKNOWN，并用 Run 版本 CAS 进入 PAUSED；UNKNOWN 禁止再次调用外部工具。
- 保留 PENDING 接管与只读 RUNNING/UNKNOWN 安全重试语义。
- 新增跨实例重放、请求指纹冲突、写后崩溃、未知副作用暂停、只读重试和稳定调用身份契约。
- 完整契约 123/123、类型检查和构建通过；PostgreSQL 集成测试因未配置 `DATABASE_URL` 未启动。
