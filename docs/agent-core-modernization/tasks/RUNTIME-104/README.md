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

在不改变现有 legacy 执行流程的前提下建立不绑定特定模型厂商的请求路由核心，使确定性请求不必全部进入 Planner，并为 RUNTIME-105 的四类执行器提供稳定 `RouteDecision`。

## 本任务做了什么

### 一句话说明

> 只负责判断一个请求应该走哪种执行方式，不负责真正执行。

### 为什么需要这个任务

改造前，所有用户请求都会进入完整的 `PlannerReActFlow`。像“你好”“解释乐观锁”这样的简单问题也要经过规划，增加了模型成本、响应延迟和不必要的执行复杂度。RUNTIME-104 增加 Router，让简单请求和确定性流程不必默认使用最重的 Planner。

### 四种执行路径

| 路径 | 适用情况 | 例子 |
| --- | --- | --- |
| `direct` | 不需要外部工具，可以直接回答 | “解释什么是 CAS” |
| `single_tool` | 只需要一次主要工具调用 | “查询今天上海的天气” |
| `workflow` | 有固定、确定的代码执行流程 | “生成固定格式的每日报告” |
| `planned_agent` | 开放、复杂、需要多步骤判断 | “调研市场并生成报告和附件” |

Router 返回的不是最终回答，而是一个结构化 `RouteDecision`：

```ts
{
  route: 'single_tool',
  reason: '该请求只需要一次天气查询',
  requiredCapabilities: ['weather'],
  requestedSkills: [],
  confidence: 0.92
}
```

### 路由过程

```text
收到用户请求
  ↓
按注册顺序检查确定性规则
  ├─ 命中：直接返回 RouteDecision，不调用模型
  ↓ 未命中
调用轻量路由模型
  ↓
使用 RouteDecisionSchema 严格校验
  ↓
置信度达到阈值？
  ├─ 是：返回四种路径之一
  └─ 否：回退 planned_agent
```

确定性规则适合注册 Workflow、固定格式转换等代码可以稳定判断的请求。规则同步执行，首个命中后立即停止，避免产生额外模型成本。

### Schema 和安全回退

`RouteDecisionSchema` 会检查：

- `route` 必须是四种合法值之一。
- `confidence` 必须位于 0～1。
- `workflow` 必须提供 `workflowName`，其他路径不能夹带该字段。
- `direct` 不能声明外部能力，否则与“不调用工具”冲突。
- 未知字段和缺失必填字段都会被拒绝。

模型调用失败、输出无效或置信度低于 `0.6` 时，Router 不会让整个请求失败，也不会冒险选择简单路径，而是回退到当前兼容行为：

```ts
{
  route: 'planned_agent',
  confidence: 0,
  reason: '路由模型返回无效结果，回退到 planned_agent'
}
```

### 为什么路由不会执行副作用

Router 的模型端口只有 `decide()`，LLM 调用参数明确不包含 `tools` 和 `toolChoice`。因此路由阶段只能分析文本，不能发送邮件、删除文件、执行 Shell 或真正启动 Workflow。

### 当前接入边界

四路径决策、规则优先级、模型适配器和安全回退已经完成，但四条路径的执行器尚未实现，当前聊天仍固定使用 legacy Planner。RUNTIME-105 负责“选中路径后怎样执行”，RUNTIME-108 再把 Router 和新执行器接入真实请求。

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
- [x] 类型检查、契约测试和构建成功。
- [x] “本任务做了什么”已详细说明四条路径、路由流程、Schema、回退和副作用边界。
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
| 实际接入状态 | legacy `AgentTaskRunner` 固定运行 `PlannerReActFlow`。 | 路由核心完成但尚未接入请求，四类执行器也尚未实现。 | 当前用户流程不变；RUNTIME-105/108 可在稳定契约上继续接线。 |

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

- Current state: `done`，专项 10/10、全量契约 53/53 和生产构建通过。
- Remaining work: 无 RUNTIME-104 范围内工作。
- Blockers: 无。
- Recommended next action: 执行 RUNTIME-105，并由后续 Registry 能力注册具体确定性规则。
