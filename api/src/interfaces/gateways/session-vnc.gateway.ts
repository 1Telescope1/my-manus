import { HttpAdapterHost } from '@nestjs/core';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { IncomingMessage, Server } from 'node:http';
import { Duplex } from 'node:stream';
import WebSocket, { RawData, WebSocketServer } from 'ws';
import { SessionService } from '../../application/services/session.service';

@Injectable()
export class SessionVncGateway implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SessionVncGateway.name);
  private readonly webSocketServer = new WebSocketServer({
    noServer: true,
    handleProtocols(protocols) {
      if (protocols.has('binary')) {
        return 'binary';
      }
      if (protocols.has('base64')) {
        return 'base64';
      }
      return false;
    },
  });
  private httpServer?: Server;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly sessionService: SessionService,
  ) {}

  onModuleInit(): void {
    this.httpServer = this.adapterHost.httpAdapter.getHttpServer() as Server;
    this.httpServer.on('upgrade', this.handleUpgrade);
  }

  onModuleDestroy(): void {
    this.httpServer?.off('upgrade', this.handleUpgrade);
    this.webSocketServer.close();
  }

  /** 建立客户端与沙箱 VNC 之间的双向 WebSocket 转发。 */
  private readonly handleUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    const match = pathname.match(/^\/api\/sessions\/([^/]+)\/vnc$/);
    if (!match) {
      return;
    }

    const sessionId = decodeURIComponent(match[1]);
    const protocols = (request.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((protocol) => protocol.trim());
    const selectedProtocol = protocols.includes('binary')
      ? 'binary'
      : protocols.includes('base64')
        ? 'base64'
        : undefined;

    this.logger.log(`为会话[${sessionId}]开启WebSocket连接`);
    this.webSocketServer.handleUpgrade(request, socket, head, (client) => {
      void this.proxyVnc(client, sessionId, selectedProtocol);
    });
  };

  private async proxyVnc(
    client: WebSocket,
    sessionId: string,
    selectedProtocol?: string,
  ): Promise<void> {
    try {
      // 1. 获取对应会话的 VNC 链接。
      const sandboxVncUrl = await this.sessionService.getVncUrl(sessionId);
      this.logger.log(`连接WebSocket VNC： ${sandboxVncUrl}`);

      // 2. 连接沙箱 VNC，并双向转发数据。
      const sandbox = new WebSocket(sandboxVncUrl, selectedProtocol ? [selectedProtocol] : undefined);
      sandbox.on('message', (data: RawData) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(data, { binary: true });
        }
      });
      client.on('message', (data: RawData) => {
        if (sandbox.readyState === WebSocket.OPEN) {
          sandbox.send(data, { binary: true });
        }
      });

      // 3. 任意一端关闭时同步关闭另一端连接。
      sandbox.on('close', () => client.close());
      client.on('close', () => sandbox.close());
      sandbox.on('error', (error) => {
        this.logger.error(`VNC->Web连接出错: ${error.message}`);
        client.close(1011, `连接沙箱环境失败: ${error.message}`);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`WebSocket异常: ${message}`);
      client.close(1011, `WebSocket异常: ${message}`);
    }
  }
}
