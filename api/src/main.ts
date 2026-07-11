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
  // 1. 日志打印代码已经开始执行。
  Logger.log('MoocManus正在初始化');

  // 2. 创建应用后，各基础设施 provider 会依次完成数据库迁移和客户端初始化。
  const app = await NestFactory.create(AppModule);
  const settings = app.get(SettingsService);

  // 3. 配置 CORS 中间件。
  app.enableCors({
    origin: true,
    credentials: true,
    methods: '*',
    allowedHeaders: '*',
  });

  // 4. 集成 API 路由、数据校验和统一异常过滤。
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

  // 5. 从配置端口开始寻找可用端口并启动应用。
  const port = await listenOnAvailablePort(app, settings.port);
  Logger.log(`MoocManus TS API listening on http://localhost:${port}/api`);
}

void bootstrap();
