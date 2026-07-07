import { FileModel, createFileModel } from '../../domain/models/file';

export type FilePersistenceRecord = {
  id: string;
  filename: string;
  filepath: string;
  key: string;
  extension: string;
  mimeType: string;
  size: number;
  updatedAt: Date;
  createdAt: Date;
};

export type FilePersistenceInput = {
  id: string;
  filename: string;
  filepath: string;
  key: string;
  extension: string;
  mimeType: string;
  size: number;
};

export function fileToPersistence(file: FileModel): FilePersistenceInput {
  return {
    // 1. 基础字段直接从领域模型写入。
    id: file.id,
    filename: file.filename,
    filepath: file.filepath,
    key: file.key,
    extension: file.extension,
    mimeType: file.mime_type,
    size: file.size,
  };
}

export function persistenceToFile(record: FilePersistenceRecord): FileModel {
  return createFileModel({
    id: record.id,
    filename: record.filename,
    filepath: record.filepath,
    key: record.key,
    extension: record.extension,
    mime_type: record.mimeType,
    size: record.size,
  });
}

export function fileUpdateToPersistence(file: FileModel): FilePersistenceInput {
  return fileToPersistence(file);
}
