# Manus TypeScript 一键部署

本项目由 NestJS API、Next.js UI、NestJS Sandbox、PostgreSQL、Redis 和 Nginx 组成。默认使用一个常驻沙箱，适合单机私有部署；所有服务由 Docker Compose 统一构建和启动。

## 一键启动

要求：Docker 20.10+，Docker Compose 2.20+。

```bash
docker compose up -d --build
```

首次启动会自动完成以下操作：

- 构建 API、UI 和 Sandbox 镜像；
- 启动 PostgreSQL 和 Redis；
- 执行 Prisma 数据库迁移；
- 创建并持久化默认应用配置；
- 等待服务健康后启动 Nginx。

启动完成后访问 <http://localhost:8088>。首次部署前必须在根目录 `.env` 中填写有效的 `LLM_API_KEY`；模型地址和名称可通过 `LLM_BASE_URL`、`LLM_MODEL_NAME` 配置。

## 可选配置

根目录 `.env` 是 Docker 一键部署的统一配置入口，集中管理 API、Sandbox、UI、PostgreSQL 和 Redis 的环境变量。修改配置后重新构建并启动：

```bash
docker compose up -d --build
```

如果 `.env` 被删除，可以从示例重新创建：

```bash
cp .env.example .env
```

项目只保留根目录 `.env`，API、Sandbox 和 UI 不再维护重复的环境配置文件。腾讯云 COS 未配置时不影响系统启动，但上传和持久化文件功能不可用。生产环境务必修改 `POSTGRES_PASSWORD`，如设置 `REDIS_PASSWORD`，Compose 会同时为 Redis 服务和 API 客户端启用该密码。

## 运维命令

```bash
docker compose ps
docker compose logs -f
docker compose logs -f api sandbox
docker compose restart api
docker compose down
```

数据保存在 `postgres_data`、`redis_data` 和 `api_config` 三个 Docker volume 中。普通的 `docker compose down` 不会删除数据；只有明确执行 `docker compose down -v` 才会清空。

## 服务结构

| 服务 | 作用 | 内部端口 |
| --- | --- | --- |
| nginx | 唯一对外入口，代理 HTTP、SSE 和 WebSocket | 80 |
| ui | Next.js 前端 | 3000 |
| api | NestJS API，启动时自动执行 Prisma 迁移 | 8000 |
| sandbox | Shell、Chromium、CDP、VNC | 8080/9222/5901 |
| postgres | 业务数据 | 5432 |
| redis | 任务流与消息流 | 6379 |

默认只暴露 Nginx，其他服务均留在 Compose 内部网络中。
