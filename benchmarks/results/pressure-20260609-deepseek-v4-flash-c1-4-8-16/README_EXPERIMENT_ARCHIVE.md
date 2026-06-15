# ModelNet High-Load Pressure Benchmark Archive

归档时间：2026-06-10

实验目录：

`/home/duxianghe/ModelNet-toc/benchmarks/results/pressure-20260609-deepseek-v4-flash-c1-4-8-16/`

这个目录保留本次压力 benchmark 的原始结果、中间过程、评测记录、运行配置、日志、汇总报告、代码快照和校验和。DeepSeek API key 不写入本目录，`run_config.json` 中相关路径已脱敏为 `<redacted>`。

## 核心文件

| 文件 | 含义 | 是否原始中间过程 |
| --- | --- | --- |
| `answers.jsonl` | 每一次系统回答的逐条记录。包含并发级别、问题 ID、系统名、状态、总延迟、每轮 prompt/answer、模型 metadata、runner/strategy/source/selected model 等。 | 是 |
| `judgments.jsonl` | DeepSeek V4 Flash 对 `modelnet_auto` 与各 baseline 的逐条 pairwise 评测。每条含并发级别、问题 ID、baseline、展示顺序、评分、状态等。 | 是 |
| `run.log` | 实验运行全过程日志，按时间顺序记录 answer 阶段和 judge 阶段的每条完成事件。 | 是 |
| `run_config.json` | 本次实验的完整参数配置和候选模型列表。敏感字段已脱敏。 | 是 |
| `summary.json` | 从原始 answers/judgments 汇总出的机器可读统计，包括性能、质量、路由混合、模型选择次数。 | 派生 |
| `report.md` | 面向人工阅读的汇总报告。 | 派生 |
| `README_EXPERIMENT_ARCHIVE.md` | 本文件，解释归档内容和参数含义。 | 说明 |
| `MANIFEST.sha256` | 归档文件的 SHA256 校验和。 | 校验 |
| `code_snapshot/run_pressure_modelnet.py` | 本次实验 runner 的代码快照。 | 代码快照 |
| `code_snapshot/git_commit.txt` | 归档时仓库 HEAD commit。 | 环境快照 |
| `code_snapshot/git_status_short.txt` | 归档时仓库 dirty worktree 状态。 | 环境快照 |
| `code_snapshot/service_status_at_archive.txt` | 归档时 `docker compose ps` 输出。 | 环境快照 |
| `code_snapshot/gpu_status_at_archive.csv` | 归档时 GPU 显存状态。 | 环境快照 |

## 原始记录规模

- `answers.jsonl`: 256 条。4 个系统 × 4 个并发级别 × 16 个 MT-Bench 问题。
- `judgments.jsonl`: 192 条。4 个并发级别 × 8 个抽样问题 × 3 个 baseline × 2 个展示顺序。
- `run.log`: 467 行运行过程日志。
- `answer_status`: 256/256 ok，0 failed。
- `judgment_status`: 192/192 ok，0 failed。

## 复现实验命令

```bash
cd /home/duxianghe/ModelNet-toc
python3 benchmarks/run_pressure_modelnet.py \
  --output-dir benchmarks/results/pressure-20260609-deepseek-v4-flash-c1-4-8-16 \
  --question-ids 81,86,91,96,101,106,111,116,121,126,131,136,141,146,151,156 \
  --concurrency-levels 1,4,8,16 \
  --judge-question-count 8 \
  --max-tokens 768 \
  --expert-max-tokens 384 \
  --critic-max-tokens 256 \
  --aggregation-max-tokens 768 \
  --request-timeout 300 \
  --judge-timeout 120
```

复现时需要保证 ModelNet router 在 `http://127.0.0.1:3092/v1/chat/completions` 可访问，并且 DeepSeek API key 通过远端 secret 文件或环境变量提供。不要把 key 写入结果目录。

## 参数含义

### 请求与数据参数

| 参数 | 本次取值 | 含义 |
| --- | --- | --- |
| `endpoint` | `http://127.0.0.1:3092/v1/chat/completions` | ModelNet router 的 OpenAI-compatible chat completion endpoint。所有被测系统都通过这个入口发请求。 |
| `models_endpoint` | `http://127.0.0.1:3092/v1/models` | 用于发现当前网关可用模型列表。 |
| `question_file` | `benchmarks/data/mt_bench_question.jsonl` | MT-Bench 问题文件。 |
| `question_ids` | `81,86,...,156` | 本次抽取的 16 个问题 ID。覆盖 writing、roleplay、reasoning、math、coding 等不同类型。 |
| `question_ids_resolved` | 16 个整数 ID | runner 实际解析后的问题 ID 列表。 |
| `output_dir` | `benchmarks/results/pressure-20260609-deepseek-v4-flash-c1-4-8-16` | 所有结果和中间过程输出目录。 |
| `force` | `false` | 是否强制覆盖已有输出。false 表示保留已有记录并按缺失项续跑。 |

### 负载参数

| 参数 | 本次取值 | 含义 |
| --- | --- | --- |
| `concurrency_levels` | `[1, 4, 8, 16]` | 外部闭环并发级别。每个系统在每个并发级别下跑 16 个问题。 |
| `request_timeout` | `300` 秒 | 单次 answer 请求的超时时间。超过则记为 failed/timeout。 |
| `retries` | `1` | answer 请求失败后的重试次数。 |

### 生成参数

