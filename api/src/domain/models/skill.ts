/** Skill 诊断码；每一项表示候选 Skill 被隔离或发现根不可用的具体原因。 */
export enum SkillDiagnosticCode {
  /** 项目级 Skills 根目录无法读取。 */
  ROOT_UNREADABLE = 'root_unreadable',
  /** SKILL.md 缺失、不是普通文件或无法读取。 */
  SKILL_FILE_UNREADABLE = 'skill_file_unreadable',
  /** SKILL.md 超过发现阶段允许读取的字节上限。 */
  SKILL_FILE_TOO_LARGE = 'skill_file_too_large',
  /** Frontmatter 缺失、YAML 无法解析或必填字段无效。 */
  FRONTMATTER_INVALID = 'frontmatter_invalid',
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
