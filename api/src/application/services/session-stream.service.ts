import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Session } from '../../domain/models/session';
import { SessionService } from './session.service';

const SESSION_REFRESH_INTERVAL_MS = 5_000;

type SessionListener = (sessions: Session[]) => void;

/** 共享会话列表查询结果，避免每个 SSE 连接分别轮询数据库。 */
@Injectable()
export class SessionStreamService implements OnModuleDestroy {
  private readonly logger = new Logger(SessionStreamService.name);
  private readonly listeners = new Set<SessionListener>();
  private timer?: NodeJS.Timeout;
  private polling?: Promise<void>;

  constructor(private readonly sessionService: SessionService) {}

  /** 订阅会话列表；返回函数用于断开连接时取消订阅。 */
  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      this.startPolling();
    }

    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.stopPolling();
      }
    };
  }

  onModuleDestroy(): void {
    this.listeners.clear();
    this.stopPolling();
  }

  private startPolling(): void {
    // 首个订阅建立后立即推送一次，后续保持原有五秒刷新间隔。
    this.poll();
    this.timer = setInterval(() => this.poll(), SESSION_REFRESH_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private poll(): void {
    // 上一次查询尚未结束时不重复发起数据库请求。
    if (this.polling) {
      return;
    }

    this.polling = this.broadcastSessions().finally(() => {
      this.polling = undefined;
    });
  }

  private async broadcastSessions(): Promise<void> {
    try {
      const sessions = await this.sessionService.getAllSessions();
      for (const listener of [...this.listeners]) {
        listener(sessions);
      }
    } catch (error) {
      this.logger.error(`刷新会话列表失败: ${errorMessage(error)}`);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
