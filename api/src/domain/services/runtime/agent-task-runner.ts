import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { Logger } from '@nestjs/common';
import { Browser } from '../../external/browser';
import { FileStorage } from '../../external/file-storage';
import { JSONParser } from '../../external/json-parser';
import { LLM } from '../../external/llm';
import { Sandbox, SandboxFileData } from '../../external/sandbox';
import { SearchEngine } from '../../external/search-engine';
import { Task, TaskRunner } from '../../external/task';
import { AgentConfig, A2AConfig, MCPConfig } from '../../models/app-config';
import {
  A2AToolContent,
  BaseEvent,
  Event,
  MCPToolContent,
  MessageEvent,
  TitleEvent,
  ToolEvent,
  ToolEventStatus,
  events,
} from '../../models/event';
import { createFileModel, FileModel } from '../../models/file';
import { createMessage, Message } from '../../models/message';
import { SearchResults } from '../../models/search';
import { RuntimeEvent } from '../../models/runtime-event';
import { SessionStatus } from '../../models/session';
import { ToolResult } from '../../models/tool-result';
import { UnitOfWork } from '../../repositories/unit-of-work';
import { PlannerReActFlow } from '../flows/planner-react-flow';
import {
  AgentToolRuntimeInvoker,
  LLMDirectResponseProvider,
  LLMSingleToolProvider,
  PlannerFlowRuntimeRunner,
  UnavailableRuntimeWorkflowRunner,
} from './adapters';
import {
  DirectRuntimeExecutor,
  PlannedAgentRuntimeExecutor,
  RuntimeExecutorDispatcher,
  SingleToolRuntimeExecutor,
  WorkflowRuntimeExecutor,
} from './executor.service';
import { RuntimeRouterService } from './router.service';
import { RuntimeService } from './runtime.service';
import { PersistentToolIdempotencyStore } from './persistent-tool-idempotency.store';
import { A2ATool } from '../tools/a2a.tool';
import {
  createAgentToolRegistry,
  createAgentToolset,
  synchronizeAgentToolRegistry,
} from '../tools/agent-toolset';
import { MCPTool } from '../tools/mcp.tool';
import { throwIfAborted } from './cancellation';

/** AgentTaskRunner 依赖的 Runtime Event 转换边界。 */
export interface RuntimeEventAdapterPort {
  /** 将一条 Runtime Event 转换为当前 Session/UI 使用的 Event。 */
  adapt(event: RuntimeEvent): Event | null;
}

/** 创建 AgentTaskRunner 所需的 Runtime 协作依赖。 */
export type AgentTaskRunnerOptions = {
  router: RuntimeRouterService;
  eventAdapter: RuntimeEventAdapterPort;
};

export class AgentTaskRunner extends TaskRunner {
  private readonly logger = new Logger(AgentTaskRunner.name);
  private readonly uow: UnitOfWork;
  private readonly mcpTool = new MCPTool();
  private readonly a2aTool = new A2ATool();
  private readonly flow: PlannerReActFlow;
  private readonly runtime: RuntimeService;
  private readonly runtimeEventAdapter: RuntimeEventAdapterPort;
  private readonly generatedFilePaths = new Set<string>();
  private readonly syncedGeneratedFiles = new Map<string, FileModel>();
  private readonly attachedGeneratedFilePaths = new Set<string>();

