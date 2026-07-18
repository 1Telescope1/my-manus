# Manus UI

`ui` 是 Manus 的 Web 前端，基于 Next.js 16 App Router、React 19、TypeScript、Tailwind CSS 4 和 Radix UI 构建。它提供会话列表、流式对话、计划/工具过程、文件预览、设置管理和 noVNC 桌面查看。

## 目录结构

```text
ui/
├── public/                         # 静态资源
├── src/
│   ├── app/
│   │   ├── page.tsx                # 首页：创建任务并跳转会话
│   │   ├── sessions/page.tsx       # /sessions 重定向入口
│   │   ├── sessions/[id]/page.tsx  # 会话详情页
│   │   ├── layout.tsx              # 全局布局与 Provider
│   │   └── globals.css
│   ├── components/
│   │   ├── tool-use/               # 各类 Agent 工具事件渲染
│   │   ├── ui/                     # 基础 UI 组件
│   │   ├── chat-*.tsx              # 对话头部、输入、消息
│   │   ├── plan-panel.tsx           # 计划进度
│   │   ├── file-preview-panel.tsx   # 文件预览
│   │   ├── vnc-*.tsx                # noVNC 远程桌面
│   │   └── manus-settings.tsx       # LLM/Agent/MCP/A2A 设置
│   ├── hooks/                       # 会话列表与详情状态逻辑
│   ├── providers/                   # 全局 SessionsProvider
│   ├── lib/api/                     # HTTP、SSE、文件 API 客户端
│   └── config/app.config.ts         # 前端展示配置
├── Dockerfile
├── next.config.ts
└── package.json
```

## 页面与数据流

```text
首页输入任务
  → POST /sessions 创建会话
  → 跳转 /sessions/:id?init=...
  → useSessionDetail 发送初始消息
  → POST /sessions/:id/chat（SSE）
  → 按事件类型更新消息、计划、工具、文件和状态
```

- `SessionsProvider` 通过 `/sessions/stream` 订阅会话列表，并带指数退避重连；初始列表由普通 GET 请求兜底。
- `useSessionDetail` 加载历史事件、消费聊天 SSE、停止任务、读取文件和 Shell 输出。
- `tool-use/` 根据工具类型分别展示 Browser、Bash、File、Search、MCP、A2A 等调用。
- `vnc-viewer.tsx` 使用 `@novnc/novnc`，通过 API 的 WebSocket 网关查看会话 Sandbox 桌面。
- 设置面板直接读写后端运行期配置；敏感模型密钥由后端保存，前端不应硬编码。

## 本地开发

### 前置要求

- Node.js 22+（与 Dockerfile 保持一致）
- 已启动 API 服务

```powershell
npm install
$env:NEXT_PUBLIC_API_BASE_URL='http://localhost:8000/api'
npm run dev
```

访问 <http://localhost:3000>。

常用命令：

```powershell
npm run dev
npm run lint
npm run build
npm run start
```

## 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `NEXT_PUBLIC_API_BASE_URL` | `http://localhost:8000/api`（客户端代码兜底） | API 基础地址；根 Docker 构建传入 `/api` |

这是 Next.js 公共构建变量，生产环境修改后必须重新执行 `npm run build` 或重新构建镜像。通过 Nginx 部署时建议使用同源相对路径 `/api`，可避免 CORS 和 WebSocket 地址不一致。

## API 交互约定

- 普通请求由 `lib/api/fetch.ts` 解包后端 `{ code, msg, data }` 响应。
- 会话列表和聊天使用 POST SSE，而不是浏览器原生 GET `EventSource`；客户端使用 `fetch` 读取 `ReadableStream` 并解析事件块。
- 上传使用 `multipart/form-data`，下载使用文件响应或可访问 URL。
- VNC 地址从当前 API 基础地址推导为 `ws://` 或 `wss://`。

## Docker

Dockerfile 分为依赖、构建、运行三阶段，生产镜像运行 Next.js standalone 输出，并使用非 root 用户 `nextjs`。服务监听 `0.0.0.0:3000`。
