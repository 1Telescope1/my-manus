import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  SkillAccessError,
  SkillAccessErrorCode,
  SkillResourceKind,
} from '../../src/domain/models/skill-content';
import { FileSystemSkillContentLoader } from '../../src/infrastructure/skills/file-system-skill-content-loader';

/** 创建自动清理的临时项目根。 */
async function createProject(t: TestContext): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'manus-skill-loader-'));
  t.after(async () => rm(projectRoot, { recursive: true, force: true }));
  return projectRoot;
}

/** 创建自动清理且位于项目外的临时路径，用于验证真实路径逃逸。 */
async function createExternalRoot(t: TestContext): Promise<string> {
  const externalRoot = await mkdtemp(join(tmpdir(), 'manus-skill-external-'));
  t.after(async () => rm(externalRoot, { recursive: true, force: true }));
  return externalRoot;
}

/** 写入最小合法 Skill，并返回其目录。 */
async function writeSkill(projectRoot: string, name: string, body = '按步骤完成任务。') {
  const skillRoot = join(projectRoot, '.agents', 'skills', name);
  await mkdir(skillRoot, { recursive: true });
  await writeFile(join(skillRoot, 'SKILL.md'), `---
name: ${name}
description: 安全读取测试 Skill；用于验证指令和资源边界。
license: Apache-2.0
compatibility: Requires local files.
metadata:
  owner: manus
allowed-tools: read_file search_web
---
${body}
`, 'utf8');
  return skillRoot;
}

/** 断言 Promise 以指定 Skill 领域错误码失败。 */
async function assertSkillError(
  operation: Promise<unknown>,
  expectedCode: SkillAccessErrorCode,
): Promise<void> {
  await assert.rejects(operation, (error) => {
    assert.equal(error instanceof SkillAccessError, true);
    assert.equal((error as SkillAccessError).code, expectedCode);
    return true;
  });
}