  /** 创建共享同一 Session、Sandbox 和工具资源的任务运行器。 */
  constructor(
    private readonly uowFactory: () => UnitOfWork,
    private readonly llm: LLM,
    private readonly agentConfig: AgentConfig,
    private readonly mcpConfig: MCPConfig,
    private readonly a2aConfig: A2AConfig,
    private readonly sessionId: string,
    private readonly fileStorage: FileStorage,
    private readonly jsonParser: JSONParser,
    private readonly browser: Browser,
    private readonly searchEngine: SearchEngine,
    private readonly sandbox: Sandbox,
    runtimeOptions: AgentTaskRunnerOptions,
  ) {
    super();
    this.uow = this.uowFactory();
    const toolIdempotencyStore = new PersistentToolIdempotencyStore(this.uowFactory);
    this.flow = new PlannerReActFlow(
      this.uowFactory,
      this.llm,
      this.agentConfig,
      this.sessionId,
      this.jsonParser,
      this.browser,
      this.sandbox,
      this.searchEngine,
      this.mcpTool,
      this.a2aTool,
      toolIdempotencyStore,
    );
    this.runtimeEventAdapter = runtimeOptions.eventAdapter;
    const tools = createAgentToolset({
      browser: this.browser,
      sandbox: this.sandbox,
      searchEngine: this.searchEngine,
      mcpTool: this.mcpTool,
      a2aTool: this.a2aTool,
    });
    const toolRegistry = createAgentToolRegistry(tools);
    const singleToolProvider = new LLMSingleToolProvider(
      this.llm,
      this.jsonParser,
      tools,
    );
    const dispatcher = new RuntimeExecutorDispatcher([
      new DirectRuntimeExecutor(new LLMDirectResponseProvider(this.llm)),
      new SingleToolRuntimeExecutor(
        singleToolProvider,
        new AgentToolRuntimeInvoker(tools, toolIdempotencyStore),
        singleToolProvider,
      ),
      new WorkflowRuntimeExecutor(new UnavailableRuntimeWorkflowRunner()),
      new PlannedAgentRuntimeExecutor(new PlannerFlowRuntimeRunner(this.flow)),
    ]);
    this.runtime = new RuntimeService(
      this.uowFactory,
      runtimeOptions.router,
      dispatcher,
      {
        availableToolCapabilities: () => {
          // MCP 在 Runner 构造后才初始化，路由前必须吸收本轮新发现的 Descriptor。
          synchronizeAgentToolRegistry(toolRegistry, tools);
          return [...new Set(
            toolRegistry.list().flatMap((descriptor) => descriptor.capabilities),
          )];
        },
      },
    );
  }

  /** 向指定任务的消息队列中添加事件，并同步写入会话事件列表。 */
  private async putAndAddEvent(task: Task, event: Event): Promise<void> {
    // 1. 往任务输出消息队列中新增事件。
    const eventId = await task.outputStream.put(JSON.stringify(event));
    event.id = eventId;

    // 2. 将事件添加到对应会话中。
    await this.uow.run(async (active) => {
      await active.session.addEvent(this.sessionId, event);
    });
  }

  /** 从任务输入流中获取事件信息。 */
  private async popEvent(task: Task): Promise<Event> {
    // 1. 从任务 input stream 中读取数据。
    const [eventId, eventPayload] = await task.inputStream.pop();
    if (eventPayload == null) {
      this.logger.warn('AgentTaskRunner接收到空消息');
      return undefined as unknown as Event;
    }

    // 2. 将字符串或普通对象转换成事件对象。
    const event = this.parseEvent(eventPayload);
    event.id = eventId ?? event.id;
    return event;
  }

  /** 根据文件 id 将文件同步到沙箱中。 */
  private async syncFileToSandbox(fileId: string): Promise<FileModel | undefined> {
    try {
      // 1. 调用文件存储下载文件信息。
      const [fileData, file] = await this.fileStorage.downloadFile(fileId);

      // 2. 组装沙箱文件路径。
      const filepath = `/home/ubuntu/upload/${file.filename}`;

      // 3. 调用沙箱将文件上传至沙箱。
      const toolResult = await this.sandbox.uploadFile(fileData, filepath, file.filename);

      // 4. 判断是否上传成功。
      if (toolResult.success) {
        file.filepath = filepath;
        await this.uow.run(async (active) => {
          await active.file.save(file);
        });
        return file;
      }
    } catch (error) {
      this.logger.error(`AgentTaskRunner同步文件[${fileId}]失败: ${errorMessage(error)}`);
    }
    return undefined;
  }

