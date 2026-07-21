# MEMORY-102 Evidence

## Acceptance Results

| 验收项 | 状态 | 证据 |
| --- | --- | --- |
| 输入不超过模型窗口 75% | Pass | `createModelContextBudget()` 取 75% 与总窗口减输出预留的更小值；专项测试覆盖 1000/100 与 1000/400 两种预算。 |
| 关键约束、用户目标和活跃 Skill 不丢失 | Pass | 专项测试在旧历史超限时仍断言 `BASE-SYSTEM`、`CURRENT-GOAL`、`ACTIVE-SKILL` 全部进入模型。 |
| 近期优先且工具协议成组 | Pass | 专项测试验证旧历史被省略、最近工具调用与结果同时保留；空间不足时两者同时省略。 |
| 受保护内容超限时调用前失败 | Pass | Direct、Router、Single Tool 超限测试均得到 `ProtectedContextBudgetExceededError`，记录的 LLM 调用数为 0。 |
| 主要模型路径统一接入 | Pass | `BaseAgent`、`LLMDirectResponseProvider`、`LLMSingleToolProvider`、`LLMRuntimeRouteModel` 均使用 `ContextSelector`。 |
| 兼容现有存储和 API/Event | Pass | 未修改 Session/Conversation Memory 存储结构；174 项全量契约和 EVAL-101 基线通过。 |
| 独立窗口配置可兼容升级 | Pass | Schema 为旧配置补 32768；旧 Update 请求省略字段时沿用当前配置；UI 和环境变量提供显式入口。 |

## Verification Commands

| 命令或场景 | 结果 | 备注 |
| --- | --- | --- |
| `node --import tsx --test test/contracts/context-window-budget.contract.test.ts` | Pass | 7/7。 |
| `npm run test:contract` | Pass | 174/174，包含测试 TypeScript 检查。 |
| `npm run typecheck`（`api/`） | Pass | 无类型错误。 |
| `npm run build`（`api/`） | Pass | Nest build 成功。 |
| `npm run eval:agent-quality` | Pass | 9/9 已启用基线任务通过，数据集指纹不变。 |
| `npx eslint src/components/manus-settings.tsx`（`ui/`） | Pass | 本次修改的 UI 文件无 lint 问题。 |
| `npm run build`（`ui/`） | Pass | 沙箱内因 Turbopack 绑定端口被拒，按相同命令在获准的沙箱外重跑后 production build 成功。 |
| `npm run lint`（`ui/`） | Known baseline failure | 本任务文件无报错；全库被 `tool-preview-panel.tsx:369` 动态组件和 `sidebar.tsx:734` render 内 `Math.random` 两个既有错误阻塞。 |
| `git diff --check` | Pass | 无空白错误。 |

## Compatibility and Failure Cases

| 场景 | 预期 | 实际结果 |
| --- | --- | --- |
| 受保护内容本身超限 | 模型调用前明确失败 | Pass；Direct、Router、Single Tool 的模型调用次数均为 0。 |
| 历史超限 | 保留受保护内容与最近可容纳的原子消息组 | Pass；旧 user/assistant 被省略，当前目标和最近工具组保留。 |
| 工具组整体放不下 | 不制造孤立 tool call/result | Pass；两条消息同时省略。 |
| 旧配置缺少窗口字段 | 使用 Schema 默认值读取 | Pass；得到 `context_window_tokens: 32768`。 |
| 旧 UI 更新请求缺少窗口字段 | 沿用当前值 | Pass；现有密钥配置契约增加窗口断言。 |
| 输出上限大于或等于总窗口 | 配置阶段拒绝 | Pass；Schema 返回 `max_tokens 必须小于 context_window_tokens`。 |
| 现有质量基线 | 不发生完成率、工具选择或耐久指标回归 | Pass；EVAL-101 9/9，Task Success/Tool Selection/Recovery 均为 100%。 |

## Completion Evidence

- 相关提交或 PR：当前工作区改动，尚未提交。
- 评测或运行报告：EVAL-101 数据集 SHA-256 `ad60834d03071b94af2352b9221238bc9446742d2c5162792f7e874290cecbc0`，9 个已启用任务全部通过。
- 未解决限制：估算值不是厂商真实 usage；结构化摘要、恢复重建和大型 Tool Result Artifact 分别留给 MEMORY-103、MEMORY-104、TOOL-106；全量 UI lint 有两个既有错误。
- 最终结论：`pass`，MEMORY-102 验收完成。
