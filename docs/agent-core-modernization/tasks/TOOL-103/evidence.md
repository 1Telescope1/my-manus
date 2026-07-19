# TOOL-103 Evidence

## Acceptance Results

| 验收项 | 状态 | 证据 |
| --- | --- | --- |
| Signal、Timeout、Risk、Approval、Idempotency 和统一结果 | Pass | `tool-invocation.ts`、`tool-result.ts`、`tool-invocation.service.ts`。 |
| 超时、取消、校验错误、重试和副作用策略 | Pass | `tool-invocation.contract.test.ts` 12 个中文契约测试。 |
| Single Tool 与 ReAct 真实接线 | Pass | `runtime/adapters.ts`、`base-agent.ts`；真实接线测试断言统一结果和幂等语义。 |

## Verification Commands

| 命令或场景 | 结果 | 备注 |
| --- | --- | --- |
| `node --import tsx --test test/contracts/tool-invocation.contract.test.ts` | Pass | 12/12。 |
| 三个相关契约文件联合执行 | Pass | 20/20，覆盖专项、Single Tool 和 ReAct。 |
| `npm run test:contract` | Pass | 159/159，包含 `test:contract:typecheck`。 |
| `npm run build` | Pass | Nest 生产构建成功。 |
| `git diff --check` | Pass | 无空白错误。 |

## Compatibility and Failure Cases

| 场景 | 预期 | 实际结果 |
| --- | --- | --- |
| 现有成功 `ToolResult` | 保持 `success/data` 可消费，并补充 metadata | Pass；真实搜索结果和 UI 事件契约通过。 |
| 需要审批但无批准 | 不执行工具，返回结构化审批错误 | Pass；缺失 gate 为 `approval_required`，拒绝为 `approval_denied`。 |
| 只读瞬时失败 | 在上限内重试 | Pass；第三次成功，metadata.attempts=3。 |
| 副作用工具无适配器幂等保证 | 不自动重试 | Pass；即使提供 key 也只执行一次。 |
| 副作用工具有适配器幂等保证 | 携带相同 key 后允许受控重试 | Pass；第二次成功。 |
| 超时或外部取消 | 停止消费结果并返回可区分错误 | Pass；分别为 `timeout`、`cancelled`。 |
| 幂等重放、冲突和并发占用 | 重放不执行，冲突/执行中可区分 | Pass；实际工具只执行一次。 |
| 工具返回 `success:false` | 不包装为成功，补齐结构化错误 | Pass；归一为 `execution_failed`。 |

## Completion Evidence

- 相关提交或 PR：待提交。
- 评测或运行报告：专项 12/12；全量契约 159/159；类型检查和构建通过。
- 未解决限制：大型结果 Artifact 化属于 TOOL-106。
- 最终结论：`pass`，TOOL-103 验收完成。