test('Loader 应读取完整指令并生成稳定资源清单', async (t) => {
  const projectRoot = await createProject(t);
  const skillRoot = await writeSkill(projectRoot, 'web-research');
  await mkdir(join(skillRoot, 'references', 'nested'), { recursive: true });
  await mkdir(join(skillRoot, 'scripts'), { recursive: true });
  await mkdir(join(skillRoot, 'assets'), { recursive: true });
  await writeFile(join(skillRoot, 'references', 'nested', 'guide.md'), '参考资料', 'utf8');
  await writeFile(join(skillRoot, 'scripts', 'run.sh'), '#!/bin/sh\necho safe', 'utf8');
  await writeFile(join(skillRoot, 'assets', 'template.bin'), Buffer.from([1, 2, 3]));
  await writeFile(join(skillRoot, 'ignored.txt'), '不属于规范资源目录', 'utf8');

  const loader = new FileSystemSkillContentLoader(projectRoot);
  const loaded = await loader.load('project:web-research');

  assert.equal(loaded.descriptor.name, 'web-research');
  assert.equal(loaded.content.includes('按步骤完成任务。'), true);
  assert.match(loaded.contentDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(loaded.allowedTools, ['read_file', 'search_web']);
  assert.deepEqual(loaded.metadata, { owner: 'manus' });
  assert.deepEqual(loaded.resources, [
    { path: 'assets/template.bin', kind: SkillResourceKind.ASSET, sizeBytes: 3 },
    {
      path: 'references/nested/guide.md',
      kind: SkillResourceKind.REFERENCE,
      sizeBytes: Buffer.byteLength('参考资料'),
    },
    { path: 'scripts/run.sh', kind: SkillResourceKind.SCRIPT, sizeBytes: 19 },
  ]);

  const resource = await loader.readResource(
    'project:web-research',
    'references/nested/guide.md',
  );
  assert.equal(new TextDecoder().decode(resource.bytes), '参考资料');
});

test('没有可选资源目录的 Skill 应返回空清单', async (t) => {
  const projectRoot = await createProject(t);
  await writeSkill(projectRoot, 'plain-skill');

  const loaded = await new FileSystemSkillContentLoader(projectRoot).load(
    'project:plain-skill',
  );

  assert.deepEqual(loaded.resources, []);
});

test('父目录、绝对路径和反斜杠资源路径应在文件访问前被拒绝', async (t) => {
  const projectRoot = await createProject(t);
  await writeSkill(projectRoot, 'safe-skill');
  const loader = new FileSystemSkillContentLoader(projectRoot);

  for (const resourcePath of [
    '../secret.txt',
    '/tmp/secret.txt',
    'references/../SKILL.md',
    'references\\secret.txt',
    '__proto__/secret.txt',
  ]) {
    await assertSkillError(
      loader.readResource('project:safe-skill', resourcePath),
      SkillAccessErrorCode.RESOURCE_PATH_INVALID,
    );
  }
});

test('Skills 根或单个 Skill 的符号链接逃逸应被拒绝', async (t) => {
  const projectRoot = await createProject(t);
  const externalRoot = await createExternalRoot(t);
  await writeSkill(externalRoot, 'external-skill');
  await mkdir(join(projectRoot, '.agents'), { recursive: true });
  await symlink(
    join(externalRoot, '.agents', 'skills'),
    join(projectRoot, '.agents', 'skills'),
  );

  await assertSkillError(
    new FileSystemSkillContentLoader(projectRoot).load('project:external-skill'),
    SkillAccessErrorCode.PATH_ESCAPE,
  );

  const secondProject = await createProject(t);
  const externalSkillRoot = await writeSkill(externalRoot, 'escaped-skill');
  await mkdir(join(secondProject, '.agents', 'skills'), { recursive: true });
  await symlink(
    externalSkillRoot,
    join(secondProject, '.agents', 'skills', 'escaped-skill'),
  );
  await assertSkillError(
    new FileSystemSkillContentLoader(secondProject).load('project:escaped-skill'),
    SkillAccessErrorCode.PATH_ESCAPE,
  );
});

test('指令和资源符号链接逃逸应在读取内容前被拒绝', async (t) => {
  const projectRoot = await createProject(t);
  const externalRoot = await createExternalRoot(t);
  const skillRoot = await writeSkill(projectRoot, 'linked-skill');
  await writeFile(join(externalRoot, 'outside.md'), '外部内容', 'utf8');
  await mkdir(join(skillRoot, 'references'), { recursive: true });
  await symlink(
    join(externalRoot, 'outside.md'),
    join(skillRoot, 'references', 'outside.md'),
  );

  await assertSkillError(
    new FileSystemSkillContentLoader(projectRoot).load('project:linked-skill'),
    SkillAccessErrorCode.PATH_ESCAPE,
  );

  const instructionSkillRoot = join(projectRoot, '.agents', 'skills', 'linked-instruction');
  await mkdir(instructionSkillRoot, { recursive: true });
  await symlink(
    join(externalRoot, 'outside.md'),
    join(instructionSkillRoot, 'SKILL.md'),
  );
  await assertSkillError(
    new FileSystemSkillContentLoader(projectRoot).load('project:linked-instruction'),
    SkillAccessErrorCode.PATH_ESCAPE,
  );
});

test('真实目标仍在 Skill 根内的资源符号链接应可列出和读取', async (t) => {
  const projectRoot = await createProject(t);
  const skillRoot = await writeSkill(projectRoot, 'internal-link');
  await mkdir(join(skillRoot, 'references'), { recursive: true });
  await writeFile(join(skillRoot, 'references', 'source.md'), '根内资料', 'utf8');
  await symlink('source.md', join(skillRoot, 'references', 'alias.md'));

  const loader = new FileSystemSkillContentLoader(projectRoot);
  const loaded = await loader.load('project:internal-link');
  const alias = await loader.readResource('project:internal-link', 'references/alias.md');

  assert.deepEqual(loaded.resources.map((resource) => resource.path), [
    'references/alias.md',
    'references/source.md',
  ]);
  assert.equal(new TextDecoder().decode(alias.bytes), '根内资料');
});

test('缺失资源应稳定失败且不影响读取其他 Skill', async (t) => {
  const projectRoot = await createProject(t);
  await writeSkill(projectRoot, 'first-skill');
  await writeSkill(projectRoot, 'second-skill');
  const loader = new FileSystemSkillContentLoader(projectRoot);

  await assertSkillError(
    loader.readResource('project:first-skill', 'references/missing.md'),
    SkillAccessErrorCode.RESOURCE_NOT_FOUND,
  );
  const second = await loader.load('project:second-skill');

  assert.equal(second.descriptor.id, 'project:second-skill');
});

test('缺失 Skill 和缺失指令应返回不同稳定错误', async (t) => {
  const projectRoot = await createProject(t);
  const skillsRoot = join(projectRoot, '.agents', 'skills');
  await mkdir(join(skillsRoot, 'missing-instruction'), { recursive: true });
  const loader = new FileSystemSkillContentLoader(projectRoot);

  await assertSkillError(
    loader.load('project:missing-skill'),
    SkillAccessErrorCode.SKILL_NOT_FOUND,
  );
  await assertSkillError(
    loader.load('project:missing-instruction'),
    SkillAccessErrorCode.INSTRUCTION_NOT_FOUND,
  );
});

test('指令和资源超过各自上限时应返回不同错误', async (t) => {
  const projectRoot = await createProject(t);
  await writeSkill(
    projectRoot,
    'large-instruction',
    'x'.repeat(512),
  );
  const instructionLoader = new FileSystemSkillContentLoader(projectRoot, {
    skillFileMaxBytes: 128,
  });
  await assertSkillError(
    instructionLoader.load('project:large-instruction'),
    SkillAccessErrorCode.INSTRUCTION_TOO_LARGE,
  );

  const resourceSkill = await writeSkill(projectRoot, 'large-resource');
  await mkdir(join(resourceSkill, 'assets'), { recursive: true });
  await writeFile(join(resourceSkill, 'assets', 'large.bin'), Buffer.alloc(64, 1));
  const resourceLoader = new FileSystemSkillContentLoader(projectRoot, {
    resourceMaxBytes: 32,
  });
  const manifest = await resourceLoader.load('project:large-resource');
  assert.equal(manifest.resources[0].sizeBytes, 64);
  await assertSkillError(
    resourceLoader.readResource('project:large-resource', 'assets/large.bin'),
    SkillAccessErrorCode.RESOURCE_TOO_LARGE,
  );
});

test('非法 Skill ID 和读取上限配置应在文件访问前失败', async (t) => {
  const projectRoot = await createProject(t);
  const loader = new FileSystemSkillContentLoader(projectRoot);

  await assertSkillError(
    loader.load('project:../escape'),
    SkillAccessErrorCode.INVALID_SKILL_ID,
  );
  assert.throws(
    () => new FileSystemSkillContentLoader(projectRoot, { resourceMaxBytes: 0 }),
    RangeError,
  );
});

test('资源目录符号链接循环应被去重而不阻断可信 Skill', async (t) => {
  const projectRoot = await createProject(t);
  const cyclicSkill = await writeSkill(projectRoot, 'cyclic-skill');
  await mkdir(join(cyclicSkill, 'references'), { recursive: true });
  await writeFile(join(cyclicSkill, 'references', 'guide.md'), '说明', 'utf8');
  await symlink('.', join(cyclicSkill, 'references', 'loop'));
  const loaded = await new FileSystemSkillContentLoader(projectRoot).load(
    'project:cyclic-skill',
  );

  assert.deepEqual(loaded.resources.map((resource) => resource.path), [
    'references/guide.md',
  ]);
});
