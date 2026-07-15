import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
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

  /** 查找当前 Windows 环境可用的 PowerShell 可执行文件。 */
  private resolveWindowsShell(): string {
    // 优先使用系统自带 powershell.exe，再尝试 PowerShell 7 的 pwsh.exe。
    for (const candidate of ['powershell.exe', 'pwsh.exe']) {
      // where.exe 查询成功说明该可执行文件存在于 PATH 中。
      const result = spawnSync('where.exe', [candidate], { stdio: 'ignore', windowsHide: true });
      if (result.status === 0) {
        return candidate;
      }
    }

    // 极简环境下如果查询失败，仍按 powershell.exe 兜底交给 spawn 报错。
    return 'powershell.exe';
  }

  /** Windows 下强制终止进程树，避免只杀掉外层 shell 后留下子进程。 */
  private killWindowsProcessTree(pid: number): Promise<void> {
    return new Promise((resolve) => {
      // /T 递归终止子进程，/F 强制结束进程。
      const child = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });

      child.once('close', () => resolve());
      child.once('error', () => resolve());
    });
  }

  /** 终止子进程；Windows 下超时后会清理完整进程树。 */
  private async terminateProcess(child: ChildProcessWithoutNullStreams, gracefulSeconds: number): Promise<void> {
    // 进程已经结束时不重复发送终止信号。
    if (child.exitCode !== null) {
      return;
    }

    try {
      // 先尝试普通终止，让子进程有机会自行清理资源。
      child.kill();
    } catch {
      return;
    }

    try {
      // 在宽限时间内等待进程自然退出。
      await this.waitForExit(child, gracefulSeconds);
      return;
    } catch (error) {
      if (!(error instanceof ProcessWaitTimeoutError)) {
        throw error;
      }
    }

    // Windows 下 child.kill 可能只杀外层 shell，需要额外清理整棵进程树。
    if (process.platform === 'win32' && child.pid) {
      await this.killWindowsProcessTree(child.pid);
      await this.waitForExit(child, 1).catch(() => undefined);
      return;
    }

    try {
      // 非 Windows 平台宽限超时后使用 SIGKILL 强制终止。
      child.kill('SIGKILL');
    } catch {
      return;
    }
    await this.waitForExit(child, 1).catch(() => undefined);
  }

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

    // Windows 使用 PowerShell 执行命令，并显式设置 UTF-8，避免中文输出乱码。
    if (process.platform === 'win32') {
      const powershellCommand =
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
        '$OutputEncoding = [System.Text.Encoding]::UTF8; ' +
        command;

      return spawn(
        this.resolveWindowsShell(),
        ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', powershellCommand],
        { cwd: execDir, stdio: 'pipe', windowsHide: true },
      );
    }

    // Linux 容器内使用 bash -lc，保持和常见交互式 shell 的命令解析行为一致。
    return spawn('/bin/bash', ['-lc', command], { cwd: execDir, stdio: 'pipe' });
  }

  /** 持续读取 stdout/stderr，并写入会话输出缓存。 */
  private startOutputReader(sessionId: string, child: ChildProcessWithoutNullStreams): void {
    this.logger.debug(`正在启用会话输出读取器: ${sessionId}`);

    const appendOutput = (buffer: Buffer): void => {
      // 会话可能已被关闭或替换，找不到时直接丢弃这次输出。
      const shell = this.activeShells.get(sessionId);
      if (!shell) {
        return;
      }

      // 原始输出保存在会话上，供 read-shell-output 直接返回。
      const output = buffer.toString('utf8');
      shell.output += output;
      // 控制台记录只更新最近一次命令，便于前端按命令分段展示。
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
    // 如果进程已经退出，直接返回已有退出码，不再注册监听器。
    if (child.exitCode !== null) {
      return Promise.resolve(child.exitCode);
    }

    return new Promise((resolve, reject) => {
      // 超时只负责结束等待，不直接杀进程；调用方决定是否需要终止。
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
      // 无论成功、失败或超时，都清理监听器和定时器，避免内存泄漏。
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
    // 会话 ID 由服务端生成，调用方可以用它继续读取、等待或写入同一个进程。
    const sessionId = randomUUID();
    this.logger.log(`创建新的 Shell 会话 ID: ${sessionId}`);
    return sessionId;
  }

  /** 从指定会话中获取控制台记录。 */
  getConsoleRecords(sessionId: string): ConsoleRecord[] {
    this.logger.debug(`正在获取 Shell 会话的控制台记录: ${sessionId}`);
    // 控制台记录依赖已有会话，缺失时返回业务 404。
    const shell = this.activeShells.get(sessionId);
    if (!shell) {
      this.logger.error(`Shell 会话不存在: ${sessionId}`);
      throw new NotFoundException(`Shell 会话不存在: ${sessionId}`);
    }

    // 返回前清理 ANSI 控制码，保证 API 输出是纯文本。
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
    // 等待必须基于已有会话，否则无法定位需要等待的子进程。
    const shell = this.activeShells.get(sessionId);
    if (!shell) {
      this.logger.error(`Shell 会话不存在: ${sessionId}`);
      throw new NotFoundException(`Shell 会话不存在: ${sessionId}`);
    }

    // seconds 为空或非正数时使用默认 60 秒，避免请求传 0 导致立即超时。
    const timeoutSeconds = seconds === undefined || seconds === null || seconds <= 0 ? 60 : seconds;

    try {
      // waitForExit 只等待，不主动终止进程；超时后由调用方继续控制会话。
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
    // 输出读取只面向已创建会话，避免误把空会话当成空输出。
    const shell = this.activeShells.get(sessionId);
    if (!shell) {
      this.logger.error(`Shell 会话不存在: ${sessionId}`);
      throw new NotFoundException(`Shell 会话不存在: ${sessionId}`);
    }

    // 普通 output 返回完整文本，console_records 只有显式请求时才计算。
    const cleanOutput = ShellService.removeAnsiEscapeCodes(shell.output);
    const consoleRecords = console ? this.getConsoleRecords(sessionId) : [];

    return {
      session_id: sessionId,
      output: cleanOutput,
      console_records: consoleRecords,
    };
  }

  /** 在指定 Shell 会话中执行命令。 */
  async execCommand(sessionId: string, execDir: string, command: string): Promise<ShellExecuteResult> {
    this.logger.log(`正在会话 ${sessionId} 中执行命令: ${command}`);

    // 创建子进程前先检查目录，避免 spawn 返回低层 ENOENT。
    if (!existsSync(execDir)) {
      this.logger.error(`当前目录不存在: ${execDir}`);
      throw new BadRequestException(`当前目录不存在: ${execDir}`);
    }

    try {
      // 每次命令都会生成一个提示符记录，方便前端还原控制台历史。
      const ps1 = this.formatPs1(execDir);
      let shell = this.activeShells.get(sessionId);

      // 第一次使用该 sessionId 时创建新进程和会话缓存。
      if (!shell) {
        this.logger.debug(`创建新的 Shell 会话: ${sessionId}`);
        const child = this.createProcess(execDir, command);
        shell = new Shell({
          process: child,
          exec_dir: execDir,
          output: '',
          console_records: [new ConsoleRecord({ ps1, command })],
        });
        this.activeShells.set(sessionId, shell);
        this.startOutputReader(sessionId, child);
      } else {
        // 复用会话时，先处理旧进程，再用新命令覆盖当前进程引用。
        this.logger.debug(`使用现有的 Shell 会话: ${sessionId}`);
        const oldProcess = shell.process;

        // 如果旧命令仍在运行，需要先结束它，避免一个会话同时挂多个进程。
        if (oldProcess.exitCode === null) {
          this.logger.debug(`正在终止会话中的上一个进程: ${sessionId}`);
          try {
            await this.terminateProcess(oldProcess, 1);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(`终止 Shell 会话中的进程 ${sessionId} 失败: ${message}`);
          }
        }

        // 重置当前输出缓存，但保留 console_records 中的历史命令记录。
        const child = this.createProcess(execDir, command);
        shell.process = child;
        shell.exec_dir = execDir;
        shell.output = '';
        shell.console_records.push(new ConsoleRecord({ ps1, command }));
        this.startOutputReader(sessionId, child);
      }

      try {
        // 先短暂等待 5 秒；快速命令直接返回 completed，长命令返回 running。
        this.logger.debug(`正在等待会话中的进程完成: ${sessionId}`);
        const waitResult = await this.waitProcess(sessionId, 5);

        if (waitResult.returncode !== null) {
          // 快速完成时把输出一并返回，调用方不必再额外读取一次。
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
          // 5 秒内没结束是正常的长任务场景，保留进程继续运行。
          this.logger.warn(`进程在会话超时后仍在运行: ${sessionId}`);
        } else {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.warn(`等待进程时出现异常: ${message}`);
        }
      }

      // 长时间运行的命令返回 running，由调用方后续 read/wait/kill。
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
    // 写入必须基于正在维护的会话。
    const shell = this.activeShells.get(sessionId);
    if (!shell) {
      this.logger.error(`Shell 会话不存在: ${sessionId}`);
      throw new NotFoundException(`Shell 会话不存在: ${sessionId}`);
    }

    // 子进程退出后 stdin 已不可用，不能继续写入。
    if (shell.process.exitCode !== null) {
      this.logger.error(`子进程已结束，无法写入输入: ${sessionId}`);
      throw new BadRequestException('子进程已结束，无法写入输入');
    }

    try {
      // Windows 和 POSIX 的回车符不同，交互式输入需要按平台追加。
      const lineEnding = process.platform === 'win32' ? '\r\n' : '\n';
      const textToSend = inputText + (pressEnter ? lineEnding : '');
      // 把用户输入也记录到输出缓存，便于控制台历史完整展示。
      shell.output += textToSend;
      const latestRecord = shell.console_records.at(-1);
      if (latestRecord) {
        latestRecord.output += textToSend;
      }

      // stdin 写入是异步的，需要监听错误并在回调中确认写入完成。
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
    // 关闭进程必须基于已有会话。
    const shell = this.activeShells.get(sessionId);
    if (!shell) {
      this.logger.error(`Shell 会话不存在: ${sessionId}`);
      throw new NotFoundException(`Shell 会话不存在: ${sessionId}`);
    }

    try {
      // 仍在运行时执行终止流程，否则直接返回已结束状态。
      if (shell.process.exitCode === null) {
        this.logger.log(`尝试终止进程: ${sessionId}`);
        await this.terminateProcess(shell.process, 3);

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




