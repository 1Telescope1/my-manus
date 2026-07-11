import {
  BaseEvent,
  ErrorEvent,
  Event,
  MessageEvent,
  PlanEvent,
  StepEvent,
  ToolEvent,
  ToolEventStatus,
} from '../../domain/models/event';
import { FileModel } from '../../domain/models/file';
import { ExecutionStatus } from '../../domain/models/plan';

/** 基础事件数据。 */
export class BaseEventData {
  event_id?: string;
  created_at: number;

  constructor(input: { event_id?: string; created_at?: number }) {
    this.event_id = input.event_id;
    this.created_at = input.created_at ?? currentTimestamp();
  }

  /** 将领域事件转换成基础事件数据。 */
  static baseEventData(event: BaseEvent): { event_id?: string; created_at: number } {
    return {
      event_id: event.id,
      created_at: toTimestamp(event.created_at),
    };
  }

  /** 从领域事件构建基础事件数据。 */
  static fromEvent(event: Event): BaseEventData {
    return new BaseEventData(BaseEventData.baseEventData(event));
  }
}

/** 基础流式事件数据类型。 */
export class BaseSSEEvent<TData extends BaseEventData = BaseEventData> {
  constructor(
    readonly event: string,
    readonly data: TData,
  ) {}

  /** 将领域事件转换成基础流式事件。 */
  static fromEvent(event: Event): BaseSSEEvent {
    return new BaseSSEEvent(event.type, BaseEventData.fromEvent(event));
  }
}

/** 通用事件数据，允许填充额外字段。 */
export class CommonEventData extends BaseEventData {
  [key: string]: unknown;

  static fromEvent(event: Event): CommonEventData {
    const data = new CommonEventData(BaseEventData.baseEventData(event));
    const eventRecord = event as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(eventRecord)) {
      if (key !== 'id' && key !== 'type' && key !== 'created_at') {
        data[key] = value;
      }
    }
    return data;
  }
}

/** 通用流式事件。 */
export class CommonSSEEvent extends BaseSSEEvent<CommonEventData> {
  static fromEvent(event: Event): CommonSSEEvent {
    return new CommonSSEEvent(event.type, CommonEventData.fromEvent(event));
  }
}

/** 消息事件数据。 */
export class MessageEventData extends BaseEventData {
  role: 'user' | 'assistant';
  message: string;
  attachments: FileModel[];

  constructor(input: {
    event_id?: string;
    created_at?: number;
    role?: 'user' | 'assistant';
    message?: string;
    attachments?: FileModel[];
  }) {
    super(input);
    this.role = input.role ?? 'assistant';
    this.message = input.message ?? '';
    this.attachments = input.attachments ?? [];
  }
}

/** 消息流式事件。 */
export class MessageSSEEvent extends BaseSSEEvent<MessageEventData> {
  readonly event = 'message';

  constructor(data: MessageEventData) {
    super('message', data);
  }

  static fromEvent(event: MessageEvent): MessageSSEEvent {
    return new MessageSSEEvent(new MessageEventData({
      ...BaseEventData.baseEventData(event),
      role: event.role,
      message: event.message,
      attachments: event.attachments,
    }));
  }
}

/** 标题事件数据。 */
export class TitleEventData extends BaseEventData {
  constructor(
    input: { event_id?: string; created_at?: number; title: string },
    readonly title = input.title,
  ) {
    super(input);
  }
}

/** 标题流式事件。 */
export class TitleSSEEvent extends BaseSSEEvent<TitleEventData> {
  readonly event = 'title';

  constructor(data: TitleEventData) {
    super('title', data);
  }

  static fromEvent(event: Extract<Event, { type: 'title' }>): TitleSSEEvent {
    return new TitleSSEEvent(new TitleEventData({
      ...BaseEventData.baseEventData(event),
      title: event.title,
    }));
  }
}

/** 步骤事件数据。 */
export class StepEventData extends BaseEventData {
  readonly id: string;
  readonly status: ExecutionStatus;
  readonly description: string;

  constructor(input: {
    event_id?: string;
    created_at?: number;
    id: string;
    status: ExecutionStatus;
    description: string;
  }) {
    super(input);
    this.id = input.id;
    this.status = input.status;
    this.description = input.description;
  }
}

/** 步骤流式事件。 */
export class StepSSEEvent extends BaseSSEEvent<StepEventData> {
  readonly event = 'step';

  constructor(data: StepEventData) {
    super('step', data);
  }

  static fromEvent(event: StepEvent): StepSSEEvent {
    return new StepSSEEvent(new StepEventData({
      ...BaseEventData.baseEventData(event),
      id: event.step.id,
      status: event.step.status,
      description: event.step.description,
    }));
  }
}

/** 计划事件数据。 */
export class PlanEventData extends BaseEventData {
  constructor(
    input: { event_id?: string; created_at?: number; steps: StepEventData[] },
    readonly steps = input.steps,
  ) {
    super(input);
  }
}

/** 计划流式事件。 */
export class PlanSSEEvent extends BaseSSEEvent<PlanEventData> {
  readonly event = 'plan';

  constructor(data: PlanEventData) {
    super('plan', data);
  }

  static fromEvent(event: PlanEvent): PlanSSEEvent {
    return new PlanSSEEvent(new PlanEventData({
      ...BaseEventData.baseEventData(event),
      steps: event.plan.steps.map((step) => new StepEventData({
        ...BaseEventData.baseEventData(event),
        id: step.id,
        status: step.status,
        description: step.description,
      })),
    }));
  }
}

/** 工具事件数据。 */
export class ToolEventData extends BaseEventData {
  readonly tool_call_id: string;
  readonly name: string;
  readonly status: ToolEventStatus;
  readonly function: string;
  readonly args: Record<string, unknown>;
  readonly content?: unknown;

