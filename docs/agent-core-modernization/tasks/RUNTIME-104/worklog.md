# RUNTIME-104 Worklog

## 2026-07-18 — 建立四路径路由核心

### Goal

- 完成严格路由 Schema、确定性规则优先级、无工具模型回退和兼容性降级。

### Investigation

- SDD 固定四种路径：`direct`、`single_tool`、`workflow`、`planned_agent`。
- 现有 `RouteKind` 已由 RUNTIME-101 定义，Zod 和厂商无关的 `LLM` 抽象可直接复用。
- 当前 legacy `AgentTaskRunner` 固定创建 `PlannerReActFlow`；本任务按范围不提前接线。
- Skill、Workflow、Agent 和 Tool Registry 尚未完成，因此确定性路由采用可注册的纯决策规则接口。

### Changes

| 文件 | 变更原因 |
| --- | --- |
| `api/src/domain/models/route-decision.ts` | 定义请求和 RouteDecision 的严格 Zod Schema及跨字段路径约束。 |
| `api/src/domain/external/runtime-route-model.ts` | 建立只允许分析、不暴露工具且不绑定特定模型厂商的模型端口。 |
| `api/src/domain/services/runtime/router.service.ts` | 实现规则优先、模型回退、置信度检查和 planned_agent 安全降级。 |
| `api/src/infrastructure/external/llm/llm-runtime-route-model.ts` | 通过现有 LLM 生成 JSON 候选，并明确省略工具调用参数。 |
| `api/test/contracts/runtime-router.contract.test.ts` | 覆盖四条路径、规则顺序、严格校验、异常/低置信回退和无工具调用。 |
| `docs/agent-core-modernization/TASKS.md` | 记录任务从 ready 到 in_progress 再到 done 的状态变化。 |
| `docs/agent-core-modernization/tasks/RUNTIME-104/*` | 保存任务范围、决策、验证和完成证据。 |

### Verification

- RUNTIME-104 专项契约测试 10/10 通过。
- `npm run test:contract`：53/53 通过，包含 legacy、SSE、持久化和恢复回归。
- `npm run build`：NestJS 生产构建成功。
- `git diff --check`：通过。

### Findings

- 路由模型必须不接收工具列表，从类型和调用参数上阻断路由阶段副作用。
- 无效、异常或低置信输出应返回稳定的 `planned_agent` 决策，而不是让请求失败。
- 确定性规则使用同步接口并按注册顺序短路；首个命中后不产生模型成本。
- Workflow 路由必须携带 `workflowName`，非 Workflow 路由不能夹带该字段。
- Direct 路由不能声明外部能力，否则与“不调用工具”的语义冲突。

### Next

- RUNTIME-104 已完成；执行 RUNTIME-105 实现四类执行器，再由 RUNTIME-108 接入实际请求流程。
