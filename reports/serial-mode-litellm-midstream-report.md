# ModelNet 串联模式 LiteLLM 500 报错简报

日期：2026-06-16

## 结论

串联模式报错的直接根因是 `modelnet-router` 缺少 Dify 串联运行所需的配置：

- `MODELNET_DIFY_INNER_API_KEY`
- `MODELNET_DIFY_WORKSPACE_ID`
- `MODELNET_DIFY_CREATOR_EMAIL`

LiteLLM 返回的 `MidStreamFallbackError` 是上层包装错误。实际链路中，router 已经开始返回 OpenAI 流式响应，随后在串联 Dify 配置检查阶段发出了流内错误；LiteLLM/OpenAI SDK 将这个流中错误解释为 `APIConnectionError: An error occurred during streaming`，又因为 `modelnet` 这个 model group 没有 fallback，最终对外显示为 500。

## 现象

用户侧错误：

```text
500 litellm.MidStreamFallbackError: litellm.APIConnectionError:
APIConnectionError: OpenAIException - An error occurred during streaming.
Received Model Group=modelnet
Available Model Group Fallbacks=None
```

LiteLLM 日志中也出现同类错误：

```text
Fallback also failed: litellm.MidStreamFallbackError ...
Received Model Group=modelnet
Available Model Group Fallbacks=None
openai.APIError: An error occurred during streaming
POST /v1/chat/completions HTTP/1.1" 500 Internal Server Error
```

## 关键证据

1. LobeHub 串联模式会发送 `payload.model = 'modelnet'`，并设置：

```text
runner: 'response.serial'
aggregator: 'dify.dsl'
show_serial_flow: true
```

对应代码：`lobehub/src/services/chat/index.ts:514-532`。

2. router 对 `response.serial + dify.dsl` 会进入 Dify 串联路径。代码会先检查 Dify 配置，缺失时直接发出：

```text
stage: serial.dify.config
error: missing Dify serial configuration: ...
```

对应代码：`modelnet_router/app.py:7971-7985`、`modelnet_router/app.py:8093-8096`。

3. docker compose 中 router 的 Dify 配置来自宿主机环境变量；其中三个关键项默认是空值：

```yaml
MODELNET_DIFY_INNER_API_KEY: ${MODELNET_DIFY_INNER_API_KEY:-}
MODELNET_DIFY_WORKSPACE_ID: ${MODELNET_DIFY_WORKSPACE_ID:-}
MODELNET_DIFY_CREATOR_EMAIL: ${MODELNET_DIFY_CREATOR_EMAIL:-}
```

对应配置：`docker-compose.yml:94-99`。

4. 当前实际环境检查结果：

```text
MODELNET_DIFY_CREATOR_EMAIL=<empty>
MODELNET_DIFY_INNER_API_KEY=<empty>
MODELNET_DIFY_WORKSPACE_ID=<empty>
```

同时，远端仓库的 `.env` 和 `.env.modelnet` 中这些变量均为 `<absent>`。

5. 直打 `modelnet-router` 的最小串联流式请求复现了原始错误：

```text
status 200
data: {"id": "...", "object": "chat.completion.chunk", ... "delta": {"role": "assistant"}}
data: {"error": {"error": "missing Dify serial configuration: MODELNET_DIFY_INNER_API_KEY, MODELNET_DIFY_WORKSPACE_ID, MODELNET_DIFY_CREATOR_EMAIL", "stage": "serial.dify.config"}}
data: [DONE]
```

这说明 router 的原始错误不是后端模型不可用，而是串联模式 Dify 配置缺失。

## 根因链路

1. 前端选择 ModelNet 串联模式。
2. LobeHub 将请求发给 LiteLLM 的 `modelnet` model group，并在 `modelnet.collaboration_plan` 中声明 `response.serial`。
3. LiteLLM 将请求转发给 `modelnet-router`。
4. router 进入 `run_dify_serial_ensemble()`，发现 Dify 串联配置缺失。
5. router 在已经开始的 OpenAI SSE 流里返回 `data: {"error": ...}`。
6. LiteLLM/OpenAI SDK 把流式中途错误包装为 `APIConnectionError` / `MidStreamFallbackError`。
7. LiteLLM 配置里 `modelnet` 没有 fallback，因此最终返回 500。

## 修复建议

短期修复：

1. 在远端 `/home/duxianghe/ModelNet-toc/.env` 或启动环境中补齐：

```bash
MODELNET_DIFY_INNER_API_KEY=...
MODELNET_DIFY_WORKSPACE_ID=...
MODELNET_DIFY_CREATOR_EMAIL=...
```

2. 重新创建相关服务：

```bash
docker compose up -d --force-recreate modelnet-router modelnet-litellm
```

或使用项目已有的 `scripts/reload_modelnet.sh`。

3. 修复后再次执行最小串联请求，预期不再出现 `stage=serial.dify.config`，而是进入 `serial.dsl.compiled` / `serial.dify.provisioned` / workflow run。

中期改进：

- router 在 OpenAI streaming 首包发出前做串联配置 preflight；配置缺失时直接返回明确的 HTTP 4xx/5xx JSON，避免被 LiteLLM 包装成模糊的 mid-stream error。
- 在 `/v1/capabilities` 或健康检查中暴露串联 Dify readiness，前端可在配置不可用时禁用串联模式并提示原因。
- LiteLLM 可配置 model group fallback，但这只能缓解上层 500，不会修复串联模式缺配置的根因。
