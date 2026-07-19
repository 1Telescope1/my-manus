import { Injectable, Logger } from '@nestjs/common';
import { RuntimeEventAdapter } from './runtime-event.adapter';
import { FileStorage } from '../../domain/external/file-storage';
import { JSONParser } from '../../domain/external/json-parser';
import { SandboxManager } from '../../domain/external/sandbox';
import { LLMFactory } from '../../domain/external/llm';
import { SearchEngine } from '../../domain/external/search-engine';
import { Task, TaskManager } from '../../domain/external/task';
import { BaseEvent, Event, events } from '../../domain/models/event';
import { LLMConfig } from '../../domain/models/app-config';
import { Session, SessionStatus } from '../../domain/models/session';
import { UnitOfWork } from '../../domain/repositories/unit-of-work';
import { AgentTaskRunner } from '../../domain/services/runtime/agent-task-runner';
import { createDefaultRuntimeRouteRules } from '../../domain/services/runtime/route-rules';
import { RuntimeRouterService } from '../../domain/services/runtime/router.service';
import { LLMRuntimeRouteModel } from '../../infrastructure/external/llm/llm-runtime-route-model';
import { FileAppConfigRepository } from '../../infrastructure/repositories/file-app-config.repository';

export type ChatOptions = {
  message?: string;
  attachments?: string[];
  latestEventId?: string;
  timestamp?: Date;
};

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  /** 注入会话执行、配置、外部能力和任务管理依赖。 */
  constructor(
    private readonly uow: UnitOfWork,
    private readonly appConfigRepository: FileAppConfigRepository,
    private readonly jsonParser: JSONParser,
    private readonly searchEngine: SearchEngine,
    private readonly fileStorage: FileStorage,
    private readonly taskManager: TaskManager,
    private readonly sandboxManager: SandboxManager,
    private readonly llmFactory: LLMFactory<LLMConfig>,
  ) {
    this.logger.log('AgentService初始化成功');
  }

  /** 根据任务会话获取任务实例。 */
  private getTask(session: Session): Task | undefined {
    // 1. 从会话中取出任务 id。
    const taskId = session.task_id;
    if (!taskId) {
      return undefined;
    }

    // 2. 调用任务类的 get 方法获取任务实例。
    return this.taskManager.get(taskId);
  }

  /** 根据传递的会话创建一个新任务。 */
  private async createTask(session: Session): Promise<Task> {
    // 1. 获取沙箱实例。
    let sandbox = session.sandbox_id
      ? await this.sandboxManager.get(session.sandbox_id)
      : null;

    // 2. 无法获取沙箱时创建一个新的沙箱。
    if (!sandbox) {
      // 3. 沙箱可能已被释放，创建后更新会话信息。
      sandbox = await this.sandboxManager.create();
      session.sandbox_id = sandbox.id;
      await this.uow.run(async (active) => {
        await active.session.save(session);
      });
    }

    // 4. 从沙箱中获取浏览器实例。
    const browser = await sandbox.getBrowser();
    if (!browser) {
      this.logger.error(`获取沙箱[${sandbox.id}]中的浏览器实例失败`);
      throw new Error(`获取沙箱[${sandbox.id}]中的浏览器实例失败`);
    }

    // 5. 创建 AgentTaskRunner。
    const appConfig = await this.appConfigRepository.load();
    const llm = this.llmFactory.create(appConfig.llm_config);
    const taskRunner = new AgentTaskRunner(
      () => this.uow,
      llm,
      appConfig.agent_config,
      appConfig.mcp_config,
      appConfig.a2a_config,
      session.id,
      this.fileStorage,
      this.jsonParser,
      browser,
      this.searchEngine,
      sandbox,
      {
        router: new RuntimeRouterService(new LLMRuntimeRouteModel(llm), {
          rules: createDefaultRuntimeRouteRules(),
        }),
        eventAdapter: new RuntimeEventAdapter(),
      },
    );

    // 6. 创建任务并更新会话中的任务信息。
    const task = this.taskManager.create(taskRunner);
    session.task_id = task.id;
    await this.uow.run(async (active) => {
      await active.session.save(session);
    });
    return task;
  }

  /** 在独立后台任务中更新未读消息计数。 */
  private async safeUpdateUnreadCount(sessionId: string): Promise<void> {
    try {
      await this.uow.run(async (active) => {
        await active.session.updateUnreadMessageCount(sessionId, 0);
      });
    } catch (error) {
      this.logger.warn(`会话[${sessionId}]后台更新未读消息计数失败: ${errorMessage(error)}`);
    }
  }

  /** 根据传递的信息发起对话请求。 */
  async *chat(sessionId: string, options: ChatOptions = {}): AsyncGenerator<BaseEvent> {
    try {
      // 1. 检查会话是否存在。
      const session = await this.uow.run((active) => active.session.getById(sessionId));
      if (!session) {
        this.logger.error(`尝试与不存在的任务会话[${sessionId}]对话`);
        throw new Error('任务会话不存在, 请核实后重试');
      }

      // 2. 获取对应会话任务。
      let task = this.getTask(session);

      // 3. 判断是否传递了 message。
      if (options.message) {
        // 4. 会话不在运行中或任务不存在时，创建一个新任务。
        if (session.status !== SessionStatus.RUNNING || task === undefined) {
          // 5. 创建任务并启动。
          task = await this.createTask(session);
          if (!task) {
            this.logger.error(`会话[${sessionId}]创建任务失败`);
            throw new Error(`会话[${sessionId}]创建任务失败`);
          }
        }

        // 6. 更新会话中的最后一条消息。
        await this.uow.run(async (active) => {
          await active.session.updateLatestMessage(
            sessionId,
            options.message as string,
            options.timestamp ?? new Date(),
          );
        });

        // 从文件数据库中查询附件，并更新为实际文件内容。
        const dbAttachments = await this.uow.run(async (active) => {
          const result = [];
          for (const id of options.attachments ?? []) {
            result.push(await active.file.getById(id));
          }
          return result;
        });

        // 7. 创建一个人类消息事件。
        const messageEvent = events.message({
          role: 'user',
          message: options.message,
          attachments: dbAttachments.filter((attachment) => attachment !== null),
        });

        // 8. 将事件添加到任务输入流，并写入会话事件列表。
        const eventId = await task.inputStream.put(JSON.stringify(messageEvent));
        messageEvent.id = eventId;
        yield messageEvent;
        await this.uow.run(async (active) => {
          await active.session.addEvent(sessionId, messageEvent);
        });

        // 9. 执行任务。
        await task.invoke();
        this.logger.log(`往会话[${sessionId}]输入消息队列写入消息: ${options.message.slice(0, 50)}...`);
      }

      // 10. 记录会话与任务启动信息。
      this.logger.log(`会话[${sessionId}]已启动`);
      this.logger.log(`会话[${sessionId}]任务实例: ${task}`);

      // 11. 从任务输出流中读取数据。
      let latestEventId = options.latestEventId;
      while (task && !task.done) {
        // 12. 从输出消息队列中获取数据。
        const [eventId, eventPayload] = await task.outputStream.get(latestEventId, 0);
        latestEventId = eventId ?? latestEventId;
        if (eventPayload === null) {
          this.logger.debug(`在会话[${sessionId}]输出队列中未发现事件内容`);
          continue;
        }

        // 13. 将事件字符串转换为领域事件实例。
        const event = parseEvent(eventPayload);
        event.id = eventId ?? event.id;
        this.logger.debug(`从会话[${sessionId}]中获取事件: ${event.type}`);

        // 14. 将未读消息数重置为 0。
        await this.uow.run(async (active) => {
          await active.session.updateUnreadMessageCount(sessionId, 0);
        });

        // 15. 返回事件，并在结束、错误或等待事件后停止读取。
        yield event;
        if (event.type === 'done' || event.type === 'error' || event.type === 'wait') {
          break;
        }
      }

      // 16. 循环结束表示本轮运行已结束。
      this.logger.log(`会话[${sessionId}]本轮运行结束`);
    } catch (error) {
      // 17. 记录日志并返回错误事件。
      this.logger.error(`任务会话[${sessionId}]对话出错: ${errorMessage(error)}`);
      const event = events.error(errorMessage(error));
      try {
        await this.uow.run(async (active) => {
          await active.session.addEvent(sessionId, event);
        });
      } catch (addError) {
        this.logger.warn(`会话[${sessionId}]添加错误事件失败(可能是客户端断开连接): ${errorMessage(addError)}`);
      }
      yield event;
    } finally {
      // 18. 流结束后在独立 Promise 中清空未读消息数，避免阻塞响应关闭。
      void this.safeUpdateUnreadCount(sessionId);
    }
  }

  /** 根据会话 id 停止指定会话。 */
  async stopSession(sessionId: string): Promise<void> {
    // 1. 查找会话是否存在。
    const session = await this.uow.run((active) => active.session.getById(sessionId));
    if (!session) {
      this.logger.error(`尝试停止不存在的会话[${sessionId}]`);
      throw new Error('任务会话不存在, 请核实后重试');
    }

    // 2. 根据会话获取任务信息并取消任务。
    const task = this.getTask(session);
    if (task) {
      task.cancel();
      // stop 只有在 Runtime 确认活动链退出后才返回，避免 UI 已停止而后台仍运行。
      await task.waitForCompletion();
    }

    // 3. 更新会话任务状态。
    await this.uow.run(async (active) => {
      await active.session.updateStatus(sessionId, SessionStatus.COMPLETED);
    });
  }

  /** 关闭 Agent 服务并释放所有任务资源。 */
  async shutdown(): Promise<void> {
    this.logger.log('正在清除所有会话任务资源并释放');
    await this.taskManager.destroy();
    this.logger.log('所有会话任务资源清除成功');
  }

}

function parseEvent(payload: unknown): Event {
  const event = (typeof payload === 'string' ? JSON.parse(payload) : payload) as Event;
  event.created_at = event.created_at ? new Date(event.created_at) : new Date();
  return event;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
