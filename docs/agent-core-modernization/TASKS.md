# Agent 核心现代化总任务清单

本文件是所有待办事项、任务状态、依赖和验收标准的唯一来源。目标设计与接口约束见 [Agent 核心现代化 SDD](../agent-core-modernization-sdd.md)。任务开始后，为它创建独立的 `tasks/<TASK-ID>/` 工作目录。

## 状态定义

| 状态 | 含义 | 进入条件 | 退出条件 |
| --- | --- | --- | --- |
| `proposed` | 已识别但尚不能直接开始 | 意图、设计和验收已记录 | 依赖完成后转为 `ready` |
| `ready` | 可直接领取 | 无未完成依赖，验收明确 | 开始实施后转为 `in_progress` |
| `in_progress` | 正在实施 | 已创建 `tasks/<TASK-ID>/` 并记录执行会话 | 完成后转 `done`；受阻时转 `blocked` |
| `blocked` | 无法在当前条件下继续 | 任务文件记录了原因和解除条件 | 解除后回到 `ready` 或 `in_progress` |
| `done` | 已完成并验证 | Acceptance 全部满足且 Evidence 完整 | 发现回归时重新打开 |
| `deferred` | 主动延期 | 已记录原因和重新评估触发条件 | 触发后转为 `proposed` |

## 维护规则

1. 所有 Workstream 同级，表格顺序不表示优先级或实施阶段。
2. 只有 `Dependencies` 中列出的任务构成前置关系。
3. 开始任务时复制 [任务目录模板](./tasks/_template/README.md) 的结构，创建 `tasks/<TASK-ID>/`，将清单中的 ID 链接到该目录的 `README.md`，并把状态改为 `in_progress`。
4. Acceptance 全部满足后，在任务目录填写实施日志、验证证据和“改造前后对比”，再将状态改为 `done`。
5. Evidence 列应链接任务文件、测试报告或其他可复核材料，不能只写“已完成”。
6. 每次状态变化更新该任务的 `Last Updated`；不要在其他文件重复维护状态统计。
7. 每个完成任务必须在任务首页说明改造前是什么状态、完成后变成什么状态，以及对用户或后续开发产生的实际影响；不得只罗列修改文件。
8. 新增或修改自动化测试时，`test`、`it`、`describe` 的标题必须使用中文；Run、Checkpoint、CAS、SSE 等必要技术术语可以保留，确保测试报告可以直接阅读。
9. 新增或修改枚举时，枚举类型和每一个枚举项都必须有中文注释，说明业务含义或触发场景；不能只依赖英文名称和值推断含义。
10. 新增或修改函数时（包括方法、构造函数和辅助函数），函数声明上方至少要有一行中文注释说明职责；函数内部的重要或复杂步骤也必须有中文注释，重点解释执行顺序、设计原因、事务或安全约束，避免逐行复述代码。
11. 每个完成任务的 `README.md` 必须包含详细的“本任务做了什么”章节，面向未参与实现的读者，并至少说明：一句话本质、改造前的问题、核心对象或能力及例子、主要执行流程、失败/安全/兼容保护，以及当前接入状态和后续边界。读者只看这一节就应理解任务为什么做、代码怎样工作、完成后改变了什么；不能只写两段摘要，也不能只罗列文件、类型或测试。

## Runtime

