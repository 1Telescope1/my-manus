import { Logger } from '@nestjs/common';
import { HealthChecker } from '../../../domain/external/health-checker';
import { HealthStatus } from '../../../domain/models/health-status';
import { PrismaService } from '../../prisma/prisma.service';

export class PostgresHealthChecker extends HealthChecker {
  private readonly logger = new Logger(PostgresHealthChecker.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async check(): Promise<HealthStatus> {
    try {
      await this.prisma.ping();
      return { service: 'postgres', status: 'ok' };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(`Postgres健康检查失败: ${err.message}`);
      return { service: 'postgres', status: 'error', details: err.message };
    }
  }
}
