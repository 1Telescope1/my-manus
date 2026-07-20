import { ConversationMemory } from '../models/conversation-memory';

/** Session 级 Conversation Memory 的专用持久化端口。 */
export abstract class ConversationMemoryRepository {
  /** 保存指定 Agent 的完整会话语义历史。 */
  abstract save(
    sessionId: string,
    agentName: string,
    memory: ConversationMemory,
  ): Promise<void>;

  /** 读取指定 Agent 的会话语义历史；没有记录时返回空对象。 */
  abstract get(sessionId: string, agentName: string): Promise<ConversationMemory>;
}
