# TOOL-104 Evidence

## Acceptance Results

| 验收项 | 状态 | 证据 |
| --- | --- | --- |
| disabled 服务不连接/不暴露 | Pass | connector 调用与 Descriptor 均只含 enabled 服务。 |
| 单服务故障隔离 | Pass | 连接、刷新、清理三类故障均有独立测试。 |
| namespace 保持 | Pass | 同名工具按 server 生成不同 id/name；前缀服务名精确路由。 |
| 工具列表动态刷新 | Pass | SDK callback、主动刷新和每用户消息刷新已接线。 |
| Registry 删除、增加和替换 | Pass | `replaceAll` + notification 测试验证旧工具删除与 Schema 更新。 |

## Verification Commands

| 命令或场景 | 结果 | 备注 |
| --- | --- | --- |
| `node --import tsx --test test/contracts/mcp-dynamic-management.contract.test.ts` | Pass | 8/8。 |
| MCP、Registry、Runtime 相关测试联合执行 | Pass | 23/23。 |
| `npm run test:contract` | Pass | 109/109，包含 TypeScript 测试类型检查。 |
| `npm run build` | Pass | Nest 生产构建成功。 |
| `git diff --check` | Pass | 无空白错误。 |

## Compatibility and Failure Cases

| 场景 | 预期 | 实际结果 |
| --- | --- | --- |
| disabled 服务 | connector 调用次数为零，工具为空 | Pass。 |
| 一个服务连接失败 | 其他服务和内置工具仍可用 | Pass；失败 `broken` 不影响 `crm` 和 MessageTool。 |
| 刷新瞬时失败 | 保留该服务最后成功快照 | Pass；`flaky` 保留 `cached`，`stable` 正常更新。 |
| 工具新增/删除/Schema 变化 | 下一轮 Registry 使用新快照 | Pass；旧 id 删除，新描述与 inputSchema 替换。 |
| 已删除工具的迟到调用 | 不请求 MCP client | Pass；call count 为 0。 |
| server 名互为前缀 | 按完整 namespace 精确路由 | Pass；`crm_archive` 不被 `crm` 截获。 |
| Registry 替换快照冲突 | 原 Registry 不变 | Pass。 |
| 单服务 close 失败 | 继续关闭其他服务并清空缓存 | Pass。 |

## Completion Evidence

- 相关提交或 PR：待提交。
- 评测或运行报告：专项 8/8；相关路径 23/23；全量契约 109/109；生产构建通过。
- 未解决限制：Resources、Prompts 和完整 Notifications 属于 TOOL-105。
- 最终结论：`pass`，TOOL-104 验收完成。
