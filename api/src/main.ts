import 'reflect-metadata';
import { createServer } from 'node:net';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { SettingsService } from './core/config/settings';
import { GlobalExceptionFilter } from './interfaces/filters/global-exception.filter';

const DEFAULT_PORT = 8000;
const FALLBACK_PORT = 8001;

function isPortInUse(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'EADDRINUSE';
}

function warnPortFallback(): void {
  Logger.warn(`Port ${DEFAULT_PORT} is already in use, trying ${FALLBACK_PORT} instead.`);
}

async function isLocalhostPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.once('error', (error) => {
      if (isPortInUse(error)) {
        resolve(false);
        return;
      }
      reject(error);
    });

    server.once('listening', () => {
      server.close(() => resolve(true));
    });

    server.listen(port, '127.0.0.1');
  });
}

async function listenWithFallback(app: INestApplication, port: number): Promise<number> {
  if (port === DEFAULT_PORT && !(await isLocalhostPortAvailable(DEFAULT_PORT))) {
    warnPortFallback();
    await app.listen(FALLBACK_PORT);
    return FALLBACK_PORT;
  }

  try {
    await app.listen(port);
    return port;
  } catch (error) {
    if (port !== DEFAULT_PORT || !isPortInUse(error)) {
      throw error;
    }

    warnPortFallback();
    await app.listen(FALLBACK_PORT);
    return FALLBACK_PORT;
  }
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const settings = app.get(SettingsService);

  app.enableCors({
    origin: true,
    credentials: true,
    methods: '*',
    allowedHeaders: '*',
  });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: false,
      forbidUnknownValues: false,
    }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.enableShutdownHooks();

  const port = await listenWithFallback(app, settings.port);
  Logger.log(`MoocManus TS API listening on http://localhost:${port}/api`);
}

void bootstrap();
