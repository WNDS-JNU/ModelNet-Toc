# ModelNet 当前可用三种协作方案具体做法

日期：2026-06-19

适用环境：`/home/duxianghe/ModelNet-toc` 当前 4A100 部署。

本文只写当前已经能走通的三种用户侧协作方案：

1. `modelnet-auto`：自动组网。
2. `ModelNet 并联`：用户选 2-16 个模型并行回答，再合成。
3. `ModelNet 串联`：用户选 2-8 个模型按顺序改写/审阅。

核心原则很简单：**用户选择信息不是 LiteLLM 决策出来的，而是 TOC/LobeHub 写进请求体 `modelnet.collaboration_plan`，LiteLLM 原样透传，ModelNet Gateway 解析后执行。**

## 0. 公共链路

生产链路：

```text
TOC/LobeHub
  -> modelnet-litellm:8000 /v1/chat/completions
  -> modelnet-router:8000 /v1/chat/completions
  -> K8S backend models
```

开发链路：

```text
TOC dev
  -> modelnet-litellm-dev:8000 /v1/chat/completions
  -> modelnet-router-dev:8000 /v1/chat/completions
  -> K8S backend models
```

本机调试端口：

| 栈 | LiteLLM | Gateway | TOC |
| --- | --- | --- | --- |
| production | `http://127.0.0.1:3090/v1` | `http://127.0.0.1:3092` | `http://127.0.0.1:3081` |
| dev | `http://127.0.0.1:3190/v1` | `http://127.0.0.1:3192` | `http://127.0.0.1:3181` |

LiteLLM 配置里，两个聚合别名都转发到 Gateway：

```yaml
model_name: modelnet
api_base: http://modelnet-router:8000/v1
allowed_openai_params:
  - modelnet

model_name: modelnet-auto
api_base: http://modelnet-router:8000/v1
allowed_openai_params:
  - modelnet
```

`allowed_openai_params: [modelnet]` 加上项目里的 LiteLLM 补丁，保证这个扩展字段能穿过 LiteLLM 到达 Gateway。

## 1. 方案一：自动组网 `modelnet-auto`

### 适用场景

用在不知道该选哪个模型、希望系统自动按问题复杂度和后端负载决定策略的场景。

适合：

- 普通用户默认入口。
- 问题复杂度不确定。
- 希望简单问题自动走单模型，复杂问题自动走多模型。
- 需要保留 `auto_plan`、trace 和内部调用统计。

不适合：

- 用户明确要比较指定几个模型。
- 用户明确要按某个顺序让模型互相审阅。

### UI 做法

在 TOC/LobeHub 里选择 OpenAI provider 下的：

```text
modelnet-auto
```

前端会识别：

```ts
provider === openai && model === modelnet-auto
```

然后强制走 Chat Completions，不走 Responses API，并在 payload 中加入 `modelnet.collaboration_plan`。

### 实际请求体

TOC 当前发送的核心形状：

```json
{
  "model": "modelnet-auto",
  "stream": true,
  "messages": [
    {
      "role": "user",
      "content": "请分析这个方案的风险并给出改进建议。"
    }
  ],
  "modelnet": {
    "stream_options": {
      "include_trace": true
    },
    "collaboration_plan": {
      "runner": "auto.network",
      "aggregator": "auto",
      "runner_config": {
        "show_auto_flow": true
      }
    }
  }
}
```

### Gateway 怎么理解

Gateway 收到后：

1. `openai_chat_to_ir()` 读取 `body.modelnet.collaboration_plan`。
2. 看到 `model=modelnet-auto`，runner 是 `auto.network`。
3. `ir_to_ensemble_request()` 转成 `EnsembleRequest`：
   - `runner = auto`
   - `aggregator = auto`
   - `runner_config.native_runner = auto.network`
4. `run_ensemble_stream()` 进入 `run_auto_ensemble()`。
5. `plan_auto_ensemble()` 做自动规划。

自动规划会看：

- prompt 长度、问题数量、历史轮数。
- 是否中文、代码、设计、安全、推理类任务。
- 当前可见 candidate pool。
- K8S ready 状态。
- Prometheus CPU/memory/GPU 指标。
- in-flight 请求数。
- failure cooldown。
- `max_auto_sources`、`quality`、`strategy` 等 runner_config。

可能规划成：

