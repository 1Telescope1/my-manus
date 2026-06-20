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
import { Message } from '../../models/message';
import { createStep, ExecutionStatus, Plan, Step } from '../../models/plan';
import { UnitOfWork } from '../../repositories/unit-of-work';
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

  async *executeStep(plan: Plan, step: Step, message: Message): AsyncGenerator<Event> {
    const query = formatTemplate(EXECUTION_PROMPT, {
      message: message.message,
      attachments: message.attachments.join('\n'),
      language: plan.language,
      step: step.description,
    });

    step.status = ExecutionStatus.RUNNING;
    yield events.step(step, StepEventStatus.STARTED);

    for await (const event of this.invoke(query)) {
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
        step.status = ExecutionStatus.COMPLETED;
        const parsed = await this.jsonParser.invoke<Partial<Step>>(event.message);
        const nextStep = createStep(parsed);
        step.success = nextStep.success;
        step.result = nextStep.result;
        step.attachments = nextStep.attachments;
        yield events.step(step, StepEventStatus.COMPLETED);
        if (step.result) {
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

    step.status = ExecutionStatus.COMPLETED;
  }

  async *summarize(): AsyncGenerator<Event> {
    for await (const event of this.invoke(SUMMARIZE_PROMPT)) {
      if (event.type === 'message') {
        const parsed = await this.jsonParser.invoke<Message>(event.message);
        yield events.message({
          role: 'assistant',
          message: parsed.message,
          attachments: parsed.attachments.map((filepath) => createFileModel({ filepath })),
        });
      } else {
        yield event;
      }
    }
  }
}
