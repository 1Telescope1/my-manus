import { MessageQueue } from './message-queue';

export abstract class TaskRunner {
  abstract invoke(task: Task): Promise<void>;
  abstract destroy(): Promise<void>;
  abstract onDone(task: Task): Promise<void>;
}

export abstract class Task {
  abstract invoke(): Promise<void>;
  abstract cancel(): boolean;
  abstract readonly inputStream: MessageQueue;
  abstract readonly outputStream: MessageQueue;
  abstract readonly id: string;
  abstract readonly done: boolean;
}
