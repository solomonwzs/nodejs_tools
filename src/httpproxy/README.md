# httpproxy

按 `X-Ori-Host` 头路由的 HTTP 转发服务，仅使用 Node.js 内置模块。

## 配置与启动

```json
{
  "listen": 4004,
  "allowLan": false,
  "httpProxy": "http://127.0.0.1:8080",
  "httpsProxy": "http://127.0.0.1:8080"
}
```

```sh
npm run build_httpproxy
node dist/httpproxy/index.js src/httpproxy/config.example.json
```

- `allowLan` 缺省为 `false`，仅监听 `127.0.0.1`；设为 `true` 时监听 `0.0.0.0`。
- HTTP 目标使用 `httpProxy`，HTTPS 目标使用 `httpsProxy`（CONNECT 隧道 + TLS）。对应代理配置省略时直连，不读取环境代理变量。
- 代理 URL 支持 `http://`、`https://` 和 Basic 认证，例如 `http://user:password@proxy:8080`。
- HTTPS 校验证书及目标主机名，不跳过 TLS 验证。

## 调用

```sh
curl 'http://localhost:4004/api/example?lang=zh' \
  -H 'X-Ori-Host: https://www.example.org' \
  -H 'Content-Type: application/json' \
  --data-binary '{"hello":"world"}'
```

请求将转发到 `https://www.example.org/api/example?lang=zh`。

`X-Ori-Host` 必须是 HTTP(S) origin，可含端口，但不能含用户信息、非根路径、查询参数或 fragment。缺失/无效返回 400；代理或上游连接失败返回 502。

方法、原始路径与查询参数、正文及普通请求头保持不变。转发时 `Host` 改为目标地址，移除路由头 `X-Ori-Host`、代理认证头和逐跳头（包括 `Connection` 指定的头）。响应状态、普通响应头和正文流式返回，不解析 JSON、不缓冲整个正文、不自动跟随重定向。

这是按头路由的 HTTP 服务，不提供客户端 CONNECT 或 WebSocket Upgrade。服务不带客户端认证；开启 `allowLan` 后应使用防火墙限制访问，避免成为开放代理。

## 验证

```sh
npx tsc --noEmit
node --test src/httpproxy/server.test.mjs
```

集成测试使用本地 HTTP/HTTPS 上游与本地代理，验证直连、HTTP 代理、HTTPS CONNECT、二进制正文、头部处理和错误响应；测试生成证书需要 `openssl`。
