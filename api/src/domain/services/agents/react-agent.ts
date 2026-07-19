import { JSONParser } from '../../external/json-parser';
import { LLM } from '../../external/llm';
import { AgentConfig } from '../../models/app-config';
import {
  Event,
  events,
  StepEventStatus,
  ToolEventStatus,
} from '../../models/event';
import { createFileModel } from '../../models/file';
import { Message, messageToText } from '../../models/message';
import { createStep, ExecutionStatus, Plan, Step } from '../../models/plan';
import { UnitOfWork } from '../../repositories/unit-of-work';
import { ToolSelectionRequest } from '../../models/tool-selection';
import { BaseTool } from '../tools/base-tool';
import { BaseAgent } from './base-agent';
import { SYSTEM_PROMPT } from '../prompts/system';
import { EXECUTION_PROMPT, REACT_SYSTEM_PROMPT, SUMMARIZE_PROMPT } from '../prompts/react';

function formatTemplate(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (acc, [key, value]) => acc.replaceAll(`{${key}}`, value),
    template,
  );
}

// 这些文本只表示模型声称“正在处理”，不包含用户可消费的实际结果。
// 即使模型错误地同时返回 success=true，也必须按失败处理。
const PLACEHOLDER_RESULT_PATTERNS = [
  /(?:搜索|查询|处理中|加载中|执行中).{0,8}(?:中|稍候|请稍候|请等待)/i,
  /(?:请稍候|请等待).{0,8}(?:搜索|查询|处理|执行)/i,
  /(?:searching|processing|working on it|please wait)/i,
];

export function isPlaceholderResult(result: string | null | undefined): boolean {
  const normalized = result?.trim();
  return Boolean(normalized && PLACEHOLDER_RESULT_PATTERNS.some((pattern) => pattern.test(normalized)));
}

export class ReActAgent extends BaseAgent {
  readonly name = 'react';
  protected override systemPrompt = SYSTEM_PROMPT + REACT_SYSTEM_PROMPT;
  protected override format = 'json_object';

  constructor(
    uowFactory: () => UnitOfWork,
    sessionId: string,
    agentConfig: AgentConfig,
    llm: LLM,
    jsonParser: JSONParser,
    tools: BaseTool[],
  ) {
    super(uowFactory, sessionId, agentConfig, llm, jsonParser, tools);
  }

  /** 在 Runtime 选定的工具边界内执行一个计划步骤。 */
  async *executeStep(
    plan: Plan,
    step: Step,
    message: Message,
    toolSelection?: ToolSelectionRequest,
    toolInvocation?: { scopeId: string; signal?: AbortSignal },
  ): AsyncGenerator<Event> {
    const query = formatTemplate(EXECUTION_PROMPT, {
      message: message.message,
      attachments: message.attachments.join('\n'),
      language: plan.language,
      step: step.description,
    });

    step.status = ExecutionStatus.RUNNING;
    yield events.step(step, StepEventStatus.STARTED);

    // 执行步骤时至少完成一次真实工具调用，避免模型直接用“搜索中”等占位 JSON
    // 冒充执行结果。后续轮次恢复 auto，允许模型在拿到工具结果后提交最终 JSON。
    for await (const event of this.invoke(query, undefined, {
      requireToolCall: true,
      maxToolCalls: 12,
      maxCallsPerTool: {
        search_web: 3,
      },
      toolSelection,
      toolInvocation,
    })) {
      if (event.type === 'tool' && event.function_name === 'message_ask_user') {
        if (event.status === ToolEventStatus.CALLING) {
          yield events.message({
            role: 'assistant',
            message: String(event.function_args.text ?? ''),
          });
        } else if (event.status === ToolEventStatus.CALLED) {
          yield events.wait();
          return;
        }
        continue;
      }

      if (event.type === 'message') {
        const parsed = await this.jsonParser.invoke<Partial<Step>>(event.message);
        const nextStep = createStep(parsed);
        step.result = nextStep.result;
        step.attachments = nextStep.attachments;

        // 步骤完成必须同时满足模型声明成功、且结果不是进度占位文本。
        // 不能只依据“收到 message 事件”判断完成，否则 UI 会出现虚假的 4/4。
        const placeholderResult = isPlaceholderResult(step.result);
        step.success = nextStep.success && !placeholderResult;

        if (step.success) {
          step.status = ExecutionStatus.COMPLETED;
          step.error = null;
          yield events.step(step, StepEventStatus.COMPLETED);
        } else {
          step.status = ExecutionStatus.FAILED;
          step.error = placeholderResult
            ? '模型只返回了进度占位文本，没有提供可交付结果'
            : nextStep.error || step.result || '步骤执行失败，模型未提供原因';
          yield events.step(step, StepEventStatus.FAILED);
        }

        if (step.result && !placeholderResult) {
          yield events.message({ role: 'assistant', message: step.result });
        }
        continue;
      }

      if (event.type === 'error') {
        step.status = ExecutionStatus.FAILED;
        step.error = event.error;
        yield events.step(step, StepEventStatus.FAILED);
      }

      yield event;
    }
  }

  async *summarize(
    plan: Plan,
    toolInvocation?: { scopeId: string; signal?: AbortSignal },
  ): AsyncGenerator<Event> {
    // 把最终计划（包含每一步的 success/result/error）显式交给总结阶段，
    // 避免总结模型只根据对话记忆复述开场白或把失败任务描述成已完成。
    const query = formatTemplate(SUMMARIZE_PROMPT, {
      plan: JSON.stringify(plan),
    });
    for await (const event of this.invoke(query, undefined, { toolInvocation })) {
      if (event.type === 'message') {
        const parsed = await this.jsonParser.invoke<Partial<Message> & Record<string, unknown>>(
          event.message,
        );
        const attachmentPaths = Array.isArray(parsed.attachments)
          ? parsed.attachments.filter((filepath): filepath is string => typeof filepath === 'string')
          : [];
        yield events.message({
          role: 'assistant',
          message: messageToText(parsed.message ?? parsed),
          attachments: attachmentPaths.map((filepath) => createFileModel({ filepath })),
        });
      } else {
        yield event;
      }
    }
  }
}
