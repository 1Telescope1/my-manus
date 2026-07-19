/** 表示执行链因 Run 取消而主动短路，不应被归类为普通失败。 */
export class RuntimeCancelledError extends Error {
  /** 保留 AbortError 名称以兼容底层 SDK 和既有取消识别逻辑。 */
  constructor(message = 'Runtime 执行已取消', readonly reason?: unknown) {
    super(message);
    this.name = 'AbortError';
  }
}

/** Signal 已终止时抛出统一取消异常，阻止调用方继续调度活动。 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new RuntimeCancelledError('Runtime 执行已取消', signal.reason);
  }
}

/** 判断异常是否属于标准或 SDK 常见取消异常。 */
export function isCancellationError(error: unknown): boolean {
  return error instanceof Error
    && ['AbortError', 'CancelError', 'CancelledError'].includes(error.name);
}

