import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { AutoExtendTimeoutMiddleware } from './core/middleware';
import { FileController } from './interfaces/controllers/file.controller';
import { ShellController } from './interfaces/controllers/shell.controller';
import { SupervisorController } from './interfaces/controllers/supervisor.controller';
import { FileService } from './services/file.service';
import { ShellService } from './services/shell.service';
import { SupervisorService } from './services/supervisor.service';

/** 聚合 sandbox 当前已有的 router，并注册服务单例。 */
@Module({
  controllers: [FileController, ShellController, SupervisorController],
  providers: [FileService, ShellService, SupervisorService, AutoExtendTimeoutMiddleware],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // 自动保活需要观察所有 API 请求，因此在模块层注册到全部路由。
    consumer.apply(AutoExtendTimeoutMiddleware).forRoutes('*');
  }
}
