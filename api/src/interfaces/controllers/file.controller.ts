import { Readable } from 'node:stream';
import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { FileService } from '../../application/services/file.service';
import { UploadedFilePayload } from '../../domain/external/file-storage';
import { ResponseEnvelope } from '../../core/response/api-response';

type HeaderResponse = {
  setHeader(name: string, value: string): void;
};

@Controller('files')
export class FileController {
  constructor(private readonly fileService: FileService) {}

  /** 上传文件到文件存储。 */
  @Post()
  @UseInterceptors(FileInterceptor('file'))
  async uploadFile(@UploadedFile() file?: UploadedFilePayload) {
    if (!file) {
      throw new BadRequestException('上传文件不能为空');
    }

    // 1. 上传文件并获取文件元信息。
    const fileInfo = await this.fileService.uploadFile(file);

    // 2. 返回统一响应。
    return ResponseEnvelope.success(fileInfo, '上传文件成功');
  }

  /** 根据文件 id 获取文件元信息。 */
  @Get(':fileId')
  async getFileInfo(@Param('fileId') fileId: string) {
    // 1. 查询文件元信息。
    const fileInfo = await this.fileService.getFileInfo(fileId);

    // 2. 返回统一响应。
    return ResponseEnvelope.success(fileInfo, '获取文件信息成功');
  }

  /** 根据文件 id 下载文件内容。 */
  @Get(':fileId/download')
  async downloadFile(
    @Param('fileId') fileId: string,
    @Res({ passthrough: true }) response: HeaderResponse,
  ): Promise<StreamableFile> {
    // 1. 下载文件内容和元信息。
    const [fileData, fileInfo] = await this.fileService.downloadFile(fileId);

    // 2. 设置下载响应头。
    const encodedFilename = encodeURIComponent(fileInfo.filename);
    response.setHeader('Content-Disposition', `attachment; filename*=utf-8''${encodedFilename}`);
    response.setHeader('Content-Length', String(fileInfo.size));

    if (fileInfo.mime_type) {
      response.setHeader('Content-Type', fileInfo.mime_type);
    }

    // 3. 返回可流式下载的文件内容。
    if (fileData instanceof Readable) {
      return new StreamableFile(fileData);
    }
    return new StreamableFile(fileData);
  }
}
