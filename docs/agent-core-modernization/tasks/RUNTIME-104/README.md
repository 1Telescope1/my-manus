# RUNTIME-104 — 实现运行路由决策

> 本目录是该任务的独立工作记录。总体设计以 [SDD](../../../agent-core-modernization-sdd.md) 为准，总体状态以 [TASKS.md](../../TASKS.md) 为准。

| 字段 | 值 |
| --- | --- |
| Workstream | `Runtime` |
| Status | `done` |
| Dependencies | `—` |
| Started | `2026-07-18` |
| Last Updated | `2026-07-18` |
| Working Session | `Codex：执行 RUNTIME-104` |

## Intent

在不改变现有 legacy 执行流程的前提下建立供应商中立的请求路由核心，使确定性请求不必全部进入 Planner，并为 RUNTIME-105 的四类执行器提供稳定 `RouteDecision`。

## Scope

### In scope

- 定义并严格校验 `RouteDecision` Schema。
- 按注册顺序执行无副作用的确定性路由规则。
- 未命中确定性规则时调用不携带工具的轻量路由模型。
- 对模型异常、无效输出和低置信结果回退到 `planned_agent`。
- 覆盖 `direct`、`single_tool`、`workflow`、`planned_agent` 四条路径及规则优先级。

### Out of scope

- 实现四类路径的实际执行器；这些属于 RUNTIME-105。
- 接入当前 legacy `AgentTaskRunner` 或运行模式开关；这些属于 RUNTIME-108。
- Skill、Workflow、Agent 和 Tool 的完整注册表及权限解析；由对应 Workstream 提供确定性规则。
- 在路由阶段调用工具、执行 Workflow 或产生任何外部副作用。

## Acceptance Checklist

- [x] `RouteDecision` 对路由类型、置信度、必填字段和未知字段进行严格校验。
- [x] 确定性规则按顺序执行，命中后不调用路由模型。
- [x] 路由服务可返回 `direct`、`single_tool`、`workflow`、`planned_agent` 四种合法路径。
- [x] 模型异常、无效输出和低置信结果回退到 `planned_agent`。
- [x] 路由模型请求不携带工具，路由阶段不执行副作用。
- [x] 四种路径及关键失败场景有中文标题测试。
- [x] 新增函数和复杂步骤具有中文注释；本任务未新增枚举。
- [x] 类型检查、合同测试和构建成功。
- [x] “改造前后对比”已填写，并说明实际影响。
- [x] [evidence.md](./evidence.md) 已填写。
- [x] 总任务清单和本目录工作记录已更新。

## 改造前后对比

| 对比项 | 改造前 | 完成后 | 实际影响 |
| --- | --- | --- | --- |
| 决策结构 | 只有 `RouteKind`，没有描述原因、能力、Skill、Workflow 和置信度的严格边界。 | `RouteDecisionSchema` 严格校验全部字段、路径组合、置信度和未知字段。 | 模型或规则的异常输出不会直接进入执行器。 |
| 路由顺序 | 所有请求由 legacy Planner 流程处理，没有确定性规则优先层。 | `RuntimeRouterService` 按注册顺序执行同步规则，未命中才调用轻量模型。 | 固定请求未来可避免不必要的 Planner 调用，路由策略也可独立测试。 |
| 失败回退 | 路由能力不存在，无法表达低置信或模型故障时的兼容行为。 | 规则/模型无效、低置信或模型异常均返回 `planned_agent`。 | 路由错误不会阻断请求，也不会冒险进入过于简单的路径。 |
| 副作用边界 | 没有独立 Router，模型与工具能力处于同一 legacy 流程。 | `RuntimeRouteModel` 只有决策端口，LLM 调用明确不携带 `tools`/`toolChoice`。 | 路由阶段只能分析，不能执行外部写操作。 |
| 实际接入状态 | legacy `AgentTaskRunner` 固定运行 `PlannerReActFlow`。 | 路由核心完成但尚未接入请求，四类执行器也尚未实现。 | 当前用户流程不变；RUNTIME-105/108 可在稳定合同上继续接线。 |

## Current State

- 当前进展：RouteDecision Schema、确定性规则优先级、无工具模型适配器和安全回退全部完成。
- 当前阻塞：无。
- 下一步：执行 RUNTIME-105，为四种路由决策实现统一执行器接口。

## Task Files

- [worklog.md](./worklog.md)：按时间追加工作过程，保留历史。
- [evidence.md](./evidence.md)：验收项、测试结果和完成证据。

## Decisions and Risks

- 确定性规则只返回决策，不接收工具执行接口；具体规则由后续 Registry/Workflow 能力注册。
- 模型路由失败时回退 `planned_agent`，保持与当前全部进入 Planner 的行为接近。
- 本任务不把新路由接入线上请求，避免越过 RUNTIME-105 和 RUNTIME-108 的任务边界。

## Latest Session State

- Current state: `done`，专项 10/10、全量合同 53/53 和生产构建通过。
- Remaining work: 无 RUNTIME-104 范围内工作。
- Blockers: 无。
- Recommended next action: 执行 RUNTIME-105，并由后续 Registry 能力注册具体确定性规则。
