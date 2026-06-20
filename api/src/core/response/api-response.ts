export type EmptyObject = Record<string, never>;

export type ApiResponse<T = unknown> = {
  code: number;
  msg: string;
  data: T | EmptyObject;
};

export class ResponseEnvelope {
  static success<T>(data?: T, msg = 'success'): ApiResponse<T> {
    return {
      code: 200,
      msg,
      data: data ?? ({} as EmptyObject),
    };
  }

  static fail<T>(code: number, msg: string, data?: T): ApiResponse<T> {
    return {
      code,
      msg,
      data: data ?? ({} as EmptyObject),
    };
  }
}
