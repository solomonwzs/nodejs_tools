# 工具描述

+ 这是一个 http 代理服务，用于转发 http 请求
+ 接收的请求为 `openai` 规范的 `/chat/completions` 请求
+ 接收请求后，会调整请求，并根据请求中的 `model` 字段，转发到不同的 `target` 上
+ 如果配置了 `http_proxy`，转发请求会经过 `http_proxy` 转发到 `target`
+ 如果配置了 `ext_headers` 字段，转发请求会加上相应的 http 头部
+ 服务的配置为 json 格式，如下：
```json
{
    "listen": 4000,
    "models": [
        {
            "name": "$model_0",
            "target": "http://target-endpoint.org/0/v1",
            "http_proxy": "http://127.0.0.1:4001",
            "ext_headers": {
                "X-Foo": "foo",
                "X-Bar": "bar"
            }
        },
        {
            "name": "$model_1",
            "target": "http://target-endpoint.org/1/v1",
            "http_proxy": "http://127.0.0.1:4001"
        }
    ]
}
```

## 工具接口

### /$/models_info

服务启动后，当访问 `/$/models_info` 时，服务会根据配置中的 `target`，通过 HTTP GET 调用 `http://target-endpoint.org/0/v1/models`（如果配置中有 `http_proxy` 和 `ext_header`，需要通过 `http_proxy` 转发以及调整请求头部），请求会返回如下 json 内容：
```json
{"object":"list","data":[{"id":"glm_5_fp8","max_model_len":202752}]}
```
将所有 `target` 返回内容中的 `data` 提取出来，并合并成 json 返回
