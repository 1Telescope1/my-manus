import type { LoadedSkillContent, SkillContentLoader } from '../../models/skill-content';
import type { SkillCatalogDiscovery, SkillCatalogEntry } from '../../models/skill';
import {
  SkillActivationError,
  SkillDisclosure,
  SkillProgressiveDisclosure,
  SkillRunDisclosure,
} from '../../models/skill-disclosure';

/** 使用 Catalog 与安全 Loader 组成单 Run 渐进披露。 */
export class SkillProgressiveDisclosureService implements SkillProgressiveDisclosure {
  /** 注入元数据发现和完整内容读取端口。 */
  constructor(
    private readonly catalogDiscovery: SkillCatalogDiscovery,
    private readonly contentLoader: SkillContentLoader,
  ) {}

  /** 每次重新发现 Catalog，防止不同 Run 共享可变激活状态。 */
  async initialize(input: {
    message: string;
    requestedSkills?: readonly string[];
  }): Promise<SkillRunDisclosure> {
    const { entries } = await this.catalogDiscovery.discover();
    const index = new Map(entries.flatMap((entry) => [
      [entry.id, entry] as const,
      [entry.name, entry] as const,
    ]));
    const explicitSkillIds = unique([
      ...(input.requestedSkills ?? []).map((request) => resolveExplicit(request, index)),
      ...entries
        .filter((entry) => hasToken(input.message, `$${entry.name}`) || hasToken(input.message, entry.id))
        .map((entry) => entry.id),
    ]);
    return new RunDisclosure(entries, explicitSkillIds, index, this.contentLoader);
  }
}

/** 在一个 Run 内按 stable ID 缓存完整 Skill 内容。 */
class RunDisclosure implements SkillRunDisclosure {
  private readonly activated = new Map<string, LoadedSkillContent>();

  /** 固定当前 Run 的 Catalog、显式请求和 Loader。 */
  constructor(
    readonly catalog: readonly SkillCatalogEntry[],
    readonly explicitSkillIds: readonly string[],
    private readonly index: ReadonlyMap<string, SkillCatalogEntry>,
    private readonly loader: SkillContentLoader,
  ) {}

  /** 忽略模型发明的未知项，并保证已知 Skill 只读取一次。 */
  async activate(requestedSkills: readonly string[]): Promise<SkillDisclosure> {
    const skillIds = unique([
      ...this.explicitSkillIds,
      ...requestedSkills.flatMap((request) => {
        const entry = this.index.get(request.trim());
        return entry ? [entry.id] : [];
      }),
    ]);
    for (const skillId of skillIds) {
      if (!this.activated.has(skillId)) {
        this.activated.set(skillId, await this.loader.load(skillId));
      }
    }
    return { catalog: this.catalog, activated: [...this.activated.values()] };
  }
}

/** 显式请求必须精确命中 stable ID 或 Catalog name。 */
function resolveExplicit(
  request: string,
  index: ReadonlyMap<string, SkillCatalogEntry>,
): string {
  const normalized = request.trim();
  const entry = index.get(normalized);
  if (!entry) {
    throw new SkillActivationError(
      normalized,
      `显式请求的 Skill 不存在：${normalized || '(empty)'}`,
    );
  }
  return entry.id;
}

/** 使用 Skill 名允许字符之外的边界执行精确标记匹配。 */
function hasToken(message: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9-])${escaped}(?=$|[^a-z0-9-])`, 'iu').test(message);
}

/** 清理空值并保持首次出现顺序。 */
function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