  /** 将消息事件中的附件同步到沙箱中。 */
  private async syncMessageAttachmentsToSandbox(event: MessageEvent): Promise<void> {
    // 1. 定义附件列表。
    const attachments: FileModel[] = [];

    try {
      // 2. 判断消息中是否存在附件。
      if (event.attachments.length) {
        // 3. 循环遍历所有消息附件。
        for (const attachment of event.attachments) {
          // 4. 根据文件 id 将数据同步到沙箱中。
          const file = await this.syncFileToSandbox(attachment.id);

          // 5. 文件同步成功则加入会话文件列表。
          if (file) {
            attachments.push(file);
            await this.uow.run(async (active) => {
              await active.session.addFile(this.sessionId, file);
            });
          }
        }
      }

      // 6. 更新消息事件中的 attachments。
      event.attachments = attachments;
    } catch (error) {
      this.logger.error(`AgentTaskRunner同步消息附件到沙箱失败: ${errorMessage(error)}`);
    }
  }

  /** 将沙箱中的指定文件同步到文件存储中。 */
  private async syncFileToStorage(filepath: string): Promise<FileModel | undefined> {
    try {
      // 1. 根据文件路径从会话中查找文件数据。
      const existing = await this.uow.run((active) =>
        active.session.getFileByPath(this.sessionId, filepath),
      );

      // 2. 从沙箱中下载文件。
      const fileData = await this.sandbox.downloadFile(filepath);

      // 3. 判断会话中的文件是否存在，存在则先移除旧记录。
      if (existing) {
        await this.uow.run(async (active) => {
          await active.session.removeFile(this.sessionId, existing.id);
        });
      }

      // 4. 提取文件名和文件内容。
      const filename = filepath.split('/').pop() || filepath;
      const buffer = await this.toBuffer(fileData);

      // 5. 上传文件到文件存储。
      const file = await this.fileStorage.uploadFile({
        buffer,
        originalname: filename,
        size: buffer.length,
      });
      file.filepath = filepath;

      // 6. 往会话中新增文件信息。
      await this.uow.run(async (active) => {
        await active.session.addFile(this.sessionId, file);
      });
      return file;
    } catch (error) {
      this.logger.error(`AgentTaskRunner同步消息附件到文件存储失败: ${errorMessage(error)}`);
    }
    return undefined;
  }

  /** 将消息事件的附件同步到文件存储中。 */
  private async syncMessageAttachmentsToStorage(event: MessageEvent): Promise<void> {
    // 1. 定义附件列表存储数据。
    const attachments: FileModel[] = [];

    try {
      // 2. 判断消息中是否存在附件。
      if (event.attachments.length) {
        // 3. 循环遍历所有附件。
        for (const attachment of event.attachments) {
          // 4. 根据文件路径将数据同步到文件存储。
          const file = this.syncedGeneratedFiles.get(attachment.filepath)
            ?? await this.syncFileToStorage(attachment.filepath);
          if (file) {
            attachments.push(file);
            this.attachedGeneratedFilePaths.add(attachment.filepath);
          }
        }
      }

      // 5. 更新事件中的附件列表资源。
      event.attachments = attachments;
    } catch (error) {
      this.logger.error(`AgentTaskRunner同步消息附件到存储失败: ${errorMessage(error)}`);
    }
  }

  /** 将本轮工具生成但尚未返回给用户的文件补充到消息附件中。 */
  private async attachGeneratedFiles(event: MessageEvent): Promise<void> {
    const attachments = [...event.attachments];
    const attachmentPaths = new Set(attachments.map((file) => file.filepath));

    for (const filepath of this.generatedFilePaths) {
      if (this.attachedGeneratedFilePaths.has(filepath)) {
        continue;
      }

      let file = this.syncedGeneratedFiles.get(filepath);
      if (!file) {
        file = await this.syncFileToStorage(filepath);
        if (file) {
          this.syncedGeneratedFiles.set(filepath, file);
        }
      }

      if (!file) {
        continue;
      }

      if (!attachmentPaths.has(filepath)) {
        attachments.push(file);
        attachmentPaths.add(filepath);
      }
      this.attachedGeneratedFilePaths.add(filepath);
    }

    event.attachments = attachments;
  }

