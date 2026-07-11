import { Injectable, Logger } from '@nestjs/common';
import { NotFoundError, ServerRequestsError } from '../../core/errors/app-exception';
import { SandboxConstructor } from '../../domain/external/sandbox';
import { FileModel } from '../../domain/models/file';
import { createSession, Session } from '../../domain/models/session';
import { UnitOfWork } from '../../domain/repositories/unit-of-work';
import { DockerSandbox } from '../../infrastructure/external/sandbox/docker-sandbox';
import { FileReadResponse, ShellReadResponse } from '../../interfaces/dto/session.dto';

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);
  private readonly sandboxClass: SandboxConstructor = DockerSandbox;

  constructor(private readonly uow: UnitOfWork) {}

  /** 创建一个空白的新任务会话。 */
  async createSession(): Promise<Session> {
    this.logger.log('创建一个空白新任务会话');
    const session = createSession({ title: '新对话' });
    await this.uow.run(async (active) => {
      await active.session.save(session);
    });
    this.logger.log(`成功创建一个新任务会话: ${session.id}`);
    return session;
  }

  /** 获取项目所有任务会话列表。 */
  async getAllSessions(): Promise<Session[]> {
    return this.uow.run((active) => active.session.getAll());
  }

  /** 清空指定会话未读消息数。 */
  async clearUnreadMessageCount(sessionId: string): Promise<void> {
    this.logger.log(`清除会话[${sessionId}]未读消息数`);
    await this.uow.run(async (active) => {
      await active.session.updateUnreadMessageCount(sessionId, 0);
    });
  }

  /** 根据传递的会话 id 删除任务会话。 */
  async deleteSession(sessionId: string): Promise<void> {
    // 1. 先检查会话是否存在。
    this.logger.log(`正在删除会话, 会话id: ${sessionId}`);
    const session = await this.uow.run((active) => active.session.getById(sessionId));
    if (!session) {
      this.logger.error(`会话[${sessionId}]不存在, 删除失败`);
      throw new NotFoundError(`会话[${sessionId}]不存在, 删除失败`);
    }

    // 2. 根据传递的会话 id 删除会话。
    await this.uow.run(async (active) => {
      await active.session.deleteById(sessionId);
    });
    this.logger.log(`删除会话[${sessionId}]成功`);
  }

  /** 获取指定会话详情信息。 */
  async getSession(sessionId: string): Promise<Session | null> {
    return this.uow.run((active) => active.session.getById(sessionId));
  }

  /** 获取指定会话的文件列表信息。 */
  async getSessionFiles(sessionId: string): Promise<FileModel[]> {
    this.logger.log(`获取指定会话[${sessionId}]下的文件列表信息`);
    const session = await this.uow.run((active) => active.session.getById(sessionId));
    if (!session) {
      throw new Error(`当前会话不存在[${sessionId}], 请核实后重试`);
    }
    return session.files;
  }

  /** 查看会话中指定文件的内容。 */
  async readFile(sessionId: string, filepath: string): Promise<FileReadResponse> {
    // 1. 检查会话是否存在。
    this.logger.log(`获取会话[${sessionId}]中的文件内容, 文件路径: ${filepath}`);
    const session = await this.uow.run((active) => active.session.getById(sessionId));
    if (!session) {
      throw new Error(`当前会话不存在[${sessionId}], 请核实后重试`);
    }

    // 2. 根据沙箱 id 获取沙箱并判断是否存在。
    const sandbox = await this.getSessionSandbox(session);

    // 3. 调用沙箱读取文件内容。
    const result = await sandbox.readFile(filepath);
    if (result.success) {
      return result.data as FileReadResponse;
    }
    throw new ServerRequestsError(result.message);
  }

  /** 获取 Shell 执行结果。 */
  async readShellOutput(sessionId: string, shellSessionId: string): Promise<ShellReadResponse> {
    // 1. 检查会话是否存在。
    this.logger.log(`获取会话[${sessionId}]中的Shell内容输出, Shell标识符: ${shellSessionId}`);
    const session = await this.uow.run((active) => active.session.getById(sessionId));
    if (!session) {
      throw new Error(`当前会话不存在[${sessionId}], 请核实后重试`);
    }

    // 2. 根据沙箱 id 获取沙箱并判断是否存在。
    const sandbox = await this.getSessionSandbox(session);

    // 3. 调用沙箱查看 Shell 内容。
    const result = await sandbox.readShellOutput(shellSessionId, true);
    if (result.success) {
      return result.data as ShellReadResponse;
    }
    throw new ServerRequestsError(result.message);
  }

  /** 获取指定会话的 VNC 链接。 */
  async getVncUrl(sessionId: string): Promise<string> {
    // 1. 检查会话是否存在。
    this.logger.log(`获取会话[${sessionId}]的VNC链接`);
    const session = await this.uow.run((active) => active.session.getById(sessionId));
    if (!session) {
      throw new Error(`当前会话不存在[${sessionId}], 请核实后重试`);
    }

    // 2. 获取会话沙箱并返回 VNC 地址。
    return (await this.getSessionSandbox(session)).vncUrl;
  }

  private async getSessionSandbox(session: Session) {
    if (!session.sandbox_id) {
      throw new NotFoundError('当前会话无沙箱环境');
    }
    const sandbox = await this.sandboxClass.get(session.sandbox_id);
    if (!sandbox) {
      throw new NotFoundError('当前会话沙箱不存在或已销毁');
    }
    return sandbox;
  }
}