| 参数 | 本次取值 | 含义 |
| --- | --- | --- |
| `max_tokens` | `768` | 普通回答或 baseline 回答的最大生成 token 数。 |
| `temperature` | `0.2` | 采样温度。越低越确定，越高越发散。 |
| `top_p` | `0.9` | nucleus sampling 阈值。 |
| `max_auto_sources` | `3` | 自动组网/并联策略最多使用的候选源模型数量。 |
| `expert_max_tokens` | `384` | `modelnet_auto` role graph 中专家节点的最大生成 token 数。 |
| `critic_max_tokens` | `256` | role graph 中 critic/skeptic 节点的最大生成 token 数。 |
| `aggregation_max_tokens` | `768` | synthesizer/aggregator 最终聚合回答的最大生成 token 数。 |

### 系统与路由参数

| 系统 | 请求模型/配置 | 含义 |
| --- | --- | --- |
| `modelnet_auto` | model=`modelnet-auto`, 默认配置 | 自动组网策略。简单问题可走 `route.once`，复杂问题走 `auto.role_graph`。 |
| `single_best` | model=`modelnet-auto`, runner_config=`{"strategy":"single_best"}` | 每个问题只选择一个当前最合适的模型回答。用于测试单路最佳模型策略。 |
| `fixed_qwen35b` | model=`inference-qwen-qwen3-5-35b-a3b-gptq-int4` | 固定 Qwen35B 基线。用于测试单独强模型在高负载下的排队情况。 |
| `parallel_consensus` | model=`modelnet-auto`, runner_config=`{"strategy":"parallel_consensus"}` | 固定并联共识策略。多个模型并行回答后聚合。 |
| `candidate_aliases` | 空字符串 | 空表示 runner 自动从 `/v1/models` 发现候选模型。 |
| `candidate_aliases_resolved` | 17 个模型 alias | 本次自动发现后实际可供路由选择的模型列表。 |

### Judge 参数

| 参数 | 本次取值 | 含义 |
| --- | --- | --- |
| `deepseek_base` | `https://api.deepseek.com` | DeepSeek OpenAI-compatible API base。 |
| `deepseek_model` | `deepseek-v4-flash` | 外部裁判模型。 |
| `deepseek_secret_file` | `<redacted>` | API key 文件路径已脱敏。归档中不保存 key。 |
| `judge_question_count` | `8` | 每个并发级别抽样 8 个问题进行质量评测。 |
| `judge_workers` | `2` | 并行评测 worker 数。 |
| `judge_max_tokens` | `512` | 裁判模型输出的最大 token 数。 |
| `judge_timeout` | `120` 秒 | 单次裁判请求超时时间。 |
| `judge_retries` | `1` | 裁判请求失败后的重试次数。 |

## 指标含义

| 指标 | 含义 |
| --- | --- |
| `total` | 当前系统/并发级别下应执行的请求数量。 |
| `ok` | 成功返回的请求数量。 |
| `failed` | 失败或超时的请求数量。 |
| `success_rate` | `ok / total`。 |
| `p50_ms` | 成功请求延迟的中位数。 |
| `p95_ms` | 成功请求延迟的 95 分位，用于观察长尾。 |
| `p99_ms` | 成功请求延迟的 99 分位。由于每组只有 16 条，本次 p95/p99 常等于最大值。 |
| `mean_ms` | 成功请求平均延迟。 |
| `max_ms` | 成功请求最大延迟。 |
| `throughput_per_min` | 每分钟完成请求数。runner 以该系统该并发段的 wall-clock 完成时间计算。 |
| `average_score` | DeepSeek pairwise 评分中 `modelnet_auto` 的平均得分。1 表示 auto 胜，0.5 表示平，0 表示 auto 负。 |
| `bootstrap_95ci` | 对 `average_score` 的 bootstrap 95% 置信区间。 |
| `wins/ties/losses` | 每个问题聚合双顺序评判后，`modelnet_auto` 相对 baseline 的胜/平/负数量。 |
| `runner_counts` | 不同 runner/strategy 实际被调用次数，如 `auto.role_graph`、`route.once`、`response.parallel`。 |
| `selected_model_counts` | 各底层模型被路由选中的次数。 |

## 如何追踪中间过程

1. 查看某个系统在某个并发下的所有原始回答：

```bash
jq -c 'select(.concurrency==16 and .system=="modelnet_auto")' answers.jsonl
```

2. 查看某个问题的四个系统输出：

```bash
jq -c 'select(.question_id==121)' answers.jsonl
```

3. 查看某个并发级别下 DeepSeek 对 `modelnet_auto` vs `single_best` 的评测：

```bash
jq -c 'select(.concurrency==16 and .baseline=="single_best")' judgments.jsonl
```

4. 查看运行过程时间线：

```bash
less run.log
```

5. 校验归档文件是否被改动：

```bash
sha256sum -c MANIFEST.sha256
```

## 本次结论摘要

- `modelnet_auto` 在本次高负载实验中没有优于 `single_best`。
- `single_best` 在所有并发级别下延迟和吞吐更好，尤其 `c=16` 时 p95 为 91.0s，而 `modelnet_auto` 为 276.1s。
- `modelnet_auto` 在 `c=16` 的质量评测中相对 `fixed_qwen35b` 和 `parallel_consensus` 有小幅优势，平均分均为 0.531，但延迟代价较大。
- 主要瓶颈来自 `auto.role_graph` 的内部多模型、多角色、多轮聚合调用，在外部高并发下会放大排队和长尾。

