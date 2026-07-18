# RUNTIME-108 — 将 Runtime 接入现有会话服务

> 本目录是该任务的独立工作记录。总体设计以 [SDD](../../../agent-core-modernization-sdd.md) 为准，总体状态以 [TASKS.md](../../TASKS.md) 为准。

| 字段 | 值 |
| --- | --- |
| Workstream | `Runtime` |
| Status | `done` |
| Dependencies | `RUNTIME-103, RUNTIME-105, COMPAT-101` |
| Started | `2026-07-18` |
| Last Updated | `2026-07-18` |

## Intent

在保持 Session API、SSE 和 UI 行为不变的前提下，以 `RuntimeService` 作为消息执行的唯一入口，串联 Router、AgentRun/Checkpoint、四路径执行器和 Runtime Event Adapter。

## 证据表

| 确定结论 | 证据路径 | 不确定项 | 改动范围 |
| --- | --- | --- | --- |
| `AgentTaskRunner` 是真实消息执行与事件持久化入口 | `api/src/domain/services/runtime/agent-task-runner.ts`、`api/src/application/services/agent.service.ts` | 无 | Runner 只调用 `RuntimeService` |
| Router、四路径执行器和 Checkpoint 已可组合 | RUNTIME-103/104/105 代码与证据 | Workflow Registry 尚未实现 | 未注册 Workflow 明确回退 Planned Agent |
| `PlannerReActFlow` 是当前复杂任务执行能力 | `api/src/domain/services/flows/planner-react-flow.ts` | 无 | 作为 Planned Agent 的内部实现保留 |
| API/UI 消费 Session Event | `api/src/interfaces/dto/event.dto.ts`、前端事件类型 | 无 | Runtime Event 经 Adapter 转换，不改公开协议 |
| 内核模式开关没有正式运行价值 | `AgentTaskRunner` 唯一入口和接线契约 | 无 | 删除配置、分支及过渡命名 |

## 正式架构

```text
AgentService 创建 Task
  ↓
AgentTaskRunner 同步输入与附件
  ↓
RuntimeService 创建 AgentRun
  ↓
生产确定性规则；未命中才调用路由模型
  ↓
Direct / Single Tool / Workflow / Planned Agent
  ↓
提交 entering_wait 或 entering_terminal Checkpoint
  ↓
RuntimeEventAdapter 转成 Session Event
  ↓
共用文件处理、Session 事件持久化和 SSE 输出
```

### 核心对象

| 对象 | 职责 |
| --- | --- |
| `AgentTaskRunner` | 复用同一 Session、Sandbox、工具和事件后处理，只通过 Runtime 执行消息 |
| `RuntimeService` | 串联 Router、AgentRun、Checkpoint、四路径 Dispatcher 和 Session 状态 |
| `DirectExplanationRouteRule` | 将无需外部数据的短概念解释稳定路由到 Direct |
| `LLMDirectResponseProvider` | 不提供工具，生成 Direct 最终回答 |
| `LLMSingleToolProvider` / `AgentToolRuntimeInvoker` | 选择并执行一次工具，再生成无工具总结 |
| `PlannerFlowRuntimeRunner` | 以 `PlannerReActFlow` 实现 Planned Agent |
| `RuntimeEventAdapter` | 将 Runtime Event 映射成当前 `plan/step/tool/message/wait/error/done` 事件 |
| `createAgentToolset` | 为 Planned Agent 和 Single Tool 提供同一组工具实例 |

### 路由与事件边界

- 概念解释规则只匹配短定义句，并排除 Skill、长上下文、实时数据、网页、文件和外部动作迹象。
- Router 返回未注册 Workflow 时，本次决策明确回退为 Planned Agent，原因写入 Run 元数据。
- Runtime 新增的 `run_id`、`sequence`、`checkpoint_id`、`metadata` 作为可选字段进入 Session Event，事件类型不变。
- 附件沙箱路径通过 `privateContext` 传给执行器，不进入 Runtime Event metadata 或 SSE。
- 路由 Schema 失败时记录首个错误字段并回退 Planned Agent。

## Scope

### In scope

- Runtime 成为消息执行的唯一入口。
- 每条消息创建并持久化 AgentRun，写入路由和停止边界 Checkpoint。
- 接入 Router、四路径 Dispatcher 与 Runtime Event Adapter。
- 保留 `PlannerReActFlow` 作为 Planned Agent 正式实现。
- 保持现有 Session 历史、附件处理和 SSE 消费方式。
- 删除运行模式配置、分支和过渡期命名。

### Out of scope

- 真实取消传播；属于 `RUNTIME-106`。
- 工具幂等与不确定副作用恢复；属于 `RUNTIME-107`。
- 完整 Tool/Workflow/Skill/Agent Registry。
- 修改现有 API 或 UI 事件结构。

## Acceptance Checklist

- [x] `AgentTaskRunner` 只通过 Runtime 执行消息。
- [x] Direct、Single Tool、Workflow 回退和 Planned Agent 路径可用。
- [x] Runtime 创建持久化 AgentRun，并记录路由与停止边界 Checkpoint。
- [x] 历史 Session 事件和 Memory 不被清空或迁移。
- [x] Runtime Event 经 Adapter 输出当前 UI 可消费的事件。
- [x] 部署不再需要运行模式环境变量。
- [x] 源码、测试变量和注释不再使用过渡期命名。
- [x] 全量契约测试、类型检查和生产构建成功。

## 改造前后对比

| 对比项 | 改造前 | 完成后 | 实际影响 |
| --- | --- | --- | --- |
| 运行入口 | 存在两个执行分支和模式配置 | `RuntimeService` 是唯一入口 | 避免配置漂移和行为分叉 |
| 运行状态 | 部分请求不创建 AgentRun | 每条消息创建 AgentRun 和边界 Checkpoint | 生命周期可独立查询 |
| 工具 | 两条分支分别组装能力 | 共用 `createAgentToolset` | 不复制工具实现 |
| Planned Agent | 被描述为过渡适配 | `PlannerReActFlow` 是内部正式实现 | 保留已验证的多步计划能力 |
| 事件 | Adapter 被描述为旧协议兼容层 | Runtime Event 到 Session Event 的稳定边界 | API、SSE 和 UI 无需修改 |
| 回滚 | 运行时切换分支 | 回滚部署镜像或提交 | 生产状态更可复现 |

## Current State

- 当前进展：唯一 Runtime 入口、四路径执行、Checkpoint 和 Session Event 输出已完成。
- 当前阻塞：无。
- 下一步：继续推进真实取消、幂等恢复或 Registry 任务。

## Decisions and Risks

- 不删除 `PlannerReActFlow`，因为它承载 Planned Agent 的真实多步执行能力。
- 不删除 Event Adapter，因为领域 Runtime Event 与公开 Session Event 的职责不同。
- 当前没有 Workflow Registry；未知 Workflow 回退 Planned Agent，避免宣称不存在的能力。
- Direct 规则保持保守；不明确或需要外部数据的请求仍由路由模型判断。
- 回滚依赖部署版本，不在正式代码中维护第二套消息执行入口。
