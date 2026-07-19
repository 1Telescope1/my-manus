import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { TestContext } from 'node:test';
import { SkillDiagnosticCode } from '../../src/domain/models/skill';
import {
  DEFAULT_SKILL_FILE_MAX_BYTES,
  FileSystemSkillCatalog,
} from '../../src/infrastructure/skills/file-system-skill-catalog';

/** 创建自动清理的临时项目根，避免契约测试依赖仓库中的真实 Skills。 */
async function createProject(t: TestContext): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'manus-skill-catalog-'));
  t.after(async () => rm(projectRoot, { recursive: true, force: true }));
  return projectRoot;
}

/** 在项目级约定目录创建一个 SKILL.md 测试候选。 */
async function writeSkill(
  projectRoot: string,
  directoryName: string,
  content: string,
): Promise<string> {
  const skillDirectory = join(projectRoot, '.agents', 'skills', directoryName);
  await mkdir(skillDirectory, { recursive: true });
  const skillFile = join(skillDirectory, 'SKILL.md');
  await writeFile(skillFile, content, 'utf8');
  return skillFile;
}

test('合法 Skill 应按名称排序发现且 Catalog 只包含元数据', async (t) => {
  const projectRoot = await createProject(t);
  await writeSkill(projectRoot, 'web-research', `---
name: web-research
description: 研究网页并核对来源；用于需要最新事实和引用的任务。
license: Apache-2.0
compatibility: Requires network access.
metadata:
  owner: manus
  version: "1.0.0"
allowed-tools: search_web browser_view
future-field: discovery-should-ignore-this
---
# 不应进入 Catalog 的完整指令
`);
  await writeSkill(projectRoot, 'data-analysis', `---
name: data-analysis
description: 分析结构化数据；用于表格统计和趋势判断。
---
敏感的内部指令正文
`);

  const snapshot = await new FileSystemSkillCatalog(projectRoot).discover();

  assert.deepEqual(snapshot, {
    entries: [
      {
        id: 'project:data-analysis',
        name: 'data-analysis',
        description: '分析结构化数据；用于表格统计和趋势判断。',
      },
      {
        id: 'project:web-research',
        name: 'web-research',
        description: '研究网页并核对来源；用于需要最新事实和引用的任务。',
      },
    ],
    diagnostics: [],
  });
  assert.deepEqual(Object.keys(snapshot.entries[0]), ['id', 'name', 'description']);
  assert.equal(JSON.stringify(snapshot).includes('敏感的内部指令正文'), false);
  assert.equal(JSON.stringify(snapshot).includes('allowed-tools'), false);
});

test('项目未定义 Skills 目录时应返回空快照', async (t) => {
  const projectRoot = await createProject(t);

  const snapshot = await new FileSystemSkillCatalog(projectRoot).discover();

  assert.deepEqual(snapshot, { entries: [], diagnostics: [] });
});

test('缺少必填字段或 YAML 无效时应隔离候选且不影响合法 Skill', async (t) => {
  const projectRoot = await createProject(t);
  await writeSkill(projectRoot, 'valid-skill', `---
name: valid-skill
description: 合法 Skill；用于验证故障隔离。
---
正文
`);
  await writeSkill(projectRoot, 'missing-description', `---
name: missing-description
---
正文
`);
  await writeSkill(projectRoot, 'broken-yaml', `---
name: broken-yaml
description: [没有闭合
---
正文
`);
  await writeSkill(projectRoot, 'missing-frontmatter', '# 只有正文');

  const snapshot = await new FileSystemSkillCatalog(projectRoot).discover();

  assert.deepEqual(snapshot.entries.map((entry) => entry.name), ['valid-skill']);
  assert.equal(snapshot.diagnostics.length, 3);
  assert.equal(snapshot.diagnostics.every(
    (diagnostic) => diagnostic.code === SkillDiagnosticCode.FRONTMATTER_INVALID,
  ), true);
});

test('超过默认 256 KiB 的 SKILL.md 应被隔离并诊断', async (t) => {
  const projectRoot = await createProject(t);
  await writeSkill(projectRoot, 'large-skill', `---
name: large-skill
description: 超限候选。
---
${'x'.repeat(DEFAULT_SKILL_FILE_MAX_BYTES)}
`);

  const snapshot = await new FileSystemSkillCatalog(projectRoot).discover();

  assert.deepEqual(snapshot.entries, []);
  assert.equal(snapshot.diagnostics.length, 1);
  assert.equal(snapshot.diagnostics[0].code, SkillDiagnosticCode.SKILL_FILE_TOO_LARGE);
  assert.match(
    snapshot.diagnostics[0].message,
    new RegExp(`超过 ${DEFAULT_SKILL_FILE_MAX_BYTES} 字节上限`),
  );
});

test('名称不匹配和重复声明应全部隔离并分别诊断', async (t) => {
  const projectRoot = await createProject(t);
  await writeSkill(projectRoot, 'first-directory', `---
name: shared-skill
description: 第一个重复声明。
---
正文
`);
  await writeSkill(projectRoot, 'second-directory', `---
name: shared-skill
description: 第二个重复声明。
---
正文
`);
  await writeSkill(projectRoot, 'safe-skill', `---
name: safe-skill
description: 不受冲突影响的合法 Skill。
---
正文
`);

  const snapshot = await new FileSystemSkillCatalog(projectRoot).discover();

  assert.deepEqual(snapshot.entries.map((entry) => entry.name), ['safe-skill']);
  assert.equal(
    snapshot.diagnostics.filter(
      (diagnostic) => diagnostic.code === SkillDiagnosticCode.NAME_MISMATCH,
    ).length,
    2,
  );
  assert.equal(
    snapshot.diagnostics.filter(
      (diagnostic) => diagnostic.code === SkillDiagnosticCode.DUPLICATE_NAME,
    ).length,
    2,
  );
});

test('Skills 根目录中的普通文件应被静默忽略', async (t) => {
  const projectRoot = await createProject(t);
  const skillsRoot = join(projectRoot, '.agents', 'skills');
  await mkdir(skillsRoot, { recursive: true });
  await writeFile(join(skillsRoot, 'README.md'), '开发者说明', 'utf8');

  const snapshot = await new FileSystemSkillCatalog(projectRoot).discover();

  assert.deepEqual(snapshot, { entries: [], diagnostics: [] });
});

test('缺少 SKILL.md 的目录应被隔离但不阻断扫描', async (t) => {
  const projectRoot = await createProject(t);
  await mkdir(join(projectRoot, '.agents', 'skills', 'empty-skill'), { recursive: true });
  await writeSkill(projectRoot, 'valid-skill', `---
name: valid-skill
description: 合法 Skill。
---
正文
`);

  const snapshot = await new FileSystemSkillCatalog(projectRoot).discover();

  assert.deepEqual(snapshot.entries.map((entry) => entry.name), ['valid-skill']);
  assert.equal(snapshot.diagnostics.length, 1);
  assert.equal(snapshot.diagnostics[0].code, SkillDiagnosticCode.SKILL_FILE_UNREADABLE);
  assert.equal(snapshot.diagnostics[0].location, '.agents/skills/empty-skill/SKILL.md');
});

test('非法文件上限配置应在扫描前失败', () => {
  assert.throws(
    () => new FileSystemSkillCatalog('/project', { skillFileMaxBytes: 0 }),
    RangeError,
  );
});
