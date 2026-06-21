import 'reflect-metadata';
import { createServer } from 'node:net';
import { Logger, type LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { getSettings } from './core/config/settings';

function getNestLoggerLevels(logLevel: string): LogLevel[] | false {
  switch (logLevel.toUpperCase()) {
    case 'DEBUG':
      return ['error', 'warn', 'log', 'debug', 'verbose'];
    case 'INFO':
      return ['error', 'warn', 'log'];
    case 'WARNING':
    case 'WARN':
      return ['error', 'warn'];
    case 'ERROR':
      return ['error'];
    case 'OFF':
    case 'NONE':
      return false;
    default:
      return ['error', 'warn', 'log'];
  }
}

function isPortInUse(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'EADDRINUSE';
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

    // 预检查 127.0.0.1，避免 Windows 下 0.0.0.0 与 localhost 判断不一致。
    server.listen(port, '127.0.0.1');
  });
}

async function resolveAvailablePort(startPort: number): Promise<number> {
  let port = startPort;

  while (!(await isLocalhostPortAvailable(port))) {
    Logger.warn(`端口 ${port} 已被占用，尝试 ${port + 1}。`);
    port += 1;
  }

  return port;
}

function setupOpenApi(app: Awaited<ReturnType<typeof NestFactory.create>>): void {
  const config = new DocumentBuilder()
    .setTitle('MoocManus 沙箱系统')
    .setDescription('该沙箱系统中预装了 Chrome、Python、Node.js，支持运行 Shell 命令、文件管理等功能')
    .setVersion('1.0.0')
    .addTag('文件模块', '包含文件增删改查等 API 接口，用于实现对沙箱文件的操作。')
    .addTag('Shell模块', '包含执行/查看 Shell 等 API 接口，用于实现操控沙箱内部的 Shell 命令。')
    .addTag('Supervisor模块', '使用接口和 Supervisor 实现管理沙箱系统的程序逻辑。')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);
}

async function bootstrap(): Promise<void> {
  const settings = getSettings();
  const app = await NestFactory.create(AppModule, {
    logger: getNestLoggerLevels(settings.logLevel),
  });

  Logger.log('MoocManus 沙箱正在初始化');

  app.enableCors({
    origin: '*',
    credentials: true,
    methods: '*',
    allowedHeaders: '*',
  });
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  setupOpenApi(app);

  const port = await resolveAvailablePort(settings.port);

  await app.listen(port);
  Logger.log(`MoocManus TS Sandbox listening on http://localhost:${port}/api`);
  Logger.log(`MoocManus TS Sandbox docs available at http://localhost:${port}/docs`);
}

void bootstrap().finally(() => {
  process.once('beforeExit', () => {
    Logger.log('MoocManus 沙箱关闭成功');
  });
});
