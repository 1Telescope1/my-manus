# TOOL-102 — 最小化模型可见工具

> 本目录是该任务的独立工作记录。总体设计以 [SDD](../../../agent-core-modernization-sdd.md) 为准，总体状态以 [TASKS.md](../../TASKS.md) 为准。

| 字段 | 值 |
| --- | --- |
| Workstream | `Tool 与 MCP` |
| Status | `done` |
| Dependencies | `TOOL-101` |
| Started | `2026-07-18` |
| Last Updated | `2026-07-18` |
| Working Session | `Codex：执行 TOOL-102` |

## Intent

在 Tool Registry 之上建立确定性的最小工具选择层，只把当前路由能力和已授权范围内真正相关的工具交给模型，避免全量工具占用上下文或扩大可调用边界。

## 证据表

| 确定结论 | 证据路径 | 不确定项 | 建议改动范围 |
| --- | --- | --- | --- |
| SDD 固定选择顺序：Router capability → Workflow/Agent 允许范围 → Skill 收窄/请求 → Policy 剔除或审批。 | `docs/agent-core-modernization-sdd.md` §7.1 | Workflow、Skill、Agent Registry 和 Policy 实现尚未完成。 | 定义可组合约束输入和纯选择服务，不提前实现其他 Workstream。 |
| Router 已产出 `requiredCapabilities`，并持久化到 Run metadata。 | `route-decision.ts`、`runtime.service.ts` | Router 尚不知道 Registry 中的 canonical capability。 | 把可用 capability catalog 交给路由模型，并将决策传给选择器。 |
| Single Tool 当前调用 `registry.list()`，把全部工具传给模型。 | `runtime/adapters.ts` | 无。 | 选择前按 Router capability 和可选范围过滤；模型返回值必须属于最终集合。 |
| Planner/ReAct 当前每轮调用 `getAvailableTools()`，同样返回全部 Registry。 | `base-agent.ts` | Planner 实际设置 `toolChoice: none`，仍携带多余 schemas。 | Planner/总结阶段零工具；ReAct 步骤只接收 Runtime 的选择上下文。 |
| Registry 已支持 Descriptor、source、capability、risk 和稳定查询。 | TOOL-101 实现与证据 | 当前 `list({ capabilities })` 是单工具同时满足全部 capability，不适合选择覆盖多种能力的工具集合。 | 新选择服务按“任一请求 capability 匹配”选择工具，并报告未覆盖 capability。 |

## 本任务做了什么

### 一句话说明

> 先证明一个工具既被允许、又与当前任务相关，再让模型看到它；没有证据时默认一个都不给。

### 为什么需要这个任务

TOOL-101 统一了工具描述和 Registry，但模型入口仍调用 `registry.list()`：一次“搜索网页”的请求会同时看到文件写入、Shell、Browser、用户通信、MCP 和 Agent 工具。工具越多，Schema 占用的上下文越大，模型选错近似工具的概率越高；更重要的是，“已注册”只表示系统知道这个工具，不表示当前 Workflow、Agent、Skill 或 Policy 授权本轮使用。

本任务新增选择层，把“Registry 中存在”“当前范围允许”“当前任务相关”分成三个判断。只有同时通过的 Descriptor 才会进入模型请求。

### 核心对象或能力

| 对象 | 职责 | 例子 |
| --- | --- | --- |
| `ToolSelectionScope` | 表达 Workflow、Agent 或 Skill 的允许范围和显式请求。 | Agent 只允许 `builtin`；一个 Skill 请求 `read_file`。 |
| `ToolPolicyConstraints` | 接收 Policy 已计算的 allow/deny 结果，不在本任务执行审批。 | 禁止 `destructive` risk 或禁止某个 MCP source。 |
| `ToolSelectionRequest` | 汇总 Router capability 和其他四类约束。 | Router 请求 `search`，Agent 允许 `search_web/read_file`，最终只有 `search_web` 相关。 |
| `ToolSelectionResult` | 返回最终 Descriptor 和未覆盖的 capability。 | 请求 `search`、`weather`，只有搜索工具时报告 `weather` 未覆盖。 |
| capability catalog | 路由前向模型提供 Registry 中存在的 canonical capability。 | 路由模型使用 `web.search`，不能自行发明 `internet_lookup`。 |

