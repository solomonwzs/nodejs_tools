# 工具描述

+ 这是一个 http 代理服务，用于转发 http 请求
+ 接收的请求为 `openai` 规范的 `/v1/chat/completions` 或者 `/v1/messages` 请求
+ 接收请求后，会调整请求，并根据请求中的 `model` 字段，匹配 `models` 中的 `name`，转发到不同的 `target` 上
+ `target` 的组装方式为：`base_url/service/{id}`
+ 代理需要支持 stream 方式的返回
+ 如果配置了 `http_proxy`，转发请求会经过 `http_proxy` 转发到 `target`
+ 如果配置了 `ext_headers` 字段，转发请求会加上相应的 http 头部
+ 服务的配置为 json 格式，如下：
```json
{
    "listen": 4000,
    "ext_headers": {
        "X-Foo": "foo",
        "X-Bar": "bar"
    },
    "http_proxy": "http://127.0.0.1:4001",
    "base_url": "http://llmproxy.com",
    "models": [
        {"name": "model_0", "id": 0},
        {"name": "model_1", "id": 1}
    ]
}
```
+ 如果服务启动时，配置文件的路径没有通过命令行参数传入，使用 `$HOME/.config/adamsproxy2.json` 作为配置路径
+ 服务需要有异常处理机制，不能因为异常而退出

## 工具接口

### /v1/models

服务启动后，当访问 `/v1/models` 时，服务会根据配置中的 `target`，通过 HTTP GET 调用 `{target}/v1/models`（如果配置中有 `http_proxy` 和 `ext_header`，需要通过 `http_proxy` 转发以及调整请求头部），请求会返回如下 json 内容：
```json
{"object":"list","data":[{"id":"glm_5_fp8","max_model_len":202752}]}
```
将所有 `target` 返回内容中的 `data` 提取出来，并合并成 json 返回
