import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIPv4 } from 'node:net';
import { Readable } from 'node:stream';
import Dockerode, { type Container, type ContainerCreateOptions } from 'dockerode';
import { Browser } from '../../../domain/external/browser';
import {
  Sandbox,
  type SandboxFileData,
} from '../../../domain/external/sandbox';
import { ToolResult, toolResultFromSandbox } from '../../../domain/models/tool-result';
import { SettingsService } from '../../../core/config/settings';
import { PlaywrightBrowser } from '../browser/playwright-browser';

type SandboxApiResponse<T = unknown> = {
  code: number;
  msg: string;
  data?: T;
};

type SupervisorProcess = {
  name?: string;
  statename?: string;
};

type DockerNetworkSettings = {
  IPAddress?: string;
  Networks?: Record<string, { IPAddress?: string }>;
};

const hostnameCache = new Map<string, string | null>();

/** 基于 Docker 的沙箱服务。 */
export class DockerSandbox extends Sandbox {
  private readonly baseUrl: string;
  private readonly vncAddress: string;
  private readonly cdpAddress: string;

  constructor(
    private readonly ip?: string | null,
    private readonly containerName?: string | null,
    private readonly externallyManaged = false,
  ) {
    super();
    // 沙箱内部服务固定监听 8080，浏览器调试和 VNC 端口也由容器内服务暴露。
    this.baseUrl = `http://${ip}:8080`;
    this.vncAddress = `ws://${ip}:5901`;
    this.cdpAddress = `http://${ip}:9222`;
  }

  /** 获取沙箱的唯一 id，使用容器名字作为唯一 id。 */
  get id(): string {
    return this.containerName || 'manus-sandbox';
  }

  get vncUrl(): string {
    return this.vncAddress;
  }

  get cdpUrl(): string {
    return this.cdpAddress;
  }

  /** 将 Docker 容器主机/地址转换成 ipv4 格式数据。 */
  private static async resolveHostnameToIp(hostname: string): Promise<string | null> {
    // 地址解析结果会被多次复用，先读缓存可以减少 DNS 查询。
    if (hostnameCache.has(hostname)) {
      return hostnameCache.get(hostname) ?? null;
    }

    try {
      // 调用方传入的如果已经是 IPv4，就直接返回并写入缓存。
      if (isIPv4(hostname)) {
        hostnameCache.set(hostname, hostname);
        return hostname;
      }

      // Docker 网络场景下可能传入容器名或服务名，这里统一解析为 IPv4。
      const result = await lookup(hostname, { family: 4 });
      hostnameCache.set(hostname, result.address);
      return result.address;
    } catch (error) {
      // 解析失败也写入空缓存，避免短时间内对同一无效地址反复查询。
      console.error(`解析 Docker 容器主机地址 ${hostname} 失败: ${errorMessage(error)}`);
      hostnameCache.set(hostname, null);
      return null;
    }
  }

  /** 根据传递的容器获取 ip 信息。 */
  private static async getContainerIp(container: Container): Promise<string> {
    // Docker 的 inspect 结果在不同网络模式下 IP 字段位置不同。
    const inspectInfo = await container.inspect();
    const networkSettings = inspectInfo.NetworkSettings as DockerNetworkSettings;
    let ipAddress = networkSettings?.IPAddress ?? '';

    // 默认 bridge 网络通常在 IPAddress，上自定义 network 后需要从 Networks 中取。
    if (!ipAddress && networkSettings?.Networks) {
      for (const networkConfig of Object.values(networkSettings.Networks)) {
        if (networkConfig?.IPAddress) {
          ipAddress = networkConfig.IPAddress;
          break;
        }
      }
    }

    return ipAddress;
  }

  /** 创建沙箱容器的异步任务。 */
  private static async createTask(): Promise<DockerSandbox> {
    // 每次创建沙箱都生成独立容器名，避免并发任务互相覆盖。
    const settings = new SettingsService();
    const image = settings.sandboxImage;
    const namePrefix = settings.sandboxNamePrefix;
    const containerName = `${namePrefix}-${randomUUID().slice(0, 8)}`;

    try {
      // dockerode 默认读取本机 Docker 环境变量和命名管道/Socket 配置。
      const docker = new Dockerode();
      const containerConfig: ContainerCreateOptions = {
        Image: image,
        name: containerName,
        Env: [
          // 沙箱服务通过环境变量接收生命周期、浏览器参数和代理配置。
          `SERVER_TIMEOUT_MINUTES=${settings.sandboxTtlMinutes}`,
          `CHROME_ARGS=${settings.sandboxChromeArgs}`,
          `HTTPS_PROXY=${settings.sandboxHttpsProxy ?? ''}`,
          `HTTP_PROXY=${settings.sandboxHttpProxy ?? ''}`,
          `NO_PROXY=${settings.sandboxNoProxy ?? ''}`,
        ],
        HostConfig: {
          AutoRemove: true,
        },
      };

      // 指定网络后，API 服务可以通过该网络访问新建沙箱容器。
      if (settings.sandboxNetwork) {
        containerConfig.HostConfig = {
          ...containerConfig.HostConfig,
          NetworkMode: settings.sandboxNetwork,
        };
      }

      // 先创建再启动，启动完成后再从 Docker inspect 结果中读取容器 IP。
      const container = await docker.createContainer(containerConfig);
      await container.start();

      const ip = await this.getContainerIp(container);
      return new DockerSandbox(ip, containerName);
    } catch (error) {
      console.error(`创建 Docker 沙箱容器失败: ${errorMessage(error)}`);
      throw new Error(`创建 Docker 沙箱容器失败: ${errorMessage(error)}`);
    }
  }

