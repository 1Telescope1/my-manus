import { Body, Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { AgentService } from '../../application/services/agent.service';
import { SessionService } from '../../application/services/session.service';
import { NotFoundError } from '../../core/errors/app-exception';
import { ApiResponse, ResponseEnvelope } from '../../core/response/api-response';
import { Event } from '../../domain/models/event';
import { Session } from '../../domain/models/session';
import { EventMapper } from '../dto/event.dto';
import {
  ChatRequest,
  CreateSessionResponse,
  FileReadRequest,
  FileReadResponse,
  GetSessionFilesResponse,
  GetSessionResponse,
  ListSessionItem,
  ListSessionResponse,
  ShellReadRequest,
  ShellReadResponse,
} from '../dto/session.dto';

const SESSION_SLEEP_INTERVAL = 5_000;

@Controller('sessions')
export class SessionController {
  constructor(
    private readonly sessionService: SessionService,
    private readonly agentService: AgentService,
  ) {}

  /** 创建一个空白的新任务会话。 */
  @Post()
  async createSession(): Promise<ApiResponse<CreateSessionResponse>> {
    const session = await this.sessionService.createSession();
    return ResponseEnvelope.success(
      { session_id: session.id },
      '创建任务会话成功',
    );
  }

  /** 间隔指定时间流式获取所有会话基础信息列表。 */
  @Post('stream')
  async streamSessions(@Req() request: Request, @Res() response: Response): Promise<void> {
    prepareSseResponse(response);
    let closed = false;
    request.on('close', () => {
      closed = true;
    });

    while (!closed) {
      // 1. 获取所有会话列表。
      const sessions = await this.sessionService.getAllSessions();

      // 2. 循环遍历并组装数据。
      const sessionItems = sessions.map((session) => this.toListItem(session));

      // 3. 将会话列表转换为流式事件数据并返回。
      writeSseEvent(response, 'sessions', { sessions: sessionItems });

      // 4. 睡眠指定时间避免高频响应。
      await sleep(SESSION_SLEEP_INTERVAL);
    }
  }

  /** 获取所有任务会话基础信息列表。 */
  @Get()
  async getAllSessions(): Promise<ApiResponse<ListSessionResponse>> {
    const sessions = await this.sessionService.getAllSessions();
    return ResponseEnvelope.success(
      { sessions: sessions.map((session) => this.toListItem(session)) },
      '获取任务会话列表成功',
    );
  }

  /** 清空指定会话未读消息数。 */
  @Post(':sessionId/clear-unread-message-count')
  async clearUnreadMessageCount(@Param('sessionId') sessionId: string): Promise<ApiResponse> {
    await this.sessionService.clearUnreadMessageCount(sessionId);
    return ResponseEnvelope.success(undefined, '清除未读消息数成功');
  }

  /** 删除指定任务会话。 */
  @Post(':sessionId/delete')
  async deleteSession(@Param('sessionId') sessionId: string): Promise<ApiResponse> {
    await this.sessionService.deleteSession(sessionId);
    return ResponseEnvelope.success(undefined, '删除任务会话成功');
  }

  /** 向指定任务会话发起聊天请求。 */
  @Post(':sessionId/chat')
  async chat(
    @Param('sessionId') sessionId: string,
    @Body() body: ChatRequest,
    @Res() response: Response,
  ): Promise<void> {
    prepareSseResponse(response);

    // 1. 调用 Agent 服务发起聊天。
    for await (const event of this.agentService.chat(sessionId, {
      message: body.message,
      attachments: body.attachments,
      latestEventId: body.event_id,
      timestamp: body.timestamp ? new Date(body.timestamp * 1_000) : undefined,
    })) {
      // 2. 将 Agent 事件转换为 SSE 数据。
      const sseEvent = EventMapper.eventToSseEvent(event as Event);
      writeSseEvent(response, sseEvent.event, sseEvent.data);
    }
    response.end();
  }

  /** 获取指定会话详情。 */
  @Get(':sessionId')
  async getSession(@Param('sessionId') sessionId: string): Promise<ApiResponse<GetSessionResponse>> {
    const session = await this.sessionService.getSession(sessionId);
    if (!session) {
      throw new NotFoundError('该会话不存在，请核实后重试');
    }
    return ResponseEnvelope.success(
      {
        session_id: session.id,
        title: session.title,
        status: session.status,
        events: EventMapper.eventsToSseEvents(session.events),
      },
      '获取会话详情成功',
    );
  }

  /** 停止指定任务会话。 */
  @Post(':sessionId/stop')
  async stopSession(@Param('sessionId') sessionId: string): Promise<ApiResponse> {
    await this.agentService.stopSession(sessionId);
    return ResponseEnvelope.success(undefined, '停止任务会话成功');
  }

  /** 获取指定任务会话文件列表。 */
  @Get(':sessionId/files')
  async getSessionFiles(
    @Param('sessionId') sessionId: string,
  ): Promise<ApiResponse<GetSessionFilesResponse>> {
    const files = await this.sessionService.getSessionFiles(sessionId);
    return ResponseEnvelope.success({ files }, '获取会话文件列表成功');
  }

  /** 查看会话沙箱中指定文件的内容。 */
  @Post(':sessionId/file')
  async readFile(
    @Param('sessionId') sessionId: string,
    @Body() body: FileReadRequest,
  ): Promise<ApiResponse<FileReadResponse>> {
    const result = await this.sessionService.readFile(sessionId, body.filepath);
    return ResponseEnvelope.success(result, '获取会话文件内容成功');
  }

  /** 查看会话的 Shell 内容输出。 */
  @Post(':sessionId/shell')
  async readShellOutput(
    @Param('sessionId') sessionId: string,
    @Body() body: ShellReadRequest,
  ): Promise<ApiResponse<ShellReadResponse>> {
    const result = await this.sessionService.readShellOutput(sessionId, body.session_id);
    return ResponseEnvelope.success(result, '获取Shell内容输出结果成功');
  }

  private toListItem(session: Session): ListSessionItem {
    return {
      session_id: session.id,
      title: session.title,
      latest_message: session.latest_message,
      latest_message_at: session.latest_message_at,
      status: session.status,
      unread_message_count: session.unread_message_count,
    };
  }
}

function prepareSseResponse(response: Response): void {
  response.status(200);
  response.setHeader('Content-Type', 'text/event-stream');
  response.setHeader('Cache-Control', 'no-cache');
  response.setHeader('Connection', 'keep-alive');
  response.flushHeaders();
}

function writeSseEvent(response: Response, event: string, data: unknown): void {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
