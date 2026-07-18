# RUNTIME-104 Evidence

## Acceptance Results

| 验收项 | 状态 | 证据 |
| --- | --- | --- |
| RouteDecision Schema | Pass | 严格拒绝未知字段、非法 RouteKind、越界置信度、缺少 Workflow 名称和 Direct 外部能力。 |
| 确定性规则 | Pass | 按注册顺序同步执行，首个命中后停止后续规则且不调用模型。 |
| 模型回退 | Pass | 无规则命中时调用轻量模型；异常、无效结构和低置信结果均回退 `planned_agent`。 |
| 四路径覆盖 | Pass | `direct`、`single_tool`、`workflow`、`planned_agent` 均有独立中文测试。 |
| 无副作用路由 | Pass | LLM 调用参数不含 `tools` 和 `toolChoice`，模型端口没有工具执行方法。 |

## Verification Commands

| 命令或场景 | 结果 | 备注 |
| --- | --- | --- |
| `node --import tsx --test test/contracts/runtime-router.contract.test.ts` | Pass | 10 tests passed，0 failed。 |
| `npm run test:contract`（`api/`） | Pass | 53 tests passed，0 failed。 |
| `npm run test:contract:typecheck`（`api/`） | Pass | 产品代码和全部合同测试 TypeScript 检查成功。 |
| `npm run build`（`api/`） | Pass | NestJS 生产构建成功。 |
| `git diff --check` | Pass | 无空白或补丁格式错误。 |

## Compatibility and Failure Cases

| 场景 | 预期 | 实际结果 |
| --- | --- | --- |
| 确定性 Direct 规则命中 | 返回 Direct，不调用模型 | Pass。 |
| 单工具模型决策 | 返回 Single Tool 和能力集合 | Pass。 |
| 固定 Workflow 规则命中 | 返回 Workflow 和名称，后续规则不执行 | Pass。 |
| 开放复杂请求 | 接受合法 Planned Agent 决策 | Pass。 |
| 模型输出无效 | 回退 Planned Agent，并保留请求的 Skill | Pass。 |
| 模型置信度不足或调用失败 | 回退 Planned Agent，不向上抛出 | Pass。 |
| 路由模型请求 | 不携带任何工具或副作用入口 | Pass。 |
| legacy Session/SSE | 行为不变 | Pass；本任务没有接入 legacy 请求路径。 |

## Completion Evidence

- 相关提交或 PR：未创建。
- 评测或运行报告：RUNTIME-104 专项 10/10、全量合同 53/53 通过。
- 未解决限制：具体 Registry 规则属于后续 Tool/Skill/Workflow/Agent 任务，四类执行器属于 RUNTIME-105，实际请求接线属于 RUNTIME-108。
- 最终结论：`pass`，RUNTIME-104 验收条件全部满足。