| 情况 | 实际 runner |
| --- | --- |
| 简单问题、高置信、低成本优先 | `route.once` |
| 高负载 shed | `route.once` |
| 复杂问题、至少 2 个候选 | `auto.rank_fuse` |
| 显式 `strategy=parallel_consensus` | `response.parallel` |
| 显式 `strategy=role_graph` | `auto.role_graph` |
| 显式 `strategy=claim_graph` | `auto.claim_graph` |

### 用户选模型信息怎么传

自动组网默认不是用户选具体模型，而是 Gateway 自动选。

如果要限制自动组网只能在用户指定模型池里选，可以在直接 API 调用中加：

```json
{
  "modelnet": {
    "candidate_aliases": [
      "inference-qwen-qwen3-14b-awq",
      "llama-cpp-deploy-pc-3090-qwen3-8b-bf16"
    ],
    "collaboration_plan": {
      "runner": "auto.network",
      "aggregator": "auto"
    }
  }
}
```

Gateway 会把 `modelnet.candidate_aliases` 放进 `collaboration_plan.candidate_aliases`，再用它过滤候选模型。

### 直接 curl 示例

Dev LiteLLM：

```bash
curl -sS http://127.0.0.1:3190/v1/chat/completions \
  -H "Authorization: Bearer $MODELNET_LITELLM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "modelnet-auto",
    "stream": false,
    "messages": [
      {
        "role": "user",
        "content": "用三点说明 LiteLLM 和 ModelNet Gateway 的分工。"
      }
    ],
    "modelnet": {
      "stream_options": {
        "include_trace": true
      },
      "collaboration_plan": {
        "runner": "auto.network",
        "aggregator": "auto",
        "runner_config": {
          "show_auto_flow": true
        }
      }
    }
  }'
```

期望结果：

- 返回 OpenAI-compatible chat completion。
- 响应里有 `modelnet.metadata.auto_plan`。
- `auto_plan.runner` 可能是 `route.once`、`auto.rank_fuse`、`auto.role_graph` 等。
- metadata 中应能看到内部调用统计，例如 `internal_total_tokens`、`internal_usage`、`call_ledger_summary`。

## 2. 方案二：并联协作 `ModelNet 并联`

### 适用场景

用在用户已经明确想让多个模型独立回答，然后合成一个最终答案的场景。

适合：

- 比较不同模型对同一问题的看法。
- 需要综合多个模型的长处。
- 希望降低单模型幻觉风险。
- 适合 benchmark 中的 `parallel_consensus` 类型。

不适合：

- 简单短问答，成本会偏高。
- 需要严格顺序推理的任务。
- 只想固定用一个模型的任务。

### UI 做法

在 TOC/LobeHub 中选择：

```text
ModelNet 并联
```

然后选择 2-16 个具体 ModelNet backend 模型。

前端限制：

```text
MIN_MODELNET_PARALLEL_MODELS = 2
MAX_MODELNET_PARALLEL_MODELS = 16
```

### 实际请求体

TOC 会把虚拟模型 `modelnet-parallel` 转成底层：

```json
{
  "model": "modelnet",
  "stream": true,
  "messages": [
    {
      "role": "user",
      "content": "请给出这个架构的优缺点。"
    }
  ],
  "modelnet": {
    "stream_options": {
      "include_trace": true
    },
    "collaboration_plan": {
      "runner": "response.parallel",
      "aggregator": "synthesize",
      "models": [
        "inference-qwen-qwen3-14b-awq",
        "llama-cpp-deploy-pc-3090-qwen3-8b-bf16"
      ],
      "runner_config": {
        "allow_degraded": false,
        "show_parallel_flow": true
      }
    }
  }
}
```

注意这里的 `model` 是 `modelnet`，但不会触发退休错误，因为请求里有显式：

```json
"runner": "response.parallel"
```

退休错误只针对：

```text
model=modelnet 且 runner=route.once
```

### Gateway 怎么知道用户选了哪些模型

用户选择的模型就在：

```json
"modelnet": {
  "collaboration_plan": {
    "models": [
      "inference-qwen-qwen3-14b-awq",
      "llama-cpp-deploy-pc-3090-qwen3-8b-bf16"
    ]
  }
}
```

Gateway 的 `build_sources()` 会按顺序读取：

1. `plan.sources`
2. `plan.candidate_aliases`
3. `plan.model_aliases`
4. `plan.models`

因此这里的 `models` 会被转成：

