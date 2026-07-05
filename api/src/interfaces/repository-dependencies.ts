import { Logger, type Provider } from '@nestjs/common';
import { SessionRepository } from '../domain/repositories/session.repository';
import { DbSessionRepository } from '../infrastructure/repositories/db-session.repository';

const logger = new Logger('RepositoryDependencies');

logger.log('加载获取DBSessionRepository');

export const repositoryProviders: Provider[] = [
  DbSessionRepository,
  {
    provide: SessionRepository,
    useExisting: DbSessionRepository,
  },
];
