import { config as loadEnv } from 'dotenv';

loadEnv();

const DEFAULT_PORT = 8001;

function optionalNumber(value: string | undefined, fallback: number): number {
  if (!value || !value.trim()) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalString(value: string | undefined, fallback: string): string {
  return value && value.trim() ? value : fallback;
}

export type SandboxSettings = {
  logLevel: string;
  serverTimeoutMinutes: number;
  port: number;
};

let cachedSettings: SandboxSettings | null = null;

/** 读取 sandbox 运行配置，对齐 Python `Settings` 和 `.env` 行为。 */
export function getSettings(): SandboxSettings {
  if (cachedSettings) {
    return cachedSettings;
  }

  cachedSettings = {
    logLevel: optionalString(process.env.LOG_LEVEL ?? process.env.log_level, 'INFO'),
    serverTimeoutMinutes: optionalNumber(
      process.env.SERVER_TIMEOUT_MINUTES ?? process.env.server_timeout_minutes,
      60,
    ),
    port: optionalNumber(process.env.PORT, DEFAULT_PORT),
  };

  return cachedSettings;
}
