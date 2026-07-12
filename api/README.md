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

统一在项目根目录 `.env` 中配置 PostgreSQL、Redis、COS 和沙箱参数，并通过根目录 Docker Compose 启动依赖。

## 启动服务

```powershell
npm run start:local
```

服务使用 `/api` 全局前缀。默认从 `.env` 的 `PORT` 开始监听；如果端口已被占用，会继续尝试下一个端口，直到启动成功。控制台会打印最终访问地址。

## Docker 启动

先确保项目根目录 `.env` 已完成配置，并通过 Docker Compose 启动所需服务。运行时应用配置由 API 自动创建并持久化，无需手工维护 `config.yaml`。然后执行：

```powershell
docker compose up -d --build
```

该配置用于直接替换原服务，沿用相同的容器名、端口、网络和数据卷：

| 容器 | 宿主机端口 | 说明 |
| --- | --- | --- |
| `manus-api-dev` | `8000` | TS API，容器内监听 `8000` |
| `manus-db-dev` | `5432` | PostgreSQL，复用 `manus_postgres_data_dev` |
| `manus-redis-dev` | `6379` | Redis，复用 `manus_redis_data_dev` |

Compose 会等待 PostgreSQL 和 Redis 就绪后启动 TS API。API 通过只读 Docker Socket 继续在已有 `manus-network-dev` 网络中动态创建沙箱容器。为保护原 Alembic 数据库，Compose 不会自动执行 `prisma db push`。

查看状态：

```powershell
docker compose ps
docker compose logs -f api
```

停止容器：

```powershell
docker compose down
```

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
