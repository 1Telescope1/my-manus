import { randomUUID } from 'node:crypto';
import { MessageQueue } from '../../../domain/external/message-queue';
import { Task, TaskRunner } from '../../../domain/external/task';
import { RedisClient } from '../../storage/redis.client';
import { RedisStreamMessageQueue } from '../message-queue/redis-stream-message-queue';

export class RedisStreamTask extends Task {
  private readonly taskId = randomUUID();
  private execution?: Promise<void>;
  private cancelled = false;
  private readonly input: RedisStreamMessageQueue;
  private readonly output: RedisStreamMessageQueue;

  constructor(
    private readonly taskRunner: TaskRunner,
    redis: RedisClient,
    private readonly onRelease: (taskId: string) => void,
  ) {
    super();
    this.input = new RedisStreamMessageQueue(`task:input:${this.taskId}`, redis);
    this.output = new RedisStreamMessageQueue(`task:output:${this.taskId}`, redis);
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
    this.release();
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

  private async executeTask(): Promise<void> {
    try {
      if (!this.cancelled) {
        await this.taskRunner.invoke(this);
      }
    } finally {
      await this.taskRunner.onDone(this);
      this.release();
      this.execution = undefined;
    }
  }

  private release(): void {
    this.onRelease(this.taskId);
  }
}
