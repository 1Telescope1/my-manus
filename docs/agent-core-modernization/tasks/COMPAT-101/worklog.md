# COMPAT-101 Worklog

## 2026-07-16 — 建立 Runtime Event 兼容适配器

### Goal

- 让 v2 模拟事件在不修改 UI 的前提下转换成现有 SSE 契约。

### Investigation

- 检查了 SDD 10.1、现有领域 Event、`EventMapper`、Session SSE 控制器和 UI 事件消费代码。
- 当前 UI 依赖 `plan`、`step`、`tool`、`message`、`wait`、`error`、`done`，并以 `tool_call_id` 合并工具状态。
- SDD 规定新增 `run_id`、`sequence`、`checkpoint_id`、`metadata` 必须可选，且 sequence 在单个 Run 内用于恢复和去重。

### Changes

| 文件 | 变更原因 |
| --- | --- |
| `docs/agent-core-modernization/TASKS.md` | 将任务链接并标为实施中。 |
| `docs/agent-core-modernization/tasks/COMPAT-101/*` | 建立任务范围、日志和证据记录。 |
| `api/src/domain/models/runtime-event.ts` | 定义适配器使用的统一 Runtime Event 联合类型。 |
| `api/src/application/compatibility/runtime-event.adapter.ts` | 实现 legacy 映射、运行字段透传和按 Run 去重。 |
| `api/src/domain/models/event.ts` | 为现有 Event 增加可选兼容字段。 |
| `api/src/interfaces/dto/event.dto.ts` | 将可选兼容字段传递到 SSE，同时保持 legacy 输出不变。 |
| `api/test/contracts/runtime-event-adapter.contract.test.ts` | 验证 v2 模拟事件、去重、失败和取消映射。 |

### Verification

- `npm run test:contract`：通过，16/16 tests passed，其中 5 项为 COMPAT-101 新增测试。
- `npm run typecheck`：通过。
- `npm run build`（API）：通过。
- `npm run build`（UI）：通过，未修改任何 UI 文件。
- `git diff --check`：通过。
- `npm run lint`（UI）：未通过；命中 2 个任务开始前已存在的规则错误，本任务未修改相关文件。

### Findings

- 现有 `EventMapper` 是稳定的 SSE 出口；适配器应输出领域 Event，而不是重复实现一套 SSE 序列化。
- UI 已忽略未知字段，因此可选兼容字段不会影响现有展示逻辑。
- Runtime 取消映射为现有 `done`，同时通过 `metadata.terminal_status=cancelled` 保留真实终态。
- sequence 水位按 Run 隔离；相同或更小的 sequence 被过滤，跳号允许通过。

### Next

- 后续在 COMPAT-102 中把适配器接到 v2 运行模式；持久化 sequence 水位由 Runtime/Session 接入任务负责。
