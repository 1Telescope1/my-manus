import { Module } from '@nestjs/common';
import { FileController } from './interfaces/controllers/file.controller';
import { ShellController } from './interfaces/controllers/shell.controller';
import { SupervisorController } from './interfaces/controllers/supervisor.controller';

/** 聚合 sandbox 当前已有的三个 Python router。 */
@Module({
  controllers: [FileController, ShellController, SupervisorController],
})
export class AppModule {}
