# SKILL-101 — 发现和描述项目 Skills

> 本目录是该任务的独立工作记录。总体设计以 [SDD](../../../agent-core-modernization-sdd.md) 为准，总体状态以 [TASKS.md](../../TASKS.md) 为准。

| 字段 | 值 |
| --- | --- |
| Workstream | `Skills` |
| Status | `done` |
| Dependencies | — |
| Started | `2026-07-19` |
| Last Updated | `2026-07-19` |
| Working Session | 当前 Codex 任务 |

## Intent

建立项目级 Skill 的可信发现边界：为后续 Runtime 提供扫描 `.agents/skills/`、校验 `SKILL.md` Frontmatter 并得到纯元数据 Catalog 的发现端口；单个坏 Skill 不得阻断其他 Skill。

## 证据表

| 确定结论 | 证据路径 | 不确定项 | 建议改动范围 |
| --- | --- | --- | --- |
| 首版只扫描项目级 `.agents/skills/`。 | `docs/agent-core-modernization-sdd.md` §6.1 | Catalog 的 Runtime 注入尚未设计。 | 本任务提供发现服务，不接入激活与模型上下文。 |
| `name`、`description` 必填，目录名必须等于 `name`，`SKILL.md` 最大 256 KiB。 | SDD §6.2 | 稳定 Skill ID 的格式未固定。 | 使用确定的 `project:<name>`，并在领域类型中隔离格式。 |
| YAML/字段错误、重名、超限、名称不匹配必须隔离并诊断。 | SDD §6.2、§6.4；`TASKS.md` Acceptance | 单项目根目录下重名通常伴随名称不匹配。 | 先解析候选，再按声明名称统一检测冲突，保留全部适用诊断。 |
| Catalog 只包含稳定 ID、`name` 和 `description`。 | SDD §6.3 | 可选 Frontmatter 字段是否需要暴露。 | 校验可选字段，但不将它们写入 Catalog。 |
| 安全读取完整指令和资源属于 SKILL-102。 | `TASKS.md` SKILL-102 | 发现阶段怎样处理符号链接。 | 发现阶段不跟随 Skills 根、Skill 目录和 `SKILL.md` 符号链接；完整真实路径能力留给 SKILL-102。 |

## 本任务做了什么

### 一句话说明

> 把项目中的 Skill 从“约定目录里的一组任意文件”变成一个可校验、可隔离、只暴露必要元数据的确定性 Catalog。

### 为什么需要这个任务

改造前，系统没有 Skill 领域类型、发现入口或诊断协议。即使仓库存在 `.agents/skills/<name>/SKILL.md`，Runtime 也无法知道哪些 Skill 合法；更无法阻止一个损坏、伪装或超大的候选污染整个目录。后续若直接把文件内容注入模型，还会把发现、信任、激活和工具授权混成同一个高风险步骤。

本任务先建立最小可信边界：发现阶段只回答“有哪些合法 Skill、为什么其他候选不可用”，不读取资源、不激活正文、不扩大工具权限。这样 SKILL-102/103 可以分别在稳定 Catalog 之上实现安全读取和渐进披露。

### 核心对象或能力

| 对象或能力 | 职责 | 例子 |
| --- | --- | --- |
| `SkillCatalogEntry` | 定义模型可见的最小元数据，不允许携带文件路径、可选配置或 Markdown 正文。 | `{ id: "project:web-research", name: "web-research", description: "…" }` |
| `SkillCatalogSnapshot` | 表达一次完整扫描结果，把合法条目和隔离诊断分开返回。 | 一个合法 Skill 与两个坏候选可同时产生 1 个 entry、2 个或更多 diagnostics。 |
| `SkillDiagnosticCode` | 为根目录、文件、Frontmatter、名称和冲突失败提供稳定机器码。 | 超限返回 `skill_file_too_large`，名称不匹配返回 `name_mismatch`。 |
| `FileSystemSkillCatalog` | 扫描项目级约定目录、限制输入、解析 YAML、执行 Schema 校验、检测重名并输出确定性快照。 | `new FileSystemSkillCatalog(projectRoot).discover()`。 |
| 稳定项目级 ID | 让相同项目 Skill 在多次扫描中获得相同标识，并给未来其他来源留出命名空间。 | `web-research` 固定映射为 `project:web-research`。 |

Frontmatter 校验遵循 Agent Skills 规范：`name` 为 1–64 个小写字母、数字或非连续连字符，不能以连字符开头或结尾；`description` 为 1–1024 字符；`compatibility`、`metadata`、`allowed-tools` 和 `license` 按各自类型校验。可选字段只用于确认描述合法，不进入 Catalog。

### 主要流程

```text
项目根目录
  → 检查 .agents/skills 是否为真实普通目录
  → 按名称扫描直接子目录，拒绝符号链接和非目录条目
  → 检查 SKILL.md 是普通文件且不超过 256 KiB
  → 只提取开头 YAML Frontmatter
  → 解析 YAML 并执行严格字段 Schema
  → 独立记录目录名不匹配
  → 汇总全部候选后检测重复声明 name
  → 隔离所有失败或冲突候选
  → 按 name 返回只含 id/name/description 的 Catalog 和排序诊断
```

