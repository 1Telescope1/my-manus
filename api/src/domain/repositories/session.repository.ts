import { BaseEvent } from '../models/event';
import { FileModel } from '../models/file';
import { Memory } from '../models/memory';

export type SessionStatus = string;
export type SessionModel = Record<string, unknown>;

export abstract class SessionRepository {
  abstract save(session: SessionModel): Promise<void>;
  abstract getAll(): Promise<SessionModel[]>;
  abstract getById(sessionId: string): Promise<SessionModel | null>;
  abstract deleteById(sessionId: string): Promise<void>;
  abstract updateTitle(sessionId: string, title: string): Promise<void>;
  abstract updateLatestMessage(
    sessionId: string,
    message: string,
    timestamp: Date,
  ): Promise<void>;
  abstract updateUnreadMessageCount(sessionId: string, count: number): Promise<void>;
  abstract incrementUnreadMessageCount(sessionId: string): Promise<void>;
  abstract decrementUnreadMessageCount(sessionId: string): Promise<void>;
  abstract updateStatus(sessionId: string, status: SessionStatus): Promise<void>;
  abstract addEvent(sessionId: string, event: BaseEvent): Promise<void>;
  abstract addFile(sessionId: string, file: FileModel): Promise<void>;
  abstract removeFile(sessionId: string, fileId: string): Promise<void>;
  abstract getFileByPath(sessionId: string, filepath: string): Promise<FileModel | null>;
  abstract saveMemory(sessionId: string, agentName: string, memory: Memory): Promise<void>;
  abstract getMemory(sessionId: string, agentName: string): Promise<Memory>;
}
