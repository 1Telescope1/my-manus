# Manus API

`api` 是 Manus 的核心后端服务，基于 NestJS、TypeScript、Prisma、PostgreSQL 和 Redis 构建。它负责会话与文件管理、Agent 生命周期、Planner + ReAct 编排、工具注册、沙箱连接、SSE 事件推送和 VNC WebSocket 代理。

## 目录结构

```text
api/
├── prisma/
│   ├── schema.prisma                 # Session、File 数据模型
│   └── migrations/                   # 数据库迁移
├── src/
│   ├── application/services/         # 应用用例：会话、Agent、文件、配置、状态
│   ├── core/                          # 配置、异常、统一响应
│   ├── domain/
│   │   ├── models/                    # 领域模型与事件
│   │   ├── repositories/              # 仓储抽象
│   │   ├── external/                  # LLM、Sandbox、Redis Task 等抽象
│   │   └── services/
│   │       ├── agents/                # PlannerAgent、ReActAgent
│   │       ├── flows/                 # PlannerReActFlow
│   │       └── tools/                 # 浏览器、Shell、文件、搜索、MCP、A2A 等
│   ├── infrastructure/
│   │   ├── prisma/                    # Prisma 映射与连接
│   │   ├── repositories/              # PostgreSQL/文件配置仓储实现
│   │   ├── storage/                   # Redis、COS 客户端
│   │   └── external/                  # 外部能力的具体实现
│   ├── interfaces/
│   │   ├── controllers/               # HTTP/SSE 控制器
│   │   ├── gateways/                  # VNC WebSocket 网关
│   │   └── dto/                       # 请求/响应 DTO
│   ├── app.module.ts
│   └── main.ts
├── Dockerfile
├── docker-compose.yml                 # API 独立开发编排（见下方说明）
└── package.json
```

## 核心逻辑

### 对话与 Agent 执行

```text
SessionController.chat (SSE)
  → AgentService.chat
    → 获取/创建 Sandbox
    → 创建 AgentTaskRunner 与 Redis Stream Task
      → PlannerReActFlow
        → PlannerAgent 生成/更新计划
        → ReActAgent 选择工具并循环执行
      → 事件写入 Task output stream
    → 保存事件到 PostgreSQL
  → SSE 推送 UI
```

- 一个 `Session` 保存 `sandbox_id` 和 `task_id`，用于复用当前执行环境与任务流。
- `AgentTaskRunner` 注册浏览器、Shell、文件、搜索、消息、MCP、A2A 等工具。
- Redis Stream Task 将用户输入与 Agent 输出解耦；`done`、`error` 或 `wait` 事件结束当轮 SSE。
- 会话事件、状态、最新消息、文件和记忆写入 PostgreSQL。
- 生成文件可同步到 COS，并登记到 `File` 表；COS 未配置时相关能力不可用。

### 配置加载

启动时 `AppLifecycleService` 初始化基础设施并确保应用配置文件存在。默认配置由环境变量生成，之后可通过 `/api/app-config/*` 或 UI 修改。配置文件包括：

- `llm_config`：OpenAI 兼容接口地址、密钥、模型和采样参数。
- `agent_config`：Agent 最大步骤等运行参数。
- `mcp_config`：MCP Server 及启用状态。
- `a2a_config`：外部 A2A Agent 及启用状态。

### 数据模型

| 模型 | 主要内容 |
| --- | --- |
| `Session` | 标题、状态、最新消息、未读数、事件 JSON、文件 JSON、记忆、Sandbox/Task ID |
| `File` | 文件名、路径、存储 key、扩展名、MIME、大小 |

## API 概览

所有 HTTP 路由使用 `/api` 前缀，普通响应采用 `{ code, msg, data }` 包装。

