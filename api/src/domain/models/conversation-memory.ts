/** 会话中可被后续模型调用复用的一条语义消息。 */
export type ConversationMemoryMessage = Record<string, any>;

/**
 * Session 生命周期内的模型语义历史。
 *
 * 该对象不保存 Run 节点、重试次数、恢复游标、临时 Skill 指令或原始大文件内容。
 */
export class ConversationMemory {
  /** 使用现有消息初始化会话记忆，保持旧 Session JSON 的兼容结构。 */
  constructor(public messages: ConversationMemoryMessage[] = []) {}

  /** 从持久化 JSON 或现有实例恢复 Conversation Memory。 */
  static from(
    input?: { messages?: ConversationMemoryMessage[] } | ConversationMemory,
  ): ConversationMemory {
    return new ConversationMemory(input?.messages ?? []);
  }

  /** 追加一条可跨 Run 复用的会话语义消息。 */
  addMessage(message: ConversationMemoryMessage): void {
    this.messages.push(message);
  }

  /** 按原始顺序追加多条会话语义消息。 */
  addMessages(messages: ConversationMemoryMessage[]): void {
    this.messages.push(...messages);
  }

  /** 返回当前会话记忆消息；调用方不得在其中写入运行游标。 */
  getMessages(): ConversationMemoryMessage[] {
    return this.messages;
  }

  /** 返回最后一条会话语义消息。 */
  getLastMessage(): ConversationMemoryMessage | undefined {
    return this.messages.length > 0 ? this.messages[this.messages.length - 1] : undefined;
  }

  /** 回滚最后一条尚未形成稳定语义结果的消息。 */
  rollBack(): void {
    this.messages = this.messages.slice(0, -1);
  }

  /**
   * 保留旧版轻量清理行为，避免本边界任务改变模型输入语义。
   * 结构化摘要和预算感知压缩由 MEMORY-102/103 替换。
   */
  compact(): void {
    for (const message of this.messages) {
      if (
        message.role === 'tool'
        && ['browser_view', 'browser_navigate'].includes(String(message.function_name))
      ) {
        message.content = '(removed)';
      }
      if ('reasoning_content' in message) {
        delete message.reasoning_content;
      }
    }
  }

  /** 判断当前会话记忆是否没有任何消息。 */
  get empty(): boolean {
    return this.messages.length === 0;
  }
}
