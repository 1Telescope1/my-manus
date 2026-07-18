import { Injectable, Logger } from '@nestjs/common';
import { createConnection } from 'node:net';
import { getSettings } from '../core/config/settings';
import { AppException, BadRequestException } from '../interfaces/errors/exceptions';
import {
  type ProcessInfo,
  type SupervisorActionResult,
  type SupervisorTimeout,
} from '../models/supervisor';

type XmlRpcValue = string | number | boolean | null | XmlRpcValue[] | { [key: string]: XmlRpcValue };
type XmlChild = XmlNode | string;
type XmlNode = {
  name: string;
  children: XmlChild[];
};

/*
1. Supervisor 启动后，通过 Unix 套接字文件实现通信，底层协议是 XML-RPC。
2. 连接通信文件 /tmp/supervisor.sock。
3. 将 XML-RPC 请求转换为本地 socket 上的 HTTP 请求。
4. 连接之后即可调用 RPC 对应方法，例如 supervisor.getAllProcessInfo()。
*/
/** Supervisor 服务。 */
@Injectable()
export class SupervisorService {
  private readonly logger = new Logger(SupervisorService.name);
  private readonly rpcUrl = '/tmp/supervisor.sock';
  private timeoutActive: boolean;
  private shutdownTime: Date | null = null;
  private shutdownTimer: NodeJS.Timeout | null = null;
  private expandEnabledState = true;

  /** 构造函数，完成 supervisor 服务连接信息和超时配置初始化。 */
  constructor() {
    // 1. 读取 supervisor 超时配置。
    const settings = getSettings();
    this.timeoutActive = settings.serverTimeoutMinutes > 0;

    // 2. 检测是否配置了自动销毁。
    if (this.timeoutActive) {
      // 3. 设置销毁时间和定时器。
      this.shutdownTime = addMinutes(new Date(), settings.serverTimeoutMinutes);
      this.setupTimer(settings.serverTimeoutMinutes);
    }
  }

  /** 只读属性，返回是否自动保活。 */
  get expandEnabled(): boolean {
    return this.expandEnabledState;
  }

  /** 只读属性，返回是否已经开启超时销毁。 */
  get isTimeoutActive(): boolean {
    return this.timeoutActive;
  }

  /** 开启自动保活。 */
  enableExpand(): void {
    this.expandEnabledState = true;
  }

  /** 关闭自动保活。 */
  disableExpand(): void {
    this.expandEnabledState = false;
  }

  /** 传递时间(分钟)并创建定时器，在时间结束之后关闭 supervisord 主进程。 */
  private setupTimer(minutes: number): void {
    // 1. 检测当前是否存在销毁任务，如果存在则先取消。
    if (this.shutdownTimer) {
      clearTimeout(this.shutdownTimer);
      this.shutdownTimer = null;
    }

    // 2. 创建一个定时器，在后台等待指定分钟后关闭服务。
    this.shutdownTimer = setTimeout(() => {
      void this.shutdown().catch((error: unknown) => {
        this.logger.warn(`超时关闭supervisord失败: ${errorMessage(error)}`);
      });
    }, minutes * 60 * 1000);
  }

  /** 根据传递的方法和参数调用 RPC 方法。 */
  private async callRpc(methodName: string, ...args: XmlRpcValue[]): Promise<XmlRpcValue> {
    try {
      const body = encodeXmlRpcRequest(methodName, args);
      const responseBody = await this.sendXmlRpcRequest(body);
      return parseXmlRpcResponse(responseBody);
    } catch (error) {
      const message = errorMessage(error);
      this.logger.error(`RPC方法调用失败: ${message}`);
      throw new BadRequestException(`RPC方法调用失败: ${message}`);
    }
  }

  /** 使用本地 Unix socket 文件连接 RPC 服务。 */
  private sendXmlRpcRequest(body: string): Promise<string> {
    const request = [
      'POST /RPC2 HTTP/1.1',
      'Host: localhost',
      'User-Agent: manus-sandbox-ts',
      'Content-Type: text/xml',
      `Content-Length: ${Buffer.byteLength(body, 'utf8')}`,
      'Connection: close',
      '',
      body,
    ].join('\r\n');

    return new Promise((resolve, reject) => {
      const socket = createConnection({ path: this.rpcUrl });
      const chunks: Buffer[] = [];
      let settled = false;

      const finish = (handler: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        handler();
      };

      socket.setTimeout(30_000);
      socket.once('connect', () => {
        socket.write(request);
      });
      socket.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      socket.once('timeout', () => {
        socket.destroy();
        finish(() => reject(new Error('Supervisor RPC请求超时')));
      });
      socket.once('error', (error) => {
        finish(() => reject(error));
      });
      socket.once('end', () => {
        finish(() => {
          try {
            resolve(extractHttpBody(Buffer.concat(chunks)));
          } catch (error) {
            reject(error);
          }
        });
      });
      socket.once('close', () => {
        if (!settled) {
          finish(() => {
            if (chunks.length === 0) {
              reject(new Error('Supervisor RPC连接已关闭'));
              return;
            }

            try {
              resolve(extractHttpBody(Buffer.concat(chunks)));
            } catch (error) {
              reject(error);
            }
          });
        }
      });
    });
  }

