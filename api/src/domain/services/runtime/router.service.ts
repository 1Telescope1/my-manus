import { RuntimeRouteModel } from '../../external/runtime-route-model';
import { ZodError } from 'zod';
import { RouteKind } from '../../models/agent-run';
import {
  NormalizedRuntimeRouteRequest,
  RouteDecision,
  RouteDecisionSchema,
  RuntimeRouteRequest,
  RuntimeRouteRequestSchema,
} from '../../models/route-decision';

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
  async route(input: RuntimeRouteRequest, signal?: AbortSignal): Promise<RouteDecision> {
    const request = RuntimeRouteRequestSchema.parse(input);

    // 确定性规则按注册顺序执行；首个命中结果结束路由，完全不调用模型。
    for (const rule of this.rules) {
      const candidate = rule.evaluate(request);
      if (candidate === null) {
        continue;
      }
      return this.validateCandidate(candidate, request, `确定性规则 ${rule.name}`);
    }

    // 规则均未命中时才调用受限路由模型；模型异常不能阻断用户请求。
    let candidate: unknown;
    try {
      candidate = await this.model.decide(request, signal);
    } catch (error) {
      // 取消不能被安全回退吞掉，否则停止后仍会进入 Planned Agent。
      if (signal?.aborted) {
        throw error;
      }
      return createPlannedAgentFallback(request, '路由模型调用失败');
    }

    return this.validateCandidate(candidate, request, '路由模型');
  }

  /** 统一校验规则与模型候选，失败时收敛到同一安全路径。 */
  private validateCandidate(
    candidate: unknown,
    request: NormalizedRuntimeRouteRequest,
    source: string,
  ): RouteDecision {
    const decision = RouteDecisionSchema.safeParse(candidate);
    if (!decision.success) {
      return createPlannedAgentFallback(
        request,
        routeValidationCause(`${source}返回无效结果`, decision.error),
      );
    }
    if (decision.data.confidence < this.minimumConfidence) {
      return createPlannedAgentFallback(request, `${source}的置信度不足`);
    }
    const unavailableCapabilities = findUnavailableCapabilities(request, decision.data);
    if (unavailableCapabilities.length > 0) {
      return createPlannedAgentFallback(
        request,
        `${source}请求了不可用 capability：${unavailableCapabilities.join(', ')}`,
      );
    }
    return decision.data;
  }
}

/** 当调用方提供 capability catalog 时找出模型或规则发明的未知值。 */
function findUnavailableCapabilities(
  request: NormalizedRuntimeRouteRequest,
  decision: RouteDecision,
): string[] {
  if (request.availableCapabilities.length === 0) {
    return [];
  }
  const available = new Set(request.availableCapabilities);
  return decision.requiredCapabilities.filter((capability) => !available.has(capability));
}

/** 提取首个 Schema 问题写入回退原因，避免诊断时只能看到笼统的无效结果。 */
function routeValidationCause(prefix: string, error: ZodError): string {
  const issue = error.issues[0];
  if (!issue) {
    return prefix;
  }
  const path = issue.path.length > 0 ? issue.path.join('.') : 'decision';
  return `${prefix}（${path}: ${issue.message}）`;
}

/** 校验配置的置信度阈值，避免错误配置使所有请求静默走错路径。 */
function parseConfidenceThreshold(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError('minimumConfidence 必须是 0 到 1 之间的有限数字');
  }
  return value;
}

/** 构造稳定的 Planned Agent 安全回退决策。 */
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