```text
source-1 -> inference-qwen-qwen3-14b-awq
source-2 -> llama-cpp-deploy-pc-3090-qwen3-8b-bf16
```

每个 source 都带同一份用户 messages 和 sampling params。

### Gateway 执行流程

```text
response.parallel
  -> 为每个 source 选择对应 candidate
  -> 并行调用多个 backend
  -> 收集每个模型完整回答
  -> 至少 2 个成功回答才进入合成
  -> 选择 synthesizer backend
  -> 输出最终答案
```

stream 中会出现：

- `source_selected`
- `modelnet_event: source.started`
- `modelnet_event: source.delta`
- `modelnet_event: source.completed`
- `modelnet_event: source.failed`
- `trace_step: synthesis.started`
- final `token`
- `done`

### 直接 curl 示例

```bash
curl -sS http://127.0.0.1:3190/v1/chat/completions \
  -H "Authorization: Bearer $MODELNET_LITELLM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "modelnet",
    "stream": false,
    "messages": [
      {
        "role": "user",
        "content": "请分别从性能、可靠性、可维护性角度评价 LiteLLM + Gateway 架构。"
      }
    ],
    "modelnet": {
      "stream_options": {
        "include_trace": true
      },
      "collaboration_plan": {
        "runner": "response.parallel",
        "aggregator": "synthesize",
        "models": [
          "inference-qwen-qwen3-14b-awq",
          "llama-cpp-deploy-pc-3090-qwen3-8b-bf16"
        ],
        "runner_config": {
          "allow_degraded": false,
          "show_parallel_flow": true
        }
      }
    }
  }'
```

期望结果：

- 至少两个 source 成功时返回合成答案。
- metadata 中能看到多个内部调用。
- 如果 source 少于两个成功，Gateway 会返回 `response_aggregate needs at least two successful source responses`。

### 可调参数

可以给每个 source 写更细的 `sources`，替代简单 `models`：

```json
{
  "collaboration_plan": {
    "runner": "response.parallel",
    "aggregator": "synthesize",
    "sources": [
      {
        "source_id": "qwen-strong",
        "model_alias": "inference-qwen-qwen3-14b-awq",
        "weight": 1.0,
        "sampling_params": {
          "temperature": 0.2,
          "max_tokens": 512
        }
      },
      {
        "source_id": "llama-check",
        "model_alias": "llama-cpp-deploy-pc-3090-qwen3-8b-bf16",
        "weight": 1.0,
        "sampling_params": {
          "temperature": 0.4,
          "max_tokens": 512
        }
      }
    ]
  }
}
```

这适合做实验或 benchmark。TOC 当前 UI 走的是简单 `models` 列表。

## 3. 方案三：串联协作 `ModelNet 串联`

### 适用场景

用在希望模型按顺序接力的场景：第一个模型先答，第二个模型审阅/改写，第三个模型继续 refine。

适合：

- 审稿式任务。
- 代码 review 后再修订。
- 方案先生成、再批判、再完善。
- 希望模型之间有明确先后关系。

不适合：

- 希望多个模型独立给出意见的任务。
- 对延迟敏感的短问答。
- 要求每个模型互不影响的比较任务。

### UI 做法

在 TOC/LobeHub 中选择：

```text
ModelNet 串联
```

然后选择 2-8 个具体 ModelNet backend 模型，并形成有序 topology。

前端限制：

```text
MIN_MODELNET_SERIAL_MODELS = 2
MAX_MODELNET_SERIAL_MODELS = 8
```

TOC 默认会把模型列表转成线性 topology：

```text
step-1 -> step-2 -> step-3
```

### 实际请求体

```json
{
  "model": "modelnet",
  "stream": true,
  "messages": [
    {
      "role": "user",
      "content": "先给出方案，再审查漏洞，最后输出改进版。"
    }
  ],
  "modelnet": {
    "stream_options": {
      "include_trace": true
    },
    "collaboration_plan": {
      "runner": "response.serial",
      "aggregator": "judge_refine",
      "runner_config": {
        "allow_degraded": false,
        "serial_topology": {
          "version": "modelnet.serial.v1",
          "nodes": [
            {
              "id": "step-1",
              "modelId": "inference-qwen-qwen3-14b-awq"
            },
            {
              "id": "step-2",
              "modelId": "llama-cpp-deploy-pc-3090-qwen3-8b-bf16"
            }
          ],
          "edges": [
            {
              "source": "step-1",
              "target": "step-2"
            }
          ]
        },
        "show_serial_flow": true
      }
    }
  }
}
```