| ID | Status | Dependencies | Intent | Design | Acceptance | Evidence | Last Updated |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [RUNTIME-101](./tasks/RUNTIME-101/README.md) | `done` | — | 建立可持久化的运行语义 | 定义 AgentRun、RunStep、ToolCallRecord、Checkpoint、Interruption 和状态转换 | 类型、状态转换测试和仓储接口评审通过；非法转换被拒绝 | [验收证据](./tasks/RUNTIME-101/evidence.md) | 2026-07-18：补充任务说明 |
| [RUNTIME-102](./tasks/RUNTIME-102/README.md) | `done` | RUNTIME-101 | 将运行状态从 Session JSON 中分离 | 增加 Prisma 模型、迁移和仓储实现，使用乐观版本控制 | 可创建、查询、更新 Run；并发更新不会静默覆盖；迁移可回滚 | [验收证据](./tasks/RUNTIME-102/evidence.md) | 2026-07-18：补充任务说明 |
| [RUNTIME-103](./tasks/RUNTIME-103/README.md) | `done` | RUNTIME-102 | 支持进程重启后继续执行 | 在约定节点写 Checkpoint，并实现恢复解析器 | 在模型调用前后和工具结果持久化后注入崩溃，均从预期节点恢复 | [验收证据](./tasks/RUNTIME-103/evidence.md) | 2026-07-18：补充任务说明 |
| [RUNTIME-104](./tasks/RUNTIME-104/README.md) | `done` | — | 避免所有请求强制 Planner | 实现 RouteDecision Schema、确定性规则和模型路由回退 | 四种路径均有单测；无效路由回退 planned_agent；路由不执行副作用 | [验收证据](./tasks/RUNTIME-104/evidence.md) | 2026-07-18：补充任务说明 |
| [RUNTIME-105](./tasks/RUNTIME-105/README.md) | `done` | RUNTIME-101, RUNTIME-104 | 提供多种执行路径 | 实现 Direct、Single Tool、Workflow、Planned Agent 执行器接口 | 每种路径可独立运行并产生统一 Runtime Event | [验收证据](./tasks/RUNTIME-105/evidence.md) | 2026-07-18：完成四路径执行器与统一事件验证 |
| [RUNTIME-106](./tasks/RUNTIME-106/README.md) | `done` | RUNTIME-101, TOOL-103 | 实现真实取消 | 根 AbortController 贯穿模型与工具适配器，停止新任务调度 | LLM、Shell、Browser、MCP、A2A 取消测试通过；终态为 CANCELLED | [验收证据](./tasks/RUNTIME-106/evidence.md) | 2026-07-19：完成真实取消传播与终态验证 |
| RUNTIME-107 | `proposed` | RUNTIME-101, TOOL-103 | 防止恢复时重复副作用 | 持久化幂等键和调用状态，恢复时复用已完成结果 | 故障注入后外部写操作不重复；未知状态进入 PAUSED | — | 2026-07-16：初始化 |
| [RUNTIME-108](./tasks/RUNTIME-108/README.md) | `done` | RUNTIME-103, RUNTIME-105, COMPAT-101 | 将 Runtime 接入现有会话服务 | `AgentTaskRunner` 以 Runtime 作为唯一执行入口 | 四条路由可完成现有聊天流程；历史 Session 和 UI 协议保持不变 | [验收证据](./tasks/RUNTIME-108/evidence.md) | 2026-07-18：Runtime 正式化并删除模式分支 |

## Skills

| ID | Status | Dependencies | Intent | Design | Acceptance | Evidence | Last Updated |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SKILL-101 | `ready` | — | 发现和描述项目 Skills | 扫描 `.agents/skills/`，解析 Frontmatter，生成只含元数据的 Catalog | 合法 Skill 可发现；重名、超限、名称不匹配被隔离并诊断 | — | 2026-07-16：初始化 |
| SKILL-102 | `proposed` | SKILL-101 | 安全读取 Skill 指令和资源 | 实现真实路径校验、大小限制和资源清单 | 路径逃逸、符号链接逃逸、缺失资源和超限测试通过 | — | 2026-07-16：初始化 |
| SKILL-103 | `proposed` | SKILL-101, SKILL-102 | 实现渐进披露 | 目录常驻上下文；显式或模型驱动激活完整 SKILL.md；Run 内去重 | 未激活 Skill 正文不进入模型；显式激活稳定；重复激活不重复注入 | — | 2026-07-16：初始化 |
| SKILL-104 | `proposed` | SKILL-103, MEMORY-102 | 防止 Skill 在压缩中丢失 | 将激活版本和受保护指令写入 Run State/Context | 多次压缩后 Skill 约束仍存在；恢复后使用原激活版本 | — | 2026-07-16：初始化 |
| SKILL-105 | `proposed` | SKILL-102, TOOL-103 | 安全使用脚本和资产 | scripts 经 Sandbox Tool 执行，资源通过 Artifact/Context 读取 | 不存在自动宿主机执行路径；执行事件和输出可追踪 | — | 2026-07-16：初始化 |
| SKILL-106 | `proposed` | SKILL-103, EVAL-101 | 用真实用例验证 Skills | 增加研究、文件处理等示例 Skill 和触发数据集 | 示例符合规范；触发 Precision/Recall 达到任务约定门槛 | — | 2026-07-16：初始化 |

## Tool 与 MCP

