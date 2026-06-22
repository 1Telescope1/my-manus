import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Injectable, Logger } from '@nestjs/common';
import { AppException, BadRequestException, NotFoundException } from '../interfaces/errors/exceptions';
import {
  type FileCheckResult,
  type FileDeleteResult,
  type FileFindResult,
  type FileReadResult,
  type FileReplaceResult,
  type FileSearchResult,
  type FileUploadResult,
  type FileWriteResult,
} from '../models/file';

export type UploadedFileData = {
  originalname?: string;
  buffer?: Buffer;
  size?: number;
  path?: string;
  stream?: NodeJS.ReadableStream;
};

/** 文件沙箱服务。 */
@Injectable()
export class FileService {
  private readonly logger = new Logger(FileService.name);

  /** 判断当前请求是否应该走 sudo 命令分支；Windows 下没有 sudo，统一降级为普通文件 API。 */
  private static shouldUseSudo(sudo?: boolean): boolean {
    return Boolean(sudo) && process.platform !== 'win32';
  }

  /** 安全包装 shell 参数，避免路径中的单引号破坏命令结构。 */
  private static quotePosixArg(value: string): string {
    return "'" + value.replace(/'/g, "'\"'\"'") + "'";
  }

  /** 在 POSIX shell 中执行命令，并收集 stdout/stderr 和退出码。 */
  private static runPosixShell(command: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return new Promise((resolve, reject) => {
      const child = spawn('/bin/bash', ['-lc', command], { stdio: 'pipe' });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
      child.once('error', reject);
      child.once('close', (code) => {
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          code,
        });
      });
    });
  }

  /** 将系统路径分隔符统一成 `/`，用于 glob 规则匹配。 */
  private static normalizeRelativePath(path: string): string {
    return path.split(sep).join('/');
  }

  /** 将简单 glob 规则转换成正则表达式，支持 `*`、`?` 和 `**/`。 */
  private static globToRegExp(globPattern: string): RegExp {
    const pattern = FileService.normalizeRelativePath(globPattern);
    let regex = '^';

    for (let index = 0; index < pattern.length; index += 1) {
      const char = pattern[index];
      const next = pattern[index + 1];

      if (char === '*' && next === '*') {
        const afterNext = pattern[index + 2];
        if (afterNext === '/') {
          regex += '(?:.*\/)?';
          index += 2;
        } else {
          regex += '.*';
          index += 1;
        }
        continue;
      }

      if (char === '*') {
        regex += '[^/]*';
        continue;
      }

      if (char === '?') {
        regex += '[^/]';
        continue;
      }

      if ('\\.^$+{}()|[]'.includes(char)) {
        regex += `\\${char}`;
        continue;
      }

      regex += char;
    }

    regex += '$';
    return new RegExp(regex);
  }

  /** 递归遍历目录，返回目录下所有文件和子目录路径。 */
  private static async walk(dirPath: string): Promise<string[]> {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const results: string[] = [];

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      results.push(fullPath);
      if (entry.isDirectory()) {
        results.push(...(await FileService.walk(fullPath)));
      }
    }

    return results;
  }

  /** 根据文件路径、起止行号、权限和最大长度读取文件内容。 */
  async readFile(
    filepath: string,
    startLine?: number | null,
    endLine?: number | null,
    sudo = false,
    maxLength: number | null = 10000,
  ): Promise<FileReadResult> {
    // 1. 检测当前运行环境是否需要走 sudo 读取分支。
    const effectiveSudo = FileService.shouldUseSudo(sudo);

    try {
      // 2. 普通权限下先检查文件是否存在。
      if (!existsSync(filepath) && !effectiveSudo) {
        this.logger.error(`要读取的文件不存在或无权限: ${filepath}`);
        throw new NotFoundException(`要读取的文件不存在或无权限: ${filepath}`);
      }

      let content: string;
      if (effectiveSudo) {
        // 3. sudo 分支使用命令读取文件内容。
        const result = await FileService.runPosixShell(`sudo cat ${FileService.quotePosixArg(filepath)}`);
        if (result.code !== 0) {
          throw new BadRequestException(`阅读文件失败: ${result.stderr}`);
        }
        content = result.stdout;
      } else {
        // 4. 普通分支直接使用 utf-8 读取文件。
        content = await readFile(filepath, 'utf8');
      }

      // 5. 如果传递了行范围，则按行切片。
      if ((startLine !== undefined && startLine !== null) || (endLine !== undefined && endLine !== null)) {
        const lines = content.split(/\r?\n/);
        const start = startLine ?? 0;
        const end = endLine ?? lines.length;
        content = lines.slice(start, end).join('\n');
      }

      // 6. 如果传递了最大长度，则裁切内容并标记截断。
      if (maxLength !== null && maxLength !== undefined && maxLength > 0 && maxLength < content.length) {
        content = `${content.slice(0, maxLength)}(truncated)`;
      }

      return { filepath, content };
    } catch (error) {
      // 7. 已知业务异常直接向上抛出，未知异常统一包装。
      if (error instanceof BadRequestException || error instanceof NotFoundException || error instanceof AppException) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new AppException(`文件读取失败: ${message}`);
    }
  }

  /** 根据文件路径和内容向指定文件写入内容。 */
  async writeFile(
    filepath: string,
    content: string,
    append = false,
    leadingNewline = false,
    trailingNewline = false,
    sudo = false,
  ): Promise<FileWriteResult> {
    // 1. 检测当前运行环境是否需要走 sudo 写入分支。
    const effectiveSudo = FileService.shouldUseSudo(sudo);
    let actualContent = content;

    try {
      // 2. 根据参数组装实际写入内容。
      if (leadingNewline) {
        actualContent = `\n${actualContent}`;
      }
      if (trailingNewline) {
        actualContent = `${actualContent}\n`;
      }

      // 3. 计算写入内容的字节数。
      const bytesWritten = Buffer.byteLength(actualContent, 'utf8');

      if (effectiveSudo) {
        // 4. sudo 分支先写入临时文件，再通过 shell 覆盖或追加到目标文件。
        const tempFile = `/tmp/file_write_${process.pid}_${Date.now()}.tmp`;
        await writeFile(tempFile, actualContent, 'utf8');

        try {
          const mode = append ? '>>' : '>';
          const innerCommand = `cat ${FileService.quotePosixArg(tempFile)} ${mode} ${FileService.quotePosixArg(filepath)}`;
          const result = await FileService.runPosixShell(`sudo bash -c ${FileService.quotePosixArg(innerCommand)}`);
          if (result.code !== 0) {
            throw new BadRequestException(`文件内容写入失败: ${result.stderr}`);
          }
        } finally {
          // 5. 无论写入成功与否，都尝试清理临时文件。
          await unlink(tempFile).catch(() => undefined);
        }
      } else {
        // 6. 普通分支先确保目录存在，再按覆盖或追加模式写入。
        await mkdir(dirname(filepath), { recursive: true });
        await writeFile(filepath, actualContent, { encoding: 'utf8', flag: append ? 'a' : 'w' });
      }

      return { filepath, bytes_written: bytesWritten };
    } catch (error) {
      // 7. 根据不同错误类型决定直接抛出或统一包装。
      this.logger.error(`文件内容写入失败: ${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof BadRequestException) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new AppException(`文件内容写入失败: ${message}`);
    }
  }

  /** 根据传递的数据替换文件内指定内容。 */
  async replaceInFile(
    filepath: string,
    oldStr: string,
    newStr: string,
    sudo = false,
  ): Promise<FileReplaceResult> {
    // 1. 先读取完整文件内容。
    const fileReadResult = await this.readFile(filepath, undefined, undefined, sudo, null);
    const content = fileReadResult.content;

    // 2. 计算原始字符串出现次数；未命中则直接返回。
    const replacedCount = oldStr ? content.split(oldStr).length - 1 : 0;
    if (replacedCount === 0) {
      return { filepath, replaced_count: replacedCount };
    }

    // 3. 替换旧内容并写回文件。
    await this.writeFile(filepath, content.split(oldStr).join(newStr), false, false, false, sudo);
    return { filepath, replaced_count: replacedCount };
  }

  /** 根据文件路径和匹配规则查询文件内符合条件的内容。 */
  async searchInFile(filepath: string, regex: string, sudo = false): Promise<FileSearchResult> {
    // 1. 先读取完整文件内容。
    const fileReadResult = await this.readFile(filepath, undefined, undefined, sudo, null);
    const content = fileReadResult.content;

    // 2. 将内容拆分为行，并准备匹配结果容器。
    const lines = content.split(/\r?\n/);
    const matches: string[] = [];
    const lineNumbers: number[] = [];

    // 3. 将外部传递的 regex 转换为正则对象。
    let pattern: RegExp;
    try {
      pattern = new RegExp(`^(?:${regex})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(`传递正则表达式[${regex}]出错: ${message}`);
    }

    // 4. 按行匹配并记录命中的文本和行号。
    lines.forEach((line, index) => {
      if (pattern.test(line)) {
        matches.push(line);
        lineNumbers.push(index);
      }
    });

    return { filepath, matches, line_numbers: lineNumbers };
  }

  /** 根据文件夹路径和 glob 规则查询文件列表。 */
  async findFiles(dirPath: string, globPattern: string): Promise<FileFindResult> {
    // 1. 检测传入目录是否存在。
    if (!existsSync(dirPath)) {
      throw new NotFoundException(`当前文件夹不存在: ${dirPath}`);
    }

    // 2. 将 glob 规则转换为正则，并递归遍历目录。
    const pattern = FileService.globToRegExp(globPattern);
    const entries = await FileService.walk(dirPath);

    // 3. 使用相对路径匹配 glob 规则。
    const files = entries.filter((entry) => {
      const relativePath = FileService.normalizeRelativePath(relative(dirPath, entry));
      return pattern.test(relativePath);
    });

    return { dir_path: dirPath, files };
  }

  /** 根据文件源和路径将文件上传至沙箱。 */
  async uploadFile(file: UploadedFileData, filepath: string): Promise<FileUploadResult> {
    try {
      // 1. 确保上传目标所在目录存在。
      await mkdir(dirname(filepath), { recursive: true });

      // 2. 优先处理内存 buffer 上传。
      if (file.buffer) {
        await writeFile(filepath, file.buffer);
        return { filepath, file_size: file.buffer.length, success: true };
      }

      // 3. 如果上传中间件提供临时文件路径，则复制临时文件。
      if (file.path) {
        await copyFile(file.path, filepath);
        const fileStat = await stat(filepath);
        return { filepath, file_size: fileStat.size, success: true };
      }

      // 4. 如果提供的是流，则通过 pipeline 写入目标文件。
      if (file.stream) {
        await pipeline(file.stream, writeFileStream(filepath));
        const fileStat = await stat(filepath);
        return { filepath, file_size: fileStat.size, success: true };
      }

      throw new BadRequestException('上传文件内容为空');
    } catch (error) {
      // 5. 上传错误统一包装为应用异常。
      if (error instanceof BadRequestException) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`上传文件到沙箱出错: ${message}`);
      throw new AppException(`上传文件到沙箱出错: ${message}`);
    }
  }

  /** 确保当前文件存在。 */
  async ensureFile(filepath: string): Promise<void> {
    if (!existsSync(filepath)) {
      throw new NotFoundException(`该文件不存在: ${filepath}`);
    }
  }

  /** 根据传递的路径判断文件是否存在。 */
  async checkFileExists(filepath: string): Promise<FileCheckResult> {
    return { filepath, exists: existsSync(filepath) };
  }

  /** 根据传递的路径删除指定文件。 */
  async deleteFile(filepath: string): Promise<FileDeleteResult> {
    // 1. 删除前先确认文件存在。
    await this.ensureFile(filepath);

    try {
      // 2. 调用文件系统删除文件。
      await rm(filepath);
      return { filepath, deleted: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`删除文件${filepath}失败: ${message}`);
      throw new AppException(`删除文件${filepath}失败: ${message}`);
    }
  }
}

function writeFileStream(filepath: string) {
  return createWriteStream(filepath);
}