  /** 类方法，创建沙箱容器。 */
  static async create(): Promise<DockerSandbox> {
    const settings = new SettingsService();

    // 如果配置了固定沙箱地址，则直接连接已有沙箱，不再创建新容器。
    if (settings.sandboxAddress) {
      const ip = await this.resolveHostnameToIp(settings.sandboxAddress);
      return new DockerSandbox(ip, null, true);
    }

    // 未配置固定地址时，按镜像和容器参数创建一次性沙箱容器。
    return this.createTask();
  }

  /** 销毁当前的 DockerSandbox 实例。 */
  async destroy(): Promise<boolean> {
    try {
      // 只有由当前实例持有容器名时，才尝试删除对应容器。
      if (this.containerName && !this.externallyManaged) {
        const docker = new Dockerode();
        await docker.getContainer(this.containerName).remove({ force: true });
      }
      return true;
    } catch (error) {
      console.error(`销毁当前 Docker 沙箱[${this.containerName}]失败: ${errorMessage(error)}`);
      return false;
    }
  }

  /** 根据传递的 id 获取沙箱实例。 */
  static async get(id: string): Promise<DockerSandbox | null> {
    const settings = new SettingsService();

    // 固定沙箱地址模式下，id 只作为实例标识保留，不用于查找容器。
    if (settings.sandboxAddress) {
      try {
        const ip = await this.resolveHostnameToIp(settings.sandboxAddress);
        return new DockerSandbox(ip, null, true);
      } catch (error) {
        console.error(`解析沙箱地址失败: ${errorMessage(error)}`);
        return null;
      }
    }

    try {
      // 动态容器模式下，id 就是 Docker 容器名或容器 id。
      const docker = new Dockerode();
      const container = docker.getContainer(id);
      const inspectInfo = await container.inspect();

      // 容器存在但未运行时，不能继续作为可用沙箱返回。
      if (!inspectInfo.State?.Running) {
        console.warn(`容器存在但未运行, 容器名字: ${id}`);
        return null;
      }

      // 没有容器 IP 时，API 服务无法访问沙箱内部 HTTP 服务。
      const ip = await this.getContainerIp(container);
      if (!ip) {
        return null;
      }

      return new DockerSandbox(ip, id);
    } catch (error) {
      const message = errorMessage(error);
      // 容器不存在通常表示沙箱已经过期或被清理，这里按空结果处理。
      if (isDockerNotFoundError(error)) {
        console.warn(`该容器找不到可能被销毁: ${id}`);
        return null;
      }

      console.error(`获取沙箱发生未知错误: ${message}`);
      return null;
    }
  }

  /** 获取沙箱中的浏览器实例。 */
  async getBrowser(): Promise<Browser> {
    return new PlaywrightBrowser(this.cdpUrl);
  }

