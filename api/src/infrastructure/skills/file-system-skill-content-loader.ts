import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import {
  LoadedSkillContent,
  LoadedSkillResource,
  SkillAccessError,
  SkillAccessErrorCode,
  SkillContentLoader,
  SkillResourceDescriptor,
  SkillResourceKind,
} from '../../domain/models/skill-content';
import { DEFAULT_SKILL_FILE_MAX_BYTES } from './file-system-skill-catalog';

/** 单个资源默认最多读取 10 MiB；更大资源由后续 Artifact 能力处理。 */
export const DEFAULT_SKILL_RESOURCE_MAX_BYTES = 10 * 1024 * 1024;

const SKILLS_DIRECTORY = '.agents/skills';
const SKILL_FILE_NAME = 'SKILL.md';
const RESOURCE_DIRECTORIES = {
  scripts: SkillResourceKind.SCRIPT,
  references: SkillResourceKind.REFERENCE,
  assets: SkillResourceKind.ASSET,
} as const;

/** Loader 只解释后续激活需要的字段，其他可信内置字段保持兼容。 */
const frontmatterSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  license: z.string().optional(),
  compatibility: z.string().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  'allowed-tools': z.string().optional(),
}).passthrough();

type ParsedSkillId = {
  id: string;
  name: string;
};

type ResolvedSkill = ParsedSkillId & {
  skillRoot: string;
};

/** 文件系统 Loader 的正文和资源读取上限。 */
export type FileSystemSkillContentLoaderOptions = {
  skillFileMaxBytes?: number;
  resourceMaxBytes?: number;
};

/** 为可信项目级 Skill 提供必要的真实路径与大小保护。 */
export class FileSystemSkillContentLoader implements SkillContentLoader {
  private readonly projectRoot: string;
  private readonly skillFileMaxBytes: number;
  private readonly resourceMaxBytes: number;

  /** 固定项目根和读取上限，避免单次调用改变边界。 */
  constructor(projectRoot: string, options: FileSystemSkillContentLoaderOptions = {}) {
    this.projectRoot = resolve(projectRoot);
    this.skillFileMaxBytes = positiveSafeInteger(
      options.skillFileMaxBytes ?? DEFAULT_SKILL_FILE_MAX_BYTES,
      'skillFileMaxBytes',
    );
    this.resourceMaxBytes = positiveSafeInteger(
      options.resourceMaxBytes ?? DEFAULT_SKILL_RESOURCE_MAX_BYTES,
      'resourceMaxBytes',
    );
  }

  /** 读取完整 `SKILL.md`，并列出三个规范目录中的资源元数据。 */
  async load(skillId: string): Promise<LoadedSkillContent> {
    const skill = await this.resolveSkill(skillId);
    const instructionPath = await this.resolveFile(
      skill,
      SKILL_FILE_NAME,
      SkillAccessErrorCode.INSTRUCTION_NOT_FOUND,
    );
    const instructionBytes = await this.readSizedFile(
      skill,
      instructionPath,
      SKILL_FILE_NAME,
      this.skillFileMaxBytes,
      SkillAccessErrorCode.INSTRUCTION_INVALID,
      SkillAccessErrorCode.INSTRUCTION_TOO_LARGE,
    );
    const content = instructionBytes.toString('utf8');
    const frontmatter = parseFrontmatter(content, skill.id);
    if (frontmatter.name !== skill.name) {
      throw this.error(
        SkillAccessErrorCode.INSTRUCTION_INVALID,
        skill.id,
        `Skill name "${frontmatter.name}" 与稳定 ID 不一致`,
      );
    }

    return {
      descriptor: {
        id: skill.id,
        name: frontmatter.name,
        description: frontmatter.description,
      },
      content,
      contentDigest: createHash('sha256').update(instructionBytes).digest('hex'),
      ...(frontmatter.license ? { license: frontmatter.license } : {}),
      ...(frontmatter.compatibility ? { compatibility: frontmatter.compatibility } : {}),
      ...(frontmatter.metadata ? { metadata: { ...frontmatter.metadata } } : {}),
      ...(frontmatter['allowed-tools']?.trim()
        ? { allowedTools: frontmatter['allowed-tools'].trim().split(/\s+/) }
        : {}),
      resources: await this.listResources(skill),
    };
  }

