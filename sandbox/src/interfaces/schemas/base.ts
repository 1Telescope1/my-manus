export type EmptyObject = Record<string, never>;

export type ApiResponse<T = unknown> = {
  code: number;
  msg: string;
  data: T | EmptyObject;
};

/** 基础 API 响应结构，对齐 Python `Response` 泛型模型。 */
export class ResponseEnvelope {
  /** 成功响应，业务状态码固定为 200。 */
  static success<T>(data?: T, msg = 'success'): ApiResponse<T> {
    return {
      code: 200,
      msg,
      data: data ?? ({} as EmptyObject),
    };
  }

  /** 失败响应，携带业务状态码、消息和可选数据。 */
  static fail<T>(code: number, msg: string, data?: T): ApiResponse<T> {
    return {
      code,
      msg,
      data: data ?? ({} as EmptyObject),
    };
  }
}
