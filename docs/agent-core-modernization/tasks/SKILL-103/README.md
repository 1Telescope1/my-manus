# SKILL-103 — 实现 Skill 渐进披露

> 本目录是该任务的独立工作记录。总体设计以 [SDD](../../../agent-core-modernization-sdd.md) 为准，总体状态以 [TASKS.md](../../TASKS.md) 为准。

| 字段 | 值 |
| --- | --- |
| Workstream | `Skills` |
| Status | `done` |
| Dependencies | `SKILL-101`, `SKILL-102` |
| Started | `2026-07-19` |
| Last Updated | `2026-07-19` |
| Working Session | 当前 Codex 任务 |

## Intent

把可信项目级 Skill 接入真实 Runtime：每个 Run 的模型都能看到最小 Catalog；只有显式请求或 Router 判断相关的 Skill 才读取并注入完整 `SKILL.md`；同一 Skill 在单个 Run 内只激活一次，资源和脚本保持未加载、未执行。

## 本任务做了什么

### 一句话说明

> 把 `api/.agents/skills/` 中随服务发布的内置 Skill 变成真实 Runtime 能按需使用的能力：所有模型先看到目录，只有相关 Skill 才加载正文，并且正文只在当前 Run 生效。

### 核心能力

| 对象或能力 | 职责 | 实际行为 |
| --- | --- | --- |
| `SkillProgressiveDisclosureService` | 为每个 Run 固定 Catalog 并管理激活缓存。 | API 显式请求、`$skill-name` 和 Router 选择统一解析为 stable ID。 |
| `SkillRunDisclosure` | 保持单 Run 激活状态。 | 同一 ID 多次请求只调用一次 Loader；模型未知项被隔离。 |
| `SkillDisclosure` | 直接承载当前 Run 的 Catalog 和激活内容。 | 格式化时只输出 `id/name/description`、完整 `SKILL.md` 和摘要。 |
| Router Catalog | 支持模型按描述选择相关 Skill。 | 路由模型不接收正文、资源或文件路径，只能返回 Catalog 中的 ID。 |
| protected system context | 把当前 Run 的 Skill 约束送入执行模型。 | Direct、Single Tool、Planner、ReAct、更新和总结使用同一内容，但不写入 Session Memory。 |
| Skill Tool scope | 解释 `allowed-tools`。 | 只作为现有 Tool Selection 的 allow 上界；不会注册工具、增加 capability 或绕过 Policy。 |

### 主要流程

```text
Run 初始化
  → 发现 api/.agents/skills Catalog
  → 解析 RuntimeRequest.requestedSkills、$skill-name 和 project:<name>
  → Router 只读取 id/name/description
  → 校验 Router requestedSkills
  → 合并显式请求并按 stable ID 去重
  → SkillContentLoader.load() 读取完整 SKILL.md
  → 构造 Catalog + activatedSkills 私有上下文
  → 合并 allowed-tools 上界
  → 注入 Direct / Single Tool / Planner-ReAct 的每次模型请求
  → Run 结束后丢弃激活缓存
```

### 内置 Skill 放在哪里

- 当前 API Runtime 的项目根是 `api/`，所以所有用户共享的内置 Skill 放在 `api/.agents/skills/<skill-name>/SKILL.md`。
- `api/Dockerfile` 会把整个 `.agents` 目录复制到运行镜像的 `/app/.agents`；因此这些 Skill 随代码评审、构建和部署统一发布，不需要逐用户安装。
- 当前只建立目录和 Runtime 能力，没有加入示例业务 Skill；真实研究、文件处理等内置 Skill 属于 SKILL-106。
- 用户私有 Skill、版本发布和会话沉淀属于 SKILL-107，不与这里的全局内置目录混用。

## 证据表

| 确定结论 | 证据路径 | 不确定项 | 建议改动范围 |
| --- | --- | --- | --- |
| Catalog 和 Loader 已形成独立可信端口，但 Runtime 没有依赖它们。 | `api/src/domain/models/skill.ts`；`skill-content.ts`；`runtime.service.ts` | 无。 | 新增领域级渐进披露服务，由 Runtime 编排，不让执行适配器直接读文件系统。 |
| Router 决策已有 `requestedSkills`，但输入没有可用 Skill 目录。 | `route-decision.ts`；`llm-runtime-route-model.ts` | 模型可能返回未知 Skill。 | Router 只接收 `id/name/description` Catalog，并在返回后校验请求项。 |
| Direct、Single Tool、Planner/ReAct 各自构造模型消息，当前均无 Skill 上下文。 | `adapters.ts`；`planner-react-flow.ts`；`base-agent.ts` | Workflow 尚未注册。 | 生成统一受保护上下文，覆盖当前所有可执行模型路径。 |
| Tool Selection 已支持 Skill allow scope，缺少 allow 不扩大权限。 | `tool-selection.service.ts` | `allowed-tools` 当前仅表达工具名。 | 激活时只映射 `allowedToolNames` 上界，不创建工具或 capability。 |
| 一条用户消息创建一个 `AgentRun`。 | `runtime.service.ts` | 跨恢复保留激活版本属于 SKILL-104。 | 本任务只保证当前 `execute` 对应 Run 内去重。 |
| Loader 只列资源清单，不读取或执行资源。 | `file-system-skill-content-loader.ts` | 资源按需消费属于后续任务。 | SKILL-103 不调用 `readResource()`，也不增加 scripts 执行入口。 |

