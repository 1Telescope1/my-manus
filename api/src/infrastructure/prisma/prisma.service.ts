import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { SettingsService } from '../../core/config/settings';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(settings: SettingsService) {
    process.env.DATABASE_URL ||= settings.databaseUrl;
    super();
  }

  async onModuleInit(): Promise<void> {
    this.logger.log('Prisma client initialized lazily');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }
}
