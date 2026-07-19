import type { LoadedSkillContent } from './skill-content';
import type { SkillCatalogEntry } from './skill';
import type { ToolSelectionScope } from './tool-selection';

/** 当前 Run 可用的 Catalog 与已经激活的完整 Skill。 */
export type SkillDisclosure = {
  readonly catalog: readonly SkillCatalogEntry[];
  readonly activated: readonly LoadedSkillContent[];
};

/** 一次 Run 内的渐进披露会话。 */
export interface SkillRunDisclosure {
  readonly catalog: readonly SkillCatalogEntry[];
  readonly explicitSkillIds: readonly string[];

  /** 合并 Router 请求并按 stable ID 至多读取一次完整 `SKILL.md`。 */
  activate(requestedSkills: readonly string[]): Promise<SkillDisclosure>;
}

/** 每个 Runtime Run 初始化一个独立渐进披露会话的领域端口。 */
export interface SkillProgressiveDisclosure {
  /** 固定 Catalog，并解析 API 显式请求及消息中的 canonical 显式标记。 */
  initialize(input: {
    message: string;
    requestedSkills?: readonly string[];
  }): Promise<SkillRunDisclosure>;
}

/** 显式 Skill 请求无法解析时返回的稳定领域错误。 */
export class SkillActivationError extends Error {
  readonly code = 'explicit_skill_not_found';

  /** 保存错误码和原始请求，调用方无需解析 message。 */
  constructor(
    readonly skillRequest: string,
    message: string,
  ) {
    super(message);
    this.name = 'SkillActivationError';
  }
}

/** 把已激活 Skill 的 `allowed-tools` 转成现有 Tool Selection 上界。 */
export function skillToolSelectionScopes(disclosure: SkillDisclosure): ToolSelectionScope[] {
  return disclosure.activated.flatMap((skill) => skill.allowedTools === undefined
    ? []
    : [{ allowedToolNames: [...skill.allowedTools] }]);
}

/** 只格式化模型需要的两级信息，不披露资源、路径或可选元数据。 */
export function formatRuntimeSkillContext(disclosure: SkillDisclosure): string {
  return [
    '以下是当前 Run 的 Skill 上下文。Catalog 只用于判断相关性；必须遵循已激活 instruction。',
    '资源和脚本均未加载，不得声称已经读取或执行。',
    JSON.stringify({
      skillCatalog: disclosure.catalog,
      activatedSkills: disclosure.activated.map((skill) => ({
        id: skill.descriptor.id,
        name: skill.descriptor.name,
        contentDigest: skill.contentDigest,
        instruction: skill.content,
      })),
    }),
  ].join('\n');
}
