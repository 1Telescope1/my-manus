import { Module } from '@nestjs/common';
import { AppConfigService } from './application/services/app-config.service';
import { AppLifecycleService } from './application/services/app-lifecycle.service';
import { FileService } from './application/services/file.service';
import { AgentService } from './application/services/agent.service';
import { SessionService } from './application/services/session.service';
import { StatusService } from './application/services/status.service';
import { CoreConfigModule } from './core/config/core-config.module';
import { FileStorage } from './domain/external/file-storage';
import { JSONParser } from './domain/external/json-parser';
import { SearchEngine } from './domain/external/search-engine';
import { LLMFactory } from './domain/external/llm';
import { SandboxManager } from './domain/external/sandbox';
import { TaskManager } from './domain/external/task';
import { AppConfigController } from './interfaces/controllers/app-config.controller';
import { FileController } from './interfaces/controllers/file.controller';
import { SessionController } from './interfaces/controllers/session.controller';
import { StatusController } from './interfaces/controllers/status.controller';
import { FileAppConfigRepository } from './infrastructure/repositories/file-app-config.repository';
import { PrismaService } from './infrastructure/prisma/prisma.service';
import { RedisClient } from './infrastructure/storage/redis.client';
import { CosClient } from './infrastructure/storage/cos.client';
import { repositoryProviders } from './interfaces/repository-dependencies';
import { CosFileStorage } from './infrastructure/external/file-storage/cos-file-storage';
import { RepairJSONParser } from './infrastructure/external/json-parser/repair-json.parser';
import { BingSearchEngine } from './infrastructure/external/search/bing-search.engine';
import { SessionVncGateway } from './interfaces/gateways/session-vnc.gateway';
import { OpenAILLMFactory } from './infrastructure/external/llm/openai-llm.factory';
import { DockerSandboxManager } from './infrastructure/external/sandbox/docker-sandbox.manager';
import { RedisStreamTaskManager } from './infrastructure/external/task/redis-stream-task.manager';

@Module({
  imports: [CoreConfigModule],
  controllers: [StatusController, AppConfigController, FileController, SessionController],
  providers: [
    PrismaService,
    RedisClient,
    CosClient,
    FileAppConfigRepository,
    CosFileStorage,
    RepairJSONParser,
    BingSearchEngine,
    OpenAILLMFactory,
    DockerSandboxManager,
    RedisStreamTaskManager,
    {
      provide: FileStorage,
      useExisting: CosFileStorage,
    },
    {
      provide: JSONParser,
      useExisting: RepairJSONParser,
    },
    {
      provide: SearchEngine,
      useExisting: BingSearchEngine,
    },
    {
      provide: LLMFactory,
      useExisting: OpenAILLMFactory,
    },
    {
      provide: SandboxManager,
      useExisting: DockerSandboxManager,
    },
    {
      provide: TaskManager,
      useExisting: RedisStreamTaskManager,
    },
    ...repositoryProviders,
    StatusService,
    AppConfigService,
    FileService,
    SessionService,
    AgentService,
    SessionVncGateway,
    AppLifecycleService,
  ],
})
export class AppModule {}
