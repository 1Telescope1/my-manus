# SKILL-103 Evidence

## Acceptance Results

| 验收项 | 状态 | 证据 |
| --- | --- | --- |
| 未激活正文不披露 | Pass | Router 和未激活执行上下文只含 Catalog 元数据；正文唯一标记不存在。 |
| 显式和模型驱动激活 | Pass | API/名称/stable ID/`$name` 显式解析与 Router Catalog 选择均通过。 |
| Run 内去重 | Pass | 同一 Skill 以名称、ID 和重复 activate 请求触发时 Loader 只调用一次，正文只出现一次。 |
| 工具权限不扩大 | Pass | `allowed-tools` 只生成 `allowedToolNames` scope；缺失字段不生成 scope。 |
| 资源和脚本不自动处理 | Pass | 激活流程从未调用 `readResource()`；模型上下文不含资源清单或正文。 |
| 全模型路径一致 | Pass | Direct、Single Tool 选择/总结、Planned Flow、Planner/ReAct protected context 均有路径断言。 |
| Session Memory 隔离 | Pass | 首个 Run 的激活正文不写入 Memory，下一次无激活模型请求不含正文。 |
| 部署目录可用 | Pass | `api/.agents/skills/.gitkeep` 建立目录，Docker Runtime 复制 `.agents` 到 `/app/.agents`。 |

## Verification Commands

| 命令或场景 | 结果 | 备注 |
| --- | --- | --- |
| `node --import tsx --test test/contracts/skill-progressive-disclosure.contract.test.ts` | Pass | 5 tests，5 pass，0 fail。 |
| Router、Runner 与专项组合测试 | Pass | 26 tests，26 pass，0 fail。 |
| `npm run test:contract` | Pass | 158 tests，158 pass，0 fail。 |
| `npm run typecheck` | Pass | TypeScript 无错误。 |
| `npm run build` | Pass | Nest 构建成功。 |

## Compatibility and Failure Cases

| 场景 | 预期 | 实际结果 |
| --- | --- | --- |
| 没有内置 Skill | Router 和执行流程保持可用 | Pass，空 Catalog 不改变旧路径。 |
| `$known-skill` | 确定性显式激活 | Pass，Router 前转为 canonical ID。 |
| API 显式请求未知 Skill | 明确失败，不静默忽略 | Pass，返回 `explicit_skill_not_found`。 |
| Router 返回未知 Skill | 不加载正文、不阻断普通执行 | Pass，激活层静默过滤未知项。 |
| 同一 Skill 重复请求 | 单 Run 只读取和注入一次 | Pass，Loader 计数为 1。 |
| Skill 缺少 `allowed-tools` | 不新增授权范围 | Pass，scope 数组为空。 |
| Skill 有 `allowed-tools` | 只保留声明工具且继续受 Agent/Policy 限制 | Pass，Single Tool 仅见 `search_web`。 |
| 下一 Run 未激活 | 上一 Run 正文不残留 | Pass，持久 Memory 中没有 protected context。 |

## Completion Evidence

- 相关提交或 PR：未创建。
- 评测或运行报告：专项 5/5、相关组合 26/26、全量契约 158/158，typecheck/build 通过。
- 未解决限制：跨 Run/压缩恢复属于 SKILL-104；资源与脚本安全使用属于 SKILL-105。
- 最终结论：`pass`，SKILL-103 Acceptance 全部满足。
