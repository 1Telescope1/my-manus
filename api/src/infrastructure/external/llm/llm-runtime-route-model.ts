import { LLM, LLMMessage } from '../../../domain/external/llm';
import { RuntimeRouteModel } from '../../../domain/external/runtime-route-model';
import { NormalizedRuntimeRouteRequest } from '../../../domain/models/route-decision';

const ROUTER_SYSTEM_PROMPT = `你是请求路由器，只负责选择执行路径，不回答用户问题，也不调用工具。
只返回一个 JSON 对象，不要使用 Markdown。
所有路径必须包含 route、reason、requiredCapabilities、requestedSkills 和 confidence；两个 capabilities/skills 字段必须是数组，confidence 必须是 0 到 1 的数字。
只有 workflow 路径必须额外包含非空字符串 workflowName；direct、single_tool、planned_agent 必须省略 workflowName，不要返回 null。
route 只能是 direct、single_tool、workflow、planned_agent。
direct 用于无需外部能力的直接回答；single_tool 用于一次主要工具调用；workflow 用于已知确定性工作流；planned_agent 用于开放复杂任务。
requiredCapabilities 只能使用用户消息中 availableCapabilities 提供的精确值；不要发明同义词或不存在的 capability。`;

/** 通过现有厂商无关的 LLM 端口获取结构化路由候选。 */
export class LLMRuntimeRouteModel extends RuntimeRouteModel {
  /** 注入独立的轻量 LLM 客户端，不向适配器提供任何工具执行接口。 */
  constructor(private readonly llm: LLM) {
    super();
  }

  /** 请求 JSON 路由结果并把消息内容解析为待校验对象。 */
  async decide(request: NormalizedRuntimeRouteRequest): Promise<unknown> {
    // 调用参数刻意不包含 tools 和 toolChoice，从边界上禁止模型触发副作用。
    const response = await this.llm.invoke({
      messages: [
        { role: 'system', content: ROUTER_SYSTEM_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({
            message: request.message,
            requestedSkills: request.requestedSkills,
            availableCapabilities: request.availableCapabilities,
          }),
        },
      ],
      responseFormat: { type: 'json_object' },
    });

    return parseModelContent(response);
  }
}

/** 将模型消息中的 JSON 字符串或对象转换成领域层可校验的未知值。 */
function parseModelContent(response: LLMMessage): unknown {
  const content: unknown = response.content;
  if (typeof content === 'string') {
    return normalizeRouteModelObject(JSON.parse(content));
  }
  if (content !== null && typeof content === 'object' && !Array.isArray(content)) {
    return normalizeRouteModelObject(content);
  }
  throw new TypeError('路由模型必须返回 JSON 对象或 JSON 字符串');
}

/** 兼容模型常见的可选字段 null 表达，并保持其他未知字段交给严格 Schema 拒绝。 */
function normalizeRouteModelObject(value: object): object {
  if (
    'workflowName' in value
    && (value as Record<string, unknown>).workflowName === null
  ) {
    const normalized = { ...value } as Record<string, unknown>;
    delete normalized.workflowName;
    return normalized;
  }
  return value;
}
