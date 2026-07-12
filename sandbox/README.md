# MoocManus Sandbox

`sandbox` 是 Agent 的隔离执行环境。它在 Ubuntu 容器中组合 NestJS 工具 API、Shell 子进程、Chromium、虚拟显示器、CDP、VNC 和 WebSocket VNC，使 API 能执行命令、操作文件、自动化浏览器，并将桌面实时展示给前端。

> 沙箱提供的是执行隔离和统一接口，不应被视为强安全边界。当前容器内应用以 root 启动、Chromium 使用 `--no-sandbox`，文件和 Shell API 也没有内置鉴权；不要直接暴露到公网或运行不可信的多租户负载。

## 目录结构

```text
sandbox/
├── src/
│   ├── core/                       # 配置与自动延长 TTL 中间件
│   ├── interfaces/
│   │   ├── controllers/            # File、Shell、Supervisor API
│   │   ├── schemas/                # 请求 DTO
│   │   └── errors/                 # 统一异常响应
│   ├── models/                     # 返回模型
│   ├── services/                   # 文件、Shell、Supervisor 实现
│   ├── app.module.ts
│   └── main.ts
├── Dockerfile                      # Ubuntu + Node.js + Chromium + VNC
├── supervisord.conf                # 管理全部沙箱进程
├── nest-cli.json
└── package.json
```

## 容器内进程与端口

| 进程 | 端口 | 作用 |
| --- | --- | --- |
| NestJS `app` | `8080` | 文件、Shell、Supervisor HTTP API |
| Chromium | 内部 `8222` | 浏览器远程调试原始端口 |
| `socat` | `9222` | 将 CDP 转发到 Chromium |
| Xvfb | Display `:1` | 1280×1080 虚拟显示器 |
| x11vnc | `5900` | VNC 服务 |
| websockify | `5901` | VNC 转 WebSocket，供 noVNC 使用 |

Supervisor 按 Xvfb → Chromium → CDP 转发 → VNC → WebSocket → API 的优先级启动进程，并在异常退出时自动重启。

## API 概览

HTTP API 使用 `/api` 前缀，Swagger 文档位于 `/docs`。

### 文件

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/file/read-file` | 按路径/行范围读取文件，可限制长度 |
| `POST` | `/api/file/write-file` | 覆盖或追加写入文件 |
| `POST` | `/api/file/replace-in-file` | 替换文件内容 |
| `POST` | `/api/file/search-in-file` | 按正则逐行搜索 |
| `POST` | `/api/file/find-files` | 按简单 glob 递归查找 |
| `POST` | `/api/file/upload-file` | multipart 上传到指定路径 |
| `GET` | `/api/file/download-file` | 下载指定路径文件 |
| `POST` | `/api/file/check-file-exists` | 检查文件是否存在 |
| `POST` | `/api/file/delete-file` | 删除文件 |

### Shell

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/shell/exec-command` | 同步执行或创建后台 Shell 会话 |
| `POST` | `/api/shell/read-shell-output` | 增量读取 stdout/stderr |
| `POST` | `/api/shell/wait-process` | 等待进程退出 |
| `POST` | `/api/shell/write-shell-input` | 向 stdin 写入内容 |
| `POST` | `/api/shell/kill-process` | 终止进程 |

### Supervisor

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/supervisor/status` | 健康检查与进程状态 |
| `POST` | `/api/supervisor/stop-all-processes` | 停止受管进程 |
| `POST` | `/api/supervisor/restart` | 重启进程组 |
| `POST` | `/api/supervisor/shutdown` | 关闭 Sandbox |
| `POST` | `/api/supervisor/activate-timeout` | 启用自动关闭计时器 |
| `POST` | `/api/supervisor/extend-timeout` | 延长计时器 |
| `POST` | `/api/supervisor/cancel-timeout` | 取消计时器 |
| `GET` | `/api/supervisor/timeout-status` | 查询计时状态 |

每次 API 请求都会经过 `AutoExtendTimeoutMiddleware`，在 TTL 已启用时自动续期。

## 本地开发

仅调试 NestJS 文件/Shell API 时，可直接运行：

```powershell
npm install
npm run start:dev
```

```powershell
npm run typecheck
npm run build
```

直接运行不会自动提供 Chromium、Xvfb、VNC 和 Supervisor；要验证完整能力，应构建容器：

```bash
docker build -t manus-sandbox:latest .
docker run --rm --shm-size=1g \
  -p 8080:8080 -p 9222:9222 -p 5901:5901 \
  manus-sandbox:latest
```

健康检查：

```bash
curl http://localhost:8080/api/supervisor/status
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | NestJS API 端口 |
| `LOG_LEVEL` | `INFO` | `DEBUG/INFO/WARN/ERROR/OFF` |
| `SERVER_TIMEOUT_MINUTES` | 本地 `60`；根 Compose `0` | 自动关闭时间；`0` 表示禁用 |
| `CHROME_ARGS` | 空 | 追加 Chromium 参数 |
| `APP_ARGS` | 空 | 追加 NestJS 启动参数 |
| `HTTP_PROXY/HTTPS_PROXY/NO_PROXY` | 空 | 容器网络代理 |

## 已知边界

- 文件路径由调用方提供，服务本身不限制在某个工作目录内。
- Shell 命令可以访问容器内权限允许的全部资源。
- VNC 默认无密码，必须仅放在受信任的内部网络中。
- 根 Compose 不映射 Sandbox 端口到宿主机，所有访问经 API/Nginx 间接完成。
