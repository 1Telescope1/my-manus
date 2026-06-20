import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createClient, RedisClientType } from 'redis';
import { SettingsService } from '../../core/config/settings';

@Injectable()
export class RedisClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisClient.name);
  private redisClient?: RedisClientType;
  private initError?: Error;

  constructor(private readonly settings: SettingsService) {}

  async onModuleInit(): Promise<void> {
    await this.init();
  }

  async init(): Promise<void> {
    if (this.redisClient?.isOpen) {
      this.logger.warn('Redis client already exists');
      return;
    }

    const database = this.settings.redisDb;
    const password = this.settings.redisPassword;
    const url = `redis://${this.settings.redisHost}:${this.settings.redisPort}`;

    this.redisClient = createClient({
      url,
      database,
      password,
    }) as RedisClientType;

    this.redisClient.on('error', (error) => {
      this.initError = error instanceof Error ? error : new Error(String(error));
      this.logger.error(`Redis client error: ${this.initError.message}`);
    });

    try {
      await this.redisClient.connect();
      await this.redisClient.ping();
      this.initError = undefined;
      this.logger.log('Redis client initialized');
    } catch (error) {
      this.initError = error instanceof Error ? error : new Error(String(error));
      this.logger.error(`Failed to initialize Redis client: ${this.initError.message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.shutdown();
  }

  async shutdown(): Promise<void> {
    if (this.redisClient?.isOpen) {
      await this.redisClient.quit();
      this.logger.log('Redis client closed');
    }
    this.redisClient = undefined;
  }

  get client(): RedisClientType {
    if (!this.redisClient || !this.redisClient.isOpen) {
      throw this.initError ?? new Error('Redis客户端未初始化，获取客户端失败');
    }
    return this.redisClient;
  }

  async ping(): Promise<boolean> {
    if (!this.redisClient || !this.redisClient.isOpen) {
      throw this.initError ?? new Error('Redis客户端未初始化，获取客户端失败');
    }
    return (await this.redisClient.ping()) === 'PONG';
  }
}
