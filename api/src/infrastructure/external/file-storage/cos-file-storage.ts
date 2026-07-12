import { extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { Injectable } from '@nestjs/common';
import { BadRequestError } from '../../../core/errors/app-exception';
import {
  FileStorage,
  FileStorageData,
  UploadedFilePayload,
} from '../../../domain/external/file-storage';
import { createFileModel, FileModel } from '../../../domain/models/file';
import { UnitOfWork } from '../../../domain/repositories/unit-of-work';
import { SettingsService } from '../../../core/config/settings';
import { CosClient } from '../../storage/cos.client';

type CosResponse = {
  Body?: Buffer | string | Readable;
};

@Injectable()
export class CosFileStorage extends FileStorage {
  constructor(
    private readonly settings: SettingsService,
    private readonly cos: CosClient,
    private readonly uow: UnitOfWork,
  ) {
    super();
  }

  /** 上传文件到对象存储，并保存文件元信息。 */
  async uploadFile(uploadFile: UploadedFilePayload): Promise<FileModel> {
    if (!uploadFile.buffer) {
      throw new BadRequestError('上传文件内容为空，请核实后重试');
    }

    // 1. 生成文件 id、扩展名和对象存储 key。
    const fileId = randomUUID();
    const filename = uploadFile.originalname ?? '';
    const extension = extname(filename);
    const datePath = this.currentDatePath();
    const key = `${datePath}/${fileId}${extension}`;

    // 2. 上传原始文件内容到对象存储。
    await this.putObject({
      Bucket: this.settings.cosBucket,
      Region: this.settings.cosRegion,
      Body: uploadFile.buffer,
      Key: key,
    });

    // 3. 构建文件领域模型并保存元信息。
    const file = createFileModel({
      id: fileId,
      filename,
      key,
      extension,
      mime_type: uploadFile.mimetype ?? '',
      size: uploadFile.size ?? uploadFile.buffer.length,
    });
    await this.uow.run(async (active) => {
      await active.file.save(file);
    });

    // 4. 返回文件元信息。
    return file;
  }

  /** 根据文件 id 从对象存储下载文件。 */
  async downloadFile(fileId: string): Promise<[FileStorageData, FileModel]> {
    // 1. 查询文件元信息。
    const file = await this.uow.run(async (active) => active.file.getById(fileId));
    if (!file) {
      throw new Error(`该文件不存在, 文件id: ${fileId}`);
    }

    // 2. 通过对象存储 key 下载文件内容。
    const response = await this.getObject({
      Bucket: this.settings.cosBucket,
      Region: this.settings.cosRegion,
      Key: file.key,
    });

    // 3. 标准化对象存储返回内容。
    const body = this.normalizeBody(response.Body);
    return [body, file];
  }

  private currentDatePath(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}/${month}/${day}`;
  }

  private putObject(params: Record<string, unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
      (this.cos.client as any).putObject(params, (error: unknown) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private getObject(params: Record<string, unknown>): Promise<CosResponse> {
    return new Promise((resolve, reject) => {
      (this.cos.client as any).getObject(params, (error: unknown, data: CosResponse) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(data);
      });
    });
  }

  private normalizeBody(body: CosResponse['Body']): FileStorageData {
    if (Buffer.isBuffer(body) || body instanceof Readable) {
      return body;
    }

    if (typeof body === 'string') {
      return Buffer.from(body);
    }

    throw new Error('对象存储返回的文件内容为空');
  }
}
