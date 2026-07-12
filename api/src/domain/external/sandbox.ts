import { Browser } from './browser';
import { ToolResult } from '../models/tool-result';

export type SandboxFileData = Buffer | NodeJS.ReadableStream;

/**
 * 沙箱能力边界。
 *
 * 该抽象类描述沙箱文件操作、Shell 进程操作、
 * 浏览器实例获取，以及沙箱自身生命周期。当前还没有 concrete
 * implementation，所以暂时只保留端口，不主动补真实实现。
 */
export abstract class Sandbox {
  /** 执行指定会话和目录下的命令。 */
  abstract execCommand(sessionId: string, execDir: string, command: string): Promise<ToolResult>;

  /** 读取指定会话的 shell 输出；console=true 时返回控制台记录。 */
  abstract readShellOutput(sessionId: string, console?: boolean): Promise<ToolResult>;

  /** 等待指定会话中的进程执行一段时间。 */
  abstract waitProcess(sessionId: string, seconds?: number): Promise<ToolResult>;

  /** 向指定会话的进程写入标准输入。 */
  abstract writeShellInput(
    sessionId: string,
    inputText: string,
    pressEnter?: boolean,
  ): Promise<ToolResult>;

  /** 终止指定会话中的进程。 */
  abstract killProcess(sessionId: string): Promise<ToolResult>;

  /** 写入沙箱文件，支持追加、首尾换行和 sudo 标记。 */
  abstract writeFile(
    filepath: string,
    content: string,
    append?: boolean,
    leadingNewline?: boolean,
    trailingNewline?: boolean,
    sudo?: boolean,
  ): Promise<ToolResult>;

  /** 读取沙箱文件，支持行范围、sudo 标记和最大长度限制。 */
  abstract readFile(
    filepath: string,
    startLine?: number,
    endLine?: number,
    sudo?: boolean,
    maxLength?: number,
  ): Promise<ToolResult>;

  /** 判断沙箱中的文件是否存在。 */
  abstract checkFileExists(filepath: string): Promise<ToolResult>;

  /** 删除沙箱中的指定文件。 */
  abstract deleteFile(filepath: string): Promise<ToolResult>;

  /** 列出沙箱目录下的文件。 */
  abstract listFiles(dirPath: string): Promise<ToolResult>;

  /** 在沙箱文件中替换指定内容。 */
  abstract replaceInFile(
    filepath: string,
    oldStr: string,
    newStr: string,
    sudo?: boolean,
  ): Promise<ToolResult>;

  /** 在沙箱文件中按正则搜索内容。 */
  abstract searchInFile(filepath: string, regex: string, sudo?: boolean): Promise<ToolResult>;

  /** 按 glob 规则查找沙箱目录中的文件。 */
  abstract findFiles(dirPath: string, globPattern: string): Promise<ToolResult>;

  /** 上传文件数据到沙箱路径。 */
  abstract uploadFile(
    fileData: SandboxFileData,
    filepath: string,
    filename?: string,
  ): Promise<ToolResult>;

  /** 从沙箱下载文件数据。 */
  abstract downloadFile(filepath: string): Promise<SandboxFileData>;

  /** 确保沙箱实例存在；不存在时由 concrete implementation 创建。 */
  abstract ensureSandbox(): Promise<void>;

  /** 销毁当前沙箱实例并释放资源。 */
  abstract destroy(): Promise<boolean>;

  /** 获取沙箱内的浏览器实例。 */
  abstract getBrowser(): Promise<Browser>;

  /** 沙箱实例 ID。 */
  abstract readonly id: string;

  /** 控制沙箱浏览器的 CDP 地址。 */
  abstract readonly cdpUrl: string;

  /** 远程桌面的 VNC 地址。 */
  abstract readonly vncUrl: string;
}

/** 负责创建和查找沙箱实例，隔离具体运行环境实现。 */
export abstract class SandboxManager {
  abstract create(): Promise<Sandbox>;
  abstract get(id: string): Promise<Sandbox | null>;
}

