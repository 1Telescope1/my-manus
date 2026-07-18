import { NormalizedRuntimeRouteRequest } from '../models/route-decision';

/** 不绑定特定模型厂商的轻量路由端口；返回值必须再经过领域 Schema 校验。 */
export abstract class RuntimeRouteModel {
  /** 仅分析请求并返回候选决策，不具备任何工具执行能力。 */
  abstract decide(request: NormalizedRuntimeRouteRequest): Promise<unknown>;
}
