import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AgentRunRepository } from '../../domain/repositories/agent-run.repository';
import { ConversationMemoryRepository } from '../../domain/repositories/conversation-memory.repository';
import { FileRepository } from '../../domain/repositories/file.repository';
import { SessionRepository } from '../../domain/repositories/session.repository';
import { UnitOfWork } from '../../domain/repositories/unit-of-work';
import { DbFileRepository } from './db-file.repository';
import { DbAgentRunRepository } from './db-agent-run.repository';
import { DbSessionRepository } from './db-session.repository';
import { DbConversationMemoryRepository } from './db-conversation-memory.repository';

/** 使用 Prisma 交互式事务实现跨仓储 UnitOfWork。 */
@Injectable()
export class DbUnitOfWork extends UnitOfWork {
  readonly agentRun: AgentRunRepository;
  readonly conversationMemory: ConversationMemoryRepository;
  readonly file: FileRepository;
  readonly session: SessionRepository;

  /** 创建共享根 Prisma 连接的非事务仓储入口。 */
  constructor(private readonly prisma: PrismaService) {
    super();
    this.agentRun = new DbAgentRunRepository(this.prisma);
    this.conversationMemory = new DbConversationMemoryRepository(this.prisma);
    this.file = new DbFileRepository(this.prisma);
    this.session = new DbSessionRepository(this.prisma);
  }

  /** 进入 UoW 操作上下文，所有仓储共享同一个事务客户端。 */
  async run<T>(fn: (uow: UnitOfWork) => Promise<T>): Promise<T> {
    // 回调收到的新 UoW 只持有 transactionClient，确保写入落在同一事务。
    return this.prisma.$transaction((transactionClient) =>
      fn(new TransactionUnitOfWork(transactionClient)),
    );
  }
}

/** 事务范围内的仓储集合，由 Prisma 决定提交或回滚。 */
class TransactionUnitOfWork extends UnitOfWork {
  readonly agentRun: AgentRunRepository;
  readonly conversationMemory: ConversationMemoryRepository;
  readonly file: FileRepository;
  readonly session: SessionRepository;

  /** 用同一个 Prisma 事务客户端构造全部事务仓储。 */
  constructor(transactionClient: Prisma.TransactionClient) {
    super();
    this.agentRun = new DbAgentRunRepository(transactionClient);
    this.conversationMemory = new DbConversationMemoryRepository(transactionClient);
    this.file = new DbFileRepository(transactionClient);
    this.session = new DbSessionRepository(transactionClient);
  }

  /** 复用当前事务执行嵌套回调，避免意外开启第二个独立事务。 */
  async run<T>(fn: (uow: UnitOfWork) => Promise<T>): Promise<T> {
    return fn(this);
  }
}