  constructor(input: {
    event_id?: string;
    created_at?: number;
    tool_call_id: string;
    name: string;
    status: ToolEventStatus;
    function: string;
    args: Record<string, unknown>;
    content?: unknown;
  }) {
    super(input);
    this.tool_call_id = input.tool_call_id;
    this.name = input.name;
    this.status = input.status;
    this.function = input.function;
    this.args = input.args;
    this.content = input.content;
  }
}

/** 工具流式事件。 */
export class ToolSSEEvent extends BaseSSEEvent<ToolEventData> {
  readonly event = 'tool';

  constructor(data: ToolEventData) {
    super('tool', data);
  }

  static fromEvent(event: ToolEvent): ToolSSEEvent {
    return new ToolSSEEvent(new ToolEventData({
      ...BaseEventData.baseEventData(event),
      tool_call_id: event.tool_call_id,
      name: event.tool_name,
      status: event.status,
      function: event.function_name,
      args: event.function_args,
      content: event.tool_content,
    }));
  }
}

export class DoneSSEEvent extends BaseSSEEvent {
  readonly event = 'done';

  constructor(data: BaseEventData) {
    super('done', data);
  }

  static fromEvent(event: Extract<Event, { type: 'done' }>): DoneSSEEvent {
    return new DoneSSEEvent(BaseEventData.fromEvent(event));
  }
}

export class WaitSSEEvent extends BaseSSEEvent {
  readonly event = 'wait';

  constructor(data: BaseEventData) {
    super('wait', data);
  }

  static fromEvent(event: Extract<Event, { type: 'wait' }>): WaitSSEEvent {
    return new WaitSSEEvent(BaseEventData.fromEvent(event));
  }
}

/** 错误事件数据。 */
export class ErrorEventData extends BaseEventData {
  constructor(
    input: { event_id?: string; created_at?: number; error: string },
    readonly error = input.error,
  ) {
    super(input);
  }
}

/** 错误流式事件。 */
export class ErrorSSEEvent extends BaseSSEEvent<ErrorEventData> {
  readonly event = 'error';

  constructor(data: ErrorEventData) {
    super('error', data);
  }

  static fromEvent(event: ErrorEvent): ErrorSSEEvent {
    return new ErrorSSEEvent(new ErrorEventData({
      ...BaseEventData.baseEventData(event),
      error: event.error,
    }));
  }
}

export type AgentSseEvent =
  | CommonSSEEvent
  | MessageSSEEvent
  | TitleSSEEvent
  | StepSSEEvent
  | PlanSSEEvent
  | ToolSSEEvent
  | DoneSSEEvent
  | ErrorSSEEvent
  | WaitSSEEvent;

/** 保存事件类型和转换函数的映射信息。 */
type EventMapping = {
  eventType: string;
  fromEvent: (event: Event) => AgentSseEvent;
};

/** 将领域事件转换为适合流式传输的事件。 */
export class EventMapper {
  private static cacheMapping?: Map<string, EventMapping>;

  /** 构建并缓存领域事件类型到流式事件类型的映射。 */
  private static getEventTypeMapping(): Map<string, EventMapping> {
    // 1. 缓存存在时直接返回。
    if (EventMapper.cacheMapping !== undefined) {
      return EventMapper.cacheMapping;
    }

    // 2. TS 类型在运行时会被擦除，因此显式登记全部流式事件类型。
    const mappings: EventMapping[] = [
      { eventType: 'message', fromEvent: (event) => MessageSSEEvent.fromEvent(event as MessageEvent) },
      { eventType: 'title', fromEvent: (event) => TitleSSEEvent.fromEvent(event as Extract<Event, { type: 'title' }>) },
      { eventType: 'step', fromEvent: (event) => StepSSEEvent.fromEvent(event as StepEvent) },
      { eventType: 'plan', fromEvent: (event) => PlanSSEEvent.fromEvent(event as PlanEvent) },
      { eventType: 'tool', fromEvent: (event) => ToolSSEEvent.fromEvent(event as ToolEvent) },
      { eventType: 'done', fromEvent: (event) => DoneSSEEvent.fromEvent(event as Extract<Event, { type: 'done' }>) },
      { eventType: 'error', fromEvent: (event) => ErrorSSEEvent.fromEvent(event as ErrorEvent) },
      { eventType: 'wait', fromEvent: (event) => WaitSSEEvent.fromEvent(event as Extract<Event, { type: 'wait' }>) },
    ];

    // 3. 构建并注册映射关系。
    const mapping = new Map<string, EventMapping>();
    for (const eventMapping of mappings) {
      mapping.set(eventMapping.eventType, eventMapping);
    }

    // 4. 更新类级缓存。
    EventMapper.cacheMapping = mapping;
    return mapping;
  }

  /** 将领域事件转换为流式事件模型。 */
  static eventToSseEvent(event: Event): AgentSseEvent {
    // 1. 获取事件映射表。
    const eventTypeMapping = EventMapper.getEventTypeMapping();

    // 2. 根据事件类型获取映射信息。
    const eventMapping = eventTypeMapping.get(event.type);

    // 3. 找到映射时调用对应转换函数。
    if (eventMapping) {
      return eventMapping.fromEvent(event);
    }

    // 4. 未找到映射时使用通用事件类型。
    return CommonSSEEvent.fromEvent(event);
  }

  /** 将领域事件列表转换为流式事件列表。 */
  static eventsToSseEvents(events: Event[]): AgentSseEvent[] {
    return events.map((event) => EventMapper.eventToSseEvent(event));
  }
}

function currentTimestamp(): number {
  return Math.floor(Date.now() / 1_000);
}

function toTimestamp(value: Date): number {
  return Math.floor(value.getTime() / 1_000);
}