| ID | Status | Dependencies | Intent | Design | Acceptance | Evidence | Last Updated |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [TOOL-101](./tasks/TOOL-101/README.md) | `done` | — | 统一描述内置、MCP 和 Agent 工具 | 建立 ToolDescriptor、capability、risk 和 registry 接口 | 三类工具可注册、查询和检测名称冲突；领域层无厂商类型 | [验收证据](./tasks/TOOL-101/evidence.md) | 2026-07-18：完成统一 Tool Registry 与现有路径接入 |
| [TOOL-102](./tasks/TOOL-102/README.md) | `done` | TOOL-101 | 减少模型可见工具 | 根据 Router、Workflow、Agent、Skill 和 Policy 计算最终工具集合 | 工具选择测试证明未授权/无关工具不进入模型请求 | [验收证据](./tasks/TOOL-102/evidence.md) | 2026-07-18：完成最小工具选择与真实模型入口接入 |
| [TOOL-103](./tasks/TOOL-103/README.md) | `done` | TOOL-101 | 统一调用可靠性和错误语义 | Tool 调用支持 Signal、Timeout、Risk、Approval、Idempotency 和统一结果 | 超时、取消、校验错误、重试和副作用策略测试通过 | [验收证据](./tasks/TOOL-103/evidence.md) | 2026-07-18：完成统一可靠调用层与真实路径接入 |
| [TOOL-104](./tasks/TOOL-104/README.md) | `done` | TOOL-101 | 修复 MCP 动态管理 | 只连接 enabled 服务，保留命名空间，隔离连接故障并刷新工具列表 | disabled 服务不连接/不暴露；单服务故障不影响其他工具 | [验收证据](./tasks/TOOL-104/evidence.md) | 2026-07-18：完成 MCP enabled、故障隔离与动态刷新 |
| TOOL-105 | `proposed` | TOOL-104, MEMORY-102 | 使用完整 MCP 上下文能力 | Resources 接入 Context Manager，Prompts 作为模板，处理 Notifications | Tools/Resources/Prompts 类型边界清晰；动态变化可被刷新 | — | 2026-07-16：初始化 |
| TOOL-106 | `proposed` | TOOL-103, MEMORY-103 | 防止大型工具结果污染上下文 | 超过阈值的结果保存为 Artifact，只返回摘要和引用 | 128 KiB 以上结果不直接进入 LLM；Artifact 可按需读取 | — | 2026-07-16：初始化 |

## Memory 与 Context

| ID | Status | Dependencies | Intent | Design | Acceptance | Evidence | Last Updated |
| --- | --- | --- | --- | --- | --- | --- | --- |
| MEMORY-101 | `ready` | — | 分离执行状态和对话上下文 | 定义 Run State、Conversation Memory、Working Context、Artifact 边界 | 类型和仓储职责评审通过；执行游标不依赖聊天消息 | — | 2026-07-16：初始化 |
| MEMORY-102 | `proposed` | MEMORY-101 | 主动控制上下文窗口 | 建立模型窗口预算、受保护内容和 Context Selector | 输入不超过 75% 窗口；关键约束、用户目标和活跃 Skill 不丢失 | — | 2026-07-16：初始化 |
| MEMORY-103 | `proposed` | MEMORY-101 | 替代当前轻量删除式压缩 | 生成结构化摘要并保留来源、Artifact 和待办 | 长会话评测中事实不被错误升级，Pending Work 可继续执行 | — | 2026-07-16：初始化 |
| MEMORY-104 | `proposed` | MEMORY-101, RUNTIME-102 | 在恢复时重建正确上下文 | Checkpoint 保存摘要版本、激活 Skill 和 Artifact 引用 | 进程重启后 Working Context 与崩溃前语义一致 | — | 2026-07-16：初始化 |

## Multi-Agent 与 A2A

