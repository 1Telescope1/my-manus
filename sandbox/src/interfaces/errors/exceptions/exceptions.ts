import { HttpStatus, Logger } from '@nestjs/common';

/** 应用基础异常，对齐 Python `AppException`。 */
export class AppException extends Error {
  private static readonly logger = new Logger(AppException.name);

  constructor(
    readonly msg = '应用发生错误，请稍后尝试',
    readonly statusCode = HttpStatus.INTERNAL_SERVER_ERROR,
    readonly data: unknown = {},
  ) {
    super(msg);
    AppException.logger.error(`沙箱发生错误: ${msg} (code: ${statusCode})`);
  }
}

/** 资源未找到异常。 */
export class NotFoundException extends AppException {
  constructor(msg = '资源未找到，请核实后尝试') {
    super(msg, HttpStatus.NOT_FOUND);
  }
}

/** 错误请求异常。 */
export class BadRequestException extends AppException {
  constructor(msg = '客户端请求错误，请检查后重试') {
    super(msg, HttpStatus.BAD_REQUEST);
  }
}
