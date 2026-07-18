import { JSONParser } from '../../external/json-parser';
import { LLM } from '../../external/llm';
import {
  Event,
  PlanEventStatus,
  StepEventStatus,
  ToolEventStatus,
} from '../../models/event';
import { createMessage, messageToText } from '../../models/message';
import { ToolResult } from '../../models/tool-result';
import { PlannerReActFlow } from '../flows/planner-react-flow';
import {
  DirectResponseProvider,
  PlannedAgentRunner,
  RuntimeExecutionContext,
  RuntimeExecutionEventPayload,
  RuntimeToolCallInput,
  RuntimeToolInvocation,
  RuntimeToolInvoker,
  RuntimeWorkflowInput,
  RuntimeWorkflowRunner,
  SingleToolResponseInput,
  SingleToolResponseProvider,
  SingleToolSelector,
} from './executor.service';
import { BaseTool } from '../tools/base-tool';
import { ToolDescriptor, ToolRegistry } from '../../models/tool';
import { ToolSelectionRequest } from '../../models/tool-selection';
import {
  createAgentToolRegistry,
  synchronizeAgentToolRegistry,
} from '../tools/agent-toolset';
import { ToolSelectionService } from '../tools/tool-selection.service';

const DIRECT_SYSTEM_PROMPT =
  '你负责直接回答用户请求。不得声称调用了工具或访问了未提供的外部信息；请给出简洁、完整的最终回答。';

const SINGLE_TOOL_SYSTEM_PROMPT =
  '你只负责为当前请求选择一个主要工具调用。必须调用且只能调用一个提供的工具，不要直接回答用户。';

const SINGLE_TOOL_SUMMARY_PROMPT =
  '你负责根据一次工具调用结果回答用户。不得继续调用工具；结果失败时明确说明失败原因。';

/** 使用现有厂商无关的 LLM 端口实现 Direct 回答。 */
export class LLMDirectResponseProvider implements DirectResponseProvider {
  /** 注入当前会话使用的 LLM 客户端。 */
  constructor(private readonly llm: LLM) {}

  /** 在不提供 tools 参数的情况下生成最终回答。 */
  async respond(context: RuntimeExecutionContext): Promise<string> {
    const response = await this.llm.invoke({
      messages: [
        { role: 'system', content: DIRECT_SYSTEM_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({
            message: context.message,
            attachments: runtimeAttachments(context),
          }),
        },
      ],
    });
    return messageToText(response.content);
  }
}

/** 使用一次受限 LLM 选择和一次无工具总结实现 Single Tool 两个模型阶段。 */
export class LLMSingleToolProvider implements SingleToolSelector, SingleToolResponseProvider {
  private readonly toolRegistry: ToolRegistry;
  private readonly toolSelector: ToolSelectionService;

  /** 注入模型、JSON 参数解析器和当前可用 Agent 工具集合。 */
  constructor(
    private readonly llm: LLM,
    private readonly jsonParser: JSONParser,
    private readonly tools: readonly BaseTool[],
  ) {
    this.toolRegistry = createAgentToolRegistry(tools);
    this.toolSelector = new ToolSelectionService(this.toolRegistry);
  }

  /** 要求模型从现有 Tool Schema 中选择且只选择一次调用。 */
  async select(context: RuntimeExecutionContext): Promise<RuntimeToolInvocation> {
    const availableTools = this.selectTools(context);
    const response = await this.llm.invoke({
      messages: [
        { role: 'system', content: SINGLE_TOOL_SYSTEM_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({
            message: context.message,
            attachments: runtimeAttachments(context),
            requiredCapabilities: context.decision.requiredCapabilities,
          }),
        },
      ],
      tools: availableTools,
      // 当前兼容的部分思考模型不支持 required；由提示词要求一次调用，无调用则明确失败。
      toolChoice: 'auto',
    });
    const toolCall = response.tool_calls?.[0];
    const functionName = toolCall?.function?.name;
    if (!functionName) {
      throw new Error('Single Tool 路径未选择工具');
    }
    const tool = this.findTool(
      functionName,
      new Set(availableTools.map((descriptor) => descriptor.name)),
    );
    if (!tool) {
      throw new Error(`Single Tool 路径选择了未授权或无关工具：${functionName}`);
    }
    const arguments_ = await this.jsonParser.invoke<Record<string, unknown>>(
      String(toolCall.function.arguments ?? '{}'),
      {},
    );
    return {
      toolName: tool.groupName,
      functionName,
      arguments: arguments_,
    };
  }

  /** 把唯一工具结果交给无工具模型生成最终回答。 */
  async respond(input: SingleToolResponseInput): Promise<string> {
    const response = await this.llm.invoke({
      messages: [
        { role: 'system', content: SINGLE_TOOL_SUMMARY_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({
            message: input.context.message,
            tool: input.invocation.functionName,
            arguments: input.invocation.arguments,
            result: input.result,
          }),
        },
      ],
      toolChoice: 'none',
    });
    return messageToText(response.content);
  }

