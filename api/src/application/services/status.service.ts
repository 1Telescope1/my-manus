import { Injectable, Logger } from '@nestjs/common';
import { HealthStatus } from '../../domain/models/health-status';
import { PostgresHealthChecker } from '../../infrastructure/external/health-checker/postgres-health.checker';
import { RedisHealthChecker } from '../../infrastructure/external/health-checker/redis-health.checker';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RedisClient } from '../../infrastructure/storage/redis.client';

@Injectable()
export class StatusService {
  private readonly logger = new Logger(StatusService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisClient,
  ) {}

  async checkAll(): Promise<HealthStatus[]> {
    const checkers = [
      new PostgresHealthChecker(this.prisma),
      new RedisHealthChecker(this.redis),
    ];

    const results = await Promise.allSettled(checkers.map((checker) => checker.check()));

    return results.map((result) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      const error = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
      this.logger.error(`未知检查器发生错误: ${error.message}`);
      return {
        service: '未知服务',
        status: 'error',
        details: `未知检查器发生错误: ${error.message}`,
      };
    });
  }
}
