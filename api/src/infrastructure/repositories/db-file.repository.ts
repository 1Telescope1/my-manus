import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { FileModel } from '../../domain/models/file';
import { FileRepository } from '../../domain/repositories/file.repository';
import { PrismaService } from '../prisma/prisma.service';
import {
  fileToPersistence,
  fileUpdateToPersistence,
  persistenceToFile,
  type FilePersistenceRecord,
} from '../prisma/file.mapper';

type FileDelegate = {
  findUnique(args: Record<string, unknown>): Promise<FilePersistenceRecord | null>;
  create(args: Record<string, unknown>): Promise<unknown>;
  update(args: Record<string, unknown>): Promise<unknown>;
};

@Injectable()
export class DbFileRepository extends FileRepository {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService | Prisma.TransactionClient,
  ) {
    super();
  }

  private get fileClient(): FileDelegate {
    return (this.prisma as unknown as { file: FileDelegate }).file;
  }

  /** 根据传入的领域模型更新或者新增文件记录。 */
  async save(file: FileModel): Promise<void> {
    // 1. 根据 id 查询文件是否存在。
    const record = await this.fileClient.findUnique({
      where: { id: file.id },
    });

    // 2. 文件不存在则新建记录。
    if (!record) {
      await this.fileClient.create({
        data: fileToPersistence(file),
      });
      return;
    }

    // 3. 文件存在则更新记录。
    await this.fileClient.update({
      where: { id: file.id },
      data: fileUpdateToPersistence(file),
    });
  }

  /** 根据 id 查询文件记录。 */
  async getById(fileId: string): Promise<FileModel | null> {
    // 1. 根据 id 查询文件是否存在。
    const record = await this.fileClient.findUnique({
      where: { id: fileId },
    });

    // 2. 判断文件记录是否存在并返回。
    return record ? persistenceToFile(record) : null;
  }
}
