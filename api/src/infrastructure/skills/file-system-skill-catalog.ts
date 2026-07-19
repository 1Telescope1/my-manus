import type { Dirent } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import {
  SkillCatalogDiscovery,
  SkillCatalogEntry,
  SkillCatalogSnapshot,
  SkillDiagnostic,
  SkillDiagnosticCode,
} from '../../domain/models/skill';

/** SDD 规定的默认 SKILL.md 文件上限：256 KiB。 */
export const DEFAULT_SKILL_FILE_MAX_BYTES = 256 * 1024;

const SKILLS_DIRECTORY = '.agents/skills';
const SKILL_FILE_NAME = 'SKILL.md';

/** 发现阶段只消费 Catalog 必需字段；其他字段由后续激活和权限模块解释。 */
const skillFrontmatterSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
}).passthrough();

type SkillCandidate = {
  directoryName: string;
  entry: SkillCatalogEntry;
  eligible: boolean;
};

/** 文件系统 Skill Catalog 的可调边界；测试可缩小上限，生产默认遵循 SDD。 */
export type FileSystemSkillCatalogOptions = {
  skillFileMaxBytes?: number;
};

/** 扫描单一项目根目录下的 `.agents/skills/` 并隔离无效候选。 */
export class FileSystemSkillCatalog implements SkillCatalogDiscovery {
  private readonly skillsRoot: string;
  private readonly skillFileMaxBytes: number;

  /** 固定项目根和文件上限，避免每次发现时由调用方改变扫描边界。 */
  constructor(
    private readonly projectRoot: string,
    options: FileSystemSkillCatalogOptions = {},
  ) {
    this.skillsRoot = resolve(projectRoot, SKILLS_DIRECTORY);
    this.skillFileMaxBytes = options.skillFileMaxBytes ?? DEFAULT_SKILL_FILE_MAX_BYTES;
    if (!Number.isSafeInteger(this.skillFileMaxBytes) || this.skillFileMaxBytes <= 0) {
      throw new RangeError('skillFileMaxBytes 必须是正安全整数');
    }
  }

  /** 发现全部直接子目录，聚合诊断后再统一处理声明 name 冲突。 */
  async discover(): Promise<SkillCatalogSnapshot> {
    const diagnostics: SkillDiagnostic[] = [];
    const directoryEntries = await this.readSkillsRoot(diagnostics);
    const candidates: SkillCandidate[] = [];

    // 固定文件系统枚举顺序，使 Catalog 和诊断在不同平台上仍可复核。
    for (const directoryEntry of directoryEntries.sort(compareDirectoryEntries)) {
      if (!directoryEntry.isDirectory()) {
        continue;
      }

      const candidate = await this.readCandidate(directoryEntry.name, diagnostics);
      if (candidate) {
        candidates.push(candidate);
      }
    }

    const duplicateNames = findDuplicateNames(candidates);
    for (const candidate of candidates) {
      if (!duplicateNames.has(candidate.entry.name)) {
        continue;
      }
      diagnostics.push(this.diagnostic(
        SkillDiagnosticCode.DUPLICATE_NAME,
        resolve(this.skillsRoot, candidate.directoryName, SKILL_FILE_NAME),
        `Skill name 重复：${candidate.entry.name}`,
      ));
    }

    const entries = candidates
      .filter((candidate) => candidate.eligible && !duplicateNames.has(candidate.entry.name))
      .map((candidate) => candidate.entry)
      .sort((left, right) => left.name.localeCompare(right.name));

    return {
      entries,
      diagnostics: diagnostics.sort(compareDiagnostics),
    };
  }

  /** 读取可选的项目 Skills 根；目录不存在代表项目尚未定义 Skill。 */
  private async readSkillsRoot(diagnostics: SkillDiagnostic[]): Promise<Dirent[]> {
    try {
      return await readdir(this.skillsRoot, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return [];
      }
      diagnostics.push(this.diagnostic(
        SkillDiagnosticCode.ROOT_UNREADABLE,
        this.skillsRoot,
        `无法读取项目 Skills 目录：${errorMessage(error)}`,
      ));
      return [];
    }
  }

