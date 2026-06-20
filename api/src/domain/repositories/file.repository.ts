import { FileModel } from '../models/file';

export abstract class FileRepository {
  abstract save(file: FileModel): Promise<void>;
  abstract getById(fileId: string): Promise<FileModel | null>;
}
