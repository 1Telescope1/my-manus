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
 * 抽象实例协议只描述运行时对象能力，任务注册和销毁由 TaskManager 管理。
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

/** 管理当前 API 进程拥有的任务实例。 */
export abstract class TaskManager {
  /** 创建任务并注册到当前进程。 */
  abstract create(taskRunner: TaskRunner): Task;

  /** 根据任务 ID 获取当前进程中的任务。 */
  abstract get(taskId: string): Task | undefined;

  /** 停止并释放当前进程中仍被管理的全部任务。 */
  abstract destroy(): Promise<void>;
}

