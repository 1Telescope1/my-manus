import { Module } from '@nestjs/common';
import { AppConfigService } from './application/services/app-config.service';
import { StatusService } from './application/services/status.service';
import { CoreConfigModule } from './core/config/core-config.module';
import { AppConfigController } from './interfaces/controllers/app-config.controller';
import { StatusController } from './interfaces/controllers/status.controller';
import { FileAppConfigRepository } from './infrastructure/repositories/file-app-config.repository';
import { PrismaService } from './infrastructure/prisma/prisma.service';
import { RedisClient } from './infrastructure/storage/redis.client';
import { CosClient } from './infrastructure/storage/cos.client';
import { repositoryProviders } from './interfaces/repository-dependencies';

@Module({
  imports: [CoreConfigModule],
  controllers: [StatusController, AppConfigController],
  providers: [
    PrismaService,
    RedisClient,
    CosClient,
    FileAppConfigRepository,
    ...repositoryProviders,
    StatusService,
    AppConfigService,
  ],
})
export class AppModule {}
