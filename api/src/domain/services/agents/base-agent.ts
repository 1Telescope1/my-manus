import { randomUUID } from 'node:crypto';
import { JSONParser } from '../../external/json-parser';
import { LLM, LLMMessage } from '../../external/llm';
import { AgentConfig } from '../../models/app-config';
import { Event, events, ToolEventStatus } from '../../models/event';
import { Memory } from '../../models/memory';
import { Message } from '../../models/message';
import { ToolResult } from '../../models/tool-result';
import { UnitOfWork } from '../../repositories/unit-of-work';
import { BaseTool } from '../tools/base-tool';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export abstract class BaseAgent {
  abstract readonly name: string;
  protected systemPrompt = '';
  protected format?: string;
  protected retryIntervalMs = 1000;
  protected toolChoice?: string | null;
  protected memory?: Memory;

  constructor(
    protected readonly uowFactory: () => UnitOfWork,
    protected readonly sessionId: string,
    protected readonly agentConfig: AgentConfig,
    protected readonly llm: LLM,
    protected readonly jsonParser: JSONParser,
    protected readonly tools: BaseTool[],
  ) {}

  async compactMemory(): Promise<void> {
    await this.ensureMemory();
    this.memory?.compact();
    const uow = this.uowFactory();
    await uow.run(async (active) => {
      await active.session.saveMemory(this.sessionId, this.name, this.memory as Memory);
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
      await active.session.saveMemory(this.sessionId, this.name, this.memory as Memory);
    });
  }

  async *invoke(query: string, format?: string): AsyncGenerator<Event> {
    const responseFormat = format ?? this.format;
    let message = await this.invokeLlm([{ role: 'user', content: query }], responseFormat);

    for (let i = 0; i < this.agentConfig.max_iterations; i += 1) {
      if (!message || !message.tool_calls?.length) {
        break;
      }

      const toolMessages: LLMMessage[] = [];
      for (const toolCall of message.tool_calls) {
        if (!toolCall.function) {
          continue;
        }

        const toolCallId = toolCall.id || randomUUID();
        const functionName = toolCall.function.name;
        const functionArgs = await this.jsonParser.invoke<Record<string, any>>(
          toolCall.function.arguments,
          {},
        );
        const tool = this.findTool(functionName);

        if (!tool) {
          const availableToolNames = this.getAvailableTools().map(
            (schema) => schema.function.name,
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
          tool_name: tool.name,
          function_name: functionName,
          function_args: functionArgs,
          status: ToolEventStatus.CALLING,
        });

        const result = await this.invokeTool(tool, functionName, functionArgs);

        yield events.tool({
          tool_call_id: toolCallId,
          tool_name: tool.name,
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

      message = await this.invokeLlm(toolMessages);
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
        this.memory = await active.session.getMemory(this.sessionId, this.name);
      });
    }
  }

  protected getAvailableTools() {
    return this.tools.flatMap((tool) => tool.getTools());
  }

  protected getTool(toolName: string): BaseTool {
    const found = this.findTool(toolName);
    if (!found) {
      throw new Error(`未知工具: ${toolName}`);
    }
    return found;
  }

  protected findTool(toolName: string): BaseTool | undefined {
    return this.tools.find((tool) => tool.hasTool(toolName));
  }

  protected async invokeLlm(messages: LLMMessage[], format?: string): Promise<LLMMessage> {
    await this.addToMemory(messages);

    const responseFormat = format ? { type: format } : null;
    let lastError = '调用语言模型发生错误';

    for (let i = 0; i < this.agentConfig.max_retries; i += 1) {
      try {
        const message = await this.llm.invoke({
          messages: this.memory?.getMessages() ?? [],
          tools: this.getAvailableTools(),
          responseFormat,
          toolChoice: this.toolChoice,
        });

        let filteredMessage: LLMMessage;
        if (message.role === 'assistant') {
          if (!message.content && !message.tool_calls) {
            await this.addToMemory([
              { role: 'assistant', content: '' },
              { role: 'user', content: 'AI无响应内容，请继续。' },
            ]);
            await sleep(this.retryIntervalMs);
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
        const err = error instanceof Error ? error : new Error(String(error));
        lastError = err.message;
        await sleep(this.retryIntervalMs);
      }
    }

    throw new Error(`调用语言模型失败, 已达到最大重试次数(${this.agentConfig.max_retries}): ${lastError}`);
  }

  protected async invokeTool(
    tool: BaseTool,
    toolName: string,
    args: Record<string, any>,
  ): Promise<ToolResult> {
    let error = '';
    for (let i = 0; i < this.agentConfig.max_retries; i += 1) {
      try {
        return await tool.invoke(toolName, args);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        await sleep(this.retryIntervalMs);
      }
    }

    return { success: false, message: error };
  }

  protected async addToMemory(messages: LLMMessage[]): Promise<void> {
    await this.ensureMemory();

    if (this.memory?.empty) {
      this.memory.addMessage({ role: 'system', content: this.systemPrompt });
    }

    this.memory?.addMessages(messages);

    const uow = this.uowFactory();
    await uow.run(async (active) => {
      await active.session.saveMemory(this.sessionId, this.name, this.memory as Memory);
    });
  }
}
