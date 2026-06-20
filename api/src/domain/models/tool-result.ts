export type ToolResult<T = unknown> = {
  success: boolean;
  message?: string;
  data?: T;
};

export function toolResultFromSandbox<T>(code: number, msg: string, data?: T): ToolResult<T> {
  return {
    success: code < 300,
    message: msg,
    data,
  };
}
