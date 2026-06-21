import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { Injectable, Logger } from '@nestjs/common';
import {
  ConsoleRecord,
  Shell,
  type ShellExecuteResult,
  type ShellKillResult,
  type ShellReadResult,
  type ShellWaitResult,
  type ShellWriteResult,
} from '../models/shell';
import { AppException, BadRequestException, NotFoundException } from '../interfaces/errors/exceptions';

class ProcessWaitTimeoutError extends Error {}

/** Shell 命令服务。 */
@Injectable()
export class ShellService {
  private readonly logger = new Logger(ShellService.name);
  private readonly activeShells = new Map<string, Shell>();

  /** 将用户主目录替换成 `~`，用于生成控制台提示符。 */
  private static getDisplayPath(path: string): string {
    const homeDir = homedir();
    if (path.startsWith(homeDir)) {
      return path.replace(homeDir, '~');
    }
    return path;
  }

  /** 格式化 Shell 提示符，例如 `user@host:~/workspace $`。 */
  private formatPs1(execDir: string): string {
    let username = process.env.USERNAME ?? process.env.USER ?? 'unknown';
    try {
      username = userInfo().username;
    } catch {
      // Windows 服务账号或极简容器里可能取不到 userInfo，这里沿用环境变量兜底。
    }

    return `${username}@${hostname()}:${ShellService.getDisplayPath(execDir)} $`;
  }

  /** 根据执行目录和命令创建子进程。 */
  private createProcess(execDir: string, command: string): ChildProcessWithoutNullStreams {
    this.logger.debug(`在目录 ${execDir} 下使用命令 ${command} 创建子进程`);

    if (process.platform === 'win32') {
      const powershellCommand =
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
        '$OutputEncoding = [System.Text.Encoding]::UTF8; ' +
        command;

      return spawn(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', powershellCommand],
        { cwd: execDir, stdio: 'pipe', windowsHide: true },
      );
    }

    return spawn('/bin/bash', ['-lc', command], { cwd: execDir, stdio: 'pipe' });
  }

  /** 持续读取 stdout/stderr，并写入会话输出缓存。 */
  private startOutputReader(sessionId: string, child: ChildProcessWithoutNullStreams): void {
    this.logger.debug(`正在启用会话输出读取器: ${sessionId}`);

    const appendOutput = (buffer: Buffer): void => {
      const shell = this.activeShells.get(sessionId);
      if (!shell) {
        return;
      }

      const output = buffer.toString('utf8');
      shell.output += output;
      const latestRecord = shell.console_records.at(-1);
      if (latestRecord) {
        latestRecord.output += output;
      }
    };

    child.stdout.on('data', appendOutput);
    child.stderr.on('data', appendOutput);
    child.on('error', (error) => {
      this.logger.error(`读取或执行 Shell 进程时出错: ${error.message}`);
    });
    child.once('close', () => {
      this.logger.debug(`会话 ${sessionId} 的输出读取器已完成`);
    });
  }

  /** 删除 ANSI 转义字符，避免终端颜色控制码污染 API 输出。 */
  private static removeAnsiEscapeCodes(text: string): string {
    return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
  }

