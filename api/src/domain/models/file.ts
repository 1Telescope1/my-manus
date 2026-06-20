import { randomUUID } from 'node:crypto';

export type FileModel = {
  id: string;
  filename: string;
  filepath: string;
  key: string;
  extension: string;
  mime_type: string;
  size: number;
};

export function createFileModel(input: Partial<FileModel> = {}): FileModel {
  return {
    id: input.id ?? randomUUID(),
    filename: input.filename ?? '',
    filepath: input.filepath ?? '',
    key: input.key ?? '',
    extension: input.extension ?? '',
    mime_type: input.mime_type ?? '',
    size: input.size ?? 0,
  };
}
