import type { ToolRisk } from './tool';

/** 工具失败的稳定分类，供 Runtime、模型与后续恢复策略判断。 */
export type ToolErrorCode =
  | 'invalid_input'
  | 'approval_required'
  | 'approval_denied'
  | 'idempotency_conflict'
  | 'duplicate_in_progress'
  | 'uncertain_side_effect'
  | 'timeout'
  | 'cancelled'
  | 'execution_failed';

/** 结构化工具错误；retryable 只表达错误性质，实际重试仍受风险策略约束。 */
export type ToolError = {
  code: ToolErrorCode;
  message: string;
  retryable: boolean;
  details?: unknown;
};

/** 可靠调用层补充的可观测元数据。 */
export type ToolResultMetadata = {
  attempts: number;
  durationMs: number;
  risk: ToolRisk;
  idempotencyKey?: string;
  replayed?: boolean;
  signalPropagation: 'forwarded' | 'guarded';
};

/** 所有工具共用的结果；message 为现有消费者保留，error/metadata 提供稳定机器语义。 */
export type ToolResult<T = unknown> = {
  success: boolean;
  message?: string;
  data?: T;
  error?: ToolError;
  metadata?: ToolResultMetadata;
};

/** 将 Sandbox 的 HTTP 风格结果转换成兼容 ToolResult。 */
export function toolResultFromSandbox<T>(code: number, msg: string, data?: T): ToolResult<T> {
  return {
    success: code < 300,
    message: msg,
    data,
  };
}
