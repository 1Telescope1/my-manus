import { Logger } from '@nestjs/common';
import { HealthChecker } from '../../../domain/external/health-checker';
import { HealthStatus } from '../../../domain/models/health-status';
import { RedisClient } from '../../storage/redis.client';

export class RedisHealthChecker extends HealthChecker {
  private readonly logger = new Logger(RedisHealthChecker.name);

  constructor(private readonly redis: RedisClient) {
    super();
  }

  async check(): Promise<HealthStatus> {
    try {
      if (await this.redis.ping()) {
        return { service: 'redis', status: 'ok' };
      }
      return { service: 'redis', status: 'error', details: 'Redis服务Ping失败' };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(`Redis健康检查失败: ${err.message}`);
      return { service: 'redis', status: 'error', details: err.message };
    }
  }
}
