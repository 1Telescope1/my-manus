import { randomUUID } from 'node:crypto';
import { JSONParser } from '../../external/json-parser';
import { LLM, LLMMessage } from '../../external/llm';
import { AgentConfig } from '../../models/app-config';
import { Event, events, ToolEventStatus } from '../../models/event';
import { ConversationMemory } from '../../models/conversation-memory';
import { formatMemorySummaryForContext } from '../../models/memory-summary';
import { Message } from '../../models/message';
import { ToolResult } from '../../models/tool-result';
import { ToolIdempotencyStore } from '../../models/tool-invocation';
import { ToolRegistration, ToolRegistry } from '../../models/tool';
import { ToolSelectionRequest } from '../../models/tool-selection';
import { UnitOfWork } from '../../repositories/unit-of-work';
import { BaseTool } from '../tools/base-tool';
import {
  createAgentToolRegistry,
  synchronizeAgentToolRegistry,
} from '../tools/agent-toolset';
import { ToolSelectionService } from '../tools/tool-selection.service';
import { ToolInvocationService } from '../tools/tool-invocation.service';
import { throwIfAborted } from '../runtime/cancellation';
import {
  ContextSelector,
  createModelContextBudget,
  modelFixedInput,
} from '../context/context-selector.service';
import {
  LLMMemorySummaryGenerator,
  MemoryCompactionContext,
  MemoryCompactionService,
} from '../memory/memory-compaction.service';

/** 等待模型重试间隔，并允许根取消立即打断等待。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException('模型调用已取消', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

type AgentInvokeOptions = {
  /** 是否要求执行阶段至少产生一次工具调用，防止模型直接返回未经验证的答案。 */
  requireToolCall?: boolean;
  /** 单个步骤允许的工具调用总数；达到上限后必须使用已有结果生成最终答复。 */
  maxToolCalls?: number;
  /** 每种工具函数的调用上限，用于阻止模型反复使用同一无效工具。 */
  maxCallsPerTool?: Record<string, number>;
  /** 本次模型调用允许使用的 Router、Workflow、Agent、Skill 和 Policy 约束。 */
  toolSelection?: ToolSelectionRequest;
  /** 当前 Run 的可靠调用作用域与可选取消信号。 */
  toolInvocation?: { scopeId: string; signal?: AbortSignal };
  /** 仅当前 Run 的模型请求可见、不得写入 Session Memory 的系统上下文。 */
  protectedSystemContext?: string;
};

export abstract class BaseAgent {
  abstract readonly name: string;
  protected systemPrompt = '';
  protected format?: string;
  protected retryIntervalMs = 1000;
  protected toolChoice?: string | null;
  protected memory?: ConversationMemory;
  protected readonly toolRegistry: ToolRegistry;
  protected readonly toolSelector: ToolSelectionService;
  protected readonly toolInvoker: ToolInvocationService;
  protected readonly contextSelector = new ContextSelector();

  constructor(
    protected readonly uowFactory: () => UnitOfWork,
    protected readonly sessionId: string,
    protected readonly agentConfig: AgentConfig,
    protected readonly llm: LLM,
    protected readonly jsonParser: JSONParser,
    protected readonly tools: BaseTool[],
    idempotencyStore?: ToolIdempotencyStore,
  ) {
    this.toolRegistry = createAgentToolRegistry(tools);
    this.toolSelector = new ToolSelectionService(this.toolRegistry);
    this.toolInvoker = new ToolInvocationService(this.toolRegistry, { idempotencyStore });
  }

  /** 生成可溯源摘要；失败时保留原消息且不阻断主执行流。 */
  async compactMemory(
    context: MemoryCompactionContext,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.ensureMemory();
    const memory = this.memory as ConversationMemory;
    const compaction = new MemoryCompactionService(
      new LLMMemorySummaryGenerator(this.llm, this.jsonParser),
      createModelContextBudget(this.llm).inputTokenLimit,
    );
    const compacted = await compaction.compact(memory, context, signal);
    if (!compacted) {
      return;
    }
    // 只有内存已完成原子替换时才持久化，生成失败不会覆盖数据库中的原始历史。
    const uow = this.uowFactory();
    await uow.run(async (active) => {
      await active.conversationMemory.save(
        this.sessionId,
        this.name,
        memory,
      );
    });
  }

