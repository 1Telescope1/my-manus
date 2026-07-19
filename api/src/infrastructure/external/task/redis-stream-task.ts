import { randomUUID } from 'node:crypto';
import { MessageQueue } from '../../../domain/external/message-queue';
import { Task, TaskRunner } from '../../../domain/external/task';
import { RedisClient } from '../../storage/redis.client';
import { RedisStreamMessageQueue } from '../message-queue/redis-stream-message-queue';

export class RedisStreamTask extends Task {
  private readonly taskId = randomUUID();
  private execution?: Promise<void>;
  private cancelled = false;
  private abortController = new AbortController();
  private cancellation?: Promise<void>;
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
    this.abortController = new AbortController();
    this.cancellation = undefined;
    this.execution = this.executeTask();
  }

  /** 先等待 Runner 记录取消请求，再触发根 Signal 并等待活动执行退出。 */
  cancel(): boolean {
    if (this.cancelled) {
      return true;
    }
    this.cancelled = true;
    this.cancellation = this.cancelAndWait();
    return true;
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /** 返回取消确认 Promise，供停止 API 等待真实终止。 */
  async waitForCompletion(): Promise<void> {
    await (this.cancellation ?? this.execution);
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

  /** 严格执行“持久化请求 → abort → 等待退出”的取消顺序。 */
  private async cancelAndWait(): Promise<void> {
    await this.taskRunner.requestCancellation();
    this.abortController.abort(new DOMException('用户取消任务', 'AbortError'));
    await this.execution;
  }

  private release(): void {
    this.onRelease(this.taskId);
  }
}
