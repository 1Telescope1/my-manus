# SKILL-103 Worklog

## 2026-07-19 — 真实 Runtime 渐进披露接入

### Goal

- 让 Catalog 元数据常驻模型上下文，只在显式或模型选择后披露完整 `SKILL.md`，并保证单 Run 去重。

### Investigation

- `RuntimeService` 已把 Router 的 `requestedSkills` 写入 Run metadata，但路由输入没有 Catalog，执行上下文也没有 Skill 内容。
- 当前四条模型路径各自构造消息，必须通过统一上下文协议接入，不能只修改 Planner/ReAct。
- `ToolSelectionService` 已有 Skill scope 并集及 allow 上界语义，可直接承接 `allowed-tools`。
- 资源 Loader 已有安全读取端口，但本任务不应调用 `readResource()` 或提供脚本执行能力。

### Changes

| 文件 | 变更原因 |
| --- | --- |
| `docs/agent-core-modernization/TASKS.md` | 领取任务并建立任务链接。 |
| `docs/agent-core-modernization/tasks/SKILL-103/*` | 记录边界、证据和实施状态。 |
| `api/src/domain/models/skill-disclosure.ts` | 定义 Run 级披露、激活错误、模型上下文和 Skill 工具 scope。 |
| `api/src/domain/services/skills/skill-progressive-disclosure.service.ts` | 实现 Catalog 固定、显式解析、模型选择隔离和 Run 内读取去重。 |
| `api/src/domain/models/route-decision.ts`、`router.service.ts` | 把最小 Skill Catalog 加入路由契约并校验模型输出。 |
| `api/src/infrastructure/external/llm/llm-runtime-route-model.ts` | 只向 Router 模型披露元数据并要求返回 canonical ID。 |
| `api/src/domain/services/runtime/runtime.service.ts` | 编排初始化、路由、激活、上下文和工具上界。 |
| `api/src/domain/services/runtime/adapters.ts` | 覆盖 Direct、Single Tool 和 Planned Agent 桥接。 |
| `api/src/domain/services/agents/*`、`flows/planner-react-flow.ts` | 让 Planner/ReAct 全阶段使用不持久化的 protected system context。 |
| `api/src/application/services/agent.service.ts`、`api/Dockerfile` | 生产装配文件系统 Catalog/Loader，并把 `.agents` 发布到镜像。 |
| `api/test/contracts/*skill*`、Runtime Router/Wiring 测试 | 覆盖披露、激活、去重、权限、Memory 和全路径接线。 |

### Verification

- 专项渐进披露测试：5/5 通过。
- Router、Runner 与专项组合：26/26 通过。
- `npm run test:contract`：158/158 通过。
- `npm run typecheck`：通过。
- `npm run build`：通过。

### Findings

- Router 模型驱动激活必须先看到 Catalog 元数据，但绝不能在路由阶段看到正文。
- 显式未知 Skill 应向调用方返回稳定失败；Router 幻觉出的未知 Skill 应隔离，避免普通请求被模型输出阻断。
- 当前一个 `execute` 对应一个新 Run，因此本任务可在请求内构造不可变激活快照；持久化版本属于 SKILL-104。
- protected system context 必须在每次 LLM 请求时临时插入，而不能进入 Session Memory；否则下一 Run 会发生正文泄漏。
- 内置 Skill 的部署根必须与 API Runtime 的 `process.cwd()` 一致，因此目录固定为 `api/.agents/skills`，并由 Docker 显式复制。
- 精简后删除未被 Runtime 消费的 Catalog/激活诊断和二次上下文快照；核心披露模型与服务由 265 行降至 158 行，未知模型项统一由激活层过滤。

### Next

- SKILL-104：把激活版本和受保护指令写入可恢复 Run State。
- SKILL-106：加入研究、文件处理等真实内置 Skill 和触发评测。
