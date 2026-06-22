import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiTags } from '@nestjs/swagger';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { BadRequestException } from '../errors/exceptions';
import { type ApiResponse, ResponseEnvelope } from '../schemas/base';
import {
  FileCheckRequest,
  FileDeleteRequest,
  FileFindRequest,
  FileReadRequest,
  FileReplaceRequest,
  FileSearchRequest,
  FileWriteRequest,
} from '../schemas/file';
import {
  type FileCheckResult,
  type FileDeleteResult,
  type FileFindResult,
  type FileReadResult,
  type FileReplaceResult,
  type FileSearchResult,
  type FileUploadResult,
  type FileWriteResult,
} from '../../models/file';
import { FileService, type UploadedFileData } from '../../services/file.service';

type DownloadResponse = {
  download(path: string, filename?: string): void;
};

@ApiTags('文件模块')
@Controller('file')
export class FileController {
  constructor(private readonly fileService: FileService) {}

  /** 根据传递的数据读取文件内容。 */
  @Post('read-file')
  async readFile(@Body() request: FileReadRequest): Promise<ApiResponse<FileReadResult>> {
    // 1. 调用服务读取文件内容。
    const result = await this.fileService.readFile(
      request.filepath,
      request.start_line,
      request.end_line,
      request.sudo ?? false,
      request.max_length ?? 10000,
    );

    // 2. 使用统一响应结构返回读取结果。
    return ResponseEnvelope.success(result, '文件内容读取成功');
  }

  /** 根据传递的数据向指定文件写入内容。 */
  @Post('write-file')
  async writeFile(@Body() request: FileWriteRequest): Promise<ApiResponse<FileWriteResult>> {
    // 1. 调用服务向目标文件写入内容。
    const result = await this.fileService.writeFile(
      request.filepath,
      request.content,
      request.append ?? false,
      request.leading_newline ?? false,
      request.trailing_newline ?? false,
      request.sudo ?? false,
    );

    // 2. 使用统一响应结构返回写入结果。
    return ResponseEnvelope.success(result, '文件内容写入成功');
  }

  /** 根据传递的数据替换文件内的部分内容。 */
  @Post('replace-in-file')
  async replaceInFile(
    @Body() request: FileReplaceRequest,
  ): Promise<ApiResponse<FileReplaceResult>> {
    // 1. 调用服务替换文件中的指定内容。
    const result = await this.fileService.replaceInFile(
      request.filepath,
      request.old_str,
      request.new_str,
      request.sudo ?? false,
    );

    // 2. 返回替换次数。
    return ResponseEnvelope.success(result, `文件内容替换完成, 已替换${result.replaced_count}处内容`);
  }

  /** 根据传递的数据检索指定文件的内容。 */
  @Post('search-in-file')
  async searchInFile(
    @Body() request: FileSearchRequest,
  ): Promise<ApiResponse<FileSearchResult>> {
    // 1. 调用服务按正则检索文件内容。
    const result = await this.fileService.searchInFile(
      request.filepath,
      request.regex,
      request.sudo ?? false,
    );

    // 2. 返回匹配结果和命中数量。
    return ResponseEnvelope.success(result, `文件内容搜索完成, 找到${result.matches.length}处匹配内容`);
  }

  /** 根据文件夹和 glob 规则查找文件列表。 */
  @Post('find-files')
  async findFiles(@Body() request: FileFindRequest): Promise<ApiResponse<FileFindResult>> {
    // 1. 调用服务根据目录和 glob 规则查找文件。
    const result = await this.fileService.findFiles(request.dir_path, request.glob_pattern);

    // 2. 返回检索到的文件列表和数量。
    return ResponseEnvelope.success(result, `查找完毕, 检索到${result.files.length}个文件`);
  }

  /** 根据文件源和路径上传文件。 */
  @Post('upload-file')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  async uploadFile(
    @UploadedFile() file: UploadedFileData | undefined,
    @Body('filepath') filepath?: string,
  ): Promise<ApiResponse<FileUploadResult>> {
    // 1. 判断是否传递了上传文件。
    if (!file) {
      throw new BadRequestException('上传文件内容为空');
    }

    // 2. 如果没有传递目标路径，则使用系统临时目录作为默认路径。
    const targetPath = filepath || join(tmpdir(), file.originalname || 'upload-file');

    // 3. 调用服务将文件写入目标路径。
    const result = await this.fileService.uploadFile(file, targetPath);

    // 4. 使用统一响应结构返回上传结果。
    return ResponseEnvelope.success(result, '文件上传成功');
  }

  /** 根据 filepath 下载指定文件。 */
  @Get('download-file')
  async downloadFile(
    @Query('filepath') filepath: string,
    @Res() response: DownloadResponse,
  ): Promise<void> {
    // 1. 确保目标文件存在。
    await this.fileService.ensureFile(filepath);

    // 2. 提取文件名并返回下载响应。
    response.download(filepath, basename(filepath));
  }

  /** 根据传递的路径判断文件是否存在。 */
  @Post('check-file-exists')
  async checkFileExists(
    @Body() request: FileCheckRequest,
  ): Promise<ApiResponse<FileCheckResult>> {
    // 1. 调用服务检查文件是否存在。
    const result = await this.fileService.checkFileExists(request.filepath);

    // 2. 根据检查结果返回对应消息。
    return ResponseEnvelope.success(result, result.exists ? '文件存在' : '文件不存在');
  }

  /** 根据传递的文件路径删除指定文件。 */
  @Post('delete-file')
  async deleteFile(@Body() request: FileDeleteRequest): Promise<ApiResponse<FileDeleteResult>> {
    // 1. 调用服务删除指定文件。
    const result = await this.fileService.deleteFile(request.filepath);

    // 2. 使用统一响应结构返回删除结果。
    return ResponseEnvelope.success(result, '删除文件成功');
  }
}
