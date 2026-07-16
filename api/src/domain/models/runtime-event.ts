import { FileModel } from './file';
import { Plan, Step } from './plan';
import { ToolResult } from './tool-result';

/**
 * 新 Runtime 发出的统一事件基础字段。
 *
 * Runtime 内部使用 camelCase；兼容适配器负责转换为现有事件的 snake_case 字段。
 */
export type RuntimeEventBase = {
  id: string;
  type: string;
  runId: string;
  sequence: number;
  createdAt: Date;
  checkpointId?: string;
  metadata?: Record<string, unknown>;
};

export type RuntimePlanEvent = RuntimeEventBase & {
  type: 'plan.created' | 'plan.updated' | 'plan.completed';
  plan: Plan;
};

export type RuntimeStepEvent = RuntimeEventBase & {
  type: 'step.started' | 'step.completed' | 'step.failed';
  step: Step;
};

export type RuntimeToolEvent = RuntimeEventBase & {
  type: 'tool.calling' | 'tool.called';
  toolCallId: string;
  toolName: string;
  functionName: string;
  arguments: Record<string, unknown>;
  result?: ToolResult;
  content?: unknown;
};

export type RuntimeMessageEvent = RuntimeEventBase & {
  type: 'message.created';
  role: 'user' | 'assistant';
  message: string;
  attachments?: FileModel[];
};

export type RuntimeTitleEvent = RuntimeEventBase & {
  type: 'title.updated';
  title: string;
};

export type RuntimeWaitingEvent = RuntimeEventBase & {
  type: 'run.waiting';
};

export type RuntimeFailedEvent = RuntimeEventBase & {
  type: 'run.failed';
  error: string;
};

export type RuntimeTerminalEvent = RuntimeEventBase & {
  type: 'run.completed' | 'run.cancelled';
};

export type RuntimeEvent =
  | RuntimePlanEvent
  | RuntimeStepEvent
  | RuntimeToolEvent
  | RuntimeMessageEvent
  | RuntimeTitleEvent
  | RuntimeWaitingEvent
  | RuntimeFailedEvent
  | RuntimeTerminalEvent;