  /** 读取一个规范资源目录下的普通文件，不提供执行语义。 */
  async readResource(skillId: string, resourcePath: string): Promise<LoadedSkillResource> {
    const skill = await this.resolveSkill(skillId);
    const normalizedPath = validateResourcePath(resourcePath, skill.id);
    const resourceRealPath = await this.resolveFile(
      skill,
      normalizedPath,
      SkillAccessErrorCode.RESOURCE_NOT_FOUND,
    );
    const bytes = await this.readSizedFile(
      skill,
      resourceRealPath,
      normalizedPath,
      this.resourceMaxBytes,
      SkillAccessErrorCode.RESOURCE_NOT_REGULAR,
      SkillAccessErrorCode.RESOURCE_TOO_LARGE,
    );

    return {
      descriptor: {
        path: normalizedPath,
        kind: resourceKind(normalizedPath),
        sizeBytes: bytes.byteLength,
      },
      bytes: new Uint8Array(bytes),
    };
  }

  /** 解析项目级稳定 ID，并校验 Skills 根与 Skill 根没有真实路径逃逸。 */
  private async resolveSkill(skillId: string): Promise<ResolvedSkill> {
    const parsed = parseProjectSkillId(skillId);
    const projectRoot = await requiredRealPath(
      this.projectRoot,
      () => this.error(
        SkillAccessErrorCode.SKILLS_ROOT_UNAVAILABLE,
        parsed.id,
        '项目根目录不存在或无法读取',
      ),
    );
    const skillsRoot = await requiredRealPath(
      resolve(this.projectRoot, SKILLS_DIRECTORY),
      () => this.error(
        SkillAccessErrorCode.SKILLS_ROOT_UNAVAILABLE,
        parsed.id,
        '项目 Skills 目录不存在或无法读取',
      ),
    );
    await this.assertDirectory(skillsRoot, parsed.id, SkillAccessErrorCode.SKILLS_ROOT_UNAVAILABLE);
    if (!isWithin(projectRoot, skillsRoot)) {
      throw this.error(
        SkillAccessErrorCode.PATH_ESCAPE,
        parsed.id,
        '项目 Skills 目录的真实路径逃逸项目根',
      );
    }

    const skillRoot = await requiredRealPath(
      resolve(skillsRoot, parsed.name),
      () => this.error(
        SkillAccessErrorCode.SKILL_NOT_FOUND,
        parsed.id,
        `Skill 不存在：${parsed.name}`,
      ),
    );
    await this.assertDirectory(skillRoot, parsed.id, SkillAccessErrorCode.SKILL_NOT_FOUND);
    if (!isWithin(skillsRoot, skillRoot)) {
      throw this.error(
        SkillAccessErrorCode.PATH_ESCAPE,
        parsed.id,
        `Skill 真实路径逃逸项目 Skills 根：${parsed.name}`,
      );
    }
    return { ...parsed, skillRoot };
  }

  /** 解析 Skill 内文件真实路径，并确认最终目标仍在 Skill 根内。 */
  private async resolveFile(
    skill: ResolvedSkill,
    relativePath: string,
    notFoundCode: SkillAccessErrorCode,
  ): Promise<string> {
    const target = await requiredRealPath(
      resolve(skill.skillRoot, relativePath),
      () => this.error(
        notFoundCode,
        skill.id,
        `Skill 文件不存在：${relativePath}`,
        relativePath,
      ),
    );
    if (!isWithin(skill.skillRoot, target)) {
      throw this.error(
        SkillAccessErrorCode.PATH_ESCAPE,
        skill.id,
        `Skill 路径逃逸根目录：${relativePath}`,
        relativePath,
      );
    }
    return target;
  }

