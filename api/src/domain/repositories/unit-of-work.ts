import { AgentRunRepository } from './agent-run.repository';
import { ConversationMemoryRepository } from './conversation-memory.repository';
import { FileRepository } from './file.repository';
import { SessionRepository } from './session.repository';

/** 聚合一次业务操作所需仓储，并定义统一事务执行边界。 */
export abstract class UnitOfWork {
  /** 访问运行聚合仓储。 */
  abstract readonly agentRun: AgentRunRepository;
  /** 访问 Session 级模型语义历史仓储。 */
  abstract readonly conversationMemory: ConversationMemoryRepository;
  /** 访问文件仓储。 */
  abstract readonly file: FileRepository;
  /** 访问会话仓储。 */
  abstract readonly session: SessionRepository;
  /** 在同一个事务上下文中执行回调，失败时整体回滚。 */
  abstract run<T>(fn: (uow: UnitOfWork) => Promise<T>): Promise<T>;
}
