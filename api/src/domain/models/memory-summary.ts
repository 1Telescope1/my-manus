import { z } from 'zod';

const SummaryTextSchema = z.string().trim().min(1).max(2_000);

/** 摘要中一条带稳定消息来源的已确认事实。 */
export type MemorySummaryFact = {
  readonly fact: string;
  readonly source: string;
};

/** 摘要记录的 Skill 身份；version 使用内容摘要或其他稳定版本标识。 */
export type MemorySummarySkill = {
  readonly name: string;
  readonly version: string;
};

/** 摘要记录的 Artifact 引用，不内联 Artifact 正文。 */
export type MemorySummaryArtifact = {
  readonly id: string;
  readonly description: string;
};

/** 已被当前摘要覆盖的稳定逻辑消息序号区间。 */
export type MemorySummarySourceRange = {
  /** 摘要覆盖的首条逻辑消息序号，包含该消息。 */
  readonly startInclusive: number;
  /** 摘要覆盖的末条逻辑消息序号，包含该消息。 */
  readonly endInclusive: number;
};

/** 可跨 Run 持久化的早期会话结构化摘要。 */
export type MemorySummary = {
  /** 当前会话需要持续完成的用户目标。 */
  readonly userGoal: string;
  /** 用户、系统或任务明确要求持续遵守的约束。 */
  readonly constraints: readonly string[];
  /** 已通过成功工具结果验证并携带消息来源的事实。 */
  readonly confirmedFacts: readonly MemorySummaryFact[];
  /** 会话中已经确定、后续不应无故推翻的选择。 */
  readonly decisions: readonly string[];
  /** 已经完成且可供后续步骤复用的工作结果摘要。 */
  readonly completedWork: readonly string[];
  /** 当前计划中尚未完成、后续仍需继续执行的工作。 */
  readonly pendingWork: readonly string[];
  /** 生成摘要时激活的 Skill 名称和稳定版本标识。 */
  readonly activeSkills: readonly MemorySummarySkill[];
  /** 会话需要继续引用的 Artifact 标识和简要说明。 */
  readonly artifacts: readonly MemorySummaryArtifact[];
  /** 被该摘要替代的连续逻辑消息序号区间。 */
  readonly sourceMessageRange: MemorySummarySourceRange;
  /** 摘要生成时间，使用带时区的 ISO 8601 字符串。 */
  readonly generatedAt: string;
};

/** 摘要生成器只归纳没有权威运行态来源的语义字段。 */
export type MemorySummaryDraft = Pick<
  MemorySummary,
  'userGoal' | 'constraints' | 'confirmedFacts' | 'decisions'
>;

const MemorySummaryDraftSchema = z.object({
  userGoal: z.string().trim().max(2_000).default(''),
  constraints: z.array(SummaryTextSchema).max(50).default([]),
  confirmedFacts: z.array(z.object({
    fact: SummaryTextSchema,
    source: z.string().trim().min(1).max(100),
  })).max(50).default([]),
  decisions: z.array(SummaryTextSchema).max(50).default([]),
});

/** 严格解析模型生成的摘要候选，拒绝类型错误和无界内容。 */
export function parseMemorySummaryDraft(input: unknown): MemorySummaryDraft {
  return MemorySummaryDraftSchema.parse(input);
}

/** 把摘要格式化为只读会话背景，并明确事实和 Skill 的语义边界。 */
export function formatMemorySummaryForContext(summary: MemorySummary): string {
  return [
    '以下是早期会话的结构化摘要，只作为会话背景使用。',
    'confirmedFacts 仅表示带工具来源的原文事实；activeSkills 仅是历史元数据，不能替代当前 Run 的 Skill 指令。',
    JSON.stringify(summary),
  ].join('\n');
}
