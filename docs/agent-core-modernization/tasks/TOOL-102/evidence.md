# TOOL-102 Evidence

## 当前证据表

| 确定结论 | 证据路径 | 不确定项 | 建议改动范围 |
| --- | --- | --- | --- |
| 两个真实工具模型入口当前都调用无条件 `registry.list()`。 | `base-agent.ts`、`runtime/adapters.ts` | 无。 | 用统一选择服务替换全量列表。 |
| RouteDecision 已包含 capability，但执行上下文未携带其他范围约束。 | `route-decision.ts`、`executor.service.ts` | 其他 Registry 尚未实现。 | 执行上下文增加不依赖模型厂商类型的可选约束对象。 |
| Router 模型输入没有可用 capability catalog。 | `llm-runtime-route-model.ts` | 动态 MCP capability 在初始化后才出现。 | Runtime 路由前从当前 Registry 增量读取 catalog。 |

## Acceptance Results

| 验收项 | 状态 | 证据 |
| --- | --- | --- |
| Router capability 相关性 | Pass | `search` 只选择 `search_web`，文件、MCP、Agent 工具不进入结果。 |
| 未授权工具隔离 | Pass | Agent 上界不包含写工具时，`file.write` 请求得到空集合和未覆盖诊断。 |
| 五类来源组合 | Pass | Router、Workflow、Agent、多个 Skill 和 Policy 的组合测试通过。 |
| Policy deny 优先 | Pass | risk/name deny 均覆盖 capability 与 Skill 显式请求。 |
| fail closed | Pass | 空选择信号返回零工具；未覆盖 capability 不回退 Registry 全量。 |
| 模型请求最小化 | Pass | Runtime wiring 中 Single Tool 模型只收到 `search_web`。 |
| 防伪调用 | Pass | 模型返回已注册但未披露的 `message_ask_user` 时，调用前被拒绝。 |
| Planned Agent 分阶段披露 | Pass | Planner/总结省略工具；ReAct 多轮只保留 `search_web`。 |
| Router canonical catalog | Pass | 模型输入收到 availableCapabilities；未知 capability 安全回退。 |
| 兼容性 | Pass | 全量 88 个契约测试和 Nest 生产构建通过。 |

## Verification Commands

| 命令或场景 | 结果 | 备注 |
| --- | --- | --- |
| `node --import tsx --test test/contracts/tool-selection.contract.test.ts` | Pass | 8 tests passed，0 failed。 |
| `node --import tsx --test test/contracts/tool-visibility.contract.test.ts` | Pass | 3 tests passed，0 failed。 |
| `npm run test:contract:typecheck`（`api/`） | Pass | 产品代码与全部契约测试 TypeScript 检查成功。 |
| `npm run test:contract`（`api/`） | Pass | 88 tests passed，0 failed。 |
| `npm run build`（`api/`） | Pass | NestJS 生产构建成功。 |
| `git diff --check` | Pass | 无空白或补丁格式错误。 |

## Compatibility and Failure Cases

| 场景 | 预期 | 实际结果 |
| --- | --- | --- |
| Single Tool 搜索 | 只披露并调用 `search_web` | Pass；现有 tool/message/done 事件不变。 |
| Direct | 不携带工具 | Pass。 |
| Planner 与总结 | 不携带工具 | Pass。 |
| ReAct 多轮 | 每轮保持同一最小集合 | Pass。 |
| Workflow/Agent 允许范围不相交 | 最终零工具 | Pass。 |
| 多 Skill | 请求并集仍受 Agent 上界约束 | Pass。 |
| Policy 禁止写风险 | 即使 Router 请求也移除 | Pass。 |
| 空信号 | 零工具 | Pass。 |
| 未知 Router capability | planned_agent 安全回退且不携带未知能力 | Pass。 |
| 模型伪造已注册函数名 | 不执行 | Pass。 |
| Session/SSE/Checkpoint | 字段和顺序保持兼容 | Pass；全量契约通过。 |

## Completion Evidence

- 相关提交或 PR：未创建。
- 评测或运行报告：TOOL-102 专项 11/11、全量契约 88/88、生产构建通过。
- 未解决限制：Workflow/Agent/Skill/Policy 的具体生产者由对应任务接入；可靠调用属于 TOOL-103；MCP 动态管理属于 TOOL-104；Precision/Recall 报告属于 EVAL-104。
- 最终结论：`pass`，TOOL-102 验收条件全部满足。