  /** 获取浏览器截图并返回截图文件对应的在线 URL。 */
  private async getBrowserScreenshot(): Promise<string> {
    // 1. 调用浏览器完成截图。
    const screenshot = await this.browser.screenshot();

    // 2. 将浏览器截图上传到文件存储中。
    const file = await this.fileStorage.uploadFile({
      buffer: screenshot,
      originalname: `${randomUUID()}.png`,
      size: screenshot.length,
    });

    // 3. 组装完整 URL。
    const cosBucket = process.env.COS_BUCKET ?? '';
    const cosRegion = process.env.COS_REGION ?? '';
    return `https://${cosBucket}.cos.${cosRegion}.myqcloud.com/${file.key}`;
  }

  /** 额外处理工具消息，补充前端展示所需的工具扩展内容。 */
  private async handleToolEvent(event: ToolEvent): Promise<void> {
    try {
      // 1. 如果事件状态为已调用，则执行以下逻辑。
      if (event.status === ToolEventStatus.CALLED) {
        // 2. 工具为浏览器则补全浏览器工具内容。
        if (event.tool_name === 'browser') {
          event.tool_content = {
            screenshot: await this.getBrowserScreenshot(),
          };
        } else if (event.tool_name === 'search') {
          // 3. 工具为搜索则添加搜索工具内容。
          const searchResults = event.function_result as ToolResult<SearchResults>;
          this.logger.log(`搜索工具结果: ${JSON.stringify(searchResults)}`);
          event.tool_content = {
            results: searchResults.data!.results,
          };
        } else if (event.tool_name === 'shell') {
          // 4. 工具为 shell 则生成 shell 工具内容。
          if ('session_id' in event.function_args) {
            const shellResult = await this.sandbox.readShellOutput(
              String(event.function_args.session_id),
              true,
            );
            event.tool_content = {
              console: this.recordData(shellResult).console_records ?? [],
            };
          } else {
            event.tool_content = { console: '(No console)' };
          }
        } else if (event.tool_name === 'file') {
          // 5. 工具为 file 则将文件同步到对象存储。
          if ('filepath' in event.function_args) {
            const filepath = event.function_args.filepath as string;
            const fileReadResult = await this.sandbox.readFile(filepath);
            event.tool_content = {
              content: String(this.recordData(fileReadResult).content ?? ''),
            };
            const result = event.function_result as ToolResult | undefined;
            const generatedFile =
              result?.success === true &&
              ['write_file', 'replace_in_file'].includes(event.function_name);

            if (generatedFile) {
              this.generatedFilePaths.add(filepath);
              this.attachedGeneratedFilePaths.delete(filepath);
            }

            const file = await this.syncFileToStorage(filepath);
            if (generatedFile && file) {
              this.syncedGeneratedFiles.set(filepath, file);
            }
          } else {
            event.tool_content = { content: '(No Content)' };
          }
        } else if (event.tool_name === 'mcp' || event.tool_name === 'a2a') {
          // 6. 工具为 mcp/a2a 则处理调用结果。
          this.logger.log(
            `处理MCP/A2A工具事件, function_result: ${JSON.stringify(event.function_result)}`,
          );
          event.tool_content = this.buildAgentToolContent(event.tool_name, event.function_result);
        }
      }
    } catch (error) {
      this.logger.error(`AgentTaskRunner生成工具内容失败: ${errorMessage(error)}`);
    }
  }

  /** 对输出工具和消息事件执行展示与文件同步处理。 */
  private async prepareOutputEvent(event: Event): Promise<void> {
    if (event.type === 'tool') {
      await this.handleToolEvent(event);
    } else if (event.type === 'message') {
      await this.syncMessageAttachmentsToStorage(event);
      await this.attachGeneratedFiles(event);
    }
  }

