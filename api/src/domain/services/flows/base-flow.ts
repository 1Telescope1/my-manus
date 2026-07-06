import { Event } from '../../models/event';
import { Message } from '../../models/message';

export enum FlowStatus {
  IDLE = 'idle',
  PLANNING = 'planning',
  EXECUTING = 'executing',
  UPDATING = 'updating',
  SUMMARIZING = 'summarizing',
  COMPLETED = 'completed',
}

/** 基础流抽象类。 */
export abstract class BaseFlow {
  /** 流调用函数，返回可迭代的基础事件。 */
  abstract invoke(message: Message): AsyncGenerator<Event>;

  /** 只读属性，用于返回流是否结束。 */
  abstract get done(): boolean;
}