  /** 确保沙箱一定存在，服务全部都开启了才执行后续步骤。 */
  async ensureSandbox(): Promise<void> {
    // 沙箱容器启动后，Supervisor 管理的子服务还需要一段初始化时间。
    const maxRetries = 30;
    const retryInterval = 2_000;

    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      try {
        // 通过沙箱内部状态接口检查 Supervisor 管理的服务进程。
        const response = await fetch(`${this.baseUrl}/api/supervisor/status`);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        // 沙箱接口统一返回 code/msg/data，这里转成 ToolResult 便于复用成功判断。
        const result = toolResultFromSandbox<SupervisorProcess[]>(
          ...await readSandboxResponse<SupervisorProcess[]>(response),
        );

        // 接口可访问但业务返回失败时，继续等待下一轮检查。
        if (!result.success) {
          console.warn(`Supervisor 进程状态监测失败: ${result.message}`);
          await sleep(retryInterval);
          continue;
        }

        const services = result.data ?? [];
        // 没有任何服务信息通常表示 Supervisor 还没有完成加载。
        if (!services.length) {
          console.warn('Supervisor 进程中未发现任何服务');
          await sleep(retryInterval);
          continue;
        }

        // 只要还有非 RUNNING 进程，就继续等待并把未就绪服务打印出来。
        const nonRunningServices: string[] = [];
        for (const service of services) {
          const serviceName = service.name ?? 'unknown';
          const stateName = service.statename ?? '';
          if (stateName !== 'RUNNING') {
            nonRunningServices.push(`${serviceName}(${stateName})`);
          }
        }

        // 所有服务都运行后，沙箱才视为真正可用。
        if (!nonRunningServices.length) {
          console.info('Sandbox Supervisor 所有进程服务运行正常');
          return;
        }

        console.info(
          `正在等待 Sandbox Supervisor 进程服务运行, 还未运行的服务列表: ${nonRunningServices.join(', ')}`,
        );
        await sleep(retryInterval);
      } catch (error) {
        // 容器刚启动时 HTTP 服务可能尚未监听，连接错误也按重试处理。
        console.warn(`无法确认 Sandbox Supervisor 进程状态: ${errorMessage(error)}`);
        await sleep(retryInterval);
      }
    }

