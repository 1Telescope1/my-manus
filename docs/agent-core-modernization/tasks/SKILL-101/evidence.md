# SKILL-101 Evidence

## Acceptance Results

| 验收项 | 状态 | 证据 |
| --- | --- | --- |
| 合法 Skill 可发现 | Pass | 两个合法候选按名称返回稳定 `project:<name>` ID。 |
| Catalog 只含元数据 | Pass | 测试断言 entry 只有 `id`、`name`、`description`，正文和 `allowed-tools` 不在快照中。 |
| 重名、超限、名称不匹配被隔离并诊断 | Pass | 256 KiB 默认上限、重复声明和目录名不一致场景全部通过。 |
| 单个坏 Skill 不影响其他 Skill | Pass | YAML、Frontmatter 边界和必填字段无效时，合法 `valid-skill` 仍可发现。 |
| 非 Catalog 字段不制造额外失败 | Pass | 可选和未知 Frontmatter 字段被接受但不进入 entry；Skills 根普通文件被静默忽略。 |
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
| 单个 Frontmatter 无效 | 隔离该候选，其他合法 Skill 仍返回 | Pass。YAML、必填字段和边界错误统一为 `frontmatter_invalid`。 |
| 重名 | 所有冲突候选都被隔离，不静默覆盖 | Pass。两个候选各自收到 `duplicate_name`。 |
| 名称不匹配 | 候选不进入 Catalog，并指出声明名和目录名 | Pass。两个不匹配候选各自收到 `name_mismatch`。 |
| 默认文件上限 | 超过 256 KiB 不读取为合法 Skill | Pass。返回 `skill_file_too_large`。 |
| Skills 根目录包含 `README.md` 等普通文件 | 静默忽略，不产生配置告警 | Pass。返回空诊断。 |
| Skill 目录缺少 `SKILL.md` | 隔离该目录，其他合法 Skill 继续可用 | Pass。返回 `skill_file_unreadable`。 |
| Frontmatter 有效但含正文和可选字段 | 只返回三项 Catalog 元数据 | Pass。序列化快照不含正文或 `allowed-tools`。 |

## Completion Evidence

- 相关提交或 PR：未创建。
- 评测或运行报告：专项契约 8/8，全量契约 139/139，typecheck/build 通过。
- 未解决限制：符号链接/真实路径、正文与资源安全读取属于 SKILL-102；Skill 激活和 Runtime 接入属于 SKILL-103。
- 最终结论：`pass`，SKILL-101 Acceptance 全部满足。