  /** 获取当前 supervisor 管理的所有进程信息。 */
  async getAllProcesses(): Promise<ProcessInfo[]> {
    try {
      const processes = await this.callRpc('supervisor.getAllProcessInfo');
      return Array.isArray(processes) ? processes.map(toProcessInfo) : [];
    } catch (error) {
      const message = errorMessage(error);
      this.logger.error(`获取进程信息失败: ${message}`);
      throw new AppException(`获取进程信息失败: ${message}`);
    }
  }

  /** 停止 supervisor 管理的所有进程。 */
  async stopAllProcesses(): Promise<SupervisorActionResult> {
    try {
      const result = await this.callRpc('supervisor.stopAllProcesses');
      return { status: 'stopped', result };
    } catch (error) {
      const message = errorMessage(error);
      this.logger.error(`停止supervisor所有进程服务失败: ${message}`);
      throw new AppException(`停止supervisor所有进程服务失败: ${message}`);
    }
  }

  /** 关闭 supervisord 服务。 */
  async shutdown(): Promise<SupervisorActionResult> {
    try {
      const shutdownResult = await this.callRpc('supervisor.shutdown');
      return { status: 'shutdown', shutdown_result: shutdownResult };
    } catch (error) {
      const message = errorMessage(error);
      this.logger.error(`关闭supervisord服务失败: ${message}`);
      throw new AppException(`关闭supervisord服务失败: ${message}`);
    }
  }

  /** 重启 Supervisor 管理的进程。 */
  async restart(): Promise<SupervisorActionResult> {
    try {
      const stopResult = await this.callRpc('supervisor.stopAllProcesses');
      const startResult = await this.callRpc('supervisor.startAllProcesses');
      return {
        status: 'restarted',
        stop_result: stopResult,
        start_result: startResult,
      };
    } catch {
      this.logger.error('重启Supervisor进程服务失败');
      throw new AppException('重启Supervisor进程服务失败');
    }
  }

  /** 传递指定分钟，并激活定时销毁任务同时关闭自动保活。 */
  async activateTimeout(minutes?: number | null): Promise<SupervisorTimeout> {
    // 1. 获取超时分钟数。
    const settings = getSettings();
    const timeoutMinutes = minutes || settings.serverTimeoutMinutes;
    if (timeoutMinutes === null || timeoutMinutes === undefined) {
      throw new BadRequestException('超时时间未配置, 并且未读取到系统默认超时时间');
    }

    // 2. 更新超时配置。
    this.timeoutActive = true;
    this.shutdownTime = addMinutes(new Date(), timeoutMinutes);

    // 3. 创建一个新的定时器。
    this.setupTimer(timeoutMinutes);

    return {
      status: 'timeout_activated',
      active: true,
      shutdown_time: this.shutdownTime.toISOString(),
      timeout_minutes: timeoutMinutes,
      remaining_seconds: remainingSeconds(this.shutdownTime),
    };
  }

  /** 传递指定的时长，延长超时销毁的时间，默认延长 3 分钟。 */
  async extendTimeout(minutes: number | null = 3): Promise<SupervisorTimeout> {
    // 1. 获取超时分钟数。
    if (minutes === null || minutes === undefined) {
      throw new BadRequestException('超时时间未配置, 请核实后重试');
    }

    if (!this.shutdownTime) {
      throw new BadRequestException('超时时间未配置, 请核实后重试');
    }

    const remaining = remainingSeconds(this.shutdownTime);
    const timeoutMinutes = Math.round(Math.max(0, remaining) / 60) + minutes;

    // 2. 更新超时配置。
    this.timeoutActive = true;
    this.shutdownTime = addMinutes(new Date(), timeoutMinutes);

    // 3. 创建一个新的定时器。
    this.setupTimer(timeoutMinutes);

    return {
      status: 'timeout_extended',
      active: true,
      shutdown_time: this.shutdownTime.toISOString(),
      timeout_minutes: timeoutMinutes,
      remaining_seconds: remainingSeconds(this.shutdownTime),
    };
  }