  /** 运行 Runtime 并把 Runtime Event 转换为当前 Session/UI 事件。 */
  private async *runRuntime(
    message: Message,
    signal?: AbortSignal,
  ): AsyncGenerator<BaseEvent> {
    // 1. 判断传递的消息是否为空。
    if (!message.message) {
      this.logger.warn('AgentTaskRunner接收了一条空消息');
      yield events.error('空消息错误');
      return;
    }

    // 2. 每条用户消息路由前主动刷新一次，覆盖未声明 tools.listChanged 的 MCP 服务。
    throwIfAborted(signal);
    await this.mcpTool.refreshTools(undefined, signal);

    // 3. 执行 Runtime 并逐条转换输出事件。
    for await (const runtimeEvent of this.runtime.execute({
      sessionId: this.sessionId,
      message,
      signal,
    })) {
      const event = this.runtimeEventAdapter.adapt(runtimeEvent);
      if (!event) {
        continue;
      }
      await this.prepareOutputEvent(event);
      yield event;
    }
  }

  /** 清理 MCP 和 A2A 工具资源，确保在同一个任务上下文中释放。 */
  private async cleanupTools(): Promise<void> {
    try {
      await this.mcpTool.cleanup();
    } catch (error) {
      this.logger.warn(`清理MCP工具资源时出错: ${errorMessage(error)}`);
    }

    try {
      await this.a2aTool.cleanup();
    } catch (error) {
      this.logger.warn(`清理A2A工具资源时出错: ${errorMessage(error)}`);
    }
  }

  /** 根据传递的任务处理 agent 消息队列并运行 agent 流。 */
  async invoke(task: Task): Promise<void> {
    try {
      // 1. 确保沙箱、mcp、a2a 均初始化完成。
      this.logger.log('AgentTaskRunner任务处理开始');
      throwIfAborted(task.signal);
      await this.sandbox.ensureSandbox(task.signal);
      await this.mcpTool.initialize(this.mcpConfig, task.signal);
      await this.a2aTool.initialize(this.a2aConfig, task.signal);

      // 2. 循环读取任务中的输入消息队列。
      while (!(await task.inputStream.isEmpty())) {
        throwIfAborted(task.signal);
        // 3. 从输入流中获取数据。
        const event = await this.popEvent(task);
        let message = '';

        // 4. 如果事件类型为消息事件，则处理消息并将附件同步到沙箱中。
        if (event.type === 'message') {
          message = event.message || '';
          await this.syncMessageAttachmentsToSandbox(event);
          this.logger.log(`AgentTaskRunner接收到新消息: ${message.slice(0, 50)}...`);
        }

        // 5. 将消息事件转换成消息对象。
        const messageObj = createMessage({
          message,
          attachments: (event as MessageEvent).attachments.map((attachment) => attachment.filepath),
        });

        // 6. 使用 Runtime 执行本轮消息。
        for await (const sessionEvent of this.runRuntime(messageObj, task.signal)) {
          // 7. 将得到的事件添加到消息队列中。
          await this.putAndAddEvent(task, sessionEvent as Event);

          // 8. 如果事件类型为标题事件，则更新会话标题。
          if (sessionEvent.type === 'title') {
            await this.uow.run(async (active) => {
              await active.session.updateTitle(this.sessionId, (sessionEvent as TitleEvent).title);
            });
          } else if (sessionEvent.type === 'message') {
            // 9. 如果事件为消息事件，则更新最新消息并新增未读消息数。
            const messageEvent = sessionEvent as MessageEvent;
            await this.uow.run(async (active) => {
              await active.session.updateLatestMessage(
                this.sessionId,
                messageEvent.message,
                messageEvent.created_at,
              );
              await active.session.incrementUnreadMessageCount(this.sessionId);
            });
          } else if (sessionEvent.type === 'wait') {
            // 10. 如果事件为等待，则更新会话状态并终止程序。
            await this.uow.run(async (active) => {
              await active.session.updateStatus(this.sessionId, SessionStatus.WAITING);
            });
            return;
          }

          // 11. 如果输入消息队列不为空则跳出循环，下一轮处理新输入。
          if (!(await task.inputStream.isEmpty())) {
            break;
          }
        }
      }

      // 12. 更新会话状态为已完成。
      await this.uow.run(async (active) => {
        await active.session.updateStatus(this.sessionId, SessionStatus.COMPLETED);
      });
    } catch (error) {
      if (isCancelledError(error)) {
        // 13. 异步任务被取消，推送结束事件并更新状态。
        this.logger.log('AgentTaskRunner任务运行取消');
        await this.putAndAddEvent(task, events.done());
        await this.uow.run(async (active) => {
          await active.session.updateStatus(this.sessionId, SessionStatus.COMPLETED);
        });
        throw error;
      }

      // 14. 记录日志并往任务队列/消息队列中写入异常事件。
      this.logger.error(`AgentTaskRunner运行出错: ${errorMessage(error)}`);
      await this.putAndAddEvent(task, events.error(`AgentTaskRunner出错: ${errorMessage(error)}`));
      await this.uow.run(async (active) => {
        await active.session.updateStatus(this.sessionId, SessionStatus.COMPLETED);
      });
    } finally {
      // 15. 在同一个任务上下文中清理 MCP/A2A 工具资源。
      await this.cleanupTools();
    }
  }