### Gateway 怎么知道用户选了哪些模型

串联不使用 `models` 列表，而是使用：

```json
"serial_topology": {
  "nodes": [
    {"id": "step-1", "modelId": "model-a"},
    {"id": "step-2", "modelId": "model-b"}
  ],
  "edges": [
    {"source": "step-1", "target": "step-2"}
  ]
}
```

Gateway 的 `parse_serial_topology()` 会读取：

- 每个 node 的 `id`。
- 每个 node 的 `modelId`。
- edges 定义的顺序。

Gateway-local serial 执行时，每个 node 会变成一个 serial step：

```text
step-1 -> model-a -> 初稿
step-2 -> model-b -> 基于初稿审阅/改写
```

### 默认执行路径

TOC 当前发送的是：

```json
"runner": "response.serial",
"aggregator": "judge_refine"
```

这会走 **Gateway-local serial**：

```text
run_gateway_serial_ensemble()
```

它不会默认走 Dify。

只有同时满足下面三个条件才会走 Dify Workflow：

```json
{
  "runner": "response.serial",
  "aggregator": "dify.dsl",
  "runner_config": {
    "serial_engine": "dify"
  }
}
```

因此当前用户 UI 的 `ModelNet 串联` 是 Gateway 自己逐步调用 backend，不依赖 Dify Workflow provision。

### Gateway 执行流程

```text
response.serial + judge_refine
  -> 解析 serial_topology
  -> step-1 选择 modelId 对应 candidate
  -> 生成第一版 answer
  -> step-2 用 previous_answer 构造审阅/改写 prompt
  -> 必要时做上下文摘要
  -> 清理 hidden reasoning
  -> 若可见答案为空，尝试 visible answer recovery
  -> 输出最终 answer
```

stream 中会出现：

- `trace_step: serial.gateway.started`
- `source_selected` with `role=serial_step`
- `trace_step: serial.step.completed`
- `full_response`
- final `token`
- `done`

`done.metadata` 中会包含：

- `native_runner=response.serial`
- `aggregator=judge_refine`
- `topology_hash`
- `total_steps`
- `model_ids`
- `serial_steps`
- `used_summaries`
- `call_ledger_summary`

### 直接 curl 示例

```bash
curl -sS http://127.0.0.1:3190/v1/chat/completions \
  -H "Authorization: Bearer $MODELNET_LITELLM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "modelnet",
    "stream": false,
    "messages": [
      {
        "role": "user",
        "content": "请先写一个简短方案，再审查这个方案的问题，最后给出修正版。"
      }
    ],
    "modelnet": {
      "stream_options": {
        "include_trace": true
      },
      "collaboration_plan": {
        "runner": "response.serial",
        "aggregator": "judge_refine",
        "runner_config": {
          "allow_degraded": false,
          "serial_topology": {
            "version": "modelnet.serial.v1",
            "nodes": [
              {
                "id": "step-1",
                "modelId": "inference-qwen-qwen3-14b-awq"
              },
              {
                "id": "step-2",
                "modelId": "llama-cpp-deploy-pc-3090-qwen3-8b-bf16"
              }
            ],
            "edges": [
              {
                "source": "step-1",
                "target": "step-2"
              }
            ]
          },
          "show_serial_flow": true
        }
      }
    }
  }'
```

期望结果：

- 返回最终修订答案。
- metadata 里有 `serial_steps`。
- 如果 topology 节点少于 2 个或超过 8 个，TOC 侧会先报错；直接 API 调用则由 Gateway preflight 返回 serial topology error。

## 4. 三个方案对比

| 方案 | 用户是否选模型 | 请求中的模型字段 | 协作信息字段 | Gateway runner | 结果形态 |
| --- | --- | --- | --- | --- | --- |
| 自动组网 | 默认不选，可选限制候选池 | `modelnet-auto` | `collaboration_plan.runner=auto.network` | `auto.network`，再规划成具体 runner | 自动选择单模型或多模型 |
| 并联 | 选 2-16 个模型 | `modelnet` | `collaboration_plan.models=[...]` | `response.parallel` | 多个模型独立回答后合成 |
| 串联 | 选 2-8 个有序模型 | `modelnet` | `runner_config.serial_topology.nodes/edges` | `response.serial` | 按顺序生成、审阅、改写 |

## 5. LiteLLM 在三种方案里的作用

