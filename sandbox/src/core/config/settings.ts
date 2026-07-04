import { config as loadEnv } from 'dotenv';

loadEnv();

const DEFAULT_PORT = 8080;

function optionalNumber(value: string | undefined, fallback: number): number {
  // 未配置或配置为空时使用默认值，避免 Number('') 被解析成 0。
  if (!value || !value.trim()) {
    return fallback;
  }

  // 非法数字同样回退默认值，保证服务可以按保守配置启动。
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalString(value: string | undefined, fallback: string): string {
  // 字符串配置只接受非空内容，空字符串按未配置处理。
  return value && value.trim() ? value : fallback;
}

export type SandboxSettings = {
  logLevel: string;
  serverTimeoutMinutes: number;
  port: number;
};

let cachedSettings: SandboxSettings | null = null;

/** 读取 sandbox 运行配置和 `.env` 行为。 */
export function getSettings(): SandboxSettings {
  // 配置在进程生命周期内保持稳定，读取一次后缓存即可。
  if (cachedSettings) {
    return cachedSettings;
  }

  cachedSettings = {
    // 兼容大小写两种环境变量命名，方便容器和本地运行共用配置。
    logLevel: optionalString(process.env.LOG_LEVEL ?? process.env.log_level, 'INFO'),
    serverTimeoutMinutes: optionalNumber(
      process.env.SERVER_TIMEOUT_MINUTES ?? process.env.server_timeout_minutes,
      60,
    ),
    // PORT 不存在时默认使用 8080，启动层会负责处理端口占用。
    port: optionalNumber(process.env.PORT, DEFAULT_PORT),
  };

  return cachedSettings;
}
