import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { AgentService } from './agent.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { CosClient } from '../../infrastructure/storage/cos.client';
import { RedisClient } from '../../infrastructure/storage/redis.client';

const AGENT_SHUTDOWN_TIMEOUT_MS = 30_000;

/** 统一协调应用关闭顺序。 */
@Injectable()
export class AppLifecycleService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AppLifecycleService.name);

  constructor(
    private readonly agentService: AgentService,
    private readonly redis: RedisClient,
    private readonly postgres: PrismaService,
    private readonly cos: CosClient,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // 按顺序初始化 Redis、Postgres 和 COS 客户端。
    await this.redis.init();
    await this.postgres.init();
    await this.cos.init();
  }

  async onApplicationShutdown(): Promise<void> {
    try {
      // 1. 等待 Agent 服务关闭，最多等待 30 秒。
      this.logger.log('MoocManus正在关闭');
      await withTimeout(this.agentService.shutdown(), AGENT_SHUTDOWN_TIMEOUT_MS);
      this.logger.log('Agent服务成功关闭');
    } catch (error) {
      if (error instanceof ShutdownTimeoutError) {
        this.logger.warn('Agent服务关闭超时, 强制关闭, 部分任务将被释放');
      } else {
        this.logger.error(`Agent服务关闭期间出现错误: ${errorMessage(error)}`);
      }
    }

    // 2. Agent 任务停止后，再关闭其他应用资源。
    await this.redis.shutdown();
    await this.postgres.shutdown();
    await this.cos.shutdown();
    this.logger.log('Manus应用关闭成功');
  }
}

class ShutdownTimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ShutdownTimeoutError()), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
