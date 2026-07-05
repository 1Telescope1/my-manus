import { randomUUID } from 'node:crypto';
import { BaseEvent, Event } from './event';
import { createFileModel, FileModel } from './file';
import { Memory } from './memory';
import { Plan } from './plan';

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
  memories: Record<string, Memory>;
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
    memories: normalizeMemories(input.memories),
    status: input.status ?? SessionStatus.PENDING,
    updated_at: input.updated_at ?? new Date(),
    created_at: input.created_at ?? new Date(),
  };
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

function normalizeMemories(memories?: Record<string, Memory>): Record<string, Memory> {
  const normalized: Record<string, Memory> = {};
  for (const [agentName, memory] of Object.entries(memories ?? {})) {
    normalized[agentName] = Memory.from(memory);
  }
  return normalized;
}
