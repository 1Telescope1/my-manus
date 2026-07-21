import { randomUUID } from 'node:crypto';
import { BaseEvent, Event } from './event';
import { createFileModel, FileModel } from './file';
import { ConversationMemory } from './conversation-memory';
import { Plan } from './plan';

export const DEFAULT_SESSION_TITLE = '新对话';
const INITIAL_SESSION_TITLE_MAX_LENGTH = 30;

export enum SessionStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  WAITING = 'waiting',
  COMPLETED = 'completed',
}

export type Session = {
  id: string;
  sandbox_id?: string | null;
  task_id?: string | null;
  title: string;
  unread_message_count: number;
  latest_message: string;
  latest_message_at?: Date | null;
  events: Event[];
  files: FileModel[];
  memories: Record<string, ConversationMemory>;
  status: SessionStatus;
  updated_at: Date;
  created_at: Date;
};

export function createSession(input: Partial<Session> = {}): Session {
  return {
    id: input.id ?? randomUUID(),
    sandbox_id: input.sandbox_id ?? null,
    task_id: input.task_id ?? null,
    title: input.title ?? '',
    unread_message_count: input.unread_message_count ?? 0,
    latest_message: input.latest_message ?? '',
    latest_message_at: input.latest_message_at ?? null,
    events: input.events ?? [],
    files: (input.files ?? []).map((file) => createFileModel(file)),
    memories: input.memories ?? {},
    status: input.status ?? SessionStatus.PENDING,
    updated_at: input.updated_at ?? new Date(),
    created_at: input.created_at ?? new Date(),
  };
}

/** 从第一条用户消息生成跨 Runtime 路由一致的初始会话标题。 */
export function createInitialSessionTitle(message: string): string {
  const normalized = message.replace(/\s+/g, ' ').trim();
  const characters = Array.from(normalized);
  if (characters.length <= INITIAL_SESSION_TITLE_MAX_LENGTH) {
    return normalized;
  }
  return `${characters.slice(0, INITIAL_SESSION_TITLE_MAX_LENGTH).join('')}…`;
}

/** 只允许尚未命名的会话自动生成初始标题。 */
export function needsInitialSessionTitle(title: string): boolean {
  const normalized = title.trim();
  return normalized.length === 0 || normalized === DEFAULT_SESSION_TITLE;
}

export function getLatestPlan(session: Session): Plan | undefined {
  // 1. 倒序遍历会话中所有事件消息。
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index] as BaseEvent & { plan?: Plan };

    // 2. 判断事件类型是否为 plan，如果是则提取计划后返回。
    if (event.type === 'plan') {
      return event.plan;
    }
  }

  return undefined;
}