### 选择规则

```text
Registry 全部工具
  ↓ 相关性：命中 Router/Workflow/Agent/Skill 请求的 capability 或显式工具
  ↓ Workflow allow（如存在）
  ↓ Agent allow（如存在）
  ↓ 多个 Skill allow 的并集（如存在）
  ↓ Policy allow（如存在）
  ↓ Policy deny 最终剔除
  ↓
最终模型可见工具 + 未覆盖 capability
```

各层语义有意不同：

- Workflow 和 Agent 是独立授权上界，因此取交集。
- 多个已激活 Skill 是并列的能力请求方，因此 Skill 之间取并集，但不能越过 Workflow、Agent 或 Policy。
- allow 只代表“最多可以用”，不自动让工具变得相关。
- Policy deny 优先级最高，即使 Router 或 Skill 显式请求也不能重新加入。
- 没有 capability 或显式工具请求时返回空集合，不把“未指定”解释成全量授权。

### 主要执行流程

Router 调用前，`AgentTaskRunner` 从当前 Registry 收集去重后的 capability catalog；MCP 初始化后新发现的 capability 也会被包含。路由模型只能从该 catalog 选择精确值，返回未知 capability 时安全回退。

执行阶段：

1. Runtime 把 `RouteDecision.requiredCapabilities` 与可选的 Workflow、Agent、Skill、Policy 约束写入私有执行上下文。
2. Single Tool 或 ReAct 调用 `ToolSelectionService` 得到最终 Descriptor。
3. capability 无法覆盖或最终集合为空时立即失败，不回退全量 Registry。
4. 只有最终集合被交给 LLM；空集合时连 `tools` 和 `toolChoice` 字段都不发送。
5. 模型返回 function name 后再次检查它是否属于本轮最终集合，伪造未披露名称不会执行。

### 例子

用户要求“搜索 Runtime 架构”，Router 返回：

```ts
{ requiredCapabilities: ['search'] }
```

Registry 中虽然存在 `read_file`、`write_file`、`shell_execute`、`message_ask_user` 等工具，最终模型请求只有：

```ts
tools: ['search_web']
```

如果模型仍返回 `message_ask_user`，Single Tool 在调用前报告“未授权或无关工具”，不会交给 Runtime invoker。

组合约束反例：Router 请求 `file.write`，但 Agent allow 只有 `read_file`。最终集合为空，并报告 `file.write` 未覆盖；系统不会为了完成请求自动扩大权限。

### 保护规则和当前边界

- Router capability 是权威字段，外部选择约束不能用同名运行时属性覆盖。
- 选择顺序完全确定，保持 Registry 注册顺序，便于测试和复现。
- 未覆盖 capability 是确定性配置/能力错误，在模型重试循环前失败。
- Planner、计划更新和总结模型不需要工具，现已完全省略 `tools/toolChoice`。
- ReAct 每一轮都复用同一选择请求；工具熔断只会进一步缩小本次集合。
- 本任务提供 Workflow、Agent、Skill、Policy 的约束契约；这些组件各自的 Registry、激活和策略计算仍由对应任务实现。
- Policy 的审批执行、超时、取消、重试和幂等属于 TOOL-103；本任务只消费 allow/deny 结果。
- MCP enabled 和动态删除/更新属于 TOOL-104；当前 capability catalog 会增量吸收已发现的新工具。

## Scope

### In scope

- 定义 Router、Workflow、Agent、Skill 和 Policy 可共同提供的工具选择约束。
- 实现授权范围交集、Skill 请求合并、Policy deny 和 capability 相关性过滤。
- Router 获得当前 Registry capability catalog，减少模型产生不可用 capability。
- Single Tool 和 Planned Agent/ReAct 只向模型发送最终工具集合。
- 模型选择最终集合外工具时拒绝调用。
- 覆盖未授权、无关、Policy 禁止、Skill 请求和 capability 未覆盖测试。

