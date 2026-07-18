# TOOL-102 Worklog

## 2026-07-18 — 建立最小工具选择层

### Goal

- 根据 Router、Workflow、Agent、Skill 和 Policy 约束计算最小模型工具集合。

### Investigation

- Router 已提供 `requiredCapabilities`，但模型路由输入没有 canonical capability catalog。
- Single Tool 与 ReAct 都无条件向模型暴露完整 Registry。
- Planner 明确 `toolChoice: none`，仍携带 schemas，没有必要。
- Workflow、Agent、Skill、Policy 尚无完整实现，本任务需要稳定输入契约而不是替它们实现生命周期。

### Changes

| 文件 | 变更原因 |
| --- | --- |
| `api/src/domain/models/tool-selection.ts` | 定义 Workflow、Agent、Skill、Policy 约束和选择结果。 |
| `api/src/domain/services/tools/tool-selection.service.ts` | 实现相关性、授权交集、Skill 并集、Policy deny 和未覆盖诊断。 |
| `api/src/domain/models/route-decision.ts` | 路由请求增加 available capability catalog。 |
| `api/src/domain/services/runtime/router.service.ts` | 拒绝 catalog 中不存在的 capability。 |
| `api/src/infrastructure/external/llm/llm-runtime-route-model.ts` | 要求路由模型只使用 canonical capability。 |
| `api/src/domain/services/runtime/runtime.service.ts`、`executor.service.ts` | 将选择约束作为私有执行上下文贯穿四路径。 |
| `api/src/domain/services/runtime/agent-task-runner.ts` | MCP 初始化后增量收集 Registry capability catalog。 |
| `api/src/domain/services/runtime/adapters.ts` | Single Tool 选择前过滤、返回后防伪；Planned Agent 传递选择请求。 |
| `api/src/domain/services/agents/base-agent.ts`、`react-agent.ts`、`planner-react-flow.ts` | Planner/总结零工具，ReAct 使用 Runtime 最小集合。 |
| `api/test/contracts/tool-selection.contract.test.ts` | 覆盖纯组合算法和失败边界。 |
| `api/test/contracts/tool-visibility.contract.test.ts` | 验证真实 LLM 输入、伪造函数拒绝和 ReAct 多轮集合。 |
| `api/test/contracts/runtime-router.contract.test.ts`、`runtime-wiring.contract.test.ts` | 验证 capability catalog 与现有 Runtime 接线。 |

### Verification

- 工具选择专项测试 8/8 通过。
- 工具可见性专项测试 3/3 通过。
- `npm run test:contract`：88/88 通过。
- `npm run build`：NestJS 生产构建成功。
- `git diff --check`：通过。

### Findings

- 允许范围只能定义授权上界；若直接把 allow list 当最终集合，仍会披露无关工具。
- 多 capability 请求需要选择各自匹配的工具集合，不能要求每个工具同时具备全部 capability。
- 工具选择必须同时约束模型可见列表和模型返回后的解析，防止伪造未披露 function name。
- Router 必须看到 Registry capability catalog，否则自由文本 capability 无法稳定映射到 Descriptor。
- 空选择和未覆盖 capability 必须 fail closed；全量回退会直接破坏本任务的安全目标。
- Router capability 必须在合并约束后保持权威，调用方不能用同名属性覆盖。

### Next

- TOOL-102 已完成；下一步由 TOOL-103 在最终集合之上实现可靠调用与审批语义。
