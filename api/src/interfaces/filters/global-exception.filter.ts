import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { AppException } from '../../core/errors/app-exception';
import { ResponseEnvelope } from '../../core/response/api-response';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();

    if (exception instanceof AppException) {
      this.logger.error(`AppException: ${exception.msg}`);
      response
        .status(exception.statusCode)
        .json(ResponseEnvelope.fail(exception.code, exception.msg, exception.data));
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
      .json(ResponseEnvelope.fail(500, '服务端出现异常请稍后重试'));
  }
}
