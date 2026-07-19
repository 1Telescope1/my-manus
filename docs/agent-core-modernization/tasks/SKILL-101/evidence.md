# SKILL-101 Evidence

## Acceptance Results

| 验收项 | 状态 | 证据 |
| --- | --- | --- |
| 合法 Skill 可发现 | Pass | 两个合法候选按名称返回稳定 `project:<name>` ID。 |
| Catalog 只含元数据 | Pass | 测试断言 entry 只有 `id`、`name`、`description`，正文和 `allowed-tools` 不在快照中。 |
| 重名、超限、名称不匹配被隔离并诊断 | Pass | 256 KiB 默认上限、重复声明和目录名不一致场景全部通过。 |
| 单个坏 Skill 不影响其他 Skill | Pass | YAML、Frontmatter 边界和名称无效时，合法 `valid-skill` 仍可发现。 |
| 不跟随发现路径上的符号链接 | Pass | 根目录、Skill 子目录和 `SKILL.md` 符号链接均不进入 Catalog。 |
| 结果可重复 | Pass | 候选、entries 和 diagnostics 使用稳定排序，契约测试验证预期快照。 |

## Verification Commands

| 命令或场景 | 结果 | 备注 |
| --- | --- | --- |
| `node --import tsx --test test/contracts/skill-catalog.contract.test.ts` | Pass | 8 tests，8 pass，0 fail。 |
| `npm run test:contract` | Pass | 139 tests，139 pass，0 fail。 |
| `npm run typecheck` | Pass | TypeScript 无错误。 |
| `npm run build` | Pass | Nest 构建成功。 |

## Compatibility and Failure Cases

| 场景 | 预期 | 实际结果 |
| --- | --- | --- |
| 项目尚未创建 `.agents/skills/` | 返回空 Catalog，不把可选目录缺失当成故障 | Pass。返回 `{ entries: [], diagnostics: [] }`。 |
| 单个 Frontmatter 无效 | 隔离该候选，其他合法 Skill 仍返回 | Pass。YAML、字段和边界错误分别诊断。 |
| 重名 | 所有冲突候选都被隔离，不静默覆盖 | Pass。两个候选各自收到 `duplicate_name`。 |
| 名称不匹配 | 候选不进入 Catalog，并指出声明名和目录名 | Pass。两个不匹配候选各自收到 `name_mismatch`。 |
| 默认文件上限 | 超过 256 KiB 不读取为合法 Skill | Pass。返回 `skill_file_too_large`。 |
| 根目录、Skill 目录或 `SKILL.md` 是符号链接 | 不跟随并返回诊断 | Pass。三层边界均有测试。 |
| Frontmatter 有效但含正文和可选字段 | 只返回三项 Catalog 元数据 | Pass。序列化快照不含正文或 `allowed-tools`。 |

## Completion Evidence

- 相关提交或 PR：未创建。
- 评测或运行报告：专项契约 8/8，全量契约 139/139，typecheck/build 通过。
- 未解决限制：Skill 激活、安全资源读取和 Runtime 接入属于 SKILL-102/103。
- 最终结论：`pass`，SKILL-101 Acceptance 全部满足。
