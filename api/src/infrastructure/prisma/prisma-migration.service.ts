import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { SettingsService } from '../../core/config/settings';

const execFileAsync = promisify(execFile);

/** 在数据库连接初始化前同步 Prisma 数据结构。 */
@Injectable()
export class PrismaMigrationService {
  private readonly logger = new Logger(PrismaMigrationService.name);
  private migrated = false;

  constructor(private readonly settings: SettingsService) {}

  async migrate(): Promise<void> {
    if (this.migrated) {
      return;
    }

    // 1. 使用当前项目安装的 Prisma CLI，避免依赖全局 npx 环境。
    const prismaCli = resolve(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js');

    // 2. 同步 schema，但不生成客户端，也不自动接受数据丢失。
    try {
      const result = await execFileAsync(
        process.execPath,
        [prismaCli, 'db', 'push', '--skip-generate'],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            DATABASE_URL: this.settings.databaseUrl,
          },
          windowsHide: true,
        },
      );

      if (result.stdout.trim()) {
        this.logger.log(result.stdout.trim());
      }
      this.migrated = true;
    } catch (error) {
      this.logger.error(`运行数据库迁移失败: ${migrationErrorMessage(error)}`);
      throw error;
    }
  }
}

function migrationErrorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === 'string' && stderr.trim()) {
      return stderr.trim();
    }
  }
  return error instanceof Error ? error.message : String(error);
}
