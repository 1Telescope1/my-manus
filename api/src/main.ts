import 'reflect-metadata';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { SettingsService } from './core/config/settings';
import { GlobalExceptionFilter } from './interfaces/filters/global-exception.filter';

function isPortInUse(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'EADDRINUSE';
}

async function listenOnAvailablePort(app: INestApplication, startPort: number): Promise<number> {
  let port = startPort;

  while (true) {
    try {
      await app.listen(port);
      return port;
    } catch (error) {
      if (!isPortInUse(error)) {
        throw error;
      }

      Logger.warn(`Port ${port} is already in use, trying ${port + 1} instead.`);
      port += 1;
    }
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

  const port = await listenOnAvailablePort(app, settings.port);
  Logger.log(`MoocManus TS API listening on http://localhost:${port}/api`);
}

void bootstrap();
