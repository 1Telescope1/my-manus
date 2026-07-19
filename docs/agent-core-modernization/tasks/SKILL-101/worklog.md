# SKILL-101 Worklog

## 2026-07-19 — 发现边界与首次实现

### Goal

- 完成项目级 Skill Catalog、隔离诊断和契约测试。

### Investigation

- `TASKS.md` 将本任务标为 `ready`，无前置依赖。
- SDD §6 规定项目根、Frontmatter 契约、256 KiB 上限、渐进披露和隔离语义。
- Agent Skills 官方规范补充了 `name` 的 64 字符、小写字母/数字/连字符、首尾及连续连字符约束，以及可选字段类型和长度。
- 当前代码没有 Skill 领域模型、扫描器、Catalog 或 `.agents/skills/` 示例目录。

### Changes

| 文件 | 变更原因 |
| --- | --- |
| `docs/agent-core-modernization/TASKS.md` | 领取任务并建立证据链接。 |
| `docs/agent-core-modernization/tasks/SKILL-101/*` | 记录范围、证据和实施状态。 |
| `api/src/domain/models/skill.ts` | 定义元数据 Catalog、结构化诊断和发现端口。 |
| `api/src/infrastructure/skills/file-system-skill-catalog.ts` | 实现项目目录扫描、Frontmatter 校验、冲突隔离和确定性快照。 |
| `api/test/contracts/skill-catalog.contract.test.ts` | 覆盖合法、空目录、无效、超限、冲突、符号链接和配置失败。 |

### Verification

- `node --import tsx --test test/contracts/skill-catalog.contract.test.ts`：8/8 通过。
- `npm run test:contract`：139/139 通过。
- `npm run typecheck`：通过。
- `npm run build`：通过。

### Findings

- 重名在单项目根目录下通常会与目录名不匹配同时出现；发现器应独立报告两类问题，而不是让一种校验遮蔽另一种。
- Catalog 不应泄露 `SKILL.md` 路径、可选配置或 Markdown 正文。
- `.agents/skills` 根本身也可能是符号链接；只检查直接子条目不足以守住项目发现范围，因此根目录同样拒绝符号链接。
- Runtime 注入属于 SKILL-103；本任务保持发现端口独立，避免未经安全读取和激活的正文进入上下文。

### Next

- 开始 SKILL-102，实现真实路径校验、资源清单和安全指令读取。
