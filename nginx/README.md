# Manus Nginx 网关

`nginx` 是全栈部署的唯一公网入口，将页面请求转发到 Next.js，将 `/api/` 请求转发到 NestJS API，并为聊天 SSE、会话列表长连接和 VNC WebSocket 提供长超时与关闭缓冲的代理配置。

## 文件结构

```text
nginx/
├── nginx.conf             # worker、日志、gzip、连接升级映射
└── conf.d/default.conf    # UI/API upstream 与 server 路由
```

## 路由

| 外部路径 | 上游 | 特殊配置 |
| --- | --- | --- |
| `/api/*` | `api:8000` | WebSocket Upgrade、SSE 禁用缓冲、24 小时读写超时 |
| `/*` | `ui:3000` | 页面和 Next.js 资源，支持 WebSocket Upgrade |

根 Compose 将宿主机 `${APP_PORT:-8088}` 映射到容器 80。API 和 UI 不单独暴露端口。

## 修改配置

语法检查和重载：

```bash
docker compose exec nginx nginx -t
docker compose exec nginx nginx -s reload
```

配置文件以只读卷挂载，修改后也可以执行：

```bash
docker compose restart nginx
```

## HTTPS

`conf.d/default.conf` 顶部仅提供 HTTPS 结构示例。实际启用时需同时完成证书挂载、443 端口映射，并在 HTTPS `server` 中复制 `/api/` 和 `/` 的完整代理规则。若 UI 使用 HTTPS，VNC 连接也必须经 `wss://`，否则浏览器会阻止混合内容。
