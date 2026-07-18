import { RouteKind } from '../../models/agent-run';
import { NormalizedRuntimeRouteRequest } from '../../models/route-decision';
import { DeterministicRouteRule } from './router.service';

const DIRECT_EXPLANATION_PATTERNS = [
  /^(?:请)?(?:简单|简要)?(?:解释|说明)(?:一下)?(?:什么是|何为)\s*.+[？?]?$/u,
  /^(?:什么是|何为)\s*.+[？?]?$/u,
  /^.+(?:是什么意思|的含义是什么)[？?]?$/u,
  /^(?:what is|define)\s+.+[?]?$/iu,
];

const EXTERNAL_CONTEXT_PATTERNS = [
  /https?:\/\//iu,
  /(?:今天|当前|现在|最新|实时|近期).*(?:天气|新闻|股价|汇率|价格|赛程|数据)/u,
  /(?:搜索|检索|查找|查询|打开|访问).*(?:网页|网站|链接|文件|附件|资料|新闻|数据)/u,
  /(?:帮我|请)(?:执行|运行|发送|创建|修改|删除|上传|下载)/u,
];

/** 对无需外部上下文的短概念解释请求给出稳定 Direct 决策。 */
export class DirectExplanationRouteRule implements DeterministicRouteRule {
  readonly name = 'direct-explanation';

  /** 只命中明确的定义句；有 Skill、长上下文或外部数据迹象时交回模型。 */
  evaluate(request: NormalizedRuntimeRouteRequest): unknown | null {
    const message = request.message.trim();
    if (
      request.requestedSkills.length > 0
      || message.length > 300
      || EXTERNAL_CONTEXT_PATTERNS.some((pattern) => pattern.test(message))
      || !DIRECT_EXPLANATION_PATTERNS.some((pattern) => pattern.test(message))
    ) {
      return null;
    }

    return {
      route: RouteKind.DIRECT,
      reason: '命中无需外部能力的概念解释规则',
      requiredCapabilities: [],
      requestedSkills: [],
      confidence: 1,
    };
  }
}

/** 返回生产环境默认启用且按优先级排列的确定性路由规则。 */
export function createDefaultRuntimeRouteRules(): DeterministicRouteRule[] {
  return [new DirectExplanationRouteRule()];
}
