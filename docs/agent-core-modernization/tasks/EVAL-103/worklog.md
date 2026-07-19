# EVAL-103 Worklog

## 2026-07-19

- 开始实施；确认前置 Runtime 任务已完成，但耐久性证据仍分散在多个 contract test 中。
- 确定评测器直接驱动真实领域服务，使用可控内存持久化与故障替身隔离外部波动。
- 确定硬门槛：可恢复场景成功率 100%、重复副作用 0、取消后新 ToolCall 0、全部场景通过。
- 抽取共享 `RuntimeEvaluationStore`，由 RUNTIME-107 契约和 EVAL-103 runner 复用，避免重复维护持久化测试替身。
- 实现六个故障场景：Checkpoint 前崩溃、已完成副作用重放、结果落库前崩溃、副作用超时、根取消、取消后晚到工具拦截。
- 实现 `schemaVersion=1` JSON 报告，统一输出 checks、metrics、gates、summary 和场景错误。
- 增加 `eval:durable-runtime` 命令；全部门槛通过退出 0，否则退出 1。
- 增加三项门槛契约，证明恢复率不足、重复副作用和取消后 ToolCall 会触发失败。
- 专项评测 6/6、恢复 4/4、重复副作用 0、取消后 ToolCall 0；完整契约 131/131、类型检查和构建通过。