  /** 读取前后检查普通文件类型和大小，防止明显超限内容进入内存结果。 */
  private async readSizedFile(
    skill: ResolvedSkill,
    path: string,
    relativePath: string,
    maxBytes: number,
    invalidCode: SkillAccessErrorCode,
    tooLargeCode: SkillAccessErrorCode,
  ): Promise<Buffer> {
    let fileStats;
    try {
      fileStats = await stat(path);
    } catch {
      throw this.error(
        SkillAccessErrorCode.IO_ERROR,
        skill.id,
        `无法检查 Skill 文件：${relativePath}`,
        relativePath,
      );
    }
    if (!fileStats.isFile()) {
      throw this.error(invalidCode, skill.id, `Skill 文件必须是普通文件：${relativePath}`);
    }
    if (fileStats.size > maxBytes) {
      throw this.error(
        tooLargeCode,
        skill.id,
        `Skill 文件超过 ${maxBytes} 字节上限：${relativePath}`,
        relativePath,
      );
    }

    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch {
      throw this.error(
        SkillAccessErrorCode.IO_ERROR,
        skill.id,
        `无法读取 Skill 文件：${relativePath}`,
        relativePath,
      );
    }
    if (bytes.byteLength > maxBytes) {
      throw this.error(
        tooLargeCode,
        skill.id,
        `Skill 文件超过 ${maxBytes} 字节上限：${relativePath}`,
        relativePath,
      );
    }
    return bytes;
  }

  /** 递归列出规范资源目录；已访问的真实目录直接跳过，避免链接循环。 */
  private async listResources(skill: ResolvedSkill): Promise<SkillResourceDescriptor[]> {
    const resources: SkillResourceDescriptor[] = [];
    const visitedDirectories = new Set<string>();
    for (const [directory, kind] of Object.entries(RESOURCE_DIRECTORIES)) {
      const directoryPath = await optionalRealPath(resolve(skill.skillRoot, directory));
      if (!directoryPath) {
        continue;
      }
      if (!isWithin(skill.skillRoot, directoryPath)) {
        throw this.error(
          SkillAccessErrorCode.PATH_ESCAPE,
          skill.id,
          `Skill 资源目录逃逸根目录：${directory}`,
          directory,
        );
      }
      await this.walkResources(
        skill,
        directoryPath,
        directory,
        kind,
        visitedDirectories,
        resources,
      );
    }
    return resources.sort((left, right) => left.path.localeCompare(right.path));
  }

  /** 遍历一个资源目录，保留普通文件并拒绝真实路径逃逸。 */
  private async walkResources(
    skill: ResolvedSkill,
    directoryPath: string,
    logicalDirectory: string,
    kind: SkillResourceKind,
    visitedDirectories: Set<string>,
    resources: SkillResourceDescriptor[],
  ): Promise<void> {
    if (visitedDirectories.has(directoryPath)) {
      return;
    }
    visitedDirectories.add(directoryPath);

    let entries: Dirent[];
    try {
      entries = await readdir(directoryPath, { withFileTypes: true });
    } catch {
      throw this.error(
        SkillAccessErrorCode.RESOURCE_NOT_REGULAR,
        skill.id,
        `Skill 资源路径必须是目录：${logicalDirectory}`,
        logicalDirectory,
      );
    }
    for (const entry of entries.sort(compareDirectoryEntries)) {
      const logicalPath = `${logicalDirectory}/${entry.name}`;
      const target = await this.resolveFile(skill, logicalPath, SkillAccessErrorCode.RESOURCE_NOT_FOUND);
      const targetStats = await stat(target);
      if (targetStats.isDirectory()) {
        await this.walkResources(
          skill,
          target,
          logicalPath,
          kind,
          visitedDirectories,
          resources,
        );
      } else if (targetStats.isFile()) {
        resources.push({ path: logicalPath, kind, sizeBytes: targetStats.size });
      }
    }
  }