  /** 校验并解析一个 Skill 目录，只返回可参与重名检测的已校验元数据。 */
  private async readCandidate(
    directoryName: string,
    diagnostics: SkillDiagnostic[],
  ): Promise<SkillCandidate | undefined> {
    const skillFilePath = resolve(this.skillsRoot, directoryName, SKILL_FILE_NAME);
    let fileStats;
    try {
      fileStats = await stat(skillFilePath);
    } catch (error) {
      diagnostics.push(this.diagnostic(
        SkillDiagnosticCode.SKILL_FILE_UNREADABLE,
        skillFilePath,
        `无法检查 ${SKILL_FILE_NAME}：${errorMessage(error)}`,
      ));
      return undefined;
    }

    if (!fileStats.isFile()) {
      diagnostics.push(this.diagnostic(
        SkillDiagnosticCode.SKILL_FILE_UNREADABLE,
        skillFilePath,
        `${SKILL_FILE_NAME} 必须是普通文件`,
      ));
      return undefined;
    }
    if (fileStats.size > this.skillFileMaxBytes) {
      diagnostics.push(this.diagnostic(
        SkillDiagnosticCode.SKILL_FILE_TOO_LARGE,
        skillFilePath,
        `${SKILL_FILE_NAME} 大小 ${fileStats.size} 字节，超过 ${this.skillFileMaxBytes} 字节上限`,
      ));
      return undefined;
    }

    let content: string;
    try {
      content = await readFile(skillFilePath, 'utf8');
    } catch (error) {
      diagnostics.push(this.diagnostic(
        SkillDiagnosticCode.SKILL_FILE_UNREADABLE,
        skillFilePath,
        `无法读取 ${SKILL_FILE_NAME}：${errorMessage(error)}`,
      ));
      return undefined;
    }

    const rawFrontmatter = extractFrontmatter(content);
    if (rawFrontmatter === undefined) {
      diagnostics.push(this.diagnostic(
        SkillDiagnosticCode.FRONTMATTER_INVALID,
        skillFilePath,
        `${SKILL_FILE_NAME} 必须以完整 YAML Frontmatter 开头`,
      ));
      return undefined;
    }

    let parsedFrontmatter: unknown;
    try {
      parsedFrontmatter = YAML.parse(rawFrontmatter);
    } catch (error) {
      diagnostics.push(this.diagnostic(
        SkillDiagnosticCode.FRONTMATTER_INVALID,
        skillFilePath,
        `YAML Frontmatter 无法解析：${errorMessage(error)}`,
      ));
      return undefined;
    }
    const frontmatter = skillFrontmatterSchema.safeParse(parsedFrontmatter);
    if (!frontmatter.success) {
      diagnostics.push(this.diagnostic(
        SkillDiagnosticCode.FRONTMATTER_INVALID,
        skillFilePath,
        `Skill Frontmatter 缺少 name 或 description：${formatZodIssue(frontmatter.error)}`,
      ));
      return undefined;
    }

    const eligible = frontmatter.data.name === directoryName;
    if (!eligible) {
      diagnostics.push(this.diagnostic(
        SkillDiagnosticCode.NAME_MISMATCH,
        skillFilePath,
        `Skill name "${frontmatter.data.name}" 与目录名 "${directoryName}" 不一致`,
      ));
    }

    return {
      directoryName,
      eligible,
      entry: {
        id: `project:${frontmatter.data.name}`,
        name: frontmatter.data.name,
        description: frontmatter.data.description,
      },
    };
  }

  /** 将绝对文件位置收敛为项目相对位置，避免诊断依赖部署机器路径。 */
  private diagnostic(
    code: SkillDiagnosticCode,
    absoluteLocation: string,
    message: string,
  ): SkillDiagnostic {
    return {
      code,
      location: normalizeRelativePath(relative(resolve(this.projectRoot), absoluteLocation)),
      message,
    };
  }
}

/** 从 SKILL.md 开头提取 YAML Frontmatter，不返回后续 Markdown 指令正文。 */
function extractFrontmatter(content: string): string | undefined {
  const normalized = content.startsWith('\uFEFF') ? content.slice(1) : content;
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(normalized);
  return match?.[1];
}

/** 找出出现两次及以上的声明 name，使全部冲突候选一起隔离。 */
function findDuplicateNames(candidates: readonly SkillCandidate[]): Set<string> {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    counts.set(candidate.entry.name, (counts.get(candidate.entry.name) ?? 0) + 1);
  }
  return new Set(
    [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([name]) => name),
  );
}

/** 用首个 Zod 问题生成短诊断，避免把完整输入或内部堆栈写入结果。 */
function formatZodIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) {
    return '未知字段错误';
  }
  return `${issue.path.join('.') || 'frontmatter'}: ${issue.message}`;
}

/** 判断未知异常是否携带 Node.js 文件系统错误码。 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/** 把未知异常转成稳定短消息。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 统一 Windows 与 POSIX 的诊断相对路径分隔符。 */
function normalizeRelativePath(path: string): string {
  return path.replaceAll('\\', '/');
}

/** 按目录名稳定排序文件系统候选。 */
function compareDirectoryEntries(left: Dirent, right: Dirent): number {
  return left.name.localeCompare(right.name);
}

/** 先按位置再按诊断码排序，保证同一输入产生稳定结果。 */
function compareDiagnostics(left: SkillDiagnostic, right: SkillDiagnostic): number {
  return left.location.localeCompare(right.location) || left.code.localeCompare(right.code);
}
