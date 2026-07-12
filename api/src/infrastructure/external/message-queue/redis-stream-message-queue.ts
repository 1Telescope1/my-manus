import { randomUUID } from 'node:crypto';
import { RedisClientType } from 'redis';
import { MessageQueue } from '../../../domain/external/message-queue';
import { RedisClient } from '../../storage/redis.client';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RedisStreamMessageQueue extends MessageQueue {
  private readonly lockExpireSeconds = 10;

  constructor(
    private readonly streamName: string,
    private readonly redis: RedisClient,
  ) {
    super();
  }

  async put(message: unknown): Promise<string> {
    return this.redis.client.xAdd(this.streamName, '*', {
      data: typeof message === 'string' ? message : JSON.stringify(message),
    });
  }

  async get(startId = '0', blockMs?: number): Promise<[string | null, unknown]> {
    // Redis 的阻塞命令会独占当前连接。使用独立连接读取输出流，避免同一任务的
    // 输入队列命令排在 XREAD BLOCK 0 后面而永远无法执行。
    const client = blockMs === undefined
      ? this.redis.client
      : this.redis.client.duplicate() as RedisClientType;

    if (client !== this.redis.client) {
      client.on('error', () => undefined);
      await client.connect();
    }

    let messages;
    try {
      messages = await client.xRead(
        { key: this.streamName, id: startId },
        { COUNT: 1, BLOCK: blockMs },
      );
    } finally {
      if (client !== this.redis.client && client.isOpen) {
        await client.quit();
      }
    }
    if (!messages?.length || !messages[0].messages.length) {
      return [null, null];
    }
    const message = messages[0].messages[0];
    return [message.id, message.message.data ?? null];
  }

  async pop(): Promise<[string | null, unknown]> {
    const lockKey = `lock:${this.streamName}:pop`;
    const lockValue = await this.acquireLock(lockKey);
    if (!lockValue) {
      return [null, null];
    }

    try {
      const messages = await this.redis.client.xRange(this.streamName, '-', '+', { COUNT: 1 });
      if (!messages.length) {
        return [null, null];
      }
      const message = messages[0];
      await this.redis.client.xDel(this.streamName, message.id);
      return [message.id, message.message.data ?? null];
    } finally {
      await this.releaseLock(lockKey, lockValue);
    }
  }

  async clear(): Promise<void> {
    await this.redis.client.xTrim(this.streamName, 'MAXLEN', 0);
  }

  async isEmpty(): Promise<boolean> {
    return (await this.size()) === 0;
  }

  async size(): Promise<number> {
    return this.redis.client.xLen(this.streamName);
  }

  async deleteMessage(messageId: string): Promise<boolean> {
    try {
      await this.redis.client.xDel(this.streamName, messageId);
      return true;
    } catch {
      return false;
    }
  }

  async *getRange(startId = '-', endId = '+', count = 100): AsyncGenerator<[string, unknown]> {
    const messages = await this.redis.client.xRange(this.streamName, startId, endId, {
      COUNT: count,
    });
    for (const message of messages) {
      yield [message.id, message.message.data ?? null];
    }
  }

  async getLatestId(): Promise<string> {
    const messages = await this.redis.client.xRevRange(this.streamName, '+', '-', { COUNT: 1 });
    return messages[0]?.id ?? '0';
  }

  private async acquireLock(lockKey: string, timeoutSeconds = 5): Promise<string | null> {
    const lockValue = randomUUID();
    let remaining = timeoutSeconds * 1000;
    while (remaining > 0) {
      const result = await this.redis.client.set(lockKey, lockValue, {
        NX: true,
        EX: this.lockExpireSeconds,
      });
      if (result) {
        return lockValue;
      }
      await sleep(100);
      remaining -= 100;
    }
    return null;
  }

  private async releaseLock(lockKey: string, lockValue: string): Promise<boolean> {
    const script = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      else
        return 0
      end
    `;
    try {
      const result = await this.redis.client.eval(script, {
        keys: [lockKey],
        arguments: [lockValue],
      });
      return result === 1;
    } catch {
      return false;
    }
  }
}
