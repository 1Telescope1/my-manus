# EVAL-102 Worklog

## 2026-07-16 — 建立 legacy 契约测试基线

### Goal

- 固化 Session API、SSE 数据映射和核心事件顺序。

### Investigation

- 检查了 `SessionController`、`EventMapper`、领域 Event/Plan/Session 模型、`PlannerReActFlow`、`ReActAgent` 和 UI 消费类型。
- 当前 SSE 使用 `event: <type>` 与单行 JSON `data:`；所有事件携带秒级 `created_at`，领域事件 id 映射为 `event_id`。
- legacy 完成路径以 `plan(completed)` 后接 `done` 结束；询问用户路径在 tool calling/called 之间映射消息，并以 `wait` 结束本轮读取。

### Changes

| 文件 | 变更原因 |
| --- | --- |
| `docs/agent-core-modernization/TASKS.md` | 将任务链接并标为实施中。 |
| `docs/agent-core-modernization/tasks/EVAL-102/*` | 建立任务范围、日志和证据记录。 |
| `api/package.json` | 增加可重复运行的契约测试入口。 |
| `api/tsconfig.test.json` | 对产品代码和契约测试共同执行严格类型检查。 |
| `api/test/contracts/event-sse.contract.test.ts` | 固化 Plan、Step、Tool、Wait、Done 的 wire payload。 |
| `api/test/contracts/session-api.contract.test.ts` | 固化 Session API、404 和 SSE framing。 |
| `api/test/contracts/planner-event-order.contract.test.ts` | 固化正常完成、工具调用和等待用户的事件顺序。 |

### Verification

- `npm run test:contract`：通过，11/11 tests passed。
- `npm run typecheck`：通过。
- `npm run build`：通过。
- `git diff --check`：通过。

### Findings

- API 包当前没有 test script；需要使用仓库已有的 `tsx` 和 Node test runner 建立轻量测试入口。
- Plan SSE 当前不传递 plan 的 id/title/status，只传递 `steps`；这是已固化的 legacy wire contract。
- Tool SSE 当前不传递 `function_result`，调用完成后的展示数据来自可选 `content`。
- `message_ask_user` 的 tool 事件不会对外透传，外部顺序是 `step(started) -> message -> wait`。

### Next

- 在新 Runtime/Event Adapter 实施时持续运行 `npm run test:contract`。
