import { Injectable } from '@nestjs/common';
import {
  FileStorage,
  FileStorageData,
  UploadedFilePayload,
} from '../../domain/external/file-storage';
import { FileModel } from '../../domain/models/file';
import { UnitOfWork } from '../../domain/repositories/unit-of-work';
import { NotFoundError } from '../../core/errors/app-exception';

@Injectable()
export class FileService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly fileStorage: FileStorage,
  ) {}

  /** 上传文件，并返回文件元信息。 */
  async uploadFile(uploadFile: UploadedFilePayload): Promise<FileModel> {
    return this.fileStorage.uploadFile(uploadFile);
  }

  /** 根据文件 id 获取文件元信息。 */
  async getFileInfo(fileId: string): Promise<FileModel> {
    return this.uow.run(async (active) => {
      // 1. 查询文件记录。
      const file = await active.file.getById(fileId);

      // 2. 文件不存在时抛出业务错误。
      if (!file) {
        throw new NotFoundError(`该文件[${fileId}]不存在`);
      }

      // 3. 返回文件元信息。
      return file;
    });
  }

  /** 根据文件 id 下载文件内容。 */
  async downloadFile(fileId: string): Promise<[FileStorageData, FileModel]> {
    return this.fileStorage.downloadFile(fileId);
  }
}
