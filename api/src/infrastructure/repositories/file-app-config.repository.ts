import { Injectable, Logger } from '@nestjs/common';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import YAML from 'yaml';
import { SettingsService } from '../../core/config/settings';
import { ServerRequestsError } from '../../core/errors/app-exception';
import {
  AppConfig,
  AppConfigSchema,
  createDefaultAppConfig,
} from '../../domain/models/app-config';
import { AppConfigRepository } from '../../domain/repositories/app-config.repository';

@Injectable()
export class FileAppConfigRepository implements AppConfigRepository {
  private readonly logger = new Logger(FileAppConfigRepository.name);
  private readonly configPath: string;

  constructor(settings: SettingsService) {
    this.configPath = resolve(process.cwd(), settings.appConfigFilepath);
  }

  async load(): Promise<AppConfig> {
    await this.createDefaultAppConfigIfNotExists();

    try {
      const raw = await readFile(this.configPath, 'utf8');
      const parsed = raw.trim() ? YAML.parse(raw) : createDefaultAppConfig();
      return AppConfigSchema.parse(parsed);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(`读取应用配置失败: ${err.message}`);
      throw new ServerRequestsError('读取应用配置失败，请稍后尝试');
    }
  }

  async save(appConfig: AppConfig): Promise<void> {
    try {
      await mkdir(dirname(this.configPath), { recursive: true });
      const normalized = AppConfigSchema.parse(appConfig);
      const content = YAML.stringify(normalized);
      await writeFile(this.configPath, content, 'utf8');
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(`写入应用配置失败: ${err.message}`);
      throw new ServerRequestsError('写入配置文件失败，请稍后尝试');
    }
  }

  private async createDefaultAppConfigIfNotExists(): Promise<void> {
    try {
      await stat(this.configPath);
    } catch {
      await this.save(createDefaultAppConfig());
    }
  }
}