  async rollBack(message: Message): Promise<void> {
    await this.ensureMemory();
    const lastMessage = this.memory?.getLastMessage();
    if (!lastMessage?.tool_calls?.length) {
      return;
    }

    const toolCall = lastMessage.tool_calls[0];
    const functionName = toolCall.function?.name;
    const toolCallId = toolCall.id;

    if (functionName === 'message_ask_user') {
      this.memory?.addMessage({
        role: 'tool',
        tool_call_id: toolCallId,
        function_name: functionName,
        content: JSON.stringify(message),
      });
    } else {
      this.memory?.rollBack();
    }

    const uow = this.uowFactory();
    await uow.run(async (active) => {
      await active.conversationMemory.save(
        this.sessionId,
        this.name,
        this.memory as ConversationMemory,
      );
    });
  }

  /** 在固定工具选择边界内运行模型与工具循环。 */
  async *invoke(
    query: string,
    format?: string,
    options: AgentInvokeOptions = {},
  ): AsyncGenerator<Event> {
    const responseFormat = format ?? this.format;
    let message = await this.invokeLlm(
      [{ role: 'user', content: query }],
      responseFormat,
      undefined,
      new Set(),
      options.toolSelection,
      options.toolInvocation?.signal,
      options.protectedSystemContext,
      query,
    );

    // 部分思考模型不支持 tool_choice="required"。保持 tool_choice=auto，并在模型
    // 跳过工具时通过对话纠正重试，以兼容这些模型同时保证执行步骤不会空跑。
    if (options.requireToolCall) {
      for (
        let retry = 0;
        retry < this.agentConfig.max_retries && !message?.tool_calls?.length;
        retry += 1
      ) {
        message = await this.invokeLlm(
          [{
            role: 'user',
            content:
              '你尚未调用任何任务工具，因此不能提交步骤结果。' +
              '现在必须选择并调用一个与当前任务直接相关的工具；' +
              'message_notify_user 等进度通知工具不算任务执行。',
          }],
          responseFormat,
          undefined,
          new Set(),
          options.toolSelection,
          options.toolInvocation?.signal,
          options.protectedSystemContext,
          query,
        );
      }

      if (!message?.tool_calls?.length) {
        yield events.error(
          `模型连续${this.agentConfig.max_retries + 1}次未调用任务工具，步骤执行失败`,
        );
        return;
      }
    }

    // 同时记录总调用次数和各函数调用次数：前者控制单步骤成本，后者用于
    // 熔断持续返回无效结果的工具，并促使模型切换到 browser/shell 等替代方案。
    let toolCallCount = 0;
    const toolCallCounts = new Map<string, number>();
    const excludedToolNames = new Set<string>();
    for (let i = 0; i < this.agentConfig.max_iterations; i += 1) {
      if (!message || !message.tool_calls?.length) {
        break;
      }

      const toolMessages: LLMMessage[] = [];
      for (const toolCall of message.tool_calls) {
        throwIfAborted(options.toolInvocation?.signal);
        if (!toolCall.function) {
          continue;
        }

        const toolCallId = toolCall.id || randomUUID();
        const functionName = toolCall.function.name;
        toolCallCount += 1;
        const functionCallCount = (toolCallCounts.get(functionName) ?? 0) + 1;
        toolCallCounts.set(functionName, functionCallCount);
        const functionArgs = await this.jsonParser.invoke<Record<string, any>>(
          toolCall.function.arguments,
          {},
        );
        const currentlyAllowedTools = this.getAvailableTools(options.toolSelection).filter(
          (descriptor) => !excludedToolNames.has(descriptor.name),
        );
        const tool = this.findTool(
          functionName,
          new Set(currentlyAllowedTools.map((descriptor) => descriptor.name)),
        );

        if (!tool) {
          const availableToolNames = currentlyAllowedTools.map(
            (descriptor) => descriptor.name,
          );
          const result: ToolResult = {
            success: false,
            message:
              `未知工具: ${functionName}。` +
              `请仅使用以下可用工具重新尝试: ${availableToolNames.join(', ')}`,
          };

          yield events.tool({
            tool_call_id: toolCallId,
            tool_name: 'unknown',
            function_name: functionName,
            function_args: functionArgs,
            function_result: result,
            status: ToolEventStatus.CALLED,
          });

          // 未知工具是模型可自行纠正的输出错误。将失败结果回传给模型，
          // 避免异常冒泡并导致整个 AgentTaskRunner 提前终止。
          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCallId,
            function_name: functionName,
            content: JSON.stringify(result),
          });
          continue;
        }

        yield events.tool({
          tool_call_id: toolCallId,
          tool_name: tool.groupName,
          function_name: functionName,
          function_args: functionArgs,
          status: ToolEventStatus.CALLING,
        });

        const result = await this.invokeTool(
          tool,
          functionArgs,
          toolCallId,
          options.toolInvocation,
        );
        if (result.error?.code === 'cancelled') {
          throwIfAborted(options.toolInvocation?.signal);
          throw new DOMException('工具调用已取消', 'AbortError');
        }

        // 当前调用仍正常执行并把结果回传给模型；从下一轮开始才从工具列表移除，
        // 确保 OpenAI/DeepSeek 的 tool_call 与 tool result 消息始终成对出现。
        const perToolLimit = options.maxCallsPerTool?.[functionName];
        if (perToolLimit && functionCallCount >= perToolLimit) {
          excludedToolNames.add(functionName);
        }

        yield events.tool({
          tool_call_id: toolCallId,
          tool_name: tool.groupName,
          function_name: functionName,
          function_args: functionArgs,
          function_result: result,
          status: ToolEventStatus.CALLED,
        });

        toolMessages.push({
          role: 'tool',
          tool_call_id: toolCallId,
          function_name: functionName,
          content: JSON.stringify(result),
        });
      }

