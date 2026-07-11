# MoocManus API 服务

基于 NestJS 和 TypeScript 构建的后端 API 服务，提供会话管理、Agent 调度、文件处理、沙箱管理等核心功能。

## 技术栈

- Node.js 20+
- NestJS
- Prisma + PostgreSQL
- Redis
- Dockerode
- Playwright
- WebSocket

## 环境准备

```powershell
npm install
npm run prisma:generate
```

根据 `.env.example` 创建本地 `.env`，配置 PostgreSQL、Redis、COS 和沙箱参数。

## 启动服务

```powershell
npm run start:local
```

服务使用 `/api` 全局前缀。默认从 `.env` 的 `PORT` 开始监听；如果端口已被占用，会继续尝试下一个端口，直到启动成功。控制台会打印最终访问地址。

## 主要接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/status` | 健康检查 |
| GET/POST | `/api/app-config` | 应用配置管理 |
| POST | `/api/files` | 文件上传 |
| GET | `/api/files/:id/download` | 文件下载 |
| POST | `/api/sessions` | 创建会话 |
| POST | `/api/sessions/stream` | SSE 流式获取会话列表 |
| GET | `/api/sessions/:id` | 获取会话详情 |
| POST | `/api/sessions/:id/chat` | SSE 流式对话 |
| GET | `/api/sessions/:id/files` | 获取会话文件 |
| POST | `/api/sessions/:id/file` | 读取沙箱文件 |
| POST | `/api/sessions/:id/shell` | 读取 Shell 输出 |
| WS | `/api/sessions/:id/vnc` | VNC WebSocket 代理 |

## 数据库

Prisma 数据模型位于 `prisma/schema.prisma`。数据库连接由 `.env` 中的 `DATABASE_URL` 或 `SQLALCHEMY_DATABASE_URI` 提供。
