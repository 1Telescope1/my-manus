# RUNTIME-108 Worklog

## 2026-07-18 — 接入 Runtime

- 串联 Router、Run/Checkpoint、四路径 Dispatcher 与 Event Adapter。
- 增加 Direct、Single Tool、Planned Agent 和 Workflow 回退适配器，并抽取共用 Toolset。
- 将附件路径隔离在 `privateContext`，避免写入 Runtime Event metadata。
- 增加接线契约，验证历史 Session、一次工具调用、Workflow 回退和 waiting 边界。

## 2026-07-18 — 补齐生产路由规则

- 根据真实 Run 的 `routeReason` 定位概念解释请求的 Schema 回退原因。
- 将概念解释意图落实为生产默认规则，实时外部数据请求继续交给模型判断。
- 对齐路由提示词和 `RouteDecision` 可选字段语义，并规范化 `workflowName: null`。
- Schema 回退原因记录首个失败字段。

## 2026-07-18 — Runtime 正式化

- 将 `RuntimeService` 固定为 `AgentTaskRunner` 的唯一消息执行入口。
- 删除运行模式类型、环境变量、Compose 配置和旧分支。
- 将版本化或过渡期命名改为正式名称：`RuntimeService`、`RuntimeEventAdapter`、`AgentToolRuntimeInvoker`、`PlannerFlowRuntimeRunner` 和 `createAgentToolset`。
- 保留 `PlannerReActFlow` 作为 Planned Agent 内部实现，保留 Event Adapter 作为领域事件与公开事件的稳定边界。
- 取消依赖双入口的 COMPAT-102/103/104，并新增 ADR-012。
- 专项契约 24/24、全量契约 67/67、类型检查和生产构建通过。
- API 镜像重建成功，容器 healthy，状态接口确认 PostgreSQL 与 Redis 正常，容器内不存在旧运行模式环境变量。

## 2026-07-19 — 会话标题回归

- 定位 Direct/Single Tool 会话长期显示“新对话”的原因：标题事件原本只由 Planned Agent 的 Plan 产生。
- 将初始标题收敛到 Session 边界：首条用户消息产生并持久化 `title` 事件，后续 Planned 标题仍可覆盖。
- 新增 3 个契约，覆盖默认标题、不覆盖和 Unicode 安全截断。

## 2026-07-19 — Runtime 全链路精简

- 审查 RUNTIME-101～108 的真实执行链，将状态机、CAS、Checkpoint 水位和副作用恢复标为必须保留的不变量。
- Mapper 改为从 Prisma 生成类型派生字段，仅对需要脏数据验证的 JSON 字段保留 `unknown`。
- Repository 直接依赖最小 Prisma 客户端接口，删除 union、getter 和双重类型断言。
- 删除附件批处理的重复异常捕获与空数组判断，保留既有单文件失败降级。
- 删除工具终态和 Zod 失败中的不可能分支，保持公开事件、幂等结果和路由回退语义不变。
- 代码净减少 78 行；专项 40/40、全量契约 158/158、类型检查和生产构建通过。
