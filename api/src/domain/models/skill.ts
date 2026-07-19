/** Skill 诊断码；每一项表示候选 Skill 被隔离或发现根不可用的具体原因。 */
export enum SkillDiagnosticCode {
  /** 项目级 Skills 根目录存在但无法读取。 */
  ROOT_UNREADABLE = 'root_unreadable',
  /** Skills 根目录下出现了不会被扫描的非目录或符号链接条目。 */
  UNSUPPORTED_ENTRY = 'unsupported_entry',
  /** Skill 目录中缺少必需的 SKILL.md。 */
  SKILL_FILE_MISSING = 'skill_file_missing',
  /** SKILL.md 不是普通文件，包含符号链接场景。 */
  SKILL_FILE_NOT_REGULAR = 'skill_file_not_regular',
  /** SKILL.md 超过发现阶段允许读取的字节上限。 */
  SKILL_FILE_TOO_LARGE = 'skill_file_too_large',
  /** SKILL.md 因文件系统错误或无效 UTF-8 而无法读取。 */
  SKILL_FILE_READ_FAILED = 'skill_file_read_failed',
  /** SKILL.md 没有完整的 YAML Frontmatter 边界。 */
  FRONTMATTER_MISSING = 'frontmatter_missing',
  /** YAML 无法解析或 Frontmatter 不是映射。 */
  FRONTMATTER_INVALID = 'frontmatter_invalid',
  /** Frontmatter 字段不满足 Agent Skills 契约。 */
  DESCRIPTOR_INVALID = 'descriptor_invalid',
  /** Frontmatter name 与父目录名称不一致。 */
  NAME_MISMATCH = 'name_mismatch',
  /** 多个候选声明了同一个 Skill name。 */
  DUPLICATE_NAME = 'duplicate_name',
}

/** 模型可见的 Skill 元数据；有意不包含路径、可选配置和指令正文。 */
export type SkillCatalogEntry = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
};

/** 发现阶段产生的结构化诊断，location 始终相对项目根目录。 */
export type SkillDiagnostic = {
  readonly code: SkillDiagnosticCode;
  readonly location: string;
  readonly message: string;
};

/** 一次项目扫描的完整快照；坏 Skill 只进入 diagnostics，不进入 entries。 */
export type SkillCatalogSnapshot = {
  readonly entries: readonly SkillCatalogEntry[];
  readonly diagnostics: readonly SkillDiagnostic[];
};

/** 项目级 Skill Catalog 的发现端口，供后续 Runtime 初始化阶段调用。 */
export interface SkillCatalogDiscovery {
  /** 重新扫描项目目录并返回不复用旧状态的确定性快照。 */
  discover(): Promise<SkillCatalogSnapshot>;
}