### Out of scope

- 实现 Workflow Registry、Agent Registry、Skill 激活器或完整 Tool Policy 引擎。
- 执行审批、超时、取消、重试和幂等；属于 TOOL-103。
- MCP enabled、连接隔离和动态刷新；属于 TOOL-104。
- 量化 Precision/Recall；属于 EVAL-104。

## Acceptance Checklist

- [x] 未授权工具不进入模型请求。
- [x] 与 Router capability 无关且未被显式请求的工具不进入模型请求。
- [x] Workflow、Agent、Skill 和 Policy 约束可组合且结果确定。
- [x] Policy deny 优先于其他来源的请求。
- [x] 无选择信号时默认零工具，不回退全量披露。
- [x] 模型返回最终集合外工具时不执行。
- [x] Planner 与总结模型调用不携带工具。
- [x] 新增或修改测试标题使用中文。
- [x] 新增函数和复杂步骤具有中文注释；本任务未新增枚举。
- [x] 类型检查、专项契约测试、全量契约测试和构建通过。
- [x] “本任务做了什么”和“改造前后对比”完整。
- [x] [evidence.md](./evidence.md) 和 [worklog.md](./worklog.md) 已填写。
- [x] 总任务清单状态和证据链接已更新。

## 改造前后对比

| 对比项 | 改造前 | 完成后 | 实际影响 |
| --- | --- | --- | --- |
| Single Tool 可见工具 | 无条件发送 Registry 全量 Descriptor。 | 只发送 Router capability 与约束共同选中的工具。 | “搜索”请求从全部工具缩小为 `search_web`。 |
| Planned Agent 可见工具 | Planner、ReAct、总结阶段都携带全量工具。 | Planner/总结零工具；ReAct 只携带本步骤继承的 Runtime 选择集合。 | 降低上下文占用和错误工具选择。 |
| 授权边界 | 注册即可能被模型选择，没有 Workflow/Agent/Skill/Policy 组合入口。 | 四类约束通过统一模型组合，Policy deny 最后生效。 | 后续 Registry 可直接注入边界，不需改模型适配器。 |
| 未指定行为 | `registry.list()` 等价于默认全部。 | 没有相关性信号时默认零工具。 | 缺少配置不会静默扩大能力。 |
| 模型伪造函数 | Single Tool 只检查 Registry 是否存在，存在即接受。 | 必须同时属于本轮最终集合。 | 未披露或未授权函数不会执行。 |
| capability 词表 | Router 可自由生成 capability 字符串。 | 路由输入包含当前 Registry catalog，未知值被拒绝并回退。 | 路由与工具描述使用同一 canonical vocabulary。 |
| 缺失能力 | 可能继续把其他工具交给模型猜测。 | 返回未覆盖 capability，并在真实路径 fail closed。 | 不用无关能力冒充任务所需能力。 |

## Current State

- 当前进展：选择模型、组合算法、Router catalog、Single Tool/ReAct 接线和防伪校验全部完成。
- 当前阻塞：无。
- 下一步：执行 TOOL-103，把 risk、approval、timeout、signal 和 idempotency 接入统一调用层。

## Task Files

- [worklog.md](./worklog.md)：按时间追加工作过程，保留历史。
- [evidence.md](./evidence.md)：验收项、测试结果和完成证据。

## Decisions and Risks

- 允许范围是授权上界，不等同于“全部都相关”；最终还必须匹配 capability 或显式请求。
- 多个 Skill 的显式请求合并后仍受 Workflow、Agent 和 Policy 上界约束。
- 缺少或无法覆盖 capability 时 fail closed，不以全量工具作为兼容回退。

## Latest Session State

- Current state: `done`，专项 11/11、全量契约 88/88 和生产构建通过。
- Remaining work: 无 TOOL-102 范围内工作。
- Blockers: 无。
- Recommended next action: 执行 TOOL-103；EVAL-104 在 Skill 接入后量化选择 Precision/Recall。
