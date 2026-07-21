import { LLM } from '../../external/llm';
import { ConversationMemoryMessage } from '../../models/conversation-memory';
import { ToolDescriptor } from '../../models/tool';
import { WorkingContext } from '../../models/working-context';

const WORKING_CONTEXT_INPUT_RATIO = 0.75;

/** 模型窗口与输出预留共同计算出的单次输入上限。 */
export type ModelContextBudget = {
  readonly inputTokenLimit: number;
};

/** 受保护消息和固定 Schema 已经超过输入预算，不能安全裁剪。 */
export class ProtectedContextBudgetExceededError extends Error {
  /** 暴露预算和最低必需估算值，便于评测和配置诊断。 */
  constructor(
    readonly inputTokenLimit: number,
    readonly requiredTokens: number,
  ) {
    super(
      `受保护上下文与固定模型输入预计需要 ${requiredTokens} tokens，超过输入预算 ${inputTokenLimit} tokens`,
    );
    this.name = ProtectedContextBudgetExceededError.name;
  }
}

type ContextMessageGroup = {
  readonly messages: ConversationMemoryMessage[];
  readonly protected: boolean;
  readonly estimatedTokens: number;
};

type ContextSelectorInput = {
  readonly context: WorkingContext;
  readonly budget: ModelContextBudget;
  /** Tool Schema、response format 等同样占用模型输入窗口的固定内容。 */
  readonly fixedInput?: readonly unknown[];
};

/**
 * 以保守 Token 估算选择 Working Context。
 *
 * 基础 system、Run 级临时 system 和显式保护的会话消息始终保留；其余消息按
 * 从近到远的顺序，以工具调用原子组为单位进入剩余预算。
 */
export class ContextSelector {
  /** 选择满足预算且保持原始顺序的消息。 */
  select(input: ContextSelectorInput): ConversationMemoryMessage[] {
    const groups = groupContextMessages(input.context);
    const fixedInputTokens = (input.fixedInput ?? []).reduce<number>(
      (total, value) => total + estimateContextValueTokens(value),
      0,
    );
    const protectedGroups = groups.filter((group) => group.protected);
    const requiredTokens = fixedInputTokens + protectedGroups.reduce(
      (total, group) => total + group.estimatedTokens,
      0,
    );

    if (requiredTokens > input.budget.inputTokenLimit) {
      throw new ProtectedContextBudgetExceededError(
        input.budget.inputTokenLimit,
        requiredTokens,
      );
    }

    const selected = new Set(protectedGroups);
    let estimatedInputTokens = requiredTokens;

    // 近期消息拥有更高价值；首个放不下的原子组形成历史边界，不能越过它
    // 再选择更早消息，否则会让旧历史挤掉更新证据。
    for (const group of [...groups].reverse()) {
      if (group.protected) {
        continue;
      }
      if (estimatedInputTokens + group.estimatedTokens > input.budget.inputTokenLimit) {
        break;
      }
      selected.add(group);
      estimatedInputTokens += group.estimatedTokens;
    }

    const selectedGroups = groups.filter((group) => selected.has(group));
    return selectedGroups.flatMap((group) => group.messages);
  }
}

/** 根据模型声明的总窗口和输出上限建立至少预留 25% 的输入预算。 */
export function createModelContextBudget(llm: LLM): ModelContextBudget {
  const contextWindowTokens = llm.contextWindowTokens;
  const maxOutputTokens = llm.maxTokens;
  if (
    !Number.isSafeInteger(contextWindowTokens)
    || contextWindowTokens <= 0
    || !Number.isSafeInteger(maxOutputTokens)
    || maxOutputTokens < 0
  ) {
    throw new RangeError('模型窗口和最大输出 tokens 必须是有效非负整数');
  }

  const inputTokenLimit = Math.min(
    Math.floor(contextWindowTokens * WORKING_CONTEXT_INPUT_RATIO),
    contextWindowTokens - maxOutputTokens,
  );
  if (inputTokenLimit <= 0) {
    throw new RangeError(
      `模型窗口 ${contextWindowTokens} 无法为最大输出 ${maxOutputTokens} 保留空间`,
    );
  }

  return { inputTokenLimit };
}

/**
 * 使用 UTF-8 字节数作保守 Token 上界，并为结构边界增加固定开销。
 *
 * 该值只用于调用前预算，不冒充模型提供商返回的真实 usage。
 */
export function estimateContextValueTokens(value: unknown): number {
  const serialized = typeof value === 'string'
    ? value
    : JSON.stringify(value) ?? String(value);
  return 8 + Buffer.byteLength(serialized, 'utf8');
}

/** 把候选消息转换成保持工具调用协议的原子组，并标记受保护内容。 */
function groupContextMessages(context: WorkingContext): ContextMessageGroup[] {
  const protectedIndexes = normalizeProtectedIndexes(context);
  const groups: ContextMessageGroup[] = [];
  const messages = context.conversationMessages;

  if (messages.length > 0) {
    groups.push(createMessageGroup([messages[0]], true));
  }

  for (const instruction of context.protectedInstructions) {
    groups.push(createMessageGroup(
      [{ role: 'system', content: instruction }],
      true,
    ));
  }

  for (let index = messages.length > 0 ? 1 : 0; index < messages.length; index += 1) {
    const message = messages[index];
    const atomicMessages = [message];
    const sourceIndexes = [index];

    // OpenAI 兼容协议要求 assistant tool_calls 与随后 tool result 成对保留。
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      while (index + 1 < messages.length && messages[index + 1]?.role === 'tool') {
        index += 1;
        atomicMessages.push(messages[index]);
        sourceIndexes.push(index);
      }
    }

    groups.push(createMessageGroup(
      atomicMessages,
      sourceIndexes.some((sourceIndex) => protectedIndexes.has(sourceIndex)),
    ));
  }

  return groups;
}

/** 合并显式索引，并默认保护最后一条 user message 作为当前调用约束。 */
function normalizeProtectedIndexes(context: WorkingContext): Set<number> {
  const indexes = new Set(context.protectedConversationMessageIndexes ?? []);
  for (let index = context.conversationMessages.length - 1; index >= 0; index -= 1) {
    if (context.conversationMessages[index]?.role === 'user') {
      indexes.add(index);
      break;
    }
  }
  return indexes;
}

/** 创建不可拆分的消息组并一次性估算其输入成本。 */
function createMessageGroup(
  messages: ConversationMemoryMessage[],
  protected_: boolean,
): ContextMessageGroup {
  return {
    messages,
    protected: protected_,
    estimatedTokens: messages.reduce(
      (total, message) => total + estimateContextValueTokens(message),
      0,
    ),
  };
}

/** 把模型工具描述转换成 Context Selector 的固定输入。 */
export function modelFixedInput(
  tools: readonly ToolDescriptor[] = [],
  responseFormat?: Record<string, unknown> | null,
): unknown[] {
  return [
    ...(tools.length > 0 ? [{ tools }] : []),
    ...(responseFormat ? [{ responseFormat }] : []),
  ];
}
