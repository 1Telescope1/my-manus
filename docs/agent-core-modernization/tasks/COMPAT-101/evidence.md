# COMPAT-101 Evidence

## Acceptance Results

| 验收项 | 状态 | 证据 |
| --- | --- | --- |
| Runtime Event 映射覆盖现有 UI 事件 | Pass | 适配器覆盖 Title、Message、Plan、Step、Tool、Wait、Error、Done。 |
| 新增字段可选且 legacy 契约不变 | Pass | `run_id`、`sequence`、`checkpoint_id`、`metadata` 仅在有值时输出；EVAL-102 回归通过。 |
| sequence 可按 Run 去重 | Pass | 测试覆盖重复、过期、跨 Run 隔离和显式 reset。 |
| UI 无需修改即可消费 v2 模拟事件 | Pass | v2 wire payload 保留旧事件名与必填字段；UI 未改动且生产构建通过。 |

## Verification Commands

| 命令或场景 | 结果 | 备注 |
| --- | --- | --- |
| `npm run test:contract` | Pass | 16 tests passed，0 failed；包含原有契约回归和 5 项兼容测试。 |
| `npm run typecheck` | Pass | API 产品代码 TypeScript 检查成功。 |
| `npm run build`（API） | Pass | Nest 构建成功。 |
| `npm run build`（UI） | Pass | Next.js 生产构建和 TypeScript 检查成功。 |
| `git diff --check` | Pass | 无空白或补丁格式错误。 |
| `npm run lint`（UI） | Existing issue | 2 个既有错误位于未改动的 `tool-preview-panel.tsx` 和 `sidebar.tsx`；另有 24 个既有 warning。 |

## Compatibility and Failure Cases

| 场景 | 预期 | 实际结果 |
| --- | --- | --- |
| legacy 事件 | 不新增任何已定义值之外的字段 | Pass，EVAL-102 精确 JSON 断言继续通过。 |
| v2 模拟事件 | 保持旧字段并增加可选运行元数据 | Pass。 |
| 重复/过期 sequence | 不重复输出 | Pass。 |
| 两个 Run 使用相同 sequence | 分别输出 | Pass。 |
| 非法 sequence | 拒绝进入兼容事件流 | Pass，负数和非安全整数由适配器拒绝。 |
| Runtime 取消 | 映射为 done，并保留 `metadata.terminal_status=cancelled` | Pass。 |

## Completion Evidence

- 相关提交或 PR：未创建。
- 评测或运行报告：`npm run test:contract` 本地运行 16/16 通过。
- 未解决限制：sequence 水位目前保存在适配器实例内，不跨进程持久化；实际 v2 执行器接线和重连水位恢复属于 RUNTIME-103、RUNTIME-108、COMPAT-102。
- 最终结论：`pass`，COMPAT-101 验收条件全部满足。
