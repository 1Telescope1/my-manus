import { MessageQueue } from './message-queue';

/**
 * 任务运行器边界。
 *
 * 具体 runner 负责执行任务、释放资源，
 * 并在任务结束时处理回调逻辑。
 */
export abstract class TaskRunner {
  /** 执行传入的任务实例。 */
  abstract invoke(task: Task): Promise<void>;

  /** 销毁 runner 持有的资源，例如网络连接、后台进程或临时状态。 */
  abstract destroy(): Promise<void>;

  /** 任务完成后的回调入口。 */
  abstract onDone(task: Task): Promise<void>;
}

/**
 * 任务实例边界。
 *
 * 具体任务类还需要提供 `get/create/destroy` 静态生命周期方法。
 * 抽象实例协议只描述运行时对象能力。
 */
export abstract class Task {
  /** 启动当前任务。 */
  abstract invoke(): Promise<void>;

  /** 取消当前任务。 */
  abstract cancel(): boolean;

  /** 当前任务的输入消息流。 */
  abstract readonly inputStream: MessageQueue;

  /** 当前任务的输出消息流。 */
  abstract readonly outputStream: MessageQueue;

  /** 当前任务 ID。 */
  abstract readonly id: string;

  /** 当前任务是否已经结束。 */
  abstract readonly done: boolean;
}

/**
 * 任务 concrete class 的静态侧约定。
 *
 * 不直接放进 `Task` abstract class，是因为静态方法
 * 无法自然参与实例抽象继承，而且不同实现可能需要额外依赖。
 */
export interface TaskConstructor<TTask extends Task = Task> {
  get(taskId: string): TTask | undefined;
  create(taskRunner: TaskRunner, ...dependencies: unknown[]): TTask;
  destroy(): Promise<void>;
}

