import { z } from 'zod';
import { RouteKind } from './agent-run';

const routeTextSchema = z.string().trim().min(1).max(512);
const routeNameSchema = z.string().trim().min(1).max(128);

/** Router 可见的最小 Skill Catalog 项；不允许携带正文或文件路径。 */
export const RuntimeRouteSkillSchema = z.object({
  id: routeNameSchema,
  name: routeNameSchema,
  description: z.string().trim().min(1),
}).strict();

/** 路由服务接收的最小用户请求上下文。 */
export const RuntimeRouteRequestSchema = z.object({
  message: z.string().trim().min(1).max(100_000),
  requestedSkills: z.array(routeNameSchema).max(32).default([]),
  availableSkills: z.array(RuntimeRouteSkillSchema).default([]),
  availableCapabilities: z.array(routeNameSchema).max(512).default([]),
}).strict();

/** 调用方可传入的原始路由请求。 */
export type RuntimeRouteRequest = z.input<typeof RuntimeRouteRequestSchema>;

/** 经过 Schema 清理并补齐默认值的路由请求。 */
export type NormalizedRuntimeRouteRequest = z.output<typeof RuntimeRouteRequestSchema>;

const routeDecisionBaseSchema = z.object({
  route: z.nativeEnum(RouteKind),
  reason: routeTextSchema,
  requiredCapabilities: z.array(routeNameSchema).max(32),
  requestedSkills: z.array(routeNameSchema).max(32),
  workflowName: routeNameSchema.optional(),
  confidence: z.number().min(0).max(1),
}).strict();

type RouteDecisionCandidate = z.infer<typeof routeDecisionBaseSchema>;

/** 校验只有跨字段组合才能表达的路径语义约束。 */
function validateRouteDecision(
  decision: RouteDecisionCandidate,
  context: z.RefinementCtx,
): void {
  // Workflow 必须给出可定位的名称，其他路径携带名称会产生含糊的执行语义。
  if (decision.route === RouteKind.WORKFLOW && !decision.workflowName) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'workflow 路由必须提供 workflowName',
      path: ['workflowName'],
    });
  }
  if (decision.route !== RouteKind.WORKFLOW && decision.workflowName) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: '只有 workflow 路由可以提供 workflowName',
      path: ['workflowName'],
    });
  }

  // Direct 路径不应声明外部能力，否则会违背“不调用工具”的路径语义。
  if (decision.route === RouteKind.DIRECT && decision.requiredCapabilities.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'direct 路由不能要求外部能力',
      path: ['requiredCapabilities'],
    });
  }
}

/** 四类执行路径共用的严格路由决策结构。 */
export const RouteDecisionSchema = routeDecisionBaseSchema.superRefine(validateRouteDecision);

/** 路由器和后续执行器之间传递的已校验决策。 */
export type RouteDecision = z.infer<typeof RouteDecisionSchema>;
