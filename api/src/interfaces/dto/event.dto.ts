import { BaseEvent, Event, PlanEvent, StepEvent, ToolEvent } from '../../domain/models/event';

export type BaseEventData = {
  event_id?: string;
  created_at: number;
  [key: string]: unknown;
};

export type AgentSseEvent = {
  event: string;
  data: BaseEventData;
};

/** 将领域事件转换为适合 SSE 传输的数据结构。 */
export class EventMapper {
  static eventToSseEvent(event: Event): AgentSseEvent {
    const base = this.baseEventData(event);

    if (event.type === 'message') {
      return {
        event: 'message',
        data: {
          ...base,
          role: event.role,
          message: event.message,
          attachments: event.attachments,
        },
      };
    }

    if (event.type === 'step') {
      const stepEvent = event as StepEvent;
      return {
        event: 'step',
        data: {
          ...base,
          id: stepEvent.step.id,
          status: stepEvent.step.status,
          description: stepEvent.step.description,
        },
      };
    }

    if (event.type === 'plan') {
      const planEvent = event as PlanEvent;
      return {
        event: 'plan',
        data: {
          ...base,
          steps: planEvent.plan.steps.map((step) => ({
            ...base,
            id: step.id,
            status: step.status,
            description: step.description,
          })),
        },
      };
    }

    if (event.type === 'tool') {
      const toolEvent = event as ToolEvent;
      return {
        event: 'tool',
        data: {
          ...base,
          tool_call_id: toolEvent.tool_call_id,
          name: toolEvent.tool_name,
          status: toolEvent.status,
          function: toolEvent.function_name,
          args: toolEvent.function_args,
          content: toolEvent.tool_content,
        },
      };
    }

    const { id: _id, type: _type, created_at: _createdAt, ...data } = event;
    return {
      event: event.type,
      data: { ...base, ...data },
    };
  }

  static eventsToSseEvents(events: Event[]): AgentSseEvent[] {
    return events.map((event) => this.eventToSseEvent(event));
  }

  private static baseEventData(event: BaseEvent): BaseEventData {
    return {
      event_id: event.id,
      created_at: Math.floor(event.created_at.getTime() / 1000),
    };
  }
}
