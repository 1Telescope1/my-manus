import { Event } from '../../domain/models/event';
import { createFileModel, FileModel } from '../../domain/models/file';
import { Memory } from '../../domain/models/memory';
import { createSession, Session, SessionStatus } from '../../domain/models/session';

export type SessionPersistenceRecord = {
  id: string;
  sandboxId?: string | null;
  taskId?: string | null;
  title: string;
  unreadMessageCount: number;
  latestMessage: string;
  latestMessageAt?: Date | null;
  events: unknown;
  files: unknown;
  memories: unknown;
  status: string;
  updatedAt: Date;
  createdAt: Date;
};

export function sessionToPersistence(session: Session): Record<string, unknown> {
  return {
    // 1. 基础字段：直接使用领域模型中的普通字段。
    id: session.id,
    sandboxId: session.sandbox_id,
    taskId: session.task_id,
    title: session.title,
    unreadMessageCount: session.unread_message_count,
    latestMessage: session.latest_message,
    latestMessageAt: session.latest_message_at,
    status: session.status,

    // 2. 复杂字段：转换成可以写入 JSON 字段的普通对象。
    events: session.events,
    files: session.files,
    memories: serializeMemories(session.memories),
  };
}

export function persistenceToSession(record: SessionPersistenceRecord): Session {
  return createSession({
    id: record.id,
    sandbox_id: record.sandboxId,
    task_id: record.taskId,
    title: record.title,
    unread_message_count: record.unreadMessageCount,
    latest_message: record.latestMessage,
    latest_message_at: record.latestMessageAt,
    events: normalizeEvents(record.events),
    files: normalizeFiles(record.files),
    memories: normalizeMemories(record.memories),
    status: normalizeSessionStatus(record.status),
    updated_at: record.updatedAt,
    created_at: record.createdAt,
  });
}

export function sessionUpdateToPersistence(session: Session): Record<string, unknown> {
  const data = sessionToPersistence(session);
  delete data.updatedAt;
  delete data.createdAt;
  return data;
}

function serializeMemories(memories: Record<string, Memory>): Record<string, unknown> {
  const serialized: Record<string, unknown> = {};
  for (const [agentName, memory] of Object.entries(memories)) {
    serialized[agentName] = {
      messages: memory.getMessages(),
    };
  }
  return serialized;
}

function normalizeEvents(events: unknown): Event[] {
  return Array.isArray(events) ? (events as Event[]) : [];
}

function normalizeFiles(files: unknown): FileModel[] {
  if (!Array.isArray(files)) {
    return [];
  }
  return files.map((file) => createFileModel(file as Partial<FileModel>));
}

function normalizeMemories(memories: unknown): Record<string, Memory> {
  if (!memories || typeof memories !== 'object' || Array.isArray(memories)) {
    return {};
  }

  const normalized: Record<string, Memory> = {};
  for (const [agentName, memory] of Object.entries(memories as Record<string, unknown>)) {
    normalized[agentName] = Memory.from(memory as { messages?: Record<string, any>[] });
  }
  return normalized;
}

function normalizeSessionStatus(status: string): SessionStatus {
  return Object.values(SessionStatus).includes(status as SessionStatus)
    ? (status as SessionStatus)
    : SessionStatus.PENDING;
}
