import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BaseEvent } from '../../domain/models/event';
import { FileModel } from '../../domain/models/file';
import { Memory } from '../../domain/models/memory';
import { Session, SessionStatus } from '../../domain/models/session';
import { SessionRepository } from '../../domain/repositories/session.repository';
import { PrismaService } from '../prisma/prisma.service';
import {
  persistenceToSession,
  sessionToPersistence,
  sessionUpdateToPersistence,
  type SessionPersistenceRecord,
} from '../prisma/session.mapper';

type SessionDelegate = {
  findUnique(args: Record<string, unknown>): Promise<SessionPersistenceRecord | null>;
  findMany(args?: Record<string, unknown>): Promise<SessionPersistenceRecord[]>;
  create(args: Record<string, unknown>): Promise<unknown>;
  update(args: Record<string, unknown>): Promise<unknown>;
  updateMany(args: Record<string, unknown>): Promise<{ count: number }>;
  deleteMany(args: Record<string, unknown>): Promise<{ count: number }>;
};

@Injectable()
export class DbSessionRepository extends SessionRepository {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService | Prisma.TransactionClient,
  ) {
    super();
  }

  private get sessionClient(): SessionDelegate {
    return (this.prisma as unknown as { session: SessionDelegate }).session;
  }

  /** 根据传递的领域模型更新或者新增会话。 */
  async save(session: Session): Promise<void> {
    // 1. 根据 id 查询会话是否存在。
    const record = await this.sessionClient.findUnique({
      where: { id: session.id },
    });

    // 2. 如果会话不存在则新建会话。
    if (!record) {
      await this.sessionClient.create({
        data: sessionToPersistence(session),
      });
      return;
    }

    // 3. 会话存在则更新会话。
    await this.sessionClient.update({
      where: { id: session.id },
      data: sessionUpdateToPersistence(session),
    });
  }

  /** 获取所有会话列表。 */
  async getAll(): Promise<Session[]> {
    // 1. 查询所有记录，并按最新消息时间倒序排序。
    const records = await this.sessionClient.findMany({
      orderBy: [{ latestMessageAt: 'desc' }],
    });

    // 2. 将数据循环遍历成 Session。
    return records.map((record) => persistenceToSession(record as SessionPersistenceRecord));
  }

  /** 根据 id 查询会话。 */
  async getById(sessionId: string): Promise<Session | null> {
    // 1. 根据 id 查询会话是否存在。
    const record = await this.sessionClient.findUnique({
      where: { id: sessionId },
    });

    // 2. 判断会话记录是否存在并返回。
    return record ? persistenceToSession(record as SessionPersistenceRecord) : null;
  }

  /** 根据传递的 id 删除会话。 */
  async deleteById(sessionId: string): Promise<void> {
    // 1. 执行删除；不存在时不抛业务错误。
    await this.sessionClient.deleteMany({
      where: { id: sessionId },
    });
  }

  /** 更新会话标题。 */
  async updateTitle(sessionId: string, title: string): Promise<void> {
    // 1. 构建更新语句并执行。
    const result = await this.sessionClient.updateMany({
      where: { id: sessionId },
      data: { title },
    });

    // 2. 检查是否更新成功。
    this.ensureUpdated(result.count, sessionId);
  }

  /** 更新会话最新消息。 */
  async updateLatestMessage(sessionId: string, message: string, timestamp: Date): Promise<void> {
    // 1. 构建更新语句并执行。
    const result = await this.sessionClient.updateMany({
      where: { id: sessionId },
      data: {
        latestMessage: message,
        latestMessageAt: timestamp,
      },
    });

    // 2. 检查是否更新成功。
    this.ensureUpdated(result.count, sessionId);
  }

  /** 往会话中新增事件。 */
  async addEvent(sessionId: string, event: BaseEvent): Promise<void> {
    // 1. 查询会话记录。
    const record = await this.getRequiredRecord(sessionId);

    // 2. 在内存中追加事件，保持 JSON 字段结构。
    const events = this.arrayJson(record.events);
    events.push(event);

    // 3. 更新会话事件列表。
    await this.sessionClient.update({
      where: { id: sessionId },
      data: { events },
    });
  }

  /** 往会话中新增文件。 */
  async addFile(sessionId: string, file: FileModel): Promise<void> {
    // 1. 查询会话记录。
    const record = await this.getRequiredRecord(sessionId);

    // 2. 在内存中追加文件信息。
    const files = this.arrayJson(record.files);
    files.push(file);

    // 3. 更新会话文件列表。
    await this.sessionClient.update({
      where: { id: sessionId },
      data: { files },
    });
  }

  /** 移除会话中的指定文件。 */
  async removeFile(sessionId: string, fileId: string): Promise<void> {
    // 1. 查询会话记录。
    const record = await this.getRequiredRecord(sessionId);

    // 2. 会话记录存在，则在内存中过滤 files。
    const files = this.arrayJson(record.files);
    if (!files.length) {
      return;
    }

    const nextFiles = files.filter((file) => file.id !== fileId);

    // 3. 文件长度没有变化时不更新。
    if (nextFiles.length === files.length) {
      return;
    }

    // 4. 更新数据。
    await this.sessionClient.update({
      where: { id: sessionId },
      data: { files: nextFiles },
    });
  }

  /** 根据文件路径获取文件信息。 */
  async getFileByPath(sessionId: string, filepath: string): Promise<FileModel | null> {
    // 1. 查询文件列表。
    const record = await this.sessionClient.findUnique({
      where: { id: sessionId },
      select: { files: true },
    });

    // 2. 判断是否为空，如果不存在则返回 null。
    const files = this.arrayJson(record?.files);
    if (!files.length) {
      return null;
    }

    // 3. 遍历查找数据，如果最后没找到则返回空。
    return (files.find((file) => file.filepath === filepath) as FileModel | undefined) ?? null;
  }

  /** 更新会话状态。 */
  async updateStatus(sessionId: string, status: SessionStatus): Promise<void> {
    // 1. 构建更新语句并执行。
    const result = await this.sessionClient.updateMany({
      where: { id: sessionId },
      data: { status },
    });

    // 2. 检查是否更新成功。
    this.ensureUpdated(result.count, sessionId);
  }

  /** 更新会话的未读消息数。 */
  async updateUnreadMessageCount(sessionId: string, count: number): Promise<void> {
    // 1. 构建更新语句并执行。
    const result = await this.sessionClient.updateMany({
      where: { id: sessionId },
      data: { unreadMessageCount: count },
    });

    // 2. 检查是否更新成功。
    this.ensureUpdated(result.count, sessionId);
  }

  /** 新增会话的未读消息数。 */
  async incrementUnreadMessageCount(sessionId: string): Promise<void> {
    // 1. 构建新增未读消息数语句并更新。
    const result = await this.sessionClient.updateMany({
      where: { id: sessionId },
      data: {
        unreadMessageCount: {
          increment: 1,
        },
      },
    });

    // 2. 检查是否更新成功。
    this.ensureUpdated(result.count, sessionId);
  }

  /** 将会话中的未读消息数 -1。 */
  async decrementUnreadMessageCount(sessionId: string): Promise<void> {
    // 1. 查询当前未读消息数。
    const record = await this.getRequiredRecord(sessionId);

    // 2. 核心逻辑：Math.max((当前值 - 1), 0) 避免出现负数。
    const nextCount = Math.max((record.unreadMessageCount ?? 0) - 1, 0);

    // 3. 更新未读消息数。
    await this.sessionClient.update({
      where: { id: sessionId },
      data: { unreadMessageCount: nextCount },
    });
  }

  /** 存储或者更新会话中的记忆。 */
  async saveMemory(sessionId: string, agentName: string, memory: Memory): Promise<void> {
    // 1. 查询会话记忆信息。
    const record = await this.getRequiredRecord(sessionId);

    // 2. 构建要打补丁的字典。
    const memories = this.objectJson(record.memories);
    memories[agentName] = { messages: memory.getMessages() };

    // 3. 执行合并更新。
    await this.sessionClient.update({
      where: { id: sessionId },
      data: { memories: memories as Prisma.InputJsonObject },
    });
  }

  /** 获取指定会话的 agent 记忆信息。 */
  async getMemory(sessionId: string, agentName: string): Promise<Memory> {
    // 1. 查询会话记忆信息。
    const record = await this.sessionClient.findUnique({
      where: { id: sessionId },
      select: { memories: true },
    });

    // 2. 如果存在记忆则直接返回。
    const memories = this.objectJson(record?.memories);
    const memoryData = memories[agentName];
    if (memoryData) {
      return Memory.from(memoryData as { messages?: Record<string, any>[] });
    }

    // 3. 如果记忆不存在，则构建一个空记忆后返回。
    return new Memory([]);
  }

  private async getRequiredRecord(sessionId: string): Promise<SessionPersistenceRecord> {
    const record = await this.sessionClient.findUnique({
      where: { id: sessionId },
    });

    if (!record) {
      throw new ValueError(`会话[${sessionId}]不存在，请核实后重试`);
    }

    return record as SessionPersistenceRecord;
  }

  private ensureUpdated(count: number, sessionId: string): void {
    if (count === 0) {
      throw new ValueError(`会话[${sessionId}]不存在，请核实后重试`);
    }
  }

  private arrayJson(value: unknown): Record<string, any>[] {
    return Array.isArray(value) ? [...(value as Record<string, any>[])] : [];
  }

  private objectJson(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }
    return { ...(value as Record<string, unknown>) };
  }
}

class ValueError extends Error {}
