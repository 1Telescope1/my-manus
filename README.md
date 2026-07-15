# MoocManus - 通用 AI Agent 系统

MoocManus 是一个可私有化部署的通用 AI Agent 系统。系统使用 Planner + ReAct 完成任务规划和工具调用，支持内置浏览器、Shell、文件、搜索与消息工具，也可以通过 MCP 和 A2A 接入外部工具或 Agent。任务在独立沙箱中执行，前端可实时查看执行计划、工具事件、生成文件和 VNC 桌面。

## 项目结构

```text
project/
├── api/                    # NestJS 后端：会话、Agent、工具编排、数据持久化
├── ui/                     # Next.js 前端：对话、执行过程、文件与 VNC 展示
├── sandbox/                # NestJS 沙箱：Shell、文件、Chromium、VNC
├── nginx/                  # 统一反向代理，支持 HTTP、SSE 和 WebSocket
│   ├── nginx.conf
│   └── conf.d/default.conf
├── docker-compose.yml      # 全栈编排
├── .env.example            # 环境变量模板
└── README.md
```

各子项目的详细说明：

- [API 服务](./api/README.md)
- [前端 UI](./ui/README.md)
- [沙箱服务](./sandbox/README.md)
- [Nginx 网关](./nginx/README.md)

## 系统架构

```text
浏览器
  │ HTTP / SSE / WebSocket
  ▼
Nginx :8088
  ├── /      ─────────────► Next.js UI :3000
  └── /api/* ─────────────► NestJS API :8000
                               ├── PostgreSQL :5432（会话、事件、文件元数据）
                               ├── Redis :6379（任务输入/输出 Stream）
                               ├── LLM / MCP / A2A / 搜索 / COS
                               └── Sandbox :8080
                                      ├── Shell 与文件 API
                                      ├── Chromium CDP :9222
                                      └── VNC WebSocket :5901
```

一次对话的主要流程：

1. UI 创建会话并向 `/api/sessions/:id/chat` 发起 SSE 请求。
2. API 为会话取得或创建 Sandbox 和 Redis Stream Task。
3. `PlannerReActFlow` 先生成计划，再由 ReAct Agent 循环选择并执行工具。
4. 消息、计划、工具调用、文件和完成状态作为事件写入 Redis，并持久化到 PostgreSQL。
5. API 将事件实时推送给 UI；UI 更新对话、计划、工具预览、文件预览和 VNC 画面。

## 一次对话的完整调用链

```mermaid
sequenceDiagram
    autonumber
    participant UI
    participant Controller as SessionController
    participant Agent as AgentService
    participant Redis as Redis Stream
    participant Runner as AgentTaskRunner
    participant Flow as PlannerReActFlow
    participant LLM
    participant Tool as ShellTool/FileTool/BrowserTool
    participant Client as DockerSandbox
    participant Sandbox as Sandbox HTTP API
    participant Runtime as Bash/File/Chromium

    UI->>Controller: POST /api/sessions/:sessionId/chat
    Controller->>Agent: chat(sessionId, options)
    Agent->>Agent: 加载 Session，根据 task_id 查找 Task
    opt Task 或 Sandbox 不存在
        Agent->>Client: 获取或创建 Sandbox
        Agent->>Runner: 创建 Task 和 AgentTaskRunner
    end
    Agent->>Redis: 写入用户 MessageEvent 到 inputStream
    Agent->>Runner: task.invoke() 启动后台执行
    Note over Agent,Runner: Runner 生产事件，AgentService 同时从 Redis 读取事件
    Runner->>Redis: pop() 读取输入消息
    Runner->>Flow: invoke(message)

    Flow->>LLM: Planner 创建 Plan（JSON）
    LLM-->>Flow: Plan JSON 文本
    Flow-->>Runner: yield Title/Message/Plan 事件
    Runner->>Redis: 写入 outputStream 并持久化 Session

    loop 逐个执行未完成的 Step
        Flow->>LLM: ReAct 提交步骤目标和工具定义
        LLM-->>Flow: tool_call(name, arguments)
        Flow->>Tool: 调用对应 Tool
        Tool->>Client: 调用 Sandbox 抽象能力
        Client->>Sandbox: HTTP /api/shell、/api/file 或 CDP
        Sandbox->>Runtime: 执行命令、操作文件或控制浏览器
        Runtime-->>Sandbox: stdout、文件或浏览器结果
        Sandbox-->>Client: code、msg、data
        Client-->>Tool: ToolResult
        Tool-->>Flow: ToolResult
        Flow->>LLM: 回传工具执行结果
        LLM-->>Flow: Step 结果 JSON
        Flow-->>Runner: yield Step/Tool/Message 事件
        Runner->>Redis: 写入 outputStream 并持久化 Session
        Flow->>LLM: Planner 根据结果更新后续 Plan
        LLM-->>Flow: 更新后的 Plan JSON
        Flow-->>Runner: yield PlanEvent(UPDATED)
        Runner->>Redis: 写入 outputStream 并持久化 Session
    end

    Flow->>LLM: ReAct 汇总所有步骤
    LLM-->>Flow: 最终 MessageEvent
    Flow-->>Runner: yield Message/Plan(COMPLETED)/Done
    Runner->>Redis: 写入最终事件

    loop 实时读取直到 done/error/wait
        Agent->>Redis: 读取 outputStream
        Redis-->>Agent: Plan/Step/Tool/Message 事件
        Agent-->>Controller: AsyncGenerator yield Event
        Controller-->>UI: SSE 实时推送
    end
    Controller-->>UI: 结束 SSE 响应
```

