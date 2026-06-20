import { FileRepository } from './file.repository';
import { SessionRepository } from './session.repository';

export abstract class UnitOfWork {
  abstract readonly file: FileRepository;
  abstract readonly session: SessionRepository;
  abstract commit(): Promise<void>;
  abstract rollback(): Promise<void>;
  abstract run<T>(fn: (uow: UnitOfWork) => Promise<T>): Promise<T>;
}