| ID | Status | Dependencies | Intent | Design | Acceptance | Evidence | Last Updated |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AGENT-101 | `ready` | — | 注册职责明确的 Specialist | 建立 AgentDescriptor 和本地 Agent Registry | Agent 可按 capability 查询；工具和 Skill 边界可验证 | — | 2026-07-16：初始化 |
| AGENT-102 | `proposed` | AGENT-101, RUNTIME-105, TOOL-101 | 让 Manager 调用有边界的专家任务 | Specialist 作为 Tool 返回结构化结果，Manager 保留最终答复权 | Specialist 不直接输出用户事件；结果可由 Manager 组合 | — | 2026-07-16：初始化 |
| AGENT-103 | `proposed` | AGENT-101, RUNTIME-103 | 支持会话所有权转移 | Handoff 过滤上下文、更新 activeAgentId 并写前后 Checkpoint | Handoff 后可恢复；无关工具历史不传递；事件仍兼容 UI | — | 2026-07-16：初始化 |
| AGENT-104 | `proposed` | TOOL-103 | 升级外部 Agent 协议适配 | 实现当前 A2A Agent Card、Message、Task、Artifact、Cancel 接口 | 与规范兼容服务完成普通、失败、取消和 Artifact 互操作测试 | — | 2026-07-16：初始化 |
| AGENT-105 | `proposed` | AGENT-104, RUNTIME-103 | 支持长任务流和多轮恢复 | 持久化远程 Task/Context 映射，转换 Streaming 和 input-required | 断线重连、输入恢复和远程取消测试通过 | — | 2026-07-16：初始化 |
| AGENT-106 | `proposed` | AGENT-102 | 对独立专家任务并行执行 | Manager 只并行无数据依赖任务，默认并发上限 3 | 并发不破坏事件顺序；依赖任务保持串行；取消传播到所有子任务 | — | 2026-07-16：初始化 |

## Compatibility

| ID | Status | Dependencies | Intent | Design | Acceptance | Evidence | Last Updated |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [COMPAT-101](./tasks/COMPAT-101/README.md) | `done` | — | 让 Runtime 继续服务现有 UI | 定义 Runtime Event 到 Session Event 的 Adapter，新增字段均可选 | 现有 UI 不修改即可消费 Runtime 事件；sequence 可去重 | [验收证据](./tasks/COMPAT-101/evidence.md) | 2026-07-18：Runtime Event Adapter 正式化 |
| COMPAT-102 | `cancelled` | RUNTIME-105, COMPAT-101 | 运行模式切换 | 原计划维护双入口与影子执行 | Runtime 已成为唯一入口，不再维护运行模式 | — | 2026-07-18：被 ADR-012 取代 |
| COMPAT-103 | `cancelled` | COMPAT-102, EVAL-101 | 双入口结果比较 | 原计划以无副作用数据集对比两条入口 | 前置双入口方案已取消 | — | 2026-07-18：被 ADR-012 取代 |
| COMPAT-104 | `cancelled` | COMPAT-103, EVAL-106 | 旧入口移除门槛 | 原计划在双入口稳定后移除旧入口 | 已在 Runtime 正式化时完成入口收敛 | — | 2026-07-18：被 ADR-012 取代 |

## Evaluation

| ID | Status | Dependencies | Intent | Design | Acceptance | Evidence | Last Updated |
| --- | --- | --- | --- | --- | --- | --- | --- |
| EVAL-101 | `ready` | — | 建立可重复的 Agent 质量基线 | 建立版本化任务集、期望结果和统一运行器 | 数据集覆盖 SDD 约定场景；结果可机器读取和重复运行 | — | 2026-07-16：初始化 |
| [EVAL-102](./tasks/EVAL-102/README.md) | `done` | — | 固化现有 API/Event 行为 | 为 Session、SSE、Plan、Step、Tool、Wait、Done 建契约测试 | 当前发布行为有基线；事件顺序和必填字段被验证 | [验收证据](./tasks/EVAL-102/evidence.md) | 2026-07-18：补充任务说明 |
| EVAL-103 | `proposed` | RUNTIME-103, RUNTIME-106, RUNTIME-107 | 验证耐久执行而非只测正常路径 | 注入进程崩溃、超时、取消和不确定副作用 | 所有恢复门槛满足；重复副作用为 0 | — | 2026-07-16：初始化 |
| EVAL-104 | `proposed` | SKILL-103, TOOL-102 | 量化 Skill 和工具选择 | 构建正例、负例和近似场景，记录 Precision/Recall | 无关 Skill/Tool 不过度披露；指标写入报告 | — | 2026-07-16：初始化 |
| EVAL-105 | `proposed` | AGENT-103, AGENT-105 | 验证多 Agent 边界 | 覆盖 Agent-as-Tool、Handoff、A2A 流、输入恢复和取消 | 所有权、上下文过滤、Artifact 和终态符合设计 | — | 2026-07-16：初始化 |
| EVAL-106 | `proposed` | EVAL-101, EVAL-102 | 形成统一比较报告 | 汇总完成率、Token、调用、延迟、恢复和事件契约 | 可按 runtime/version/task 过滤；作为完成证据被任务表引用 | — | 2026-07-16：初始化 |
