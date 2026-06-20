export type MemoryMessage = Record<string, any>;

export class Memory {
  constructor(public messages: MemoryMessage[] = []) {}

  static from(input?: { messages?: MemoryMessage[] } | Memory): Memory {
    if (input instanceof Memory) {
      return input;
    }
    return new Memory(input?.messages ?? []);
  }

  addMessage(message: MemoryMessage): void {
    this.messages.push(message);
  }

  addMessages(messages: MemoryMessage[]): void {
    this.messages.push(...messages);
  }

  getMessages(): MemoryMessage[] {
    return this.messages;
  }

  getLastMessage(): MemoryMessage | undefined {
    return this.messages.length > 0 ? this.messages[this.messages.length - 1] : undefined;
  }

  rollBack(): void {
    this.messages = this.messages.slice(0, -1);
  }

  compact(): void {
    for (const message of this.messages) {
      if (
        message.role === 'tool' &&
        ['browser_view', 'browser_navigate'].includes(String(message.function_name))
      ) {
        message.content = '(removed)';
      }
      if ('reasoning_content' in message) {
        delete message.reasoning_content;
      }
    }
  }

  get empty(): boolean {
    return this.messages.length === 0;
  }
}
