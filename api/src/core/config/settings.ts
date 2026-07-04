import { Injectable } from '@nestjs/common';

function optionalNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalString(value: string | undefined): string | undefined {
  return value && value.trim() ? value : undefined;
}

function normalizeDatabaseUrl(value: string | undefined): string {
  const fallback = 'postgresql://postgres:postgres@localhost:5432/manus';
  if (!value || !value.trim()) {
    return fallback;
  }
  return value.replace(/^postgresql\+asyncpg:\/\//, 'postgresql://');
}

@Injectable()
export class SettingsService {
  readonly env = process.env.NODE_ENV ?? process.env.ENV ?? 'development';
  readonly logLevel = process.env.LOG_LEVEL ?? 'INFO';
  readonly port = optionalNumber(process.env.PORT, 8000);
  readonly appConfigFilepath = process.env.APP_CONFIG_FILEPATH ?? 'config.yaml';

  readonly databaseUrl = normalizeDatabaseUrl(
    process.env.DATABASE_URL ?? process.env.SQLALCHEMY_DATABASE_URI,
  );
  readonly sqlalchemyDatabaseUri =
    process.env.SQLALCHEMY_DATABASE_URI ?? 'postgresql+asyncpg://postgres:postgres@localhost:5432/manus';

  readonly redisHost = process.env.REDIS_HOST ?? 'localhost';
  readonly redisPort = optionalNumber(process.env.REDIS_PORT, 6379);
  readonly redisDb = optionalNumber(process.env.REDIS_DB, 0);
  readonly redisPassword = optionalString(process.env.REDIS_PASSWORD);

  readonly cosSecretId = process.env.COS_SECRET_ID ?? '';
  readonly cosSecretKey = process.env.COS_SECRET_KEY ?? '';
  readonly cosRegion = process.env.COS_REGION ?? '';
  readonly cosScheme = process.env.COS_SCHEME ?? 'https';
  readonly cosBucket = process.env.COS_BUCKET ?? '';
  readonly cosDomain = process.env.COS_DOMAIN ?? '';

  readonly sandboxAddress = optionalString(process.env.SANDBOX_ADDRESS);
  readonly sandboxImage = optionalString(process.env.SANDBOX_IMAGE);
  readonly sandboxNamePrefix = optionalString(process.env.SANDBOX_NAME_PREFIX);
  readonly sandboxTtlMinutes = optionalNumber(process.env.SANDBOX_TTL_MINUTES, 60);
  readonly sandboxNetwork = optionalString(process.env.SANDBOX_NETWORK);
  readonly sandboxChromeArgs = process.env.SANDBOX_CHROME_ARGS ?? '';
  readonly sandboxHttpsProxy = optionalString(process.env.SANDBOX_HTTPS_PROXY);
  readonly sandboxHttpProxy = optionalString(process.env.SANDBOX_HTTP_PROXY);
  readonly sandboxNoProxy = optionalString(process.env.SANDBOX_NO_PROXY);
}
