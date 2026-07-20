import { Logger, type Provider } from '@nestjs/common';
import { AgentRunRepository } from '../domain/repositories/agent-run.repository';
import { ConversationMemoryRepository } from '../domain/repositories/conversation-memory.repository';
import { FileRepository } from '../domain/repositories/file.repository';
import { SessionRepository } from '../domain/repositories/session.repository';
import { UnitOfWork } from '../domain/repositories/unit-of-work';
import { DbFileRepository } from '../infrastructure/repositories/db-file.repository';
import { DbAgentRunRepository } from '../infrastructure/repositories/db-agent-run.repository';
import { DbConversationMemoryRepository } from '../infrastructure/repositories/db-conversation-memory.repository';
import { DbSessionRepository } from '../infrastructure/repositories/db-session.repository';
import { DbUnitOfWork } from '../infrastructure/repositories/db-uow';

const logger = new Logger('RepositoryDependencies');

logger.log('加载获取数据库仓储');

export const repositoryProviders: Provider[] = [
  DbAgentRunRepository,
  DbConversationMemoryRepository,
  DbFileRepository,
  DbSessionRepository,
  DbUnitOfWork,
  {
    provide: AgentRunRepository,
    useExisting: DbAgentRunRepository,
  },
  {
    provide: ConversationMemoryRepository,
    useExisting: DbConversationMemoryRepository,
  },
  {
    provide: FileRepository,
    useExisting: DbFileRepository,
  },
  {
    provide: SessionRepository,
    useExisting: DbSessionRepository,
  },
  {
    provide: UnitOfWork,
    useExisting: DbUnitOfWork,
  },
];
