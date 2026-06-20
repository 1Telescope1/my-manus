export abstract class MessageQueue {
  abstract put(message: unknown): Promise<string>;
  abstract get(startId?: string, blockMs?: number): Promise<[string | null, unknown]>;
  abstract pop(): Promise<[string | null, unknown]>;
  abstract clear(): Promise<void>;
  abstract isEmpty(): Promise<boolean>;
  abstract size(): Promise<number>;
  abstract deleteMessage(messageId: string): Promise<boolean>;
}