发现器每次都重新扫描，不缓存半成品。文件系统枚举、Catalog 和诊断都稳定排序，确保相同输入产生可复核的相同结果。

### 例子

正常路径：`.agents/skills/web-research/SKILL.md` 声明 `name: web-research` 和有效描述时，Catalog 返回 `project:web-research`；`allowed-tools`、`metadata` 和 `# 指令正文` 均不会出现在结果中。

失败路径：`first-directory` 与 `second-directory` 都声明 `name: shared-skill` 时，两个候选既不满足目录名一致，又形成重复声明。发现器会为两者分别记录 `name_mismatch` 和 `duplicate_name`，同时继续返回同目录中的其他合法 Skill，而不是静默选一个覆盖另一个。

### 保护规则和当前边界

- `.agents/skills` 不存在是合法空状态，返回空快照；存在但不可读、不是普通目录或是符号链接时返回根诊断。
- Skill 目录与 `SKILL.md` 符号链接不会被跟随，避免发现范围指向项目外部。
- 在读取前后都检查 256 KiB 上限，无效 UTF-8、YAML、字段类型和未知顶层字段均被隔离。
- 单个候选的失败不会抛弃已经发现的其他合法 Skill；重名则隔离全部冲突方，绝不使用先到或后到覆盖。
- 诊断位置统一为项目相对路径，结果不依赖部署机器的绝对目录。
- 当前能力是独立的项目 Catalog 发现端口，尚未接入 Run 初始化或模型上下文；安全读取正文/资源属于 SKILL-102，激活与渐进披露属于 SKILL-103。

## Scope

### In scope

- 扫描项目级 `.agents/skills/` 的直接子目录。
- 解析并校验 `SKILL.md` YAML Frontmatter。
- 生成只含稳定 ID、`name`、`description` 的 Catalog。
- 隔离无效、重名、超限、名称不匹配或不安全的候选并返回结构化诊断。
- 覆盖正常路径、隔离路径和确定性结果测试。

### Out of scope

- 读取或注入 Skill Markdown 指令正文。
- 读取 `scripts/`、`references/`、`assets/` 资源。
- Skill 激活、Run 内去重、Context 保护和 Runtime 接线。
- 用户级、组织级或远程 Skill Registry。

## Acceptance Checklist

- [x] 合法 Skill 可从项目目录发现。
- [x] Catalog 只公开稳定 ID、`name` 和 `description`。
- [x] 重名、超限、名称不匹配被隔离并诊断。
- [x] 单个无效 Skill 不影响其他合法 Skill。
- [x] 新增或修改的自动化测试标题使用中文。
- [x] 新增或修改的枚举类型及每个枚举项都有中文注释。
- [x] 新增或修改的函数有头部中文注释，重要或复杂步骤有中文说明。
- [x] 所有验证命令成功。
- [x] “本任务做了什么”已按模板详细填写。
- [x] “改造前后对比”已填写并说明实际影响。
- [x] [evidence.md](./evidence.md) 已填写。
- [x] 总任务清单和本目录工作记录已更新。

## 改造前后对比

| 对比项 | 改造前 | 完成后 | 实际影响 |
| --- | --- | --- | --- |
| 项目 Skill 发现 | 没有扫描入口，目录中的 Skill 对系统不可见。 | `FileSystemSkillCatalog` 可发现项目级合法 Skill。 | 后续激活器有稳定、可测试的输入，不必自行接触任意文件。 |
| 模型可见信息 | 没有 Catalog 边界，未来接入容易连同正文和路径一起暴露。 | entry 只含稳定 ID、`name`、`description`。 | 未激活 Skill 的正文不会因发现动作进入上下文。 |
| 坏候选处理 | 没有错误协议，单文件错误可能阻断扫描或被静默忽略。 | 每个失败产生结构化诊断，其他合法 Skill 继续可用。 | 项目可定位配置错误，局部故障不会放大成 Registry 故障。 |
| 名称冲突 | 没有重名检测，存在静默覆盖风险。 | 冲突各方全部隔离并分别诊断。 | Catalog 结果不依赖文件系统返回顺序。 |
| 输入边界 | 没有大小、格式或符号链接保护。 | 256 KiB、严格 Frontmatter、UTF-8 和非符号链接边界在发现阶段生效。 | 超大或越界候选不会进入 Catalog；完整资源安全仍由 SKILL-102 承担。 |

## Current State

- 当前进展：实现、契约测试和全量验证已完成。
- 当前阻塞：无。
- 下一步：执行已解锁的 SKILL-102，安全读取已发现 Skill 的指令和资源。

## Task Files

- [worklog.md](./worklog.md)：实施调查和变更记录。
- [evidence.md](./evidence.md)：验收项、测试结果和完成证据。

## Decisions and Risks

- Catalog 稳定 ID 暂定为 `project:<name>`；后续增加其他来源时可按命名空间扩展，不改变项目级 ID。
- 本任务拒绝根目录、Skill 目录和 `SKILL.md` 符号链接，避免发现阶段读取项目外元数据；SKILL-102 再提供完整真实路径校验与资源访问。

## Latest Session State

- Current state: 已完成并通过验收。
- Remaining work: 无；Runtime 接入不属于本任务。
- Blockers: 无。
- Recommended next action: 开始 SKILL-102。
