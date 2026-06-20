import { randomUUID } from 'node:crypto';
import { FileModel } from './file';
import { Plan, Step } from './plan';

export enum PlanEventStatus {
  CREATED = 'created',
  UPDATED = 'updated',
  COMPLETED = 'completed',
}

export enum StepEventStatus {
  STARTED = 'started',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export enum ToolEventStatus {
  CALLING = 'calling',
  CALLED = 'called',
}

export type BaseEvent = {
  id: string;
  type: string;
  created_at: Date;
};

export function baseEvent(type: string): BaseEvent {
  return {
    id: randomUUID(),
    type,
    created_at: new Date(),
  };
}

export type PlanEvent = BaseEvent & {
  type: 'plan';
  plan: Plan;
  status: PlanEventStatus;
};

export type TitleEvent = BaseEvent & {
  type: 'title';
  title: string;
};

export type StepEvent = BaseEvent & {
  type: 'step';
  step: Step;
  status: StepEventStatus;
};

export type MessageEvent = BaseEvent & {
  type: 'message';
  role: 'user' | 'assistant';
  message: string;
  attachments: FileModel[];
};

export type ToolEvent = BaseEvent & {
  type: 'tool';
  tool_call_id: string;
  tool_name: string;
  tool_content?: unknown;
  function_name: string;
  function_args: Record<string, any>;
  function_result?: unknown;
  status: ToolEventStatus;
};

export type WaitEvent = BaseEvent & {
  type: 'wait';
};

export type ErrorEvent = BaseEvent & {
  type: 'error';
  error: string;
};

export type DoneEvent = BaseEvent & {
  type: 'done';
};

export type Event =
  | PlanEvent
  | TitleEvent
  | StepEvent
  | MessageEvent
  | ToolEvent
  | WaitEvent
  | ErrorEvent
  | DoneEvent;

export const events = {
  plan(plan: Plan, status = PlanEventStatus.CREATED): PlanEvent {
    return { ...baseEvent('plan'), type: 'plan', plan, status };
  },
  step(step: Step, status = StepEventStatus.STARTED): StepEvent {
    return { ...baseEvent('step'), type: 'step', step, status };
  },
  message(input: Partial<MessageEvent> = {}): MessageEvent {
    return {
      ...baseEvent('message'),
      type: 'message',
      role: input.role ?? 'assistant',
      message: input.message ?? '',
      attachments: input.attachments ?? [],
    };
  },
  tool(input: Omit<ToolEvent, keyof BaseEvent | 'type'>): ToolEvent {
    return { ...baseEvent('tool'), type: 'tool', ...input };
  },
  wait(): WaitEvent {
    return { ...baseEvent('wait'), type: 'wait' };
  },
  error(error: string): ErrorEvent {
    return { ...baseEvent('error'), type: 'error', error };
  },
  done(): DoneEvent {
    return { ...baseEvent('done'), type: 'done' };
  },
};
