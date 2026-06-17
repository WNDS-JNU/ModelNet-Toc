# ModelNet Gateway 新同事接手技术文档

> 面向第一次接触 ModelNet Gateway 的研发同事。本文以 `modelnet-router` 网关为主，解释它在整套系统里的位置、一次请求如何流转、核心模块分别负责什么，以及接手开发时应该先看哪里。

## 1. 先用一句话理解这个网关

ModelNet Gateway 是模型服务入口层。它把上层应用的 OpenAI-compatible 请求或 ModelNet Native 请求转换成统一的内部请求格式，再根据模型注册表、租户权限、能力、健康状态、K8s/Prometheus 负载和协作策略选择模型后端执行。

它不是单纯的 HTTP 反向代理。反向代理只负责把请求转发到固定目标，而这个网关还会做以下事情：

- 把不同协议收敛成统一 IR：`ModelNetRunRequest`。
- 判断租户有没有权限使用某些模型、runner、aggregator 和 trace。
- 从注册表和实时状态里挑选可用候选模型。
- 支持普通单模型路由，也支持多模型并行、自动组网和 Claim Graph 验证。
- 把执行过程输出为 OpenAI JSON/SSE 或 ModelNet Native SSE。

## 2. 它在系统里的位置

线上链路可以简化为：

```text
LobeHub / SDK / 客户端
  -> LiteLLM
     -> modelnet-router -> 后端（仅 `modelnet` / `modelnet-auto` 聚合和自动路由入口）
     -> 具体 vLLM / llama.cpp / OpenAI-compatible / Ollama 后端（具体模型 ID）
```

LiteLLM 是外层 OpenAI-compatible proxy：`modelnet` / `modelnet-auto` 指向 `http://modelnet-router:8000/v1`，具体后端模型 ID 则使用 `scripts/sync_modelnet_litellm.py` 生成的 registry `model_url` 直连后端 `/v1`。
`modelnet-router` 是这份文档的重点。它在 Docker Compose 里暴露内部 8000 端口，默认宿主机端口为 `127.0.0.1:3092`，并对聚合、自动组网和 ModelNet Native 请求提供路由与协作能力。LiteLLM 对外提供 `127.0.0.1:3090`。

## 3. 新人应该先记住的五个概念

| 概念 | 简单解释 | 主要代码位置 |
|---|---|---|
| IR | 网关内部统一请求格式，避免执行层直接依赖 OpenAI 或 Native 原始 payload | `modelnet_gateway/schemas.py` |
| Candidate | 注册表里加载出来的可选模型后端 | `app.py` |
| Runner | 决定怎么执行，比如只选一个模型、逐 token 并行、完整回答并行、自动组网 | `plugins.py`、`app.py` |
| Aggregator | 决定多个模型结果怎么合并，比如按概率求和、综合完整回答、按负载选择 | `plugins.py`、`app.py` |
| Trace | 执行过程记录，用于调试和解释路由决策 | `app.py` |

## 4. 两条北向请求路径

### OpenAI-compatible 路径

入口是 `POST /v1/chat/completions`。这是给 LobeHub、LiteLLM、OpenAI SDK 风格客户端使用的兼容入口。

主要步骤：

1. `chat_completions()` 读取请求体和 Bearer Token。
2. `openai_chat_to_ir()` 把 OpenAI 请求转换为 `ModelNetRunRequest`。
3. 如果模型是普通模型，默认使用 `route.once`。
4. 如果模型是 `modelnet-auto`，进入 `auto.network` 自动组网。
5. 普通路径调用 `pick_candidate()` 选后端，再由 `backend_adapters.py` 调后端。
6. 返回 OpenAI-compatible JSON 或 SSE。

### ModelNet Native 路径

入口是 `POST /v1/runs/stream`。这是给高级协作、trace、runner/aggregator 显式控制使用的入口。

主要步骤：

1. `runs_stream()` 接收 `ModelNetRunRequest`。
2. `native_to_ir()` 校验 schema，并把 runner 别名归一化。
3. `ir_to_ensemble_request()` 降级成当前执行面使用的 `EnsembleRequest`。
4. `execution_contract_error()` 检查 runner、aggregator、租户权限和 reserved/degraded 状态。
5. `run_ensemble_stream()` 分发到具体 runner。
6. `run_native_stream()` 把 legacy event 转成 `modelnet.event.v1` SSE。

## 5. 内部数据契约

核心 schema 在 `modelnet_gateway/schemas.py`。

`ModelNetRunRequest` 是统一请求格式，包含：

- `messages`：聊天消息。
- `tools`：工具定义，用于能力判断。
- `files`：文件输入预留字段。
- `constraints`：上下文长度、预算、延迟等约束。
- `required_capabilities`：客户端显式要求的能力。
- `policy`：租户、预算、fallback 等策略。
- `collaboration_plan`：runner、aggregator、sources、candidate_aliases。
- `sampling_params`：temperature、top_p、top_k、max_tokens 等。
- `stream_options`：是否包含 usage 和 trace。

