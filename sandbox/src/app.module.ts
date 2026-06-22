import { Module } from '@nestjs/common';
import { FileController } from './interfaces/controllers/file.controller';
import { ShellController } from './interfaces/controllers/shell.controller';
import { SupervisorController } from './interfaces/controllers/supervisor.controller';
import { FileService } from './services/file.service';
import { ShellService } from './services/shell.service';

/** 聚合 sandbox 当前已有的 router，并注册服务单例。 */
@Module({
  controllers: [FileController, ShellController, SupervisorController],
  providers: [FileService, ShellService],
})
export class AppModule {}