## Scope

### In scope

- 在每个 Run 初始化时发现项目 Skill Catalog，并只向模型披露稳定 ID、名称和描述。
- 支持调用方显式请求 Skill，以及 Router 基于 Catalog 返回相关 Skill。
- 校验、合并并去重激活请求，只通过 `SkillContentLoader` 读取完整 `SKILL.md`。
- 把统一 Skill 上下文注入 Direct、Single Tool、Planner/ReAct 模型调用。
- 将已激活 Skill 的 `allowed-tools` 合并到现有 Tool Selection 上界。
- 覆盖正文不提前披露、显式激活、模型激活、未知项隔离和 Run 内去重测试。

### Out of scope

- 读取 references/assets 正文或执行 scripts。
- 跨 Run、进程恢复或压缩后的激活版本持久化。
- 用户级、组织级或远程 Skill Registry。
- 修改 Tool Registry、Policy 或审批语义。

## Acceptance Checklist

- [x] 未激活 Skill 的正文不进入 Router 或执行模型请求。
- [x] 显式请求按稳定 ID、唯一名称或 `$skill-name` 激活。
- [x] Router 看到给定 Catalog，输出中的未知项不会进入激活上下文。
- [x] 同一 Skill 的重复请求在单个 Run 内只读取和注入一次。
- [x] `allowed-tools` 只收紧现有工具集合；缺失字段不扩大权限。
- [x] resources/scripts 不被自动读取或执行。
- [x] Direct、Single Tool、Planner/ReAct 共享同一披露语义。
- [x] 新增或修改的自动化测试标题使用中文。
- [x] 新增或修改的枚举类型及每个枚举项都有中文注释。
- [x] 新增或修改的函数有头部中文注释，重要步骤有中文说明。
- [x] 专项测试、全量契约测试、typecheck 和 build 通过。
- [x] [evidence.md](./evidence.md)、[worklog.md](./worklog.md) 和总任务清单已更新。

## 改造前后对比

| 对比项 | 改造前 | 完成后 | 实际影响 |
| --- | --- | --- | --- |
| Router 选择 | `requestedSkills` 只是输出字段，模型不知道哪些 Skill 存在。 | Router 接收最小 Catalog，激活层过滤 Catalog 外的选择。 | 模型驱动激活有真实候选，未知项不会进入正文上下文。 |
| 显式激活 | Runtime 没有显式 Skill 输入和文本标记。 | 支持 API 请求、stable ID、唯一名称和 `$skill-name`。 | 用户或上层 UI 可以确定性选择 Skill。 |
| 正文披露 | Loader 与 Runtime 断开，任何路径都看不到 `SKILL.md`。 | 只有激活项的完整正文进入当前 Run 的受保护上下文。 | 未相关 Skill 不消耗执行上下文，相关工作流获得专用约束。 |
| 路径一致性 | Direct、Single、Planner/ReAct 分别构造模型消息。 | 四条路径共用同一格式化上下文。 | 不会出现只有 Planner 能使用 Skill 的行为差异。 |
| 生命周期 | 若直接写入 Agent Memory，正文会泄漏到后续 Run。 | Run 级 system context 每次请求临时插入，不写持久 Memory。 | 下一轮未激活时不会残留上一轮 Skill 正文。 |
| 工具权限 | `allowed-tools` 已可读取但没有 Runtime 语义。 | 映射到 Tool Selection Skill allow scope。 | Skill 只能收紧现有工具，不能创建权限或自动执行脚本。 |
| 部署 | API 镜像不包含 `.agents`。 | `api/.agents` 随镜像复制到 `/app/.agents`。 | 项目内置 Skill 在所有部署实例和用户间一致可用。 |

## Current State

- 当前进展：实现、路径级测试和全量验证已完成。
- 当前阻塞：无。
- 下一步：SKILL-104 持久化激活版本，或 SKILL-106 增加真实内置 Skill 用例。

## Task Files

- [worklog.md](./worklog.md)：实施调查和变更记录。
- [evidence.md](./evidence.md)：验收项、测试结果和完成证据。

## Decisions and Risks

- Catalog 是每个 Run 的固定发现快照，正文只从该快照中的稳定 ID 激活。
- 显式请求失败与模型未知输出需要不同语义：调用方显式请求未知 Skill 应明确失败；模型返回未知项应隔离，避免模型幻觉阻断普通请求。
- Skill 上下文属于私有执行上下文，不写入对外 Runtime Event；跨恢复持久化留给 SKILL-104。
- 不把完整 `SKILL.md` 交给 Router；Router 只根据描述选择，避免激活前泄露正文。

## Latest Session State

- Current state: 已完成并通过验收。
- Remaining work: 无；跨恢复和真实示例不属于本任务。
- Blockers: 无。
- Recommended next action: 开始 SKILL-104 或 SKILL-106。
