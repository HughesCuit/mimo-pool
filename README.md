# 小米 Mimo 号池

一个轻量的 Node.js/TypeScript Web 服务，用于批量管理小米 Mimo API key，并对外提供 OpenAI / Anthropic 兼容协议中转。

## 功能

- OpenAI 兼容接口：
  - `POST /v1/chat/completions`
  - `POST /v1/completions`
  - `POST /v1/responses`
- Anthropic 兼容接口：
  - `POST /v1/messages`
  - `POST /anthropic/v1/messages`
- 三个预置服务组：`CN`、`SGP`、`AMS`
- 按服务组顺序、组内 key 固定顺序转发
- 429 / quota / balance / exhausted / rate limit 类错误自动标记 key 耗尽并 fallback
- 网络错误和 5xx 会尝试 fallback，但不会永久踢出 key
- SQLite 持久化，内置 Web 管理界面和 REST 管理 API
- 支持 `stream: true` 事件流透传

## 快速开始

```powershell
npm.cmd install
npm.cmd run build
$env:ADMIN_TOKEN = "admin-secret"
$env:PROXY_TOKENS = "proxy-secret"
npm.cmd start
```

打开 `http://localhost:3100/admin`，使用 `ADMIN_TOKEN` 登录后台。

调试模式会输出请求级代理日志，适合排查 Codex 中途停住、上游异常或 Responses 转换问题：

```powershell
npm.cmd run debug
```

默认只输出元数据和脱敏后的 key。需要查看截断正文时可以额外设置：

```powershell
$env:DEBUG_PROXY_BODY = "1"
npm.cmd run debug
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3100` | HTTP 端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DB_PATH` | `data/mimo-pool.sqlite` | SQLite 文件路径 |
| `ADMIN_TOKEN` | `change-me-admin` | 管理后台/API token |
| `PROXY_TOKENS` | `change-me-proxy` | 下游中转 token，多个用逗号分隔 |
| `UPSTREAM_TIMEOUT_MS` | `120000` | 上游请求超时 |
| `MAX_BODY_BYTES` | `20971520` | 请求体大小限制 |
| `ANTHROPIC_VERSION` | `2023-06-01` | Anthropic 请求默认版本头 |
| `DEBUG_PROXY` | `0` | 开启代理调试日志 |
| `DEBUG_PROXY_BODY` | `0` | 输出截断后的请求/响应正文预览 |
| `DEBUG_PROXY_BODY_LIMIT` | `2000` | 正文预览最大字符数 |

## 调用示例

```powershell
curl.exe http://localhost:3100/v1/chat/completions `
  -H "Authorization: Bearer proxy-secret" `
  -H "Content-Type: application/json" `
  -d "{\"model\":\"mimo\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
```

## Docker Compose

```powershell
docker compose up --build
```

生产使用前请修改 `docker-compose.yml` 中的 `ADMIN_TOKEN` 和 `PROXY_TOKENS`。
