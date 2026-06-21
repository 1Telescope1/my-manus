import type { ChildProcessWithoutNullStreams } from 'node:child_process';

/** Shell 命令行控制台记录。 */
export class ConsoleRecord {
  ps1: string;
  command: string;
  output: string;

  constructor(params: { ps1: string; command: string; output?: string }) {
    this.ps1 = params.ps1;
    this.command = params.command;
    this.output = params.output ?? '';
  }
}

/** Shell 会话模型，保存当前子进程、执行目录、输出和控制台记录。 */
export class Shell {
  process: ChildProcessWithoutNullStreams;
  exec_dir: string;
  output: string;
  console_records: ConsoleRecord[];

  constructor(params: {
    process: ChildProcessWithoutNullStreams;
    exec_dir: string;
    output: string;
    console_records?: ConsoleRecord[];
  }) {
    this.process = params.process;
    this.exec_dir = params.exec_dir;
    this.output = params.output;
    this.console_records = params.console_records ?? [];
  }
}

/** 等待 Shell 进程结束后的返回值。 */
export type ShellWaitResult = {
  returncode: number | null;
};

/** 读取 Shell 输出后的返回值。 */
export type ShellReadResult = {
  session_id: string;
  output: string;
  console_records: ConsoleRecord[];
};

/** 执行 Shell 命令后的返回值。 */
export type ShellExecuteResult = {
  session_id: string;
  command: string;
  status: string;
  returncode?: number | null;
  output?: string;
};

/** 向 Shell 进程写入输入后的返回值。 */
export type ShellWriteResult = {
  status: string;
};

/** 关闭 Shell 进程后的返回值。 */
export type ShellKillResult = {
  status: string;
  returncode: number | null;
};

