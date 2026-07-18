import { ToolDescriptor } from './tool';
import { ToolResult } from './tool-result';

/** 一次可靠工具调用所需的运行上下文。 */
export type ToolInvocationRequest = {
  functionName: string;
  arguments: Record<string, unknown>;
  scopeId: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
};

/** 审批器判断一次具体调用是否可以继续。 */
export type ToolApprovalDecision =
  | { outcome: 'approved' }
  | { outcome: 'denied'; reason?: string };

/** 高风险工具审批端口；实现可映射到用户审批、策略服务或已持久化授权。 */
export interface ToolApprovalGate {
  /** 对具体工具和参数作出一次确定审批判断。 */
  authorize(input: {
    descriptor: ToolDescriptor;
    arguments: Readonly<Record<string, unknown>>;
    scopeId: string;
    idempotencyKey?: string;
    signal?: AbortSignal;
  }): Promise<ToolApprovalDecision>;
}

/** 幂等占用的稳定结果；existing 只在指纹相同且已有终态结果时返回。 */
export type ToolIdempotencyReservation =
  | { outcome: 'reserved' }
  | { outcome: 'existing'; result: ToolResult }
  | { outcome: 'in_progress' }
  | { outcome: 'conflict' };

/** 工具调用幂等端口；RUNTIME-107 可用持久化实现替换进程内实现。 */
export interface ToolIdempotencyStore {
  /** 原子占用 scope 内的幂等键，并校验请求指纹。 */
  reserve(input: {
    scopeId: string;
    idempotencyKey: string;
    requestFingerprint: string;
  }): Promise<ToolIdempotencyReservation>;

  /** 保存最终结果，使相同请求可以直接复用而不重复执行副作用。 */
  complete(input: {
    scopeId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    result: ToolResult;
  }): Promise<void>;
}
