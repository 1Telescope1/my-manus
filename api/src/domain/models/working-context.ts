import {
  ConversationMemoryMessage,
} from './conversation-memory';

/** 一次模型调用中不得因历史裁剪而移除的消息索引。 */
export type ProtectedConversationMessageIndex = number;

/**
 * 单次模型调用的临时输入快照。
 *
 * 它引用 Conversation Memory，但不能被 Session 或 Run 仓储直接保存。
 */
export type WorkingContext = {
  readonly protectedInstructions: readonly string[];
  readonly conversationMessages: readonly ConversationMemoryMessage[];
  readonly protectedConversationMessageIndexes?: readonly ProtectedConversationMessageIndex[];
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
