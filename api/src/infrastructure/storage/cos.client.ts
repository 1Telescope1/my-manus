import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import COS from 'cos-nodejs-sdk-v5';
import { SettingsService } from '../../core/config/settings';

type CosProtocol = 'http' | 'http:' | 'https' | 'https:';

@Injectable()
export class CosClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CosClient.name);
  private cosClient?: COS;

  constructor(private readonly settings: SettingsService) {}

  async onModuleInit(): Promise<void> {
    await this.init();
  }

  async init(): Promise<void> {
    if (this.cosClient) {
      this.logger.warn('COS client is already initialized');
      return;
    }

    this.cosClient = new COS({
      SecretId: this.settings.cosSecretId,
      SecretKey: this.settings.cosSecretKey,
      Protocol: this.normalizeProtocol(this.settings.cosScheme),
    });
    this.logger.log('COS client initialized');
  }

  async onModuleDestroy(): Promise<void> {
    await this.shutdown();
  }

  async shutdown(): Promise<void> {
    this.cosClient = undefined;
    this.logger.log('COS client closed');
  }

  get client(): COS {
    if (!this.cosClient) {
      throw new Error('腾讯云COS对象存储未初始化，请调用init()完成初始化');
    }
    return this.cosClient;
  }

  private normalizeProtocol(protocol: string): CosProtocol {
    return protocol === 'http' || protocol === 'http:' ? 'http' : 'https';
  }
}
