import { randomUUID } from 'node:crypto';
import { MessageQueue } from '../../../domain/external/message-queue';
import { Task, TaskRunner } from '../../../domain/external/task';
import { RedisClient } from '../../storage/redis.client';
import { RedisStreamMessageQueue } from '../message-queue/redis-stream-message-queue';

/** 使用 Redis Stream 承载消息，并以一个根 Signal 管理单次执行生命周期。 */
export class RedisStreamTask extends Task {
  private readonly taskId = randomUUID();
  private execution?: Promise<void>;
  private abortController = new AbortController();
  private cancellation?: Promise<void>;
  private readonly input: RedisStreamMessageQueue;
  private readonly output: RedisStreamMessageQueue;

  /** 创建当前 Task 独享的输入、输出 Stream。 */
  constructor(
    private readonly taskRunner: TaskRunner,
    redis: RedisClient,
    private readonly onRelease: (taskId: string) => void,
  ) {
    super();
    this.input = new RedisStreamMessageQueue(`task:input:${this.taskId}`, redis);
    this.output = new RedisStreamMessageQueue(`task:output:${this.taskId}`, redis);
  }

  /** 当前没有活动执行时创建新的根 Signal 并启动 Runner。 */
  async invoke(): Promise<void> {
    if (!this.done) {
      return;
    }
    this.abortController = new AbortController();
    this.cancellation = undefined;
    this.execution = this.executeTask();
  }

  /** 先等待 Runner 记录取消请求，再触发根 Signal 并等待活动执行退出。 */
  cancel(): boolean {
    if (!this.cancellation) {
      this.cancellation = this.cancelAndWait();
    }
    return true;
  }

  /** 返回当前一次执行使用的根取消 Signal。 */
  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /** 返回取消确认 Promise，供停止 API 等待真实终止。 */
  async waitForCompletion(): Promise<void> {
    await (this.cancellation ?? this.execution);
  }

  /** 返回任务输入消息流。 */
  get inputStream(): MessageQueue {
    return this.input;
  }

  /** 返回任务输出消息流。 */
  get outputStream(): MessageQueue {
    return this.output;
  }

  /** 返回进程内稳定的任务 ID。 */
  get id(): string {
    return this.taskId;
  }

  /** 判断当前是否没有活动执行。 */
  get done(): boolean {
    return !this.execution;
  }

  /** 执行 Runner，并在成功、失败或取消后统一释放任务。 */
  private async executeTask(): Promise<void> {
    try {
      await this.taskRunner.invoke(this);
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

  /** 通知 TaskManager 移除当前任务注册。 */
  private release(): void {
    this.onRelease(this.taskId);
  }
}
