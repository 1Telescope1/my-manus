import { IsArray, IsInt, IsOptional, IsString } from 'class-validator';
import { FileModel } from '../../domain/models/file';
import { SessionStatus } from '../../domain/models/session';
import { AgentSseEvent } from './event.dto';

export type CreateSessionResponse = { session_id: string };

export type ListSessionItem = {
  session_id: string;
  title: string;
  latest_message: string;
  latest_message_at?: Date | null;
  status: SessionStatus;
  unread_message_count: number;
};

export type ListSessionResponse = { sessions: ListSessionItem[] };

export class ChatRequest {
  @IsOptional()
  @IsString()
  message?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  attachments: string[] = [];

  @IsOptional()
  @IsString()
  event_id?: string;

  @IsOptional()
  @IsInt()
  timestamp?: number;
}

export type GetSessionResponse = {
  session_id: string;
  title?: string | null;
  status: SessionStatus;
  events: AgentSseEvent[];
};

export type GetSessionFilesResponse = { files: FileModel[] };

export class FileReadRequest {
  @IsString()
  filepath!: string;
}

export type FileReadResponse = { filepath: string; content: string };

export class ShellReadRequest {
  @IsString()
  session_id!: string;
}

export type ConsoleRecord = { ps1: string; command: string; output: string };

export type ShellReadResponse = {
  session_id: string;
  output: string;
  console_records: ConsoleRecord[];
};