  /** 按函数名定位实际拥有该能力的 Agent 工具。 */
  private findTool(functionName: string, allowedNames: ReadonlySet<string>) {
    return allowedNames.has(functionName)
      ? this.toolRegistry.resolve(functionName)
      : undefined;
  }

  /** 同步动态工具，并根据 Runtime 上下文计算本轮唯一可见集合。 */
  private selectTools(context: RuntimeExecutionContext): ToolDescriptor[] {
    synchronizeAgentToolRegistry(this.toolRegistry, this.tools);
    const result = this.toolSelector.select(toolSelectionRequest(context));
    if (result.uncoveredCapabilities.length > 0) {
      throw new Error(
        `Single Tool capability 无可用工具：${result.uncoveredCapabilities.join(', ')}`,
      );
    }
    if (result.tools.length === 0) {
      throw new Error('Single Tool 路径没有已授权且相关的工具');
    }
    return result.tools;
  }
}

/** 把 Single Tool 调用桥接到现有 BaseTool 实现。 */
export class AgentToolRuntimeInvoker implements RuntimeToolInvoker {
  private readonly toolRegistry: ToolRegistry;

  /** 固定本轮可调用工具集合。 */
  constructor(private readonly tools: readonly BaseTool[]) {
    this.toolRegistry = createAgentToolRegistry(tools);
  }

  /** 按函数名找到工具并执行一次结构化调用。 */
  async invoke(input: RuntimeToolCallInput): Promise<ToolResult> {
    synchronizeAgentToolRegistry(this.toolRegistry, this.tools);
    const tool = this.toolRegistry.resolve(input.functionName);
    if (!tool) {
      throw new Error(`Runtime 工具不存在：${input.functionName}`);
    }
    return tool.invoke(input.arguments);
  }
}

/** 在 Workflow Registry 完成前明确拒绝直接执行未知 Workflow。 */
export class UnavailableRuntimeWorkflowRunner implements RuntimeWorkflowRunner {
  /** 抛出稳定错误；Runtime 协调器应在到达此处前把未知 Workflow 回退到 Planned Agent。 */
  async *execute(input: RuntimeWorkflowInput): AsyncIterable<RuntimeExecutionEventPayload> {
    throw new Error(`Workflow 尚未注册：${input.workflowName}`);
  }
}

/** 把 PlannerReActFlow 接入 Planned Agent 执行器边界。 */
export class PlannerFlowRuntimeRunner implements PlannedAgentRunner {
  /** 注入当前 AgentTaskRunner 持有的 Planner Flow。 */
  constructor(private readonly flow: PlannerReActFlow) {}

  /** 将 Planner Event 流逐条转换为不带 envelope 的 Runtime Event 载荷。 */
  async *execute(context: RuntimeExecutionContext): AsyncIterable<RuntimeExecutionEventPayload> {
    const message = createMessage({
      message: context.message,
      attachments: runtimeAttachments(context),
    });
    for await (const event of this.flow.invoke(message, toolSelectionRequest(context))) {
      const payload = flowEventToRuntimePayload(event);
      if (payload) {
        yield payload;
      }
    }
  }
}

/** 把 Runtime 路由能力和外部约束组合成一次完整工具选择请求。 */
function toolSelectionRequest(context: RuntimeExecutionContext): ToolSelectionRequest {
  return {
    ...structuredClone(context.toolSelection),
    // Router 决策是权威输入，外部约束不能用同名运行时属性覆盖。
    routerCapabilities: [...context.decision.requiredCapabilities],
  };
}

/** 从私有执行上下文读取附件路径，避免路径进入对外 Runtime Event。 */
function runtimeAttachments(context: RuntimeExecutionContext): string[] {
  const attachments = context.privateContext.attachments;
  return Array.isArray(attachments)
    ? attachments.filter((item): item is string => typeof item === 'string')
    : [];
}

/** 将 Planner Event 联合类型映射为 Runtime 路径允许产生的业务载荷。 */
function flowEventToRuntimePayload(event: Event): RuntimeExecutionEventPayload | null {
  switch (event.type) {
    case 'title':
      return { type: 'title.updated', title: event.title };
    case 'message':
      return {
        type: 'message.created',
        role: event.role,
        message: event.message,
        attachments: event.attachments,
      };
    case 'plan':
      return {
        type: event.status === PlanEventStatus.CREATED
          ? 'plan.created'
          : event.status === PlanEventStatus.UPDATED
            ? 'plan.updated'
            : 'plan.completed',
        plan: event.plan,
      };
    case 'step':
      return {
        type: event.status === StepEventStatus.STARTED
          ? 'step.started'
          : event.status === StepEventStatus.COMPLETED
            ? 'step.completed'
            : 'step.failed',
        step: event.step,
      };
    case 'tool':
      return {
        type: event.status === ToolEventStatus.CALLING ? 'tool.calling' : 'tool.called',
        toolCallId: event.tool_call_id,
        toolName: event.tool_name,
        functionName: event.function_name,
        arguments: event.function_args,
        result: event.function_result,
        content: event.tool_content,
      };
    case 'wait':
      return { type: 'run.waiting' };
    case 'error':
      throw new Error(event.error);
    case 'done':
      return null;
  }
}
