import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
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

test('无效 Frontmatter 应被隔离且不影响合法 Skill', async (t) => {
  const projectRoot = await createProject(t);
  await writeSkill(projectRoot, 'valid-skill', `---
name: valid-skill
description: 合法 Skill；用于验证故障隔离。
---
正文
`);
  await writeSkill(projectRoot, 'bad--name', `---
name: bad--name
description: 名称含有连续连字符。
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
  assert.deepEqual(
    new Set(snapshot.diagnostics.map((diagnostic) => diagnostic.code)),
    new Set([
      SkillDiagnosticCode.DESCRIPTOR_INVALID,
      SkillDiagnosticCode.FRONTMATTER_INVALID,
      SkillDiagnosticCode.FRONTMATTER_MISSING,
    ]),
  );
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

test('Skill 目录和 SKILL.md 符号链接不应被发现', async (t) => {
  const projectRoot = await createProject(t);
  const skillsRoot = join(projectRoot, '.agents', 'skills');
  const externalDirectory = join(projectRoot, 'external-skill');
  await mkdir(externalDirectory, { recursive: true });
  await writeFile(join(externalDirectory, 'SKILL.md'), `---
name: linked-directory
description: 符号链接目录不应被跟随。
---
正文
`, 'utf8');
  await mkdir(skillsRoot, { recursive: true });
  await symlink(externalDirectory, join(skillsRoot, 'linked-directory'));

  const linkedFileDirectory = join(skillsRoot, 'linked-file');
  await mkdir(linkedFileDirectory, { recursive: true });
  await symlink(
    join(externalDirectory, 'SKILL.md'),
    join(linkedFileDirectory, 'SKILL.md'),
  );

  const snapshot = await new FileSystemSkillCatalog(projectRoot).discover();

  assert.deepEqual(snapshot.entries, []);
  assert.deepEqual(
    snapshot.diagnostics.map((diagnostic) => diagnostic.code),
    [
      SkillDiagnosticCode.UNSUPPORTED_ENTRY,
      SkillDiagnosticCode.SKILL_FILE_NOT_REGULAR,
    ],
  );
  assert.equal(snapshot.diagnostics.every(
    (diagnostic) => diagnostic.location.startsWith('.agents/skills/'),
  ), true);
});

test('项目 Skills 根符号链接不应扩大扫描范围', async (t) => {
  const projectRoot = await createProject(t);
  const externalRoot = join(projectRoot, 'external-root');
  await mkdir(externalRoot, { recursive: true });
  await mkdir(join(projectRoot, '.agents'), { recursive: true });
  await writeSkill(projectRoot, 'temporary-skill', `---
name: temporary-skill
description: 仅用于创建后替换真实 Skills 根。
---
正文
`);
  await rm(join(projectRoot, '.agents', 'skills'), { recursive: true });
  await symlink(externalRoot, join(projectRoot, '.agents', 'skills'));

  const snapshot = await new FileSystemSkillCatalog(projectRoot).discover();

  assert.deepEqual(snapshot.entries, []);
  assert.equal(snapshot.diagnostics.length, 1);
  assert.equal(snapshot.diagnostics[0].code, SkillDiagnosticCode.ROOT_UNREADABLE);
  assert.equal(snapshot.diagnostics[0].location, '.agents/skills');
});

test('非法文件上限配置应在扫描前失败', () => {
  assert.throws(
    () => new FileSystemSkillCatalog('/project', { skillFileMaxBytes: 0 }),
    RangeError,
  );
});
