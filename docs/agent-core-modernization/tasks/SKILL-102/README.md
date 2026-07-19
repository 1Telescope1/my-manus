# SKILL-102 — 安全读取 Skill 指令和资源

> 本目录是该任务的独立工作记录。总体设计以 [SDD](../../../agent-core-modernization-sdd.md) 为准，总体状态以 [TASKS.md](../../TASKS.md) 为准。

| 字段 | 值 |
| --- | --- |
| Workstream | `Skills` |
| Status | `done` |
| Dependencies | `SKILL-101` |
| Started | `2026-07-19` |
| Last Updated | `2026-07-19` |
| Working Session | 当前 Codex 任务 |

## Intent

在 Skill Catalog 与后续激活器之间建立唯一的安全读取边界：调用方只能按稳定 Skill ID 读取受大小约束的 `SKILL.md`，只能按规范相对路径读取已归类资源，任何路径或符号链接逃逸都必须在内容进入 Runtime 前失败。

## 证据表

| 确定结论 | 证据路径 | 不确定项 | 建议改动范围 |
| --- | --- | --- | --- |
| SKILL-102 集中承担路径和资源安全。 | SDD §6.2/6.4；SKILL-101 README/Worklog | 无。 | 新增独立 Loader，不把真实路径规则重复写入 Catalog。 |
| `SKILL.md` 默认最大 256 KiB。 | SDD §6.2 | 资源单文件上限未固定。 | 正文沿用 256 KiB；资源默认 10 MiB 且可配置。 |
| 资源按需读取，缺失只让本次操作失败。 | SDD §6.3/6.4 | 清单如何表达超限资源。 | 清单保留路径、类型和大小；实际读取时应用上限。 |
| 禁止 `..`、绝对路径和符号链接逃逸。 | SDD §6.2；TASKS Acceptance | 根内符号链接是否允许。 | 使用真实路径 containment；根内链接允许，逃逸链接拒绝。 |
| scripts 不得自动执行。 | SDD §6.3；SKILL-105 | 无。 | 本任务只返回资源字节，不提供执行入口。 |

## 本任务做了什么

### 一句话说明

> 把 Catalog 中的 Skill ID 转换为可安全使用的完整指令和按需资源，同时保证任何逻辑路径、符号链接或文件变化都不能把读取范围带出当前项目和 Skill 根。

### 为什么需要这个任务

SKILL-101 只回答“项目里有哪些可信内置 Skill”，有意不返回文件路径、正文或资源。后续激活器若自行拼接 `.agents/skills/<name>/SKILL.md`，就会在每个调用点重复实现路径校验，并容易把 `..`、绝对路径、符号链接或超大文件直接带入 Runtime。尤其资源引用来自 Skill 正文，即使 Skill 随源码发布，也不能让一个错误引用读取同项目的密钥、配置或任意宿主机文件。

本任务提供唯一读取端口：调用方只提交稳定 ID 或规范资源相对路径；Loader 负责真实路径、类型、大小、格式和错误语义。后续 SKILL-103/105 不再直接接触文件系统。

### 核心对象或能力

| 对象或能力 | 职责 | 例子 |
| --- | --- | --- |
| `SkillContentLoader` | 定义读取完整指令与单个资源的领域端口，不暴露 Node.js 文件系统类型。 | `load("project:web-research")`；`readResource(id, "references/guide.md")`。 |
| `LoadedSkillContent` | 返回 Catalog 描述、完整 `SKILL.md`、SHA-256 摘要、可选 Frontmatter 和资源清单。 | 激活器可固定 `contentDigest`，但资源正文仍未进入上下文。 |
| `SkillResourceDescriptor` | 只描述规范资源路径、类别和字节大小，不公开绝对真实路径。 | `{ path: "assets/template.bin", kind: "asset", sizeBytes: 3 }`。 |
| `LoadedSkillResource` | 按需返回单个有界二进制资源，兼容文本、脚本和静态资产。 | references 可解码为文本；scripts 仍只是字节，不会执行。 |
| `SkillAccessErrorCode` | 把文件系统异常收敛为稳定领域错误。 | `path_escape`、`resource_not_found`、`resource_too_large`。 |
| `FileSystemSkillContentLoader` | 实现 canonical path containment、递归清单和大小受限读取。 | 根内符号链接允许；指向 Skill 根外时在读取前拒绝。 |

### 主要流程

```text
project:<name>
  → 校验 ID 不含路径字符
  → realpath(projectRoot)
  → realpath(.agents/skills) 并确认仍在 projectRoot 内
  → realpath(skillRoot) 并确认仍在 skillsRoot 内
  → realpath(SKILL.md) 并确认仍在 skillRoot 内
  → 最多读取 256 KiB + 1 字节
  → UTF-8 解码、YAML Frontmatter 与 ID/name 一致校验
  → 计算 SHA-256 内容摘要
  → 递归枚举 scripts/references/assets
  → 每个节点执行 realpath containment 和普通文件类型检查
  → 返回完整指令及不含资源正文的稳定清单
```

资源读取是第二条独立路径：先拒绝绝对路径、反斜杠、空段、`.`、`..` 和非规范目录，再对真实目标执行 containment，并在读取前后检查默认 10 MiB 上限。

### 例子

正常路径：`project:web-research` 的 `SKILL.md` 合法，且包含 `references/source-quality.md`。`load()` 返回完整指令和该资源的类型/大小；只有调用方明确执行 `readResource(id, "references/source-quality.md")` 时才读取资源正文。

失败路径：`references/private.md` 是指向项目外 `/tmp/private.md` 的符号链接。Loader 先解析真实目标，再发现它不在当前 Skill 根内，返回 `path_escape`；外部文件内容不会被打开或进入模型。`references/../SKILL.md` 则更早在纯路径校验阶段返回 `resource_path_invalid`。

