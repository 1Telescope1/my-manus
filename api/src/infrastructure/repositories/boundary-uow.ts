import { Injectable } from '@nestjs/common';
import { NotImplementedBoundaryError } from '../../core/errors/not-implemented-boundary.error';
import { BaseEvent } from '../../domain/models/event';
import { FileModel } from '../../domain/models/file';
import { Memory } from '../../domain/models/memory';
import { Session, SessionStatus } from '../../domain/models/session';
import { FileRepository } from '../../domain/repositories/file.repository';
import { SessionRepository } from '../../domain/repositories/session.repository';
import { UnitOfWork } from '../../domain/repositories/unit-of-work';

class BoundaryFileRepository extends FileRepository {
  async save(_file: FileModel): Promise<void> {
    throw new NotImplementedBoundaryError('FileRepository.save');
  }

  async getById(_fileId: string): Promise<FileModel | null> {
    throw new NotImplementedBoundaryError('FileRepository.getById');
  }
}

class BoundarySessionRepository extends SessionRepository {
  async save(_session: Session): Promise<void> {
    throw new NotImplementedBoundaryError('SessionRepository.save');
  }

  async getAll(): Promise<Session[]> {
    throw new NotImplementedBoundaryError('SessionRepository.getAll');
  }

  async getById(_sessionId: string): Promise<Session | null> {
    throw new NotImplementedBoundaryError('SessionRepository.getById');
  }

  async deleteById(_sessionId: string): Promise<void> {
    throw new NotImplementedBoundaryError('SessionRepository.deleteById');
  }

  async updateTitle(_sessionId: string, _title: string): Promise<void> {
    throw new NotImplementedBoundaryError('SessionRepository.updateTitle');
  }

  async updateLatestMessage(_sessionId: string, _message: string, _timestamp: Date): Promise<void> {
    throw new NotImplementedBoundaryError('SessionRepository.updateLatestMessage');
  }

  async updateUnreadMessageCount(_sessionId: string, _count: number): Promise<void> {
    throw new NotImplementedBoundaryError('SessionRepository.updateUnreadMessageCount');
  }

  async incrementUnreadMessageCount(_sessionId: string): Promise<void> {
    throw new NotImplementedBoundaryError('SessionRepository.incrementUnreadMessageCount');
  }

  async decrementUnreadMessageCount(_sessionId: string): Promise<void> {
    throw new NotImplementedBoundaryError('SessionRepository.decrementUnreadMessageCount');
  }

  async updateStatus(_sessionId: string, _status: SessionStatus): Promise<void> {
    throw new NotImplementedBoundaryError('SessionRepository.updateStatus');
  }

  async addEvent(_sessionId: string, _event: BaseEvent): Promise<void> {
    throw new NotImplementedBoundaryError('SessionRepository.addEvent');
  }

  async addFile(_sessionId: string, _file: FileModel): Promise<void> {
    throw new NotImplementedBoundaryError('SessionRepository.addFile');
  }

  async removeFile(_sessionId: string, _fileId: string): Promise<void> {
    throw new NotImplementedBoundaryError('SessionRepository.removeFile');
  }

  async getFileByPath(_sessionId: string, _filepath: string): Promise<FileModel | null> {
    throw new NotImplementedBoundaryError('SessionRepository.getFileByPath');
  }

  async saveMemory(_sessionId: string, _agentName: string, _memory: Memory): Promise<void> {
    throw new NotImplementedBoundaryError('SessionRepository.saveMemory');
  }

  async getMemory(_sessionId: string, _agentName: string): Promise<Memory> {
    throw new NotImplementedBoundaryError('SessionRepository.getMemory');
  }
}

@Injectable()
export class BoundaryUnitOfWork extends UnitOfWork {
  readonly file = new BoundaryFileRepository();
  readonly session = new BoundarySessionRepository();

  async commit(): Promise<void> {}

  async rollback(): Promise<void> {}

  async run<T>(fn: (uow: UnitOfWork) => Promise<T>): Promise<T> {
    try {
      const result = await fn(this);
      await this.commit();
      return result;
    } catch (error) {
      await this.rollback();
      throw error;
    }
  }
}
