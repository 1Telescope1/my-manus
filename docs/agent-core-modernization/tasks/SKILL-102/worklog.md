# SKILL-102 Worklog

## 2026-07-19 — 安全读取边界与首次实现

### Goal

- 完成 Skill 指令、资源清单和按需资源读取的真实路径安全边界。

### Investigation

- SDD 固定 `SKILL.md` 上限为 256 KiB，并要求阻断 `..`、绝对路径和符号链接逃逸。
- SKILL-101 已刻意只做可信内置 Skill 的元数据发现，未提供正文、真实路径或资源读取能力。
- 资源单文件上限尚未固定；本任务采用可配置的默认 10 MiB，避免无限制读入内存。
- 当前代码没有 Skill Loader、资源清单、内容摘要或稳定访问错误协议。

### Changes

| 文件 | 变更原因 |
| --- | --- |
| `docs/agent-core-modernization/TASKS.md` | 领取任务并建立任务链接。 |
| `docs/agent-core-modernization/tasks/SKILL-102/*` | 记录范围、证据和实施状态。 |
| `api/src/domain/models/skill-content.ts` | 定义 Loader 端口、内容/资源模型和稳定访问错误。 |
| `api/src/infrastructure/skills/file-system-skill-content-loader.ts` | 实现真实路径安全、Frontmatter、摘要、清单和大小受限读取。 |
| `api/test/contracts/skill-content-loader.contract.test.ts` | 覆盖正常读取及全部关键安全和失败路径。 |

### Verification

- `node --import tsx --test test/contracts/skill-content-loader.contract.test.ts`：11/11 通过。
- `npm run test:contract`：150/150 通过。
- `npm run typecheck`：通过。
- `npm run build`：通过。

### Findings

- 资源清单不应读取全部资源内容；只在调用方明确请求单个资源时应用内容读取上限。
- scripts 与普通资源共用安全读取边界，但本任务不能提供执行方法。
- 资源目录前缀必须使用 own-property 判断；原型链判断会让 `__proto__/x` 绕过规范目录白名单。
- 单纯在读取前调用 `stat` 不足以强制上限；有界读取最多消费 `limit + 1` 字节，才能覆盖检查后文件增长。
- 内部符号链接仍可能形成递归目录循环，因此 containment 之外还需要祖先真实路径集合。

### Next

- 开始 SKILL-103，将 Catalog、显式/模型激活和 Loader 组成渐进披露流程。

## 2026-07-19 — 按可信内置 Skill 边界精简

### Goal

- 删除面向不可信第三方 Skill 包的额外防御，只保留 SKILL-102 验收和全局内置 Skill 必需边界。

### Investigation

- 当前 Skill 来源是开发者维护、随源码评审和发布的项目级目录，不是用户上传或远程 Registry。
- 初版的 1024 项配额、独立目录循环错误、严格 UTF-8 和 `limit + 1` 流式读取增加了较多代码，但不改变当前可信来源下的核心决策。

### Changes

| 文件 | 变更原因 |
| --- | --- |
| `api/src/infrastructure/skills/file-system-skill-content-loader.ts` | 删除资源数量配额、流式读取和独立循环错误；循环目录改为去重跳过，大小改为读取前后检查。 |
| `api/src/domain/models/skill-content.ts` | 删除 `RESOURCE_CYCLE`、`RESOURCE_LIMIT_EXCEEDED`。 |
| `api/test/contracts/skill-content-loader.contract.test.ts` | 删除资源数量超限测试，将根内循环改为兼容性测试。 |
| `docs/agent-core-modernization/tasks/SKILL-102/*` | 明确信任边界和当前保留的最小保护。 |

### Verification

- 专项测试保持 11/11 通过；全量结果见 `evidence.md`。

### Findings

- 不可删除的边界是路径 containment、规范资源目录、普通文件、缺失资源和大小限制。
- 第三方或用户上传 Skill 的配额、严格编码和目录炸弹保护应在未来 Registry 的不可信输入边界实现，而不是提前施加给内置 Skill。

### Next

- 运行全量契约、typecheck 和 build，确认精简没有改变 SKILL-102 验收。