`ModelNetEvent` 是 Native SSE 的统一事件，当前包括 `run_started`、`model_selected`、`token_delta`、`source_response`、`aggregation_step`、`trace`、`usage`、`error`、`done`。

## 6. 控制面：注册表、能力、拓扑、权限

控制面回答“谁可以用、哪些模型可用、模型健康不健康、当前负载如何”。

- 注册表来自 `MODELNET_REGISTRY_PATH`，Docker Compose 中挂载为 `/app/model_net.yaml`。
- `load_candidates()` 从注册表生成 Candidate 列表，并缓存 mtime。
- `candidate_capabilities()` 合并注册表能力和后端类型能力。
- K8s 快照来自 Pod、Service、Node 和 metrics API。
- Prometheus 快照用于 GPU/CPU/内存等负载评分。
- `auth.py` 从 `MODELNET_API_KEYS_JSON`、`MODELNET_API_KEYS` 或 legacy key 生成租户。

## 7. 路由面：候选模型怎么选

`pick_candidate()` 是普通请求路由的核心函数。它大致会过滤和评分：

- 租户是否允许访问该模型。
- 模型 alias、candidate_aliases 是否匹配。
- required capabilities 是否满足。
- 后端 endpoint health 是否可用。
- K8s ready pod 数量是否足够。
- Prometheus 里节点和设备负载是否过高。
- 当前 in-flight 请求数和 failure/cooldown 状态。

当没有可用模型时，`capability_diagnostics()` 会返回更可读的诊断信息，说明需要哪些能力、当前有哪些能力、有哪些模型匹配。

## 8. 执行面：runner 和 aggregator

当前 runner/aggregator 的真实状态来自 `modelnet_gateway/plugins.py`。

已实现 runner：

| Runner | 简单说明 | 常见入口 |
|---|---|---|
| `route.once` | 选择一个后端执行普通 chat | 普通 OpenAI 请求 |
| `token.parallel` | 多模型逐 token 并行投票 | Native 协作请求 |
| `response.parallel` | 多模型完整回答并行，再综合 | Native 协作请求 |
| `auto.network` | 根据问题特征、预算、负载规划拓扑 | `modelnet-auto` |
| `auto.claim_graph` | draft、抽取 claim、验证、保守组装 | 高可靠回答场景 |

需要特别注意：

- `token.serial` 和 `hybrid.graph` 是 reserved。
- `response.serial` 和 `judge_refine` 是 degraded。
- reserved 不代表 bug，而是契约占位，客户端不应该默认调用。

## 9. 后端适配层

后端适配在 `backend_adapters.py`。它把网关的统一调用转换成不同后端能理解的请求。

当前支持的 backend type 包括 `vllm_chat`、`llama_cpp`、`openai_compatible`、`anthropic`、`ollama`、`dify_provider`、`custom_http`。真正的聊天调用目前集中支持 `vllm_chat`、`llama_cpp`、`openai_compatible` 和 `ollama`。

常见逻辑：

- `prepare_chat_body()` 修改 `model` 字段，或把 OpenAI 请求转成 Ollama 请求。
- `chat_url()` 决定发到 `/chat/completions`、`/api/chat` 或 `/completion`。
- `response_should_cooldown()` 判断 408、409、425、429 和 5xx 是否触发 cooldown。
- `stream_chat()` 负责后端 SSE/流式转发。

## 10. 鉴权和多租户

`auth.py` 负责加载租户和校验 Bearer Token。

支持三种配置：

- `MODELNET_API_KEYS_JSON`：完整 JSON，可以限制模型、runner、aggregator 和 trace。
- `MODELNET_API_KEYS`：`tenant:key` 形式的简单配置。
- `MODELNET_ROUTER_API_KEY`：legacy 单 key 模式。

如果没有配置任何 key，系统会进入 anonymous 模式。生产环境应显式配置 key。

## 11. 自动组网和 Claim Graph

`modelnet-auto` 会进入 `auto.network`。它会先分析任务特征，再根据候选模型、预算、置信度和负载选择拓扑。简单问题可能退化为单模型，复杂问题可能使用 role graph、rank fuse、cascade verify 或 Claim Graph。

Claim Graph 的思想是：不要直接相信一整段回答，而是先生成草稿，再把草稿拆成可以验证的 atomic claims，最后让 verifier 对关键 claim 投票，并保守组装答案。

相关代码：

- `claim_graph.py`：prompt 构造、claim 抽取、frontier 构建、verifier 解析、答案组装。
- `claim_memory.py`：SQLite 记忆库，记录 verified、contested、refuted、unknown 等事实状态。
- `run_claim_graph_ensemble()`：在 `app.py` 中执行完整 Claim Graph 流程。