  /** 供 Task 在触发根 Signal 前持久化当前活动 Run 的取消请求。 */
  override async requestCancellation(): Promise<void> {
    await this.runtime.requestCancellation();
  }

  /** 销毁任务运行器并释放资源。 */
  async destroy(): Promise<void> {
    // 1. 清除沙箱。
    this.logger.log('开始清除销毁AgentTaskRunner资源');
    if (this.sandbox) {
      this.logger.log('销毁AgentTaskRunner中的沙箱环境');
      await this.sandbox.destroy();
    }

    // 2. 清除 mcp 和 a2a 工具。
    await this.cleanupTools();
  }

  /** 任务结束时执行的回调函数。 */
  async onDone(_task: Task): Promise<void> {
    this.logger.log('AgentTaskRunner任务执行结束');
  }

  private parseEvent(payload: unknown): Event {
    const value = typeof payload === 'string' ? JSON.parse(payload) : payload;
    const event = value as Event;
    event.created_at = event.created_at ? new Date(event.created_at) : new Date();

    if (event.type === 'message') {
      event.attachments = (event.attachments ?? []).map((file) => createFileModel(file));
    }

    return event;
  }

  private async toBuffer(data: SandboxFileData): Promise<Buffer> {
    if (Buffer.isBuffer(data)) {
      return data;
    }

    const stream = data instanceof Readable ? data : Readable.from(data as NodeJS.ReadableStream);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  private recordData(result: ToolResult): Record<string, any> {
    const data = result.data;
    return data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, any>)
      : {};
  }

  private buildAgentToolContent(
    toolName: 'mcp' | 'a2a',
    result?: ToolResult,
  ): MCPToolContent | A2AToolContent {
    let resultData: unknown;

    if (result) {
      if (result.data) {
        resultData = result.data;
      } else if (result.success) {
        resultData = result;
      } else {
        resultData = this.stringifyToolResult(result);
      }
    } else {
      resultData = toolName === 'mcp' ? '(MCP工具无可用结果)' : '(A2A智能体无可用结果)';
    }

    return this.agentToolContent(toolName, resultData);
  }

  private agentToolContent(toolName: 'mcp' | 'a2a', data: unknown): MCPToolContent | A2AToolContent {
    return toolName === 'mcp' ? { result: data } : { a2a_result: data };
  }

  private stringifyToolResult(result: ToolResult): string {
    try {
      return JSON.stringify(result);
    } catch {
      return String(result);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCancelledError(error: unknown): boolean {
  return (
    error instanceof Error &&
    ['AbortError', 'CancelError', 'CancelledError'].includes(error.name)
  );
}