  /** 确认路径是目录，否则返回调用方指定的稳定错误。 */
  private async assertDirectory(
    path: string,
    skillId: string,
    code: SkillAccessErrorCode,
  ): Promise<void> {
    try {
      if ((await stat(path)).isDirectory()) {
        return;
      }
    } catch {
      // 统一由下方领域错误表达，不暴露文件系统细节。
    }
    throw this.error(code, skillId, 'Skill 路径必须是目录');
  }

  /** 创建不暴露绝对路径的稳定领域错误。 */
  private error(
    code: SkillAccessErrorCode,
    skillId: string,
    message: string,
    resourcePath?: string,
  ): SkillAccessError {
    return new SkillAccessError(code, skillId, message, resourcePath);
  }
}

/** 解析项目级稳定 ID，并在接触文件系统前拒绝路径字符。 */
function parseProjectSkillId(skillId: string): ParsedSkillId {
  const prefix = 'project:';
  const name = skillId.startsWith(prefix) ? skillId.slice(prefix.length) : '';
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new SkillAccessError(
      SkillAccessErrorCode.INVALID_SKILL_ID,
      skillId,
      'Skill ID 必须是不能包含路径字符的 project:<name>',
    );
  }
  return { id: skillId, name };
}

/** 校验资源路径只使用三个规范目录下的相对路径。 */
function validateResourcePath(resourcePath: string, skillId: string): string {
  const segments = resourcePath.split('/');
  const root = segments[0] as keyof typeof RESOURCE_DIRECTORIES | undefined;
  if (
    !resourcePath
    || isAbsolute(resourcePath)
    || win32.isAbsolute(resourcePath)
    || resourcePath.includes('\\')
    || segments.length < 2
    || segments.some((segment) => !segment || segment === '.' || segment === '..')
    || !root
    || !Object.hasOwn(RESOURCE_DIRECTORIES, root)
  ) {
    throw new SkillAccessError(
      SkillAccessErrorCode.RESOURCE_PATH_INVALID,
      skillId,
      `Skill 资源路径必须位于 scripts/、references/ 或 assets/：${resourcePath}`,
      resourcePath,
    );
  }
  return resourcePath;
}

/** 从规范目录前缀确定资源类别。 */
function resourceKind(resourcePath: string): SkillResourceKind {
  return RESOURCE_DIRECTORIES[
    resourcePath.split('/')[0] as keyof typeof RESOURCE_DIRECTORIES
  ];
}

/** 解析完整 Frontmatter，只要求 Catalog 和激活需要的字段有效。 */
function parseFrontmatter(content: string, skillId: string) {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!match) {
    throw new SkillAccessError(
      SkillAccessErrorCode.INSTRUCTION_INVALID,
      skillId,
      `${SKILL_FILE_NAME} 缺少完整 Frontmatter`,
    );
  }
  try {
    return frontmatterSchema.parse(YAML.parse(match[1]));
  } catch {
    throw new SkillAccessError(
      SkillAccessErrorCode.INSTRUCTION_INVALID,
      skillId,
      `${SKILL_FILE_NAME} Frontmatter 无效`,
    );
  }
}

/** 读取必需真实路径，失败时使用调用方给出的领域错误。 */
async function requiredRealPath(
  path: string,
  error: () => SkillAccessError,
): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    throw error();
  }
}

/** 读取可选目录真实路径；不存在或不可读都按未提供处理。 */
async function optionalRealPath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

/** 判断真实目标是否仍位于允许根目录中。 */
function isWithin(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return pathFromRoot === ''
    || (!pathFromRoot.startsWith(`..${sep}`)
      && pathFromRoot !== '..'
      && !isAbsolute(pathFromRoot));
}

/** 校验读取上限为正安全整数。 */
function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} 必须是正安全整数`);
  }
  return value;
}

/** 按名称稳定排序资源目录项。 */
function compareDirectoryEntries(left: Dirent, right: Dirent): number {
  return left.name.localeCompare(right.name);
}
