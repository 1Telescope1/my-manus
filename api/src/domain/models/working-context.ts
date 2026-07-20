import {
  ConversationMemoryMessage,
} from './conversation-memory';

/**
 * 单次模型调用的临时输入快照。
 *
 * 它引用 Conversation Memory，但不能被 Session 或 Run 仓储直接保存。
 */
export type WorkingContext = {
  readonly protectedInstructions: readonly string[];
  readonly conversationMessages: readonly ConversationMemoryMessage[];
};

/** 将受保护指令插入首个持久 system prompt 后，不修改 Conversation Memory。 */
export function toWorkingContextMessages(
  context: WorkingContext,
): ConversationMemoryMessage[] {
  const [systemPrompt, ...conversation] = context.conversationMessages;
  return [
    ...(systemPrompt ? [systemPrompt] : []),
    ...context.protectedInstructions.map((content) => ({ role: 'system', content })),
    ...conversation,
  ];
}
