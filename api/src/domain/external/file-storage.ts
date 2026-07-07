import { Readable } from 'node:stream';
import { FileModel } from '../models/file';

export type UploadedFilePayload = {
  originalname?: string;
  mimetype?: string;
  size?: number;
  buffer?: Buffer;
  stream?: Readable;
};

export type FileStorageData = Buffer | Readable;

export abstract class FileStorage {
  abstract uploadFile(uploadFile: UploadedFilePayload): Promise<FileModel>;
  abstract downloadFile(fileId: string): Promise<[FileStorageData, FileModel]>;
}
