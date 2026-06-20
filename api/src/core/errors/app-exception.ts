export class AppException extends Error {
  constructor(
    readonly code = 400,
    readonly statusCode = 400,
    readonly msg = '应用发生错误请稍后尝试',
    readonly data: unknown = {},
  ) {
    super(msg);
  }
}

export class BadRequestError extends AppException {
  constructor(msg = '客户端请求错误，请检查后重试') {
    super(400, 400, msg);
  }
}

export class NotFoundError extends AppException {
  constructor(msg = '资源未找到，请核实后重试') {
    super(404, 404, msg);
  }
}

export class ValidationAppError extends AppException {
  constructor(msg = '请求参数数据校验错误，请核实后重试') {
    super(422, 422, msg);
  }
}

export class TooManyRequestsError extends AppException {
  constructor(msg = '请求过多，触发限流，请稍后重试') {
    super(429, 429, msg);
  }
}

export class ServerRequestsError extends AppException {
  constructor(msg = '服务端出现异常请稍后重试') {
    super(500, 500, msg);
  }
}
