import { randomUUID } from 'node:crypto';
import { MessageQueue } from '../../../domain/external/message-queue';
import { Task, TaskRunner } from '../../../domain/external/task';
import { RedisClient } from '../../storage/redis.client';
import { RedisStreamMessageQueue } from '../message-queue/redis-stream-message-queue';

export class RedisStreamTask extends Task {
  private static readonly taskRegistry = new Map<string, RedisStreamTask>();
  private readonly taskId = randomUUID();
  private execution?: Promise<void>;
  private cancelled = false;
  private readonly input: RedisStreamMessageQueue;
  private readonly output: RedisStreamMessageQueue;

  constructor(
    private readonly taskRunner: TaskRunner,
    redis: RedisClient,
  ) {
    super();
    this.input = new RedisStreamMessageQueue(`task:input:${this.taskId}`, redis);
    this.output = new RedisStreamMessageQueue(`task:output:${this.taskId}`, redis);
    RedisStreamTask.taskRegistry.set(this.taskId, this);
  }

  async invoke(): Promise<void> {
    if (!this.done) {
      return;
    }
    this.cancelled = false;
    this.execution = this.executeTask();
  }

  cancel(): boolean {
    this.cancelled = true;
    this.cleanupRegistry();
    return true;
  }

  get inputStream(): MessageQueue {
    return this.input;
  }

  get outputStream(): MessageQueue {
    return this.output;
  }

  get id(): string {
    return this.taskId;
  }

  get done(): boolean {
    return !this.execution;
  }

  static get(taskId: string): RedisStreamTask | undefined {
    return RedisStreamTask.taskRegistry.get(taskId);
  }

  static create(taskRunner: TaskRunner, redis: RedisClient): RedisStreamTask {
    return new RedisStreamTask(taskRunner, redis);
  }

  static async destroy(): Promise<void> {
    for (const task of RedisStreamTask.taskRegistry.values()) {
      task.cancel();
      await task.taskRunner.destroy();
    }
    RedisStreamTask.taskRegistry.clear();
  }

  private async executeTask(): Promise<void> {
    try {
      if (!this.cancelled) {
        await this.taskRunner.invoke(this);
      }
    } finally {
      await this.taskRunner.onDone(this);
      this.cleanupRegistry();
      this.execution = undefined;
    }
  }

  private cleanupRegistry(): void {
    RedisStreamTask.taskRegistry.delete(this.taskId);
  }
}