### 保护规则和当前边界

- 只接受不含 `/`、反斜杠、NUL、`.`/`..` 的 `project:<name>` ID。
- Skills 根、Skill 根、`SKILL.md`、资源根和每个递归节点都使用 `realpath`，containment 使用路径语义而非字符串前缀。
- 根内文件符号链接可列出和读取；重复或循环的真实目录在清单遍历时直接跳过；任何根外目标返回 `path_escape`。
- `SKILL.md` 默认上限 256 KiB，资源正文默认上限 10 MiB，两者都可在构造 Loader 时收紧。
- 清单只包含 `scripts/`、`references/`、`assets/` 中的普通文件并按 canonical 相对路径排序；Skill 根的其他文件不暴露。
- Frontmatter 在读取阶段解析 `license`、`compatibility`、`metadata`、`allowed-tools`，同时允许未来顶层扩展字段；声明 `name` 必须与稳定 ID 一致。
- 所有返回错误不包含部署机器绝对路径；缺失 Skill、缺失指令和缺失资源拥有不同错误码。
- Loader 没有 execute 方法；scripts 只能作为 `Uint8Array` 读取，Sandbox 执行与 Artifact/Context 接入仍属于 SKILL-105。
- 当前 Loader 尚未注册进 Runtime；激活、Run 内去重和模型上下文披露属于 SKILL-103。

## Scope

### In scope

- 按 `project:<name>` 稳定 ID 安全定位项目级 Skill。
- 真实路径校验项目 Skills 根、Skill 根、`SKILL.md` 和资源。
- 有界读取并校验完整 `SKILL.md`，返回内容摘要和可选 Frontmatter 元数据。
- 递归生成 `scripts/`、`references/`、`assets/` 资源清单。
- 按需读取资源，明确区分非法路径、逃逸、缺失、非普通文件和超限错误。
- 覆盖路径逃逸、符号链接逃逸、缺失资源、超限和正常读取测试。

### Out of scope

- 把 Skill Catalog 或正文注入 Runtime/模型上下文。
- Run 内激活去重和版本固定。
- 自动执行 scripts 或把资源转换为 Artifact。
- 用户级、组织级和远程 Skill Registry。

## Acceptance Checklist

- [x] `..` 和绝对资源路径被拒绝。
- [x] Skills 根、Skill 根、指令或资源的符号链接逃逸被拒绝。
- [x] 缺失 Skill 或资源返回稳定领域错误且不影响其他 Skill。
- [x] `SKILL.md` 和资源大小上限均被强制执行。
- [x] 资源清单只包含规范目录内的普通文件并稳定排序。
- [x] scripts 只可读取，不存在自动执行路径。
- [x] 新增或修改的自动化测试标题使用中文。
- [x] 新增或修改的枚举类型及每个枚举项都有中文注释。
- [x] 新增或修改的函数有头部中文注释，重要步骤有中文说明。
- [x] 专项测试、全量契约测试、typecheck 和 build 通过。
- [x] “本任务做了什么”和“改造前后对比”完整。
- [x] [evidence.md](./evidence.md) 和总任务清单已更新。

## 改造前后对比

| 对比项 | 改造前 | 完成后 | 实际影响 |
| --- | --- | --- | --- |
| 指令读取 | 调用方只能获得 Catalog 元数据，没有安全正文入口。 | 稳定 ID 经多层真实路径校验后有界读取完整指令。 | SKILL-103 可直接复用端口，不需自行拼接路径。 |
| 资源发现 | `scripts/`、`references/`、`assets/` 不可见。 | 递归生成稳定、无绝对路径的资源清单。 | 模型可先看到“有什么”，再按需读取，不会一次加载全部内容。 |
| 路径安全 | 没有统一的 `..`、绝对路径或符号链接逃逸防线。 | 逻辑路径预检加逐层 realpath containment。 | 错误或恶意引用不能读取项目和 Skill 根外文件。 |
| 大小边界 | 只有 Catalog 扫描前的 256 KiB 检查。 | 正文和资源在读取前后检查各自上限。 | 明显超限内容不会进入 Loader 结果，同时保持可信内置 Skill 实现简单。 |
| 失败语义 | 后续调用方只能处理原始文件系统异常。 | 稳定错误码区分根、Skill、指令、资源、逃逸和上限。 | Runtime 可向模型返回明确错误，同时保持其他 Skill 可用。 |
| scripts 行为 | 尚无读取或执行入口。 | 可作为普通字节安全读取，但仍无执行方法。 | 为 SKILL-105 的 Sandbox 接入准备输入，同时不存在宿主机自动执行路径。 |

## Current State

- 当前进展：实现、专项安全测试和全量验证已完成。
- 当前阻塞：无。
- 下一步：执行已解锁的 SKILL-103，将 Catalog 和 Loader 接入渐进披露。

## Task Files

- [worklog.md](./worklog.md)：实施调查和变更记录。
- [evidence.md](./evidence.md)：验收项、测试结果和完成证据。

## Decisions and Risks

- 真实路径安全采用 canonical path containment，而不是字符串前缀比较。
- 默认资源单文件读取上限为 10 MiB；这只约束 Loader 内存读取，不代表资源会内联进入模型。
- 内置 Skill 随源码评审发布，不额外限制资源总数；若未来接入第三方 Skill Registry，再在对应信任边界增加配额。
- 根内符号链接按真实目标允许，保留模板复用能力；根外目标失败，重复目录只去重跳过。

## Latest Session State

- Current state: 已完成并通过验收。
- Remaining work: 无；Runtime 激活和资源执行不属于本任务。
- Blockers: 无。
- Recommended next action: 开始 SKILL-103。
