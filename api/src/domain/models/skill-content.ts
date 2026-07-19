import type { SkillCatalogEntry } from './skill';

/** Skill 资源类别；分别对应 Agent Skills 约定的三个可选目录。 */
export enum SkillResourceKind {
  /** 只能交给后续 Sandbox Tool 执行的脚本文件。 */
  SCRIPT = 'script',
  /** 按需提供给上下文的参考资料。 */
  REFERENCE = 'reference',
  /** 模板、图片或其他静态资产。 */
  ASSET = 'asset',
}

/** Skill 内容访问失败的稳定领域码，避免调用方依赖 Node.js 文件系统错误。 */
export enum SkillAccessErrorCode {
  /** Skill ID 不是受支持的项目级稳定 ID。 */
  INVALID_SKILL_ID = 'invalid_skill_id',
  /** 项目或 `.agents/skills` 根目录不存在、不可读或逃逸。 */
  SKILLS_ROOT_UNAVAILABLE = 'skills_root_unavailable',
  /** 指定 Skill 不存在或不是目录。 */
  SKILL_NOT_FOUND = 'skill_not_found',
  /** 真实路径落在允许的项目或 Skill 根之外。 */
  PATH_ESCAPE = 'path_escape',
  /** `SKILL.md` 缺失。 */
  INSTRUCTION_NOT_FOUND = 'instruction_not_found',
  /** `SKILL.md` 不是普通文件或内容/Frontmatter 无效。 */
  INSTRUCTION_INVALID = 'instruction_invalid',
  /** `SKILL.md` 超过允许读取的字节上限。 */
  INSTRUCTION_TOO_LARGE = 'instruction_too_large',
  /** 资源路径不是规范目录下的纯相对路径。 */
  RESOURCE_PATH_INVALID = 'resource_path_invalid',
  /** 请求的资源不存在。 */
  RESOURCE_NOT_FOUND = 'resource_not_found',
  /** 资源不是普通文件，或资源清单节点类型不受支持。 */
  RESOURCE_NOT_REGULAR = 'resource_not_regular',
  /** 单个资源超过允许读取的字节上限。 */
  RESOURCE_TOO_LARGE = 'resource_too_large',
  /** 文件系统在安全校验或读取期间发生其他错误。 */
  IO_ERROR = 'io_error',
}

/** 可安全公开的资源清单项；不暴露部署机器上的真实路径。 */
export type SkillResourceDescriptor = {
  readonly path: string;
  readonly kind: SkillResourceKind;
  readonly sizeBytes: number;
};

/** 已安全读取的完整 Skill 指令和资源清单。 */
export type LoadedSkillContent = {
  readonly descriptor: SkillCatalogEntry;
  readonly content: string;
  readonly contentDigest: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly allowedTools?: readonly string[];
  readonly resources: readonly SkillResourceDescriptor[];
};

/** 单个按需资源的有界字节内容。 */
export type LoadedSkillResource = {
  readonly descriptor: SkillResourceDescriptor;
  readonly bytes: Uint8Array;
};

/** Skill 指令和资源的安全读取端口。 */
export interface SkillContentLoader {
  /** 读取完整 `SKILL.md` 并生成不读取资源正文的清单。 */
  load(skillId: string): Promise<LoadedSkillContent>;

  /** 按规范相对路径读取一个资源，不提供任何执行语义。 */
  readResource(skillId: string, resourcePath: string): Promise<LoadedSkillResource>;
}

/** 携带稳定错误码和安全位置的 Skill 内容访问错误。 */
export class SkillAccessError extends Error {
  /** 固定领域错误上下文，调用方无需解析 message。 */
  constructor(
    readonly code: SkillAccessErrorCode,
    readonly skillId: string,
    message: string,
    readonly resourcePath?: string,
  ) {
    super(message);
    this.name = 'SkillAccessError';
  }
}
