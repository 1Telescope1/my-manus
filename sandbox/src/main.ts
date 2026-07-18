import 'reflect-metadata';
import { Logger, type INestApplication, type LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { getSettings } from './core/config/settings';
import { GlobalExceptionFilter } from './interfaces/errors/exception-handler';

function getNestLoggerLevels(logLevel: string): LogLevel[] | false {
  // 将环境变量中的日志级别映射成 Nest 支持的日志通道列表。
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
  // Node 在端口被占用时会抛出带 EADDRINUSE code 的系统异常。
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'EADDRINUSE';
}

async function listenOnAvailablePort(app: INestApplication, startPort: number): Promise<number> {
  // 从配置端口开始监听，如果被占用则不断尝试下一个端口。
  let port = startPort;

  while (true) {
    try {
      await app.listen(port);
      return port;
    } catch (error) {
      if (!isPortInUse(error)) {
        // 非端口占用错误不做兜底，直接向上抛出，避免掩盖启动问题。
        throw error;
      }

      Logger.warn(`端口 ${port} 已被占用，尝试 ${port + 1}。`);
      port += 1;
    }
  }
}

function setupOpenApi(app: INestApplication): void {
  // OpenAPI 文档只描述当前沙箱暴露的 HTTP 接口，不参与业务逻辑。
  const config = new DocumentBuilder()
    .setTitle('Manus 沙箱系统')
    .setDescription('该沙箱系统预装了常用运行环境，支持运行 Shell 命令、文件管理等功能')
    .setVersion('1.0.0')
    .addTag('文件模块', '包含文件增删改查等 API 接口，用于实现对沙箱文件的操作。')
    .addTag('Shell模块', '包含执行/查看 Shell 等 API 接口，用于实现操控沙箱内部的 Shell 命令。')
    .addTag('Supervisor模块', '使用接口和 Supervisor 实现管理沙箱系统的程序逻辑。')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);
}

async function bootstrap(): Promise<void> {
  // 启动时统一读取配置，并按配置控制 Nest 控制台日志级别。
  const settings = getSettings();
  const app = await NestFactory.create(AppModule, {
    logger: getNestLoggerLevels(settings.logLevel),
  });

  Logger.log('Manus 沙箱正在初始化');

  // 沙箱服务通常会被外部 API 或调试工具直接访问，因此默认放开 CORS。
  app.enableCors({
    origin: '*',
    credentials: true,
    methods: '*',
    allowedHeaders: '*',
  });
  // 所有接口统一挂载到 /api 下，和调用侧约定保持一致。
  app.setGlobalPrefix('api');
  // 统一异常响应结构，保证业务异常和未知异常都返回 code/msg/data。
  app.useGlobalFilters(new GlobalExceptionFilter());
  // 开启 Nest 关闭钩子，便于容器或进程退出时释放资源。
  app.enableShutdownHooks();
  setupOpenApi(app);

  // 监听配置端口；如果端口已被占用，则自动使用后续可用端口。
  const port = await listenOnAvailablePort(app, settings.port);
  Logger.log(`Manus TS Sandbox listening on http://localhost:${port}/api`);
  Logger.log(`Manus TS Sandbox docs available at http://localhost:${port}/docs`);
}

void bootstrap().finally(() => {
  process.once('beforeExit', () => {
    Logger.log('Manus 沙箱关闭成功');
  });
});