    // 超过最大重试次数仍未就绪，交给调用方处理创建失败。
    console.error(`在经过 ${maxRetries} 次尝试后仍无法确认 Sandbox Supervisor 状态信息`);
    throw new Error(`在经过 ${maxRetries} 次尝试后仍无法确认 Sandbox Supervisor 状态信息`);
  }

  /** 读取沙箱中指定路径的文件内容。 */
  async readFile(
    filepath: string,
    startLine?: number,
    endLine?: number,
    sudo = false,
    maxLength = 10_000,
  ): Promise<ToolResult> {
    // 行号、sudo 和最大长度直接透传给沙箱文件读取接口。
    return this.postToolResult('/api/file/read-file', {
      filepath,
      start_line: startLine,
      end_line: endLine,
      sudo,
      max_length: maxLength,
    });
  }

  /** 向沙箱中指定文件写入内容。 */
  async writeFile(
    filepath: string,
    content: string,
    append = false,
    leadingNewline = false,
    trailingNewline = false,
    sudo = false,
  ): Promise<ToolResult> {
    // 换行控制参数由沙箱侧统一处理，API 层只负责保持字段命名一致。
    return this.postToolResult('/api/file/write-file', {
      filepath,
      content,
      append,
      leading_newline: leadingNewline,
      trailing_newline: trailingNewline,
      sudo,
    });
  }

  /** 替换沙箱中文件的旧内容为指定内容。 */
  async replaceInFile(
    filepath: string,
    oldStr: string,
    newStr: string,
    sudo = false,
  ): Promise<ToolResult> {
    // 替换接口要求旧内容完全匹配，避免模糊替换带来的误改。
    return this.postToolResult('/api/file/replace-in-file', {
      filepath,
      old_str: oldStr,
      new_str: newStr,
      sudo,
    });
  }

  /** 搜索沙箱中指定文件的内容。 */
  async searchInFile(filepath: string, regex: string, sudo = false): Promise<ToolResult> {
    // 正则表达式原样传入沙箱，由沙箱侧负责执行搜索。
    return this.postToolResult('/api/file/search-in-file', {
      filepath,
      regex,
      sudo,
    });
  }

  /** 查找沙箱中指定目录的文件列表。 */
  async findFiles(dirPath: string, globPattern: string): Promise<ToolResult> {
    // glob 模式由沙箱文件服务解释，返回匹配到的文件列表。
    return this.postToolResult('/api/file/find-files', {
      dir_path: dirPath,
      glob_pattern: globPattern,
    });
  }

  /** 传递目录列出沙箱指定目录下的所有文件。 */
  async listFiles(dirPath: string): Promise<ToolResult> {
    return this.findFiles(dirPath, '*');
  }

  /** 传递指定路径检查沙箱中指定文件是否存在。 */
  async checkFileExists(filepath: string): Promise<ToolResult> {
    // 只检查文件是否存在，不读取文件内容。
    return this.postToolResult('/api/file/check-file-exists', { filepath });
  }

  /** 传递路径删除指定的文件。 */
  async deleteFile(filepath: string): Promise<ToolResult> {
    // 删除动作完全交由沙箱执行，保留统一响应格式。
    return this.postToolResult('/api/file/delete-file', { filepath });
  }

  /** 将文件源上传至沙箱指定位置。 */
  async uploadFile(
    fileData: SandboxFileData,
    filepath: string,
    filename?: string,
  ): Promise<ToolResult> {
    // fetch 的 FormData 需要 Blob，这里先把 Buffer 转成 Uint8Array 以兼容类型约束。
    const buffer = await toBuffer(fileData);
    const fileBytes = new Uint8Array(buffer.byteLength);
    fileBytes.set(buffer);
    const formData = new FormData();
    formData.append('file', new Blob([fileBytes], { type: 'application/octet-stream' }), filename || 'upload');
    formData.append('filepath', filepath);

    // 上传接口使用 multipart/form-data，不能手动设置 JSON Content-Type。
    const response = await fetch(`${this.baseUrl}/api/file/upload-file`, {
      method: 'POST',
      body: formData,
    });
    return this.toToolResult(response);
  }

  /** 从沙箱中下载文件。 */
  async downloadFile(filepath: string): Promise<SandboxFileData> {
    // 下载接口通过查询参数传入路径，响应体就是文件二进制内容。
    const url = new URL(`${this.baseUrl}/api/file/download-file`);
    url.searchParams.set('filepath', filepath);
    const response = await fetch(url);

    // 下载失败时没有统一业务响应体，直接抛出 HTTP 状态。
    if (!response.ok) {
      throw new Error(`下载文件失败: HTTP ${response.status}`);
    }

    return Buffer.from(await response.arrayBuffer());
  }

  /** 在沙箱中执行命令。 */
  async execCommand(sessionId: string, execDir: string, command: string): Promise<ToolResult> {
    // sessionId 用来复用同一个 Shell 会话，execDir 是命令执行目录。
    return this.postToolResult('/api/shell/exec-command', {
      session_id: sessionId,
      exec_dir: execDir,
      command,
    });
  }

  /** 读取沙箱中 Shell 的输出。 */
  async readShellOutput(sessionId: string, consoleOutput = false): Promise<ToolResult> {
    // console=true 时沙箱侧会按控制台展示格式返回输出。
    return this.postToolResult('/api/shell/read-shell-output', {
      session_id: sessionId,
      console: consoleOutput,
    });
  }

  /** 向沙箱的 Shell 进程写入数据。 */
  async writeShellInput(
    sessionId: string,
    inputText: string,
    pressEnter = true,
  ): Promise<ToolResult> {
    // pressEnter 控制是否在输入末尾追加回车，支持交互式命令。
    return this.postToolResult('/api/shell/write-shell-input', {
      session_id: sessionId,
      input_text: inputText,
      press_enter: pressEnter,
    });
  }

  /** 等待沙箱中进程的执行。 */
  async waitProcess(sessionId: string, seconds?: number): Promise<ToolResult> {
    // seconds 为空时使用沙箱服务默认等待时间。
    return this.postToolResult('/api/shell/wait-process', {
      session_id: sessionId,
      seconds,
    });
  }

  /** 杀死沙箱中指定进程。 */
  async killProcess(sessionId: string): Promise<ToolResult> {
    // 只结束指定 Shell 会话关联的进程。
    return this.postToolResult('/api/shell/kill-process', {
      session_id: sessionId,
    });
  }

  private async postToolResult(path: string, body: Record<string, unknown>): Promise<ToolResult> {
    // 文件和 Shell JSON 接口都走统一 POST 入口，统一转换为 ToolResult。
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return this.toToolResult(response);
  }

  private async toToolResult<T = unknown>(response: Response): Promise<ToolResult<T>> {
    // 沙箱响应格式固定为 code/msg/data，领域层只消费 ToolResult。
    return toolResultFromSandbox(...await readSandboxResponse<T>(response));
  }
}

async function readSandboxResponse<T>(response: Response): Promise<[number, string, T | undefined]> {
  // 这里不直接依赖 HTTP 状态码，而是读取沙箱业务响应中的 code/msg/data。
  const payload = (await response.json()) as SandboxApiResponse<T>;
  return [payload.code, payload.msg, payload.data];
}

async function toBuffer(fileData: SandboxFileData): Promise<Buffer> {
  // 已经是 Buffer 时直接返回，避免额外复制。
  if (Buffer.isBuffer(fileData)) {
    return fileData;
  }

  // 流式文件需要收集所有 chunk，再合并为完整 Buffer 用于 multipart 上传。
  const chunks: Buffer[] = [];
  for await (const chunk of Readable.from(fileData)) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isDockerNotFoundError(error: unknown): boolean {
  // dockerode 的错误对象不是标准 Error，这里兼容 statusCode 和 reason 两种字段。
  if (!error || typeof error !== 'object') {
    return false;
  }

  const statusCode = (error as { statusCode?: unknown }).statusCode;
  const reason = (error as { reason?: unknown }).reason;
  return statusCode === 404 || reason === 'no such container';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