  /** 取消超时销毁设置。 */
  async cancelTimeout(): Promise<SupervisorTimeout> {
    // 1. 判断是否设置了超时销毁。
    if (!this.timeoutActive) {
      return { status: 'no_timeout_active', active: false };
    }

    // 2. 取消销毁任务。
    if (this.shutdownTimer) {
      clearTimeout(this.shutdownTimer);
      this.shutdownTimer = null;
    }

    // 3. 更新超时配置。
    this.timeoutActive = false;
    this.shutdownTime = null;
    this.expandEnabledState = true;

    return { status: 'timeout_cancelled', active: false };
  }

  /** 获取当前 supervisor 的超时状态。 */
  async getTimeoutStatus(): Promise<SupervisorTimeout> {
    // 1. 判断是否开启超时销毁功能。
    if (!this.timeoutActive) {
      return { active: false };
    }

    // 2. 统计剩余秒数。
    return {
      active: this.timeoutActive,
      shutdown_time: this.shutdownTime ? this.shutdownTime.toISOString() : null,
      remaining_seconds: this.shutdownTime ? remainingSeconds(this.shutdownTime) : 0,
    };
  }
}

/** 生成 XML-RPC methodCall 请求体。 */
function encodeXmlRpcRequest(methodName: string, args: XmlRpcValue[]): string {
  const params = args.map((arg) => `<param><value>${encodeXmlRpcValue(arg)}</value></param>`).join('');
  return `<?xml version="1.0"?><methodCall><methodName>${escapeXml(methodName)}</methodName><params>${params}</params></methodCall>`;
}

/** 将普通值编码为 XML-RPC value 节点。 */
function encodeXmlRpcValue(value: XmlRpcValue): string {
  if (value === null) {
    return '<nil/>';
  }

  if (typeof value === 'boolean') {
    return `<boolean>${value ? '1' : '0'}</boolean>`;
  }

  if (typeof value === 'number') {
    return Number.isInteger(value) ? `<int>${value}</int>` : `<double>${value}</double>`;
  }

  if (typeof value === 'string') {
    return `<string>${escapeXml(value)}</string>`;
  }

  if (Array.isArray(value)) {
    return `<array><data>${value.map((item) => `<value>${encodeXmlRpcValue(item)}</value>`).join('')}</data></array>`;
  }

  const members = Object.entries(value)
    .map(([key, item]) => `<member><name>${escapeXml(key)}</name><value>${encodeXmlRpcValue(item)}</value></member>`)
    .join('');
  return `<struct>${members}</struct>`;
}

/** 从 RPC 返回的 HTTP 报文中提取响应体。 */
function extractHttpBody(response: Buffer): string {
  const raw = response.toString('utf8');
  const separator = raw.includes('\r\n\r\n') ? '\r\n\r\n' : '\n\n';
  const separatorIndex = raw.indexOf(separator);
  if (separatorIndex < 0) {
    return raw;
  }

  const headerText = raw.slice(0, separatorIndex);
  const bodyBuffer = response.subarray(Buffer.byteLength(raw.slice(0, separatorIndex + separator.length), 'utf8'));
  const statusLine = headerText.split(/\r?\n/)[0] ?? '';
  const status = Number(statusLine.split(/\s+/)[1]);
  if (Number.isFinite(status) && (status < 200 || status >= 300)) {
    throw new Error(`Supervisor RPC HTTP状态异常: ${statusLine}`);
  }

  if (/transfer-encoding:\s*chunked/i.test(headerText)) {
    return decodeChunkedBody(bodyBuffer).toString('utf8');
  }

  return bodyBuffer.toString('utf8');
}

/** 解码 chunked 响应体。 */
function decodeChunkedBody(body: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let cursor = 0;

  while (cursor < body.length) {
    const lineEnd = body.indexOf('\r\n', cursor);
    if (lineEnd < 0) {
      break;
    }

    const sizeText = body.toString('ascii', cursor, lineEnd).trim();
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size) || size <= 0) {
      break;
    }

    const start = lineEnd + 2;
    const end = start + size;
    chunks.push(body.subarray(start, end));
    cursor = end + 2;
  }

  return Buffer.concat(chunks);
}

/** 解析 XML-RPC methodResponse 响应体。 */
function parseXmlRpcResponse(xml: string): XmlRpcValue {
  const root = parseXml(xml);
  const methodResponse = firstElement(root, 'methodResponse');
  if (!methodResponse) {
    throw new Error('Supervisor RPC响应缺少methodResponse');
  }

  const fault = firstElement(methodResponse, 'fault');
  if (fault) {
    const faultValue = firstElement(fault, 'value');
    const parsedFault = faultValue ? parseXmlRpcValue(faultValue) : null;
    if (isObjectValue(parsedFault) && typeof parsedFault.faultString === 'string') {
      throw new Error(parsedFault.faultString);
    }
    throw new Error('Supervisor RPC返回fault');
  }

  const params = firstElement(methodResponse, 'params');
  const param = params ? firstElement(params, 'param') : null;
  const value = param ? firstElement(param, 'value') : null;
  if (!value) {
    return null;
  }

  return parseXmlRpcValue(value);
}