  /** 等待子进程退出；超时由上层转换为业务异常。 */
  private waitForExit(child: ChildProcessWithoutNullStreams, seconds: number): Promise<number | null> {
    if (child.exitCode !== null) {
      return Promise.resolve(child.exitCode);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new ProcessWaitTimeoutError());
      }, seconds * 1000);

      const onExit = (code: number | null): void => {
        cleanup();
        resolve(code);
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const cleanup = (): void => {
        clearTimeout(timeout);
        child.off('exit', onExit);
        child.off('error', onError);
      };

      child.once('exit', onExit);
      child.once('error', onError);
    });
  }

  /** 创建 Shell 会话 ID。 */
  createSessionId(): string {
    const sessionId = randomUUID();
    this.logger.log(`创建新的 Shell 会话 ID: ${sessionId}`);
    return sessionId;
  }

  /** 从指定会话中获取控制台记录。 */
  getConsoleRecords(sessionId: string): ConsoleRecord[] {
    this.logger.debug(`正在获取 Shell 会话的控制台记录: ${sessionId}`);
    const shell = this.activeShells.get(sessionId);
    if (!shell) {
      this.logger.error(`Shell 会话不存在: ${sessionId}`);
      throw new NotFoundException(`Shell 会话不存在: ${sessionId}`);
    }

    return shell.console_records.map(
      (consoleRecord) =>
        new ConsoleRecord({
          ps1: consoleRecord.ps1,
          command: consoleRecord.command,
          output: ShellService.removeAnsiEscapeCodes(consoleRecord.output),
        }),
    );
  }

  /** 等待指定会话中的子进程结束。 */
  async waitProcess(sessionId: string, seconds?: number | null): Promise<ShellWaitResult> {
    this.logger.debug(`正在 Shell 会话中等待进程: ${sessionId}, 超时: ${seconds}s`);
    const shell = this.activeShells.get(sessionId);
    if (!shell) {
      this.logger.error(`Shell 会话不存在: ${sessionId}`);
      throw new NotFoundException(`Shell 会话不存在: ${sessionId}`);
    }

    const timeoutSeconds = seconds === undefined || seconds === null || seconds <= 0 ? 60 : seconds;

    try {
      const returncode = await this.waitForExit(shell.process, timeoutSeconds);
      this.logger.log(`进程已完成，返回代码为 ${returncode}`);
      return { returncode };
    } catch (error) {
      if (error instanceof ProcessWaitTimeoutError) {
        this.logger.warn(`Shell 会话进程等待超时: ${timeoutSeconds}s`);
        throw new BadRequestException(`Shell 会话进程等待超时: ${timeoutSeconds}s`);
      }

      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Shell 会话进程等待过程出错: ${message}`);
      throw new AppException(`Shell 会话进程等待过程出错: ${message}`);
    }
  }

  /** 读取指定 Shell 会话的输出。 */
  async readShellOutput(sessionId: string, console = false): Promise<ShellReadResult> {
    this.logger.debug(`查看 Shell 会话内容: ${sessionId}`);
    const shell = this.activeShells.get(sessionId);
    if (!shell) {
      this.logger.error(`Shell 会话不存在: ${sessionId}`);
      throw new NotFoundException(`Shell 会话不存在: ${sessionId}`);
    }

    const cleanOutput = ShellService.removeAnsiEscapeCodes(shell.output);
    const consoleRecords = console ? this.getConsoleRecords(sessionId) : [];

    return {
      session_id: sessionId,
      output: cleanOutput,
      console_records: consoleRecords,
    };
  }

  /** 在指定 Shell 会话中执行命令。 */
  async execCommand(sessionId: string, execDir: string | undefined | null, command: string): Promise<ShellExecuteResult> {
    this.logger.log(`正在会话 ${sessionId} 中执行命令: ${command}`);

    let normalizedExecDir = execDir;
    if (!normalizedExecDir || normalizedExecDir === '') {
      normalizedExecDir = homedir();
    }
    if (!existsSync(normalizedExecDir)) {
      this.logger.error(`当前目录不存在: ${normalizedExecDir}`);
      throw new BadRequestException(`当前目录不存在: ${normalizedExecDir}`);
    }

    try {
      const ps1 = this.formatPs1(normalizedExecDir);
      let shell = this.activeShells.get(sessionId);

      if (!shell) {
        this.logger.debug(`创建新的 Shell 会话: ${sessionId}`);
        const child = this.createProcess(normalizedExecDir, command);
        shell = new Shell({
          process: child,
          exec_dir: normalizedExecDir,
          output: '',
          console_records: [new ConsoleRecord({ ps1, command })],
        });
        this.activeShells.set(sessionId, shell);
        this.startOutputReader(sessionId, child);
      } else {
        this.logger.debug(`使用现有的 Shell 会话: ${sessionId}`);
        const oldProcess = shell.process;

        if (oldProcess.exitCode === null) {
          this.logger.debug(`正在终止会话中的上一个进程: ${sessionId}`);
          try {
            oldProcess.kill();
            await this.waitForExit(oldProcess, 1);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(`强制终止 Shell 会话中的进程 ${sessionId} 失败: ${message}`);
            oldProcess.kill('SIGKILL');
          }
        }

        const child = this.createProcess(normalizedExecDir, command);
        shell.process = child;
        shell.exec_dir = normalizedExecDir;
        shell.output = '';
        shell.console_records.push(new ConsoleRecord({ ps1, command }));
        this.startOutputReader(sessionId, child);
      }

      try {
        this.logger.debug(`正在等待会话中的进程完成: ${sessionId}`);
        const waitResult = await this.waitProcess(sessionId, 5);

        if (waitResult.returncode !== null) {
          this.logger.debug(`Shell 会话进程已结束，代码: ${waitResult.returncode}`);
          const viewResult = await this.readShellOutput(sessionId);

          return {
            session_id: sessionId,
            command,
            status: 'completed',
            returncode: waitResult.returncode,
            output: viewResult.output,
          };
        }
      } catch (error) {
        if (error instanceof BadRequestException) {
          this.logger.warn(`进程在会话超时后仍在运行: ${sessionId}`);
        } else {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.warn(`等待进程时出现异常: ${message}`);
        }
      }

      return {
        session_id: sessionId,
        command,
        status: 'running',
      };
    } catch (error) {
      if (error instanceof AppException) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`命令执行失败: ${message}`);
      throw new AppException(`命令执行失败: ${message}`, undefined, { session_id: sessionId, command });
    }
  }

  /** 向指定 Shell 子进程写入数据。 */
  async writeShellInput(sessionId: string, inputText: string, pressEnter: boolean): Promise<ShellWriteResult> {
    this.logger.debug(`写入 Shell 会话中的子进程: ${sessionId}, 是否追加回车: ${pressEnter}`);
    const shell = this.activeShells.get(sessionId);
    if (!shell) {
      this.logger.error(`Shell 会话不存在: ${sessionId}`);
      throw new NotFoundException(`Shell 会话不存在: ${sessionId}`);
    }

    if (shell.process.exitCode !== null) {
      this.logger.error(`子进程已结束，无法写入输入: ${sessionId}`);
      throw new BadRequestException('子进程已结束，无法写入输入');
    }

    try {
      const textToSend = inputText + (pressEnter ? '\n' : '');
      shell.output += textToSend;
      const latestRecord = shell.console_records.at(-1);
      if (latestRecord) {
        latestRecord.output += textToSend;
      }

      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          shell.process.stdin.off('error', onError);
          reject(error);
        };
        shell.process.stdin.once('error', onError);
        shell.process.stdin.write(textToSend, 'utf8', () => {
          shell.process.stdin.off('error', onError);
          resolve();
        });
      });

      this.logger.log('成功向子进程写入数据');
      return { status: 'success' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`向子进程写入数据出错: ${message}`);
      throw new AppException(`向子进程写入数据出错: ${message}`);
    }
  }

  /** 根据 Shell 会话 ID 关闭对应进程。 */
  async killProcess(sessionId: string): Promise<ShellKillResult> {
    this.logger.debug(`正在终止会话中的进程: ${sessionId}`);
    const shell = this.activeShells.get(sessionId);
    if (!shell) {
      this.logger.error(`Shell 会话不存在: ${sessionId}`);
      throw new NotFoundException(`Shell 会话不存在: ${sessionId}`);
    }

    try {
      if (shell.process.exitCode === null) {
        this.logger.log(`尝试优雅终止进程: ${sessionId}`);
        shell.process.kill();

        try {
          await this.waitForExit(shell.process, 3);
        } catch (error) {
          if (error instanceof ProcessWaitTimeoutError) {
            this.logger.warn(`尝试强制关闭进程: ${sessionId}`);
            shell.process.kill('SIGKILL');
          } else {
            throw error;
          }
        }

        this.logger.log(`进程已终止，返回代码为 ${shell.process.exitCode}`);
        return { status: 'terminated', returncode: shell.process.exitCode };
      }

      this.logger.log(`进程已终止，返回代码为 ${shell.process.exitCode}`);
      return { status: 'already_terminated', returncode: shell.process.exitCode };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`关闭进程失败: ${message}`);
      throw new AppException(`关闭进程失败: ${message}`);
    }
  }
}