## 12. 部署和配置入口

常用入口：

- `docker-compose.yml`：定义 `modelnet-router` 和 `modelnet-litellm`。
- `modelnet_router/model_net.yaml`：开发环境模型注册表样例。
- `/home/duxianghe/dify/api/configs/model_net.yaml`：Compose 挂载的实际注册表来源。
- `litellm/modelnet-config.yaml`：LiteLLM 代理配置；聚合/自动路由入口指向 `modelnet-router`，具体模型指向 registry 后端 `/v1`。
- `.env` 和 `.env.modelnet`：运行时 secret 和模型网关环境变量。
- `scripts/reload_modelnet.sh`：Dify 刷新模型后，重新生成配置并重启相关服务。

验证命令优先看 README 的 Verify 部分：

```bash
docker compose ps
curl -s -o /tmp/modelnet-models.json -w "%{http_code}\n" http://127.0.0.1:3090/v1/models
curl -s -o /tmp/router-health.json -w "%{http_code}\n" http://127.0.0.1:3092/healthz
```

## 13. 新增模型时怎么做

典型流程：

1. 确认 Dify 的 `model_net.yaml` 已经有新模型。
2. 确认模型的 backend type、URL、alias、capabilities 和 context length。
3. 运行 `scripts/reload_modelnet.sh`。
4. 检查 `modelnet-router` 和 `modelnet-litellm` 是否健康。
5. 请求 `/v1/models` 确认模型可见。
6. 请求 `/v1/capabilities` 确认能力是否符合预期。
7. 用一条最小 chat 请求验证实际后端可调用。

## 14. 新增 backend type 时怎么做

先不要直接在 `app.py` 里硬写调用逻辑。更稳的顺序是：

1. 在 `plugins.py` 的 `BACKEND_ADAPTERS` 里声明能力。
2. 在 `backend_adapters.py` 里实现 body 转换、URL 选择、非流式调用和流式调用。
3. 确认 `candidate_capabilities()` 能正确暴露能力。
4. 确认 `/v1/capabilities` 输出正确。
5. 对 429、5xx 等失败状态确认是否会 cooldown。

## 15. 新增 runner 或 aggregator 时怎么做

先改契约，再改执行：

1. 在 `plugins.py` 加 runner/aggregator，并明确 status。
2. 如果是新 runner，补充 canonical alias 和 legacy 映射。
3. 在 `app.py` 增加执行函数，输出标准事件。
4. 在 `run_ensemble_stream()` 中接入分发。
5. 在 `execution_contract_error()` 中确认权限、reserved/degraded 行为。
6. 用 `/v1/capabilities` 检查能力暴露。

## 16. 常见故障排查

| 现象 | 优先检查 | 说明 |
|---|---|---|
| 401 | Bearer Token、`MODELNET_API_KEYS_JSON`、`MODELNET_API_KEYS` | 认证失败不会进入路由 |
| 503 no backend | `/v1/capabilities`、required capabilities、candidate_aliases | 多数是能力不匹配或模型被租户过滤 |
| 请求很慢 | `/metrics`、K8s ready pod、Prometheus 节点负载 | 路由评分会受负载和 in-flight 影响 |
| SSE 断流 | 后端流式接口、`stream_chat()`、网络超时 | 先区分 router 断还是 backend 断 |
| modelnet-auto 退化成单模型 | budget、候选数量、confidence、复杂度判断 | 这是策略结果，不一定是错误 |
| Claim Graph 没有记忆 | `MODELNET_CLAIM_ENABLED`、SQLite 路径、timeout | 默认可能不开启 |

## 17. 建议的代码阅读顺序

1. 先读 README 的 Runtime Layout 和 Verify。
2. 读 `modelnet_gateway/schemas.py`，理解 IR 和事件。
3. 读 `modelnet_gateway/adapters.py`，看 OpenAI 和 Native 如何变成 IR。
4. 读 `modelnet_gateway/plugins.py`，掌握 runner、aggregator、backend 能力。
5. 回到 `app.py`，先看 endpoint，再看 `pick_candidate()`。
6. 继续看 `run_ensemble_stream()` 和各 runner。
7. 最后读自动组网和 Claim Graph 相关函数。

## 18. 接手检查清单

- 能说清 LobeHub、LiteLLM、modelnet-router 和后端模型的关系。
- 能用 `/v1/models` 和 `/v1/capabilities` 判断模型是否暴露正确。
- 能解释 OpenAI-compatible 请求和 Native 请求的区别。
- 能说出 `route.once`、`token.parallel`、`response.parallel` 的适用场景。
- 能根据 503 诊断定位是权限、能力、健康状态还是负载问题。
- 能指出新增 backend type 应该优先改 `plugins.py` 和 `backend_adapters.py`。
- 能解释 reserved/degraded 的含义，不把它们误认为线上故障。