/** 将 XML 文本解析为当前服务所需的最小节点树。 */
function parseXml(xml: string): XmlNode {
  const documentNode: XmlNode = { name: '#document', children: [] };
  const stack: XmlNode[] = [documentNode];
  const tokenPattern = /<\?xml[^>]*\?>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[A-Za-z0-9_.:-]+(?:\s+[^<>]*)?\/?>|[^<]+/g;
  const tokens = xml.match(tokenPattern) ?? [];

  for (const token of tokens) {
    if (token.startsWith('<?') || token.startsWith('<!--')) {
      continue;
    }

    if (token.startsWith('<![CDATA[')) {
      currentXmlNode(stack).children.push(token.slice(9, -3));
      continue;
    }

    if (token.startsWith('</')) {
      const tagName = token.slice(2, -1).trim();
      if (currentXmlNode(stack).name === tagName) {
        stack.pop();
      }
      continue;
    }

    if (token.startsWith('<')) {
      const selfClosing = token.endsWith('/>');
      const match = token.match(/^<\s*([^\s/>]+)/);
      if (!match) {
        continue;
      }

      const node: XmlNode = { name: match[1], children: [] };
      currentXmlNode(stack).children.push(node);
      if (!selfClosing) {
        stack.push(node);
      }
      continue;
    }

    if (token.trim()) {
      currentXmlNode(stack).children.push(unescapeXml(token));
    }
  }

  return documentNode;
}

/** 将 XML-RPC value 节点转换为普通值。 */
function parseXmlRpcValue(valueNode: XmlNode): XmlRpcValue {
  const element = valueNode.children.find((child): child is XmlNode => typeof child !== 'string');
  if (!element) {
    return textContent(valueNode);
  }

  switch (element.name) {
    case 'string':
    case 'dateTime.iso8601':
      return textContent(element);
    case 'int':
    case 'i4':
    case 'i8':
      return Number.parseInt(textContent(element), 10);
    case 'double':
      return Number.parseFloat(textContent(element));
    case 'boolean':
      return textContent(element).trim() === '1';
    case 'array': {
      const data = firstElement(element, 'data');
      if (!data) {
        return [];
      }
      return data.children
        .filter((child): child is XmlNode => typeof child !== 'string' && child.name === 'value')
        .map(parseXmlRpcValue);
    }
    case 'struct': {
      const result: Record<string, XmlRpcValue> = {};
      const members = element.children.filter(
        (child): child is XmlNode => typeof child !== 'string' && child.name === 'member',
      );
      for (const member of members) {
        const name = firstElement(member, 'name');
        const value = firstElement(member, 'value');
        if (name && value) {
          result[textContent(name)] = parseXmlRpcValue(value);
        }
      }
      return result;
    }
    case 'nil':
      return null;
    default:
      return textContent(element);
  }
}

function firstElement(node: XmlNode, name: string): XmlNode | null {
  return node.children.find((child): child is XmlNode => typeof child !== 'string' && child.name === name) ?? null;
}

function currentXmlNode(stack: XmlNode[]): XmlNode {
  return stack[stack.length - 1];
}

function textContent(node: XmlNode): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : textContent(child)))
    .join('');
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function unescapeXml(value: string): string {
  return value
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function isObjectValue(value: XmlRpcValue): value is Record<string, XmlRpcValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toProcessInfo(value: XmlRpcValue): ProcessInfo {
  const process: Record<string, XmlRpcValue> = isObjectValue(value) ? value : {};
  return {
    name: stringValue(process.name),
    group: stringValue(process.group),
    description: stringValue(process.description),
    start: numberValue(process.start),
    stop: numberValue(process.stop),
    now: numberValue(process.now),
    state: numberValue(process.state),
    statename: stringValue(process.statename),
    spawnerr: stringValue(process.spawnerr),
    exitstatus: numberValue(process.exitstatus),
    logfile: stringValue(process.logfile),
    stdout_logfile: stringValue(process.stdout_logfile),
    stderr_logfile: stringValue(process.stderr_logfile),
    pid: numberValue(process.pid),
  };
}

function stringValue(value: XmlRpcValue | undefined): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: XmlRpcValue | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function remainingSeconds(date: Date): number {
  return Math.max(0, (date.getTime() - Date.now()) / 1000);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
