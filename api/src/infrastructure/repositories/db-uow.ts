import { Injectable, Logger } from '@nestjs/common';
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

  /** 提交数据库持久化。 */
  async commit(): Promise<void> {
    // Prisma 的交互式事务在回调正常返回时自动提交。
  }

  /** 数据库回滚操作。 */
  async rollback(): Promise<void> {
    // Prisma 的交互式事务在回调抛出异常时自动回滚。
  }

  /** 进入 UoW 操作上下文，所有仓储共享同一个事务客户端。 */
  async run<T>(fn: (uow: UnitOfWork) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(async (transactionClient) => {
        // 1. 为当前事务创建新的 UoW 实例。
        const active = new DbUnitOfWork(transactionClient as unknown as PrismaService);

        // 2. 在事务内执行业务逻辑。
        return fn(active);
      });
    } catch (error) {
      DbUnitOfWork.logger.warn(`UoW 操作失败: ${(error as Error).message}`);
      throw error;
    }
  }
}
