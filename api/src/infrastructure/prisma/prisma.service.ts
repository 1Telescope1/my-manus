import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { SettingsService } from '../../core/config/settings';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private initialized = false;

  constructor(settings: SettingsService) {
    process.env.DATABASE_URL ||= settings.databaseUrl;
    super();
  }

  async onModuleInit(): Promise<void> {
    if (this.initialized) {
      this.logger.warn('Postgres 已初始化，无需重复操作');
      return;
    }

    try {
      await this.$connect();
      await this.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');
      this.initialized = true;
      this.logger.log('成功连接 Postgres 并安装 uuid-ossp 扩展');
    } catch (error) {
      this.logger.error(`连接 Postgres 失败: ${(error as Error).message}`);
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.initialized = false;
  }

  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }
}
