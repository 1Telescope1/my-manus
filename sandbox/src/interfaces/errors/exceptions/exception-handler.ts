import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ResponseEnvelope } from '../../schemas/base';
import { AppException } from './exceptions';

type JsonResponse = {
  status(code: number): { json(body: unknown): void };
};

/** 将所有异常统一包装成 Python `Response` 结构。 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<JsonResponse>();

    if (exception instanceof AppException) {
      this.logger.error(`AppException: ${exception.msg}`);
      response
        .status(exception.statusCode)
        .json(ResponseEnvelope.fail(exception.statusCode, exception.msg, exception.data));
      return;
    }

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

    const error = exception instanceof Error ? exception : new Error(String(exception));
    this.logger.error(`Exception: ${error.message}`, error.stack);
    response
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json(ResponseEnvelope.fail(HttpStatus.INTERNAL_SERVER_ERROR, '服务器出现异常，请稍后尝试'));
  }
}
