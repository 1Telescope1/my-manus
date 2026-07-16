# EVAL-102 Evidence

## Acceptance Results

| 验收项 | 状态 | 证据 |
| --- | --- | --- |
| 当前 legacy Session API 行为有可执行基线 | Pass | `session-api.contract.test.ts` 覆盖创建、列表、详情、404、chat SSE 和 sessions SSE。 |
| Plan、Step、Tool、Wait、Done 必填字段被验证 | Pass | `event-sse.contract.test.ts` 对 JSON wire payload 做精确断言。 |
| 正常完成和等待路径的事件顺序被验证 | Pass | `legacy-event-order.contract.test.ts` 覆盖完整 PlannerReActFlow、普通工具步骤和 ask-user 等待路径。 |

## Verification Commands

| 命令或场景 | 结果 | 备注 |
| --- | --- | --- |
| `npm run test:contract` | Pass | 11 tests passed，0 failed；命令包含合同测试类型检查。 |
| `npm run typecheck` | Pass | 产品代码 TypeScript 检查成功。 |
| `npm run build` | Pass | Nest 构建成功。 |
| `git diff --check` | Pass | 无空白或补丁格式错误。 |

## Compatibility and Failure Cases

| 场景 | 预期 | 实际结果 |
| --- | --- | --- |
| 请求不存在的 Session 详情 | 保持 legacy NotFoundError | Pass，错误消息保持“该会话不存在，请核实后重试”。 |
| 用户输入等待路径 | ask-user 工具折叠为 `step(started) -> message -> wait`，步骤保持 running | Pass。 |
| 普通工具步骤 | `step(started) -> tool(calling) -> tool(called) -> step(completed) -> message` | Pass。 |
| 正常完成路径 | 完成事件以 `plan(completed) -> done` 收尾 | Pass。 |
| SSE 连接格式 | 200、三项 legacy header、`event:` + JSON `data:` + 空行 | Pass。 |

## Completion Evidence

- 相关提交或 PR：未创建。
- 评测或运行报告：`npm run test:contract` 本地运行 11/11 通过。
- 未解决限制：本任务使用内存 fake，未覆盖真实 Redis/PostgreSQL/Sandbox/LLM；这些基础设施不影响本任务的确定性 API/Event 合同范围。legacy 尚无 `sequence` 字段，此项属于 COMPAT-101。
- 最终结论：`pass`，EVAL-102 验收条件全部满足。