      // 达到步骤级上限时，将本轮工具结果和“停止调用”的指令放进同一次请求。
      // tool_choice=none 可避免思考模型继续搜索，同时保留最后一次工具结果供总结。
      if (options.maxToolCalls && toolCallCount >= options.maxToolCalls) {
        message = await this.invokeLlm(
          [
            ...toolMessages,
            {
              role: 'user',
              content:
                `本步骤已调用${toolCallCount}次工具，必须停止继续调用工具。` +
                '请立即根据现有工具结果提交最终 JSON；如果证据仍不足，返回 success: false 并说明原因。',
            },
          ],
          responseFormat,
          'none',
          excludedToolNames,
          options.toolSelection,
          options.toolInvocation?.signal,
          options.protectedSystemContext,
          query,
        );
        break;
      }

      message = await this.invokeLlm(
        toolMessages,
        undefined,
        undefined,
        excludedToolNames,
        options.toolSelection,
        options.toolInvocation?.signal,
        options.protectedSystemContext,
        query,
      );
    }

    if (message?.tool_calls?.length) {
      yield events.error(`Agent迭代超过最大迭代次数(${this.agentConfig.max_iterations}), 任务处理失败`);
      return;
    }

    if (message?.content !== undefined && message.content !== null) {
      yield events.message({ message: String(message.content) });
    } else {
      yield events.error('Agent未能生成有效回复内容');
    }
  }

  protected async ensureMemory(): Promise<void> {
    if (!this.memory) {
      const uow = this.uowFactory();
      await uow.run(async (active) => {
        this.memory = await active.conversationMemory.get(this.sessionId, this.name);
      });
    }
  }

  /** 返回当前动态工具快照中的通用工具描述。 */
  protected getAvailableTools(selection?: ToolSelectionRequest) {
    synchronizeAgentToolRegistry(this.toolRegistry, this.tools);
    if (!selection) {
      return [];
    }
    const result = this.toolSelector.select(selection);
    if (result.uncoveredCapabilities.length > 0) {
      throw new Error(
        `Agent capability 无可用工具：${result.uncoveredCapabilities.join(', ')}`,
      );
    }
    return result.tools;
  }

  /** 在本轮已选工具名称范围内解析可执行注册项。 */
  protected findTool(
    toolName: string,
    allowedNames: ReadonlySet<string>,
  ): ToolRegistration | undefined {
    return allowedNames.has(toolName) ? this.toolRegistry.resolve(toolName) : undefined;
  }

  /** 只把选择后且未熔断的工具描述交给模型，空集合时省略 tools。 */
  protected async invokeLlm(
    messages: LLMMessage[],
    format?: string,
    toolChoice?: string | null,
    excludedToolNames: ReadonlySet<string> = new Set(),
    selection?: ToolSelectionRequest,
    signal?: AbortSignal,
    protectedSystemContext?: string,
    currentUserRequest?: string,
  ): Promise<LLMMessage> {
    throwIfAborted(signal);
    await this.addToMemory(messages);

    const responseFormat = format ? { type: format } : null;
    let lastError = '调用语言模型发生错误';
    // 选择错误是确定性的，不应伪装成可重试的模型故障。
    const availableTools = this.getAvailableTools(selection).filter(
      (descriptor) => !excludedToolNames.has(descriptor.name),
    );

    for (let i = 0; i < this.agentConfig.max_retries; i += 1) {
      // Context 选择错误是确定性的，必须在重试边界外失败；只有厂商请求故障可重试。
      const persistedMessages = this.memory?.getMessages() ?? [];
      const summary = this.memory?.getSummary();
      // 摘要是已删除早期历史的唯一替身，必须作为受保护上下文参与每次模型调用。
      const selectedMessages = this.contextSelector.select({
        context: {
          conversationMessages: persistedMessages,
          protectedInstructions: [
            ...(summary ? [formatMemorySummaryForContext(summary)] : []),
            ...(protectedSystemContext ? [protectedSystemContext] : []),
          ],
          protectedConversationMessageIndexes: findCurrentRequestIndexes(
            persistedMessages,
            currentUserRequest,
          ),
        },
        budget: createModelContextBudget(this.llm),
        fixedInput: modelFixedInput(availableTools, responseFormat),
      });
      try {
        const message = await this.llm.invoke({
          messages: selectedMessages,
          // 空集合时省略 tools，确保 Planner、总结和无授权场景不会产生全量回退。
          ...(availableTools.length > 0 ? { tools: availableTools } : {}),
          responseFormat,
          ...(availableTools.length > 0
            ? { toolChoice: toolChoice === undefined ? this.toolChoice : toolChoice }
            : {}),
          signal,
        });

        let filteredMessage: LLMMessage;
        if (message.role === 'assistant') {
          if (!message.content && !message.tool_calls) {
            await this.addToMemory([
              { role: 'assistant', content: '' },
              { role: 'user', content: 'AI无响应内容，请继续。' },
            ]);
            await sleep(this.retryIntervalMs, signal);
            continue;
          }

          filteredMessage = { role: 'assistant', content: message.content };
          if (message.reasoning_content) {
            filteredMessage.reasoning_content = message.reasoning_content;
          }
          if (message.tool_calls) {
            filteredMessage.tool_calls = message.tool_calls.slice(0, 1);
          }
        } else {
          filteredMessage = message;
        }

        await this.addToMemory([filteredMessage]);
        return filteredMessage;
      } catch (error) {
        if (signal?.aborted) {
          throw error;
        }
        const err = error instanceof Error ? error : new Error(String(error));
        lastError = err.message;
        await sleep(this.retryIntervalMs, signal);
      }
    }

    throw new Error(`调用语言模型失败, 已达到最大重试次数(${this.agentConfig.max_retries}): ${lastError}`);
  }

  /** 把模型选定的工具交给统一可靠调用层，不在 Agent 内自行决定重试。 */
  protected async invokeTool(
    tool: ToolRegistration,
    args: Record<string, any>,
    toolCallId: string,
    invocation?: { scopeId: string; signal?: AbortSignal },
  ): Promise<ToolResult> {
    return this.toolInvoker.invoke({
      functionName: tool.descriptor.name,
      arguments: args,
      scopeId: invocation?.scopeId ?? this.sessionId,
      idempotencyKey: toolCallId,
      signal: invocation?.signal,
    });
  }

  protected async addToMemory(messages: LLMMessage[]): Promise<void> {
    await this.ensureMemory();

    if (this.memory?.empty) {
      this.memory.addMessage({ role: 'system', content: this.systemPrompt });
    }

    this.memory?.addMessages(messages);

    const uow = this.uowFactory();
    await uow.run(async (active) => {
      await active.conversationMemory.save(
        this.sessionId,
        this.name,
        this.memory as ConversationMemory,
      );
    });
  }
}

/** 找出当前 Run 原始用户请求在持久消息中的最后位置，供选择器持续保护。 */
function findCurrentRequestIndexes(
  messages: LLMMessage[],
  currentUserRequest?: string,
): number[] {
  if (!currentUserRequest) {
    return [];
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'user' && message.content === currentUserRequest) {
      return [index];
    }
  }
  return [];
}
