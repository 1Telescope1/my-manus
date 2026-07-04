import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ResponseEnvelope } from '../schemas/base';
import { AppException } from './exceptions';

type JsonResponse = {
  status(code: number): { json(body: unknown): void };
};

/** 将所有异常统一包装成统一响应结构。 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    // 当前过滤器只处理 HTTP 请求上下文，因此先取出底层响应对象。
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<JsonResponse>();

    // 业务异常已经携带业务状态码、消息和扩展数据，直接透传给响应结构。
    if (exception instanceof AppException) {
      this.logger.error(`AppException: ${exception.msg}`);
      response
        .status(exception.statusCode)
        .json(ResponseEnvelope.fail(exception.statusCode, exception.msg, exception.data));
      return;
    }

    // Nest 内置异常可能返回字符串或对象，这里统一提取成可读消息。
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const exceptionResponse = exception.getResponse();
      const message =
        typeof exceptionResponse === 'string'
          ? exceptionResponse
          : (exceptionResponse as { message?: string | string[] }).message ?? exception.message;
      const normalizedMessage = Array.isArray(message) ? message.join('; ') : message;

      this.logger.error(`HttpException: ${normalizedMessage}`);
      response.status(status).json(ResponseEnvelope.fail(status, normalizedMessage));
      return;
    }

    // 未知异常只暴露通用错误文案，详细堆栈保留在控制台日志中。
    const error = exception instanceof Error ? exception : new Error(String(exception));
    this.logger.error(`Exception: ${error.message}`, error.stack);
    response
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json(ResponseEnvelope.fail(HttpStatus.INTERNAL_SERVER_ERROR, '服务器出现异常，请稍后尝试'));
  }
}

