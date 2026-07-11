import { Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { SettingsService } from '../../core/config/settings';

@Injectable()
export class PrismaService extends PrismaClient {
  private readonly logger = new Logger(PrismaService.name);
  private initialized = false;

  constructor(settings: SettingsService) {
    process.env.DATABASE_URL ||= settings.databaseUrl;
    super();
  }

  async init(): Promise<void> {
    if (this.initialized) {
      this.logger.warn('Postgres 已初始化，无需重复操作');
      return;
    }

    try {
      // 1. 连接 PostgreSQL 并确保 UUID 扩展可用。
      await this.$connect();
      await this.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');
      this.initialized = true;
      this.logger.log('成功连接 Postgres 并安装 uuid-ossp 扩展');
    } catch (error) {
      this.logger.error(`连接 Postgres 失败: ${(error as Error).message}`);
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    if (this.initialized) {
      await this.$disconnect();
      this.initialized = false;
      this.logger.log('成功关闭Postgres连接');
    }
  }

  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }
}
