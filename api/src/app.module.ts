import { Module } from '@nestjs/common';
import { AppConfigService } from './application/services/app-config.service';
import { FileService } from './application/services/file.service';
import { StatusService } from './application/services/status.service';
import { CoreConfigModule } from './core/config/core-config.module';
import { FileStorage } from './domain/external/file-storage';
import { AppConfigController } from './interfaces/controllers/app-config.controller';
import { FileController } from './interfaces/controllers/file.controller';
import { StatusController } from './interfaces/controllers/status.controller';
import { FileAppConfigRepository } from './infrastructure/repositories/file-app-config.repository';
import { PrismaService } from './infrastructure/prisma/prisma.service';
import { RedisClient } from './infrastructure/storage/redis.client';
import { CosClient } from './infrastructure/storage/cos.client';
import { repositoryProviders } from './interfaces/repository-dependencies';
import { CosFileStorage } from './infrastructure/external/file-storage/cos-file-storage';

@Module({
  imports: [CoreConfigModule],
  controllers: [StatusController, AppConfigController, FileController],
  providers: [
    PrismaService,
    RedisClient,
    CosClient,
    FileAppConfigRepository,
    CosFileStorage,
    {
      provide: FileStorage,
      useExisting: CosFileStorage,
    },
    ...repositoryProviders,
    StatusService,
    AppConfigService,
    FileService,
  ],
})
export class AppModule {}