## 快速部署

### 前置要求

- Docker 20.10+
- Docker Compose 2.20+
- 可用的 OpenAI 兼容模型 API

### 1. 配置环境变量

```bash
cp .env.example .env
```

至少填写模型密钥：

```dotenv
LLM_BASE_URL=https://api.deepseek.com
LLM_API_KEY=your_api_key
LLM_MODEL_NAME=deepseek-reasoner
```

生产环境还应修改 `POSTGRES_PASSWORD`，按需设置 `REDIS_PASSWORD`。COS 配置可留空，但文件上传和生成文件的持久化能力将不可用。

### 2. 启动全部服务

```bash
docker compose up -d --build
```

首次启动会构建 API、UI、Sandbox 镜像，等待 PostgreSQL、Redis、Sandbox 健康后启动 API，并自动执行 Prisma migration。

### 3. 访问系统

打开 <http://localhost:8088>。可通过 `APP_PORT` 修改宿主机端口。

## 容器与数据

| Compose 服务 | 技术/用途 | 内部端口 | 默认是否对外暴露 |
| --- | --- | --- | --- |
| `nginx` | 统一 HTTP 网关 | 80 | 是，宿主机 `8088` |
| `ui` | Next.js 前端 | 3000 | 否 |
| `api` | NestJS Agent API | 8000 | 否 |
| `sandbox` | 工具执行与浏览器沙箱 | 8080/9222/5900/5901 | 否 |
| `postgres` | 业务数据 | 5432 | 否 |
| `redis` | Stream 与缓存 | 6379 | 否 |

持久化卷包括 `postgres_data`、`redis_data` 和 `api_config`。`docker compose down` 不会删除这些数据；`docker compose down -v` 会永久删除，请谨慎使用。

## 主要配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `APP_PORT` | `8088` | Nginx 对外端口 |
| `POSTGRES_*` / `DATABASE_URL` | 本地 `manus` 数据库 | PostgreSQL 连接配置 |
| `REDIS_DB` / `REDIS_PASSWORD` | `0` / 空 | Redis 配置 |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL_NAME` | DeepSeek 地址 / 空 / `deepseek-reasoner` | OpenAI 兼容模型配置 |
| `COS_*` | 空 | 腾讯云 COS 文件存储配置 |
| `SANDBOX_TTL_MINUTES` | `60` | 动态沙箱存活时间；根编排使用常驻沙箱地址 |
| `SANDBOX_*_PROXY` | 空 | 沙箱内 HTTP/HTTPS 代理 |
| `NEXT_PUBLIC_API_BASE_URL` | `/api` | 前端构建时 API 基础路径 |

运行期的 LLM、Agent、MCP、A2A 配置由 API 持久化到 `APP_CONFIG_FILEPATH`（容器内默认 `/app/data/config.yaml`），也可以在 UI 设置面板中修改。

## 常用运维命令

```bash
docker compose ps
docker compose logs -f
docker compose logs -f api ui sandbox
docker compose restart api
docker compose up -d --build
docker compose down
```

排查启动问题时，建议依次检查 `sandbox`、`postgres`、`redis`、`api`、`ui` 的健康状态和日志。

## 本地开发

推荐由根 Compose 提供 PostgreSQL、Redis 和 Sandbox，再分别启动 API/UI。具体命令和注意事项见子项目 README。根 `.env` 是全栈部署的统一配置入口；前端的 `NEXT_PUBLIC_API_BASE_URL` 是构建时变量，修改后需要重新构建 UI。

## HTTPS

当前 Compose 只映射 HTTP。启用 HTTPS 时需要：

1. 将证书挂载到 Nginx 容器，例如 `/etc/nginx/ssl/fullchain.pem` 和 `/etc/nginx/ssl/privkey.pem`。
2. 在 `nginx/conf.d/default.conf` 中增加或启用 443 `server` 块。
3. 在 `docker-compose.yml` 中增加 `443:443` 端口映射和证书目录挂载。
4. 执行 `docker compose restart nginx`。

不要只取消示例注释：HTTPS server 中还需包含与 HTTP 相同的 `/api/` 和 `/` 代理规则。