### 状态与配置

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/status` | API、PostgreSQL、Redis 健康状态 |
| `GET/POST` | `/api/app-config/llm` | 获取/更新 LLM 配置 |
| `GET/POST` | `/api/app-config/agent` | 获取/更新 Agent 配置 |
| `GET/POST` | `/api/app-config/mcp-servers` | 查询/新增 MCP Server |
| `POST` | `/api/app-config/mcp-servers/:name/delete` | 删除 MCP Server |
| `POST` | `/api/app-config/mcp-servers/:name/enabled` | 启停 MCP Server |
| `GET/POST` | `/api/app-config/a2a-servers` | 查询/新增 A2A Agent |
| `POST` | `/api/app-config/a2a-servers/:id/delete` | 删除 A2A Agent |
| `POST` | `/api/app-config/a2a-servers/:id/enabled` | 启停 A2A Agent |

### 会话

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/sessions` | 创建空会话 |
| `GET` | `/api/sessions` | 获取会话列表 |
| `POST` | `/api/sessions/stream` | SSE 推送会话列表变化 |
| `GET` | `/api/sessions/:id` | 获取详情及历史事件 |
| `POST` | `/api/sessions/:id/chat` | 发送消息并通过 SSE 返回 Agent 事件 |
| `POST` | `/api/sessions/:id/stop` | 停止任务 |
| `POST` | `/api/sessions/:id/delete` | 删除会话并释放关联资源 |
| `POST` | `/api/sessions/:id/clear-unread-message-count` | 清空未读数 |
| `GET` | `/api/sessions/:id/files` | 获取会话生成文件 |
| `POST` | `/api/sessions/:id/file` | 读取沙箱文件 |
| `POST` | `/api/sessions/:id/shell` | 读取沙箱 Shell 输出 |
| `WS` | `/api/sessions/:id/vnc` | 代理沙箱 noVNC WebSocket |

### 文件

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/files` | multipart 上传文件到对象存储 |
| `GET` | `/api/files/:id` | 获取文件元数据 |
| `GET` | `/api/files/:id/download` | 下载文件 |

## 本地开发

### 前置要求

- Node.js 20+
- PostgreSQL
- Redis
- 可访问的 Sandbox 服务

```powershell
npm install
npm run prisma:generate
$env:DATABASE_URL='postgresql://postgres:postgres@localhost:5432/manus'
$env:REDIS_HOST='localhost'
$env:SANDBOX_ADDRESS='localhost'
$env:LLM_API_KEY='your_api_key'
npm run start:dev
```

默认从端口 `8000` 开始监听；若端口占用，本地进程会依次尝试后续端口。生产代理固定指向 8000，因此容器环境不应发生端口漂移。

数据库迁移：

```powershell
npx prisma migrate deploy
```

检查代码：

```powershell
npm run typecheck
npm run build
```

### 关于 `api/docker-compose.yml`

该文件面向“API 动态创建 Sandbox 容器”的独立开发模式，要求：

- 在 `api/` 下准备 `.env` 和 `config.yaml`；
- 预先创建外部网络 `manus-network-dev`；
- 已构建其 `SANDBOX_IMAGE`；
- Docker 主机支持挂载 `/var/run/docker.sock`（Windows 原生环境通常需调整）。

日常全栈开发更推荐使用仓库根目录的 `docker-compose.yml`，它采用一个常驻 `sandbox` 服务，不依赖 API 动态创建容器。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8000` | 服务端口 |
| `DATABASE_URL` | 本机 PostgreSQL | Prisma 数据库连接 |
| `REDIS_HOST/PORT/DB/PASSWORD` | `localhost/6379/0/空` | Redis 连接 |
| `APP_CONFIG_FILEPATH` | `config.yaml` | 运行期应用配置文件 |
| `LLM_*` | 见根 `.env.example` | 初始 LLM 配置 |
| `COS_*` | 空 | 腾讯云 COS 配置 |
| `SANDBOX_ADDRESS` | 空 | 固定 Sandbox 主机；设置后复用该服务 |
| `SANDBOX_IMAGE/NAME_PREFIX/NETWORK` | `manus-sandbox:latest` 等 | 动态 Sandbox 参数 |
| `SANDBOX_TTL_MINUTES` | `60` | 动态 Sandbox TTL |

## Docker

API 镜像采用多阶段构建，跳过 Playwright 浏览器下载（浏览器位于 Sandbox）。容器启动命令会先执行 `prisma migrate deploy`，再启动 `dist/main.js`。
