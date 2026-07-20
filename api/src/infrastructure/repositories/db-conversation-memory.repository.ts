import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ConversationMemory } from '../../domain/models/conversation-memory';
import { ConversationMemoryRepository } from '../../domain/repositories/conversation-memory.repository';
import { PrismaService } from '../prisma/prisma.service';

type SessionMemoryRecord = { memories?: unknown };

type SessionMemoryDelegate = {
  findUnique(args: Record<string, unknown>): Promise<SessionMemoryRecord | null>;
  update(args: Record<string, unknown>): Promise<unknown>;
};

/** 使用既有 Session.memories JSON 列实现独立 Conversation Memory 仓储责任。 */
@Injectable()
export class DbConversationMemoryRepository extends ConversationMemoryRepository {
  /** 注入根 Prisma 或当前事务客户端。 */
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService | Prisma.TransactionClient,
  ) {
    super();
  }

  /** 返回当前 Prisma 上下文中的 Session delegate。 */
  private get sessionClient(): SessionMemoryDelegate {
    return (this.prisma as unknown as { session: SessionMemoryDelegate }).session;
  }

  /** 合并保存一个 Agent 的 Conversation Memory，保持其他 Agent 记录不变。 */
  async save(
    sessionId: string,
    agentName: string,
    memory: ConversationMemory,
  ): Promise<void> {
    const record = await this.sessionClient.findUnique({
      where: { id: sessionId },
      select: { memories: true },
    });
    if (!record) {
      throw new Error(`会话[${sessionId}]不存在，请核实后重试`);
    }

    const memories = objectJson(record.memories);
    memories[agentName] = { messages: memory.getMessages() };
    await this.sessionClient.update({
      where: { id: sessionId },
      data: { memories: memories as Prisma.InputJsonObject },
    });
  }

  /** 从旧 JSON 结构读取一个 Agent 的 Conversation Memory。 */
  async get(sessionId: string, agentName: string): Promise<ConversationMemory> {
    const record = await this.sessionClient.findUnique({
      where: { id: sessionId },
      select: { memories: true },
    });
    const memory = objectJson(record?.memories)[agentName];
    return memory
      ? ConversationMemory.from(memory as { messages?: Record<string, any>[] })
      : new ConversationMemory();
  }
}

/** 将未知 JSON 值安全复制为可局部更新的对象。 */
function objectJson(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return { ...(value as Record<string, unknown>) };
}
