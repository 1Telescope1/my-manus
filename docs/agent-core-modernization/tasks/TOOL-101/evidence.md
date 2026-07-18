# TOOL-101 Evidence

## 当前证据表

| 确定结论 | 证据路径 | 不确定项 | 建议改动范围 |
| --- | --- | --- | --- |
| 当前没有统一 Registry，调用方各自遍历 `BaseTool[]`。 | `base-agent.ts`、`runtime/adapters.ts` | 无。 | 用同一领域 Registry 取代重复查找逻辑。 |
| MCP 名称已带 server 前缀。 | `mcp.tool.ts` | MCP 原始 schema 不含 risk/capability。 | 保留前缀并添加本系统描述默认值。 |
| 模型适配器目前接收通用 Record，领域工具描述仍使用模型 function 外形。 | `domain/external/llm.ts`、`base-tool.ts`、`infrastructure/external/llm/openai-llm.ts` | 无。 | 领域端改传 Descriptor，厂商外形只在基础设施生成。 |

## Acceptance Results

| 验收项 | 状态 | 证据 |
| --- | --- | --- |
| 三类工具可注册和查询 | Pass | 专项测试同时注册 `builtin`、`mcp`、`agent`，验证按 id、name、source 和 capability 查询。 |
| 名称与 id 冲突检测 | Pass | 重复 id、跨来源重复 name 均抛出 `ToolConflictError`。 |
| 批量注册原子性 | Pass | 批中后项冲突时，前面的新工具也未写入 Registry。 |
| 完整 Descriptor | Pass | 内置装饰器和 MCP 发现均生成 capability、risk、requiresApproval 和 timeoutMs。 |
| 领域层无厂商 Tool 类型 | Pass | `LLM.invoke.tools` 接收 `ToolDescriptor[]`；OpenAI function schema 只在 `infrastructure/external/llm/openai-llm.ts` 生成。 |
| 真实路径接入 | Pass | `BaseAgent`、`LLMSingleToolProvider` 和 `AgentToolRuntimeInvoker` 均通过 Registry 查询或解析。 |
| 兼容性 | Pass | 全量 76 个契约测试和 Nest 生产构建通过。 |

## Verification Commands

| 命令或场景 | 结果 | 备注 |
| --- | --- | --- |
| `node --import tsx --test test/contracts/tool-registry.contract.test.ts` | Pass | 9 tests passed，0 failed。 |
| `npm run test:contract:typecheck`（`api/`） | Pass | 产品代码与全部契约测试 TypeScript 检查成功。 |
| `npm run test:contract`（`api/`） | Pass | 76 tests passed，0 failed。 |
| `npm run build`（`api/`） | Pass | NestJS 生产构建成功。 |
| `git diff --check` | Pass | 无空白或补丁格式错误。 |

## Compatibility and Failure Cases

| 场景 | 预期 | 实际结果 |
| --- | --- | --- |
| 内置工具注册与调用 | 生成 builtin Descriptor，并通过绑定的 invoke 调用 | Pass。 |
| MCP 工具发现 | name 保留 server 前缀，生成保守 risk | Pass。 |
| Agent 工具注册 | 使用同一 Registry 契约注册和查询 | Pass。 |
| 同 id 不同 name | 注册失败 | Pass。 |
| 同 name 不同 source | 注册失败 | Pass。 |
| 批量后项冲突 | 整批不写入 | Pass。 |
| 查询方修改返回对象 | 不改变 Registry 内部状态 | Pass。 |
| Single Tool 实际搜索 | 仍只调用一次，并输出兼容 tool/message/done 事件 | Pass；Runtime wiring 回归测试通过。 |
| Planner/ReAct 事件 | Plan、Step、Tool、Message、Done 顺序不变 | Pass；事件顺序契约测试通过。 |
| OpenAI-compatible 请求 | 仍生成 function name/description/parameters | Pass；转换器专项测试和构建通过。 |

## Completion Evidence

- 相关提交或 PR：未创建。
- 评测或运行报告：TOOL-101 专项 9/9、全量契约 76/76、生产构建通过。
- 未解决限制：工具最小选择属于 TOOL-102；调用审批/超时/取消/重试/幂等属于 TOOL-103；MCP enabled、故障隔离和动态刷新属于 TOOL-104；Specialist 执行属于 AGENT-102。
- 最终结论：`pass`，TOOL-101 验收条件全部满足。
