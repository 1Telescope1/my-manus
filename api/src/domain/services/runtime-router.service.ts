import { RuntimeRouteModel } from '../external/runtime-route-model';
import { RouteKind } from '../models/agent-run';
import {
  NormalizedRuntimeRouteRequest,
  RouteDecision,
  RouteDecisionSchema,
  RuntimeRouteRequest,
  RuntimeRouteRequestSchema,
} from '../models/route-decision';

/** 模型路由的默认最低置信度，低于该值时保持 Planner 兼容路径。 */
export const DEFAULT_ROUTE_CONFIDENCE_THRESHOLD = 0.6;

/** 无外部副作用的同步确定性路由规则。 */
export interface DeterministicRouteRule {
  readonly name: string;

  /** 命中时返回候选决策，未命中时返回 null。 */
  evaluate(request: NormalizedRuntimeRouteRequest): unknown | null;
}

/** 创建运行路由服务时可调整的规则集合和置信度阈值。 */
export type RuntimeRouterOptions = {
  rules?: readonly DeterministicRouteRule[];
  minimumConfidence?: number;
};

/** 依次执行确定性规则和轻量模型，并始终返回安全的路由决策。 */
export class RuntimeRouterService {
  private readonly rules: readonly DeterministicRouteRule[];
  private readonly minimumConfidence: number;

  /** 固定规则顺序并校验置信度阈值，避免运行期间路由策略发生漂移。 */
  constructor(
    private readonly model: RuntimeRouteModel,
    options: RuntimeRouterOptions = {},
  ) {
    this.rules = [...(options.rules ?? [])];
    this.minimumConfidence = parseConfidenceThreshold(
      options.minimumConfidence ?? DEFAULT_ROUTE_CONFIDENCE_THRESHOLD,
    );
  }

  /** 优先返回确定性规则结果，未命中时使用模型，失败则回退 Planner。 */
  async route(input: RuntimeRouteRequest): Promise<RouteDecision> {
    const request = RuntimeRouteRequestSchema.parse(input);

    // 确定性规则按注册顺序执行；首个命中结果结束路由，完全不调用模型。
    for (const rule of this.rules) {
      const candidate = rule.evaluate(request);
      if (candidate === null) {
        continue;
      }

      const decision = RouteDecisionSchema.safeParse(candidate);
      if (!decision.success) {
        return createPlannedAgentFallback(
          request,
          `确定性规则 ${rule.name} 返回无效结果`,
        );
      }
      if (decision.data.confidence < this.minimumConfidence) {
        return createPlannedAgentFallback(
          request,
          `确定性规则 ${rule.name} 的置信度不足`,
        );
      }
      return decision.data;
    }

    // 规则均未命中时才调用受限路由模型；模型异常不能阻断用户请求。
    let candidate: unknown;
    try {
      candidate = await this.model.decide(request);
    } catch {
      return createPlannedAgentFallback(request, '路由模型调用失败');
    }

    // 模型输出属于不可信边界，必须经过严格 Schema 和置信度双重校验。
    const decision = RouteDecisionSchema.safeParse(candidate);
    if (!decision.success) {
      return createPlannedAgentFallback(request, '路由模型返回无效结果');
    }
    if (decision.data.confidence < this.minimumConfidence) {
      return createPlannedAgentFallback(request, '路由模型置信度不足');
    }
    return decision.data;
  }
}

/** 校验配置的置信度阈值，避免错误配置使所有请求静默走错路径。 */
function parseConfidenceThreshold(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError('minimumConfidence 必须是 0 到 1 之间的有限数字');
  }
  return value;
}

/** 构造与 legacy Planner 行为接近的稳定安全回退决策。 */
function createPlannedAgentFallback(
  request: NormalizedRuntimeRouteRequest,
  cause: string,
): RouteDecision {
  return {
    route: RouteKind.PLANNED_AGENT,
    reason: `${cause}，回退到 planned_agent`,
    requiredCapabilities: [],
    requestedSkills: [...request.requestedSkills],
    confidence: 0,
  };
}