LiteLLM 对三种方案做同一件事：

1. 根据 `model` 查 alias。
2. 如果是 `modelnet` 或 `modelnet-auto`，转发到：

```text
http://modelnet-router:8000/v1
```

3. 保留请求体中的：

```json
"modelnet": {
  "stream_options": {},
  "collaboration_plan": {}
}
```

4. 把 Gateway 返回的 OpenAI-compatible JSON/SSE 再交回 TOC。

LiteLLM 不做这些事：

- 不解析用户选了哪几个模型。
- 不执行并联或串联。
- 不做 K8S 负载调度。
- 不生成 auto_plan。
- 不决定 synthesizer。

这些都由 Gateway 完成。

## 6. Gateway 如何识别用户选择

Gateway 识别选择的入口是：

```python
modelnet_options = body.get("modelnet")
collaboration_plan = modelnet_options.get("collaboration_plan")
```

不同方案对应不同字段：

### 自动组网

```json
{
  "model": "modelnet-auto",
  "modelnet": {
    "collaboration_plan": {
      "runner": "auto.network"
    }
  }
}
```

可选候选池：

```json
{
  "modelnet": {
    "candidate_aliases": ["model-a", "model-b"]
  }
}
```

### 并联

```json
{
  "modelnet": {
    "collaboration_plan": {
      "runner": "response.parallel",
      "models": ["model-a", "model-b"]
    }
  }
}
```

`build_sources()` 会把 `models` 变成 `source-1`、`source-2`。

### 串联

```json
{
  "modelnet": {
    "collaboration_plan": {
      "runner": "response.serial",
      "runner_config": {
        "serial_topology": {
          "nodes": [
            {"id": "step-1", "modelId": "model-a"},
            {"id": "step-2", "modelId": "model-b"}
          ],
          "edges": [
            {"source": "step-1", "target": "step-2"}
          ]
        }
      }
    }
  }
}
```

`parse_serial_topology()` 会把 nodes/edges 变成有序执行步骤。

## 7. 推荐验证命令

### 查看 dev 栈状态

```bash
docker compose --env-file .env --env-file .env.dev -f docker-compose.dev.yml ps
```

### 查看 Gateway 健康

```bash
curl -sS http://127.0.0.1:3192/healthz | jq .
```

生产：

```bash
curl -sS http://127.0.0.1:3092/healthz | jq .
```

### 查看模型与能力

```bash
curl -sS http://127.0.0.1:3192/v1/models \
  -H "Authorization: Bearer $MODELNET_BACKEND_API_KEY" | jq .
```

```bash
curl -sS http://127.0.0.1:3192/v1/capabilities \
  -H "Authorization: Bearer $MODELNET_BACKEND_API_KEY" | jq .
```

### 看 Gateway 日志

```bash
docker compose --env-file .env --env-file .env.dev -f docker-compose.dev.yml logs --tail=200 modelnet-router
```

生产：

```bash
docker compose logs --tail=200 modelnet-router litellm
```

## 8. 常见坑

### 坑 1：把 `modelnet` 当自动组网入口

普通自动组网应使用：

```text
modelnet-auto
```

`modelnet` 只有在携带显式 runner 时才用于并联/串联等协作入口。否则 Gateway 会返回 410。

### 坑 2：LiteLLM 丢掉 `modelnet` 字段

如果 LiteLLM 没有应用项目补丁，或 config 没有：

```yaml
allowed_openai_params:
  - modelnet
```

Gateway 就收不到 `collaboration_plan`，并联/串联/自动组网都会退化或失败。

### 坑 3：并联少于两个成功 source

`response.parallel` 至少需要两个成功且有可见文本的 source response。只有一个成功时不会合成，而是返回错误。

### 坑 4：串联误以为默认走 Dify

当前 UI 的 `ModelNet 串联` 默认走 Gateway-local serial：

```text
response.serial + judge_refine
```

只有显式：

```text
aggregator=dify.dsl
runner_config.serial_engine=dify
```

才会走 Dify Workflow。

### 坑 5：具体 backend model 直连不会经过 Gateway

如果直接请求：

```text
model=inference-...
model=llama-cpp-...
```

LiteLLM 可能直接转发到具体 backend，不经过 Gateway 的 `auto_plan`、trace、并联/串联逻辑。要使用协作能力，必须选：

```text
modelnet-auto
modelnet + collaboration_plan
```
