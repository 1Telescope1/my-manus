import { MemorySummary } from './memory-summary';

/** 会话中可被后续模型调用复用的一条语义消息。 */
export type ConversationMemoryMessage = Record<string, any>;

/** Conversation Memory 在 Session JSON 中的兼容持久化结构。 */
export type ConversationMemorySnapshot = {
  readonly messages: ConversationMemoryMessage[];
  readonly summary?: MemorySummary;
};

/**
 * Session 生命周期内的模型语义历史。
 *
 * 该对象不保存 Run 节点、重试次数、恢复游标、临时 Skill 指令或原始大文件内容。
 */
export class ConversationMemory {
  /** 使用现有消息初始化会话记忆，保持旧 Session JSON 的兼容结构。 */
  constructor(
    public messages: ConversationMemoryMessage[] = [],
    private summary?: MemorySummary,
  ) {}

  /** 从 Session JSON 快照恢复 Conversation Memory。 */
  static fromSnapshot(input: ConversationMemorySnapshot): ConversationMemory {
    return new ConversationMemory(input.messages, input.summary);
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

  /** 返回早期历史摘要；调用方只能通过原子替换方法更新。 */
  getSummary(): MemorySummary | undefined {
    return this.summary;
  }

  /** 输出可直接写入现有 Session.memories JSON 的兼容快照。 */
  toSnapshot(): ConversationMemorySnapshot {
    return {
      messages: this.messages,
      ...(this.summary ? { summary: this.summary } : {}),
    };
  }

  /** 返回最后一条会话语义消息。 */
  getLastMessage(): ConversationMemoryMessage | undefined {
    return this.messages.length > 0 ? this.messages[this.messages.length - 1] : undefined;
  }

  /** 回滚最后一条尚未形成稳定语义结果的消息。 */
  rollBack(): void {
    this.messages = this.messages.slice(0, -1);
  }

  /** 在摘要生成成功后原子替换最早的非 system 消息前缀。 */
  replaceHistoryWithSummary(summary: MemorySummary, messageCount: number): void {
    const systemOffset = this.messages[0]?.role === 'system' ? 1 : 0;
    // system 消息属于长期指令，不在摘要覆盖范围内；只移除其后的连续早期历史。
    this.messages = [
      ...this.messages.slice(0, systemOffset),
      ...this.messages.slice(systemOffset + messageCount),
    ];
    this.summary = summary;
  }

  /** 判断当前会话记忆是否没有任何消息。 */
  get empty(): boolean {
    return this.messages.length === 0;
  }
}
