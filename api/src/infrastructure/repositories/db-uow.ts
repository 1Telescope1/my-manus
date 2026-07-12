import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FileRepository } from '../../domain/repositories/file.repository';
import { SessionRepository } from '../../domain/repositories/session.repository';
import { UnitOfWork } from '../../domain/repositories/unit-of-work';
import { DbFileRepository } from './db-file.repository';
import { DbSessionRepository } from './db-session.repository';

@Injectable()
export class DbUnitOfWork extends UnitOfWork {
  private static readonly logger = new Logger(DbUnitOfWork.name);

  readonly file: FileRepository;
  readonly session: SessionRepository;

  constructor(private readonly prisma: PrismaService) {
    super();
    this.file = new DbFileRepository(this.prisma);
    this.session = new DbSessionRepository(this.prisma);
  }

  /** 进入 UoW 操作上下文，所有仓储共享同一个事务客户端。 */
  async run<T>(fn: (uow: UnitOfWork) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(async (transactionClient) => {
        return fn(new TransactionUnitOfWork(transactionClient));
      });
    } catch (error) {
      DbUnitOfWork.logger.warn(`UoW 操作失败: ${(error as Error).message}`);
      throw error;
    }
  }
}

/** 事务范围内的仓储集合，由 Prisma 决定提交或回滚。 */
class TransactionUnitOfWork extends UnitOfWork {
  readonly file: FileRepository;
  readonly session: SessionRepository;

  constructor(transactionClient: Prisma.TransactionClient) {
    super();
    this.file = new DbFileRepository(transactionClient);
    this.session = new DbSessionRepository(transactionClient);
  }

  async run<T>(fn: (uow: UnitOfWork) => Promise<T>): Promise<T> {
    return fn(this);
  }
}
