import { Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import { getSettings } from './config/settings';
import { SupervisorService } from '../services/supervisor.service';

type MiddlewareRequest = {
  originalUrl?: string;
  url?: string;
};

type NextFunction = (error?: unknown) => void;

@Injectable()
export class AutoExtendTimeoutMiddleware implements NestMiddleware {
  private readonly logger = new Logger(AutoExtendTimeoutMiddleware.name);

  constructor(private readonly supervisorService: SupervisorService) {}

  /** 使用中间件延长每次 API 请求的超时销毁时间。 */
  async use(
    request: MiddlewareRequest,
    _response: unknown,
    next: NextFunction,
  ): Promise<void> {
    // 1. 获取系统配置。
    const settings = getSettings();
    const requestPath = getRequestPath(request);

    // 2. 判断逻辑，仅在符合条件时延长超时销毁时间 3 分钟。
    // 超时管理接口本身不触发自动延长，避免手动控制和自动保活互相影响。
    const ignorePaths = [
      '/api/supervisor/activate-timeout',
      '/api/supervisor/extend-timeout',
      '/api/supervisor/cancel-timeout',
      '/api/supervisor/timeout-status',
    ];

    if (
      settings.serverTimeoutMinutes !== null &&
      settings.serverTimeoutMinutes !== undefined &&
      this.supervisorService.isTimeoutActive &&
      requestPath.startsWith('/api/') &&
      !ignorePaths.some((path) => requestPath.startsWith(path)) &&
      this.supervisorService.expandEnabled
    ) {
      try {
        // 每次普通 API 调用只小幅延长，避免无人访问时沙箱长期存活。
        await this.supervisorService.extendTimeout(3);
        this.logger.debug(`调用 API 请求而自动延长超时销毁时长: ${requestPath}`);
      } catch (error) {
        this.logger.warn(`自动延长超时失败: ${errorMessage(error)}`);
      }
    }

    next();
  }
}

function getRequestPath(request: MiddlewareRequest): string {
  const rawUrl = request.originalUrl ?? request.url ?? '';
  return rawUrl.split('?')[0] || '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
