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

  constructor(private readonly settings: SettingsService) {
    this.configPath = resolve(process.cwd(), settings.appConfigFilepath);
  }

  async load(): Promise<AppConfig> {
    await this.createDefaultAppConfigIfNotExists();

    try {
      const raw = await readFile(this.configPath, 'utf8');
      const parsed = raw.trim() ? YAML.parse(raw) : createDefaultAppConfig();
      const config = AppConfigSchema.parse(parsed);
      config.llm_config = {
        ...config.llm_config,
        ...(this.settings.llmBaseUrl ? { base_url: this.settings.llmBaseUrl } : {}),
        ...(this.settings.llmApiKey ? { api_key: this.settings.llmApiKey } : {}),
        ...(this.settings.llmModelName ? { model_name: this.settings.llmModelName } : {}),
        temperature: this.settings.llmTemperature,
        max_tokens: this.settings.llmMaxTokens,
      };
      return AppConfigSchema.parse(config);
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
