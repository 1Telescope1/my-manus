import { JSONParser } from '../../external/json-parser';
import { LLM } from '../../external/llm';
import { AgentConfig } from '../../models/app-config';
import { Event, events, PlanEventStatus } from '../../models/event';
import { Message } from '../../models/message';
import { createPlan, Plan, Step } from '../../models/plan';
import { UnitOfWork } from '../../repositories/unit-of-work';
import { BaseTool } from '../tools/base-tool';
import { BaseAgent } from './base-agent';
import { SYSTEM_PROMPT } from '../prompts/system';
import {
  CREATE_PLAN_PROMPT,
  PLANNER_SYSTEM_PROMPT,
  UPDATE_PLAN_PROMPT,
} from '../prompts/planner';

function formatTemplate(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (acc, [key, value]) => acc.replaceAll(`{${key}}`, value),
    template,
  );
}

export class PlannerAgent extends BaseAgent {
  readonly name = 'planner';
  protected override systemPrompt = SYSTEM_PROMPT + PLANNER_SYSTEM_PROMPT;
  protected override format = 'json_object';
  protected override toolChoice = 'none';

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

  async *createPlan(
    message: Message,
    toolInvocation?: { scopeId: string; signal?: AbortSignal },
  ): AsyncGenerator<Event> {
    const query = formatTemplate(CREATE_PLAN_PROMPT, {
      message: message.message,
      attachments: message.attachments.join('\n'),
    });

    for await (const event of this.invoke(query, undefined, { toolInvocation })) {
      if (event.type === 'message') {
        const parsed = await this.jsonParser.invoke<Partial<Plan>>(event.message);
        yield events.plan(createPlan(parsed), PlanEventStatus.CREATED);
      } else {
        yield event;
      }
    }
  }

  async *updatePlan(
    plan: Plan,
    step: Step,
    toolInvocation?: { scopeId: string; signal?: AbortSignal },
  ): AsyncGenerator<Event> {
    const query = formatTemplate(UPDATE_PLAN_PROMPT, {
      plan: JSON.stringify(plan),
      step: JSON.stringify(step),
    });

    for await (const event of this.invoke(query, undefined, { toolInvocation })) {
      if (event.type === 'message') {
        const parsed = await this.jsonParser.invoke<Partial<Plan>>(event.message);
        const updatedPlan = createPlan(parsed);
        const firstPendingIndex = plan.steps.findIndex((item) => !['completed', 'failed'].includes(item.status));
        if (firstPendingIndex >= 0) {
          plan.steps = [...plan.steps.slice(0, firstPendingIndex), ...updatedPlan.steps];
        }
        yield events.plan(plan, PlanEventStatus.UPDATED);
      } else {
        yield event;
      }
    }
  }
}
