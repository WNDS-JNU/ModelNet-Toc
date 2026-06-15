# ModelNet Benchmark Design

本文档说明 ModelNet 当前 benchmark 的设计、指标定义、已知限制，以及修正后的正式评测口径。它的目标不是只描述脚本怎么跑，而是让读者能够判断：哪些结果可以支持结论，哪些结果只能作为 smoke test 或诊断信号。

当前 benchmark 的骨架是合理的：把质量、压力、负载均衡拆开；使用 open-loop scheduled arrival；区分 request latency、end-to-end latency 和 client queue delay；支持 MT-Bench prompt、synthetic workload 和 trace replay。这些都符合 LLM serving benchmark 的常见做法。

但当前实现中有几类细节会直接威胁结论有效性。正式使用 benchmark 时，必须按本文档中的修正版指标和实验矩阵执行。

## 1. 结论边界

### 1.1 当前实现可以支持的结论

在不修改 gateway 的前提下，当前脚本可以可靠支持以下诊断性结论：

- 某个 system 在给定 workload 下是否能跑通。
- 同一批请求下，各 system 的端到端延迟、错误率、client queue delay 是否明显不同。
- gateway metadata 中暴露的 runner mix 是否发生变化，例如 `route.once` 和 `auto.role_graph` 的比例。
- gateway metadata 中暴露的 selected backend 是否集中到少数 backend。
- 在小规模 smoke test 中，路由和 benchmark pipeline 是否正常工作。

这些结论适合内部调试和回归测试，不足以支撑论文式的“自动组网优于 baseline”或“负载均衡更好”的强结论。

### 1.2 当前实现不能直接支持的结论

在以下前置条件未满足前，不应下这些结论：

- 不应声称某个多模型策略有更好的 cost efficiency，因为当前未暴露完整内部调用账单。
- 不应声称 token-based backend load 已经被准确测量，因为当前只能看到部分 usage 或最终答案 usage。
- 不应把 selection-based Gini/Jain 当作真实负载均衡证据，因为它衡量的是“被选择次数”，不是 backend 上的真实负载。
- 不应把 `latency_ms > SLO` 且只除以成功请求的 SLO violation 当成用户体验 SLO，因为失败请求和排队时间被排除了。
- 不应把小样本 `p99` 当成稳定尾延迟结论。例如 `n=40` 时 nearest-rank 的 p99 实际上就是最大值。
- 不应使用与被测 backend pool 重叠的 judge 给出正式质量结论。

### 1.3 正式 benchmark 必须满足的五个前置条件

正式报告结果前，必须完成以下五件事：

1. **池外 judge + 长度控制**：judge 必须不在被测 backend pool 中，固定版本、`temperature=0`；报告答案长度，并给出 length-controlled win rate 或明确标注未控制长度偏置。
2. **完整内部调用账单**：gateway 必须为每个请求暴露 role graph 内部每次 backend call 的 prompt/completion tokens、latency、status 和 stage。
3. **goodput 口径 + e2e SLO + rate sweep**：SLO 以 offered requests 为分母，失败和超时一律算违约；headline 指标用 rate sweep 找最大可持续速率。
4. **重复运行和统计功效**：每个配置至少 3 个 seed；每个 seed 至少数百个 measured requests；丢弃 warm-up；报告置信区间。
5. **fairness 拆分和经典 baseline**：把 coverage、conditional fairness、capacity-weighted load 分开；加入 random、round-robin、least-outstanding-requests 等经典路由 baseline。

## 2. Benchmark 组成

当前 `benchmarks/` 下有三类脚本。

| Script | 目标 | 适合支持的结论 |
| --- | --- | --- |
| `run_mtbench_modelnet.py` | 全量 MT-Bench 质量评测 | 回答质量、pairwise win rate、类别差异 |
| `run_pressure_modelnet.py` | 固定并发压力测试 | 并发等级下的延迟、错误率、质量退化诊断 |
| `run_load_balancing_modelnet.py` | open-loop arrival / trace replay | goodput、e2e latency、queueing、backend selection skew |

三类 benchmark 的职责必须分清：

- 质量 benchmark 负责回答“答案是否更好”。
- pressure benchmark 负责回答“固定并发下是否稳定”。
- load-balancing benchmark 负责回答“在真实到达过程和压力变化下，系统是否保持 goodput 和低 tail latency”。

负载均衡不是最终目标，而是服务目标的一个诊断维度。正式结论应优先看 high-load goodput、e2e latency、错误率和质量成本 Pareto，再用 fairness 指标解释原因。

## 3. 被测系统和 Baseline

### 3.1 当前系统

当前脚本中的系统由 `SYSTEMS` 定义。

| System | Model | Runner / Strategy | 定位 |
| --- | --- | --- | --- |
| `modelnet_auto` | `modelnet-auto` | `role_graph` | 当前默认自动组网策略。 |
| `adaptive_sparse_graph` | `modelnet-auto` | `adaptive_sparse_graph` | 更稀疏的自动组网策略，目标是降低调用成本。 |
| `single_best` | `modelnet-auto` | `single_best` | 路由器选择单个 backend 的低成本 baseline。 |
| `fixed_qwen35b` | `inference-qwen-qwen3-5-35b-a3b-gptq-int4` | fixed direct | 固定强模型 baseline，不应同时作为 judge。 |
| `parallel_consensus` | `modelnet-auto` | `parallel_consensus` | 多模型并行回答后汇总的高成本 baseline。 |

注意：`fixed_qwen35b` 只能作为被测强模型 baseline，不能同时作为 judge。若 judge 与被测系统重叠，则 pairwise 胜率可能受到 self-enhancement bias 污染。

### 3.2 负载均衡必须补充的 baseline

如果要证明“ModelNet 路由/组网策略改善了负载均衡”，当前系统变体不够。正式 load-balancing benchmark 应至少补充：

| Baseline | 含义 | 用途 |
| --- | --- | --- |
| `random_single` | 从 candidate backend 中随机选一个 | 衡量路由选择是否优于随机分配。 |
| `round_robin` | 按顺序轮转 backend | 经典均匀分配 baseline。 |
| `least_outstanding_requests` | 选择当前 in-flight 请求最少的 backend | 经典在线负载均衡 baseline。 |
| `least_recently_used` | 选择最近最少使用的 backend | 简单无 telemetry baseline。 |

这些 baseline 当前尚未全部实现。在它们实现前，不应声称 ModelNet 的负载均衡策略优于经典调度策略，只能说当前策略之间有差异。

### 3.3 质量侧建议补充的 baseline

质量侧建议增加：

| Baseline | 含义 | 用途 |
| --- | --- | --- |
| `random_single` | 随机选单模型回答 | 衡量 router 本身是否有价值。 |
| `per_category_oracle` | 每个类别选择历史最优 backend | 估计路由上界。 |
| `strong_single_external` | 池外强模型 | 防止所有 baseline 都来自同一模型池。 |

正式质量结论应回答：在多少额外成本和延迟下，自动组网拿到了多大质量提升。

## 4. Workload 设计

### 4.1 MT-Bench workload

`mtbench` workload 使用：

```bash
benchmarks/data/mt_bench_question.jsonl
```

当前生成规则：

1. 读取 MT-Bench 题目。
2. 每个题目只取第一轮 user prompt。
3. 按 `--num-requests` 循环采样 prompt。
4. 按 arrival model 生成 `scheduled_at_s`。
5. 用 `--max-tokens` 控制输出上限。

限制：

- 这不是完整 MT-Bench 质量评测，只是借用 prompt 做服务负载。
- MT-Bench 只有 80 题，循环采样时重复率高，可能触发 prefix cache。
- MT-Bench 是 2023 年 benchmark，存在污染和饱和风险。

正式 load test 不应只依赖 MT-Bench prompt。建议使用更大的 prompt pool，例如 ShareGPT、LMSYS-Chat-1M 或真实线上 trace prompt。

### 4.2 Synthetic workload

`synthetic` workload 根据输入/输出 token hint 生成合成 prompt。

核心参数：

```bash
--synthetic-input-tokens
--synthetic-input-tokens-stddev
--synthetic-output-tokens
--synthetic-output-tokens-stddev
--max-input-tokens
--max-tokens
```

采样方式：

```text
sample = round(N(mean, stddev))
sample = clamp(sample, min_value, max_value)
```

重要限制：

- `--synthetic-output-tokens` 当前只影响 `max_tokens` 或输出长度提示，不保证模型实际生成这么多 token。
- 如果 backend 没有 `ignore_eos` 或 `min_tokens`，模型可能很快 EOS，实际输出长度远小于设定值。
- synthetic prompt 的语义分布不真实，如果 router 依赖 prompt 内容，路由行为可能不同于真实流量。

正式报告必须同时统计实际生成长度分布：

```text
avg_completion_tokens
median_completion_tokens
p95_completion_tokens
```

### 4.3 Trace replay workload

`trace` workload 用于 replay 外部真实 trace。当前兼容 CSV 和 JSONL。

支持字段：

| 语义 | 字段名 |
| --- | --- |
| 到达时间 | `Timestamp`, `timestamp`, `time`, `arrival_time`, `scheduled_at` |
| 输入长度 | `Request tokens`, `request_tokens`, `input_length`, `input_tokens`, `prompt_tokens` |
| 输出长度 | `Response tokens`, `response_tokens`, `output_length`, `output_tokens`, `completion_tokens` |
| prompt 文本 | `text_input`, `prompt`, `input`, `user_input`, `question` |
| trace 原始模型 | `Model`, `model`, `trace_model` |
| 会话 ID | `Session ID`, `session_id`, `conversation_id` |

时间缩放：

```text
scheduled_at_s = max(0, (timestamp - first_timestamp) * trace_time_scale)
```

如果 trace 没有真实 prompt，脚本会用 token hint 生成 synthetic prompt。此时 trace replay 只能验证到达动力学和队列行为，不能验证真实内容路由行为。

### 4.4 Arrival pattern

`mtbench` 和 `synthetic` 当前支持三种 arrival mode。

#### Constant

```text
interval = 1 / request_rate
```

适合稳定负载。

#### Poisson

```text
interval ~ Exponential(rate = request_rate)
```

适合近似自然在线到达。

#### Bursty

当前实现是 simple burst，不保持名义平均速率。

```text
base_interval = (1 / R) / max(1, K)
if request_index % B == 0:
    interval = base_interval + (1 / R) * G
else:
    interval = base_interval
```

其中：

- `R = --request-rate`
- `K = --burstiness`
- `B = --burst-size`
- `G = --burst-gap-multiplier`

平均间隔为：

```text
E[interval] = (1 / R) * (1 / K + G / B)
```

因此实际平均速率为：

```text
actual_rate = R / (1 / K + G / B)
```

例如 `R=1, K=1, B=8, G=8` 时，实际速率是 `0.5 req/s`，不是 `1 req/s`。所以 constant、poisson、bursty 不能只按相同 `R` 横向比较，必须报告 `actual_offered_rate`。

正式 burst test 建议二选一：

- 使用真实 trace replay，让 trace 自身携带 burstiness。
- 改为保均值 burst 模型或 Gamma/MMPP arrival model，再比较相同 actual offered rate。

## 5. 输出文件

每次 benchmark 生成：

```text
benchmarks/results/<run-name>/
```

核心文件：

| 文件 | 内容 |
| --- | --- |
| `run_config.json` | 运行参数、systems、candidate aliases、seed。 |
| `workload.jsonl` | 标准化 workload。 |
| `answers.jsonl` | 每个 system 的每个请求结果。 |
| `judgments.jsonl` | 质量评测时的 judge 结果。 |
| `summary.json` | 机器可读聚合指标。 |
| `report.md` | 人类可读报告。 |
| `MANIFEST.sha256` | 文件哈希，用于归档校验。 |

### 5.1 workload record

示例：

```json
{
  "request_id": 0,
  "scheduled_at_s": 0.0,
  "question_id": 81,
  "category": "writing",
  "prompt": "...",
  "max_tokens": 192,
  "input_tokens_hint": 512,
  "output_tokens_hint": 192,
  "trace_model": "",
  "session_id": "",
  "source": "mtbench"
}
```

解释：

- `scheduled_at_s`: open-loop 到达时间。
- `input_tokens_hint`: trace 或 synthetic 给出的输入长度提示，不一定等于真实 tokenizer 计数。
- `output_tokens_hint`: 期望输出长度提示，不等于实际输出长度。
- `max_tokens`: 传给 chat completion API 的输出上限。

### 5.2 answer record

示例：

```json
{
  "system": "modelnet_auto",
  "status": "ok",
  "request_id": 0,
  "scheduled_at_s": 0.0,
  "started_at_s": 0.001,
  "completed_at_s": 33.586,
  "queue_delay_ms": 1,
  "latency_ms": 33584,
  "e2e_ms": 33585,
  "selected_backends": ["backend-a", "backend-b"],
  "metadata": {
    "runner": "auto.role_graph",
    "strategy": "role_graph",
    "selected": ["backend-a", "backend-b"]
  }
}
```

解释：

- `latency_ms`: 实际 HTTP request 从发出到返回的耗时。
- `e2e_ms`: scheduled arrival 到完成的总耗时，包含 client queueing。
- `queue_delay_ms`: scheduled arrival 到实际开始请求之间的延迟。
- `selected_backends`: gateway metadata 暴露的 backend selection，不等于真实 workload。

## 6. 必须新增的内部调用账单

正式评估 quality-cost-latency Pareto 前，gateway 必须暴露完整内部账单。建议每个 request 的 metadata 增加：

```json
{
  "modelnet": {
    "metadata": {
      "auto_plan": {
        "runner": "auto.role_graph",
        "strategy": "role_graph"
      },
      "internal_calls": [
        {
          "call_id": "req-0-expert-0",
          "stage": "expert",
          "role": "primary_solver",
          "backend_id": "backend-a",
          "status": "ok",
          "started_at_s": 0.012,
          "completed_at_s": 5.431,
          "latency_ms": 5419,
          "prompt_tokens": 614,
          "completion_tokens": 180,
          "total_tokens": 794,
          "error": null
        }
      ],
      "internal_usage": {
        "prompt_tokens": 2130,
        "completion_tokens": 870,
        "total_tokens": 3000,
        "call_count": 4
      }
    }
  }
}
```

最低要求字段：

- `call_id`
- `stage`
- `role`
- `backend_id`
- `status`
- `started_at_s`
- `completed_at_s`
- `latency_ms`
- `prompt_tokens`
- `completion_tokens`
- `total_tokens`
- `error`

在该 schema 实现前：

- `cost/request` 不可得。
- `quality per token` 不可得。
- `token throughput` 会低估多模型策略。
- `token-based backend load` 只能作为粗略近似。
- role graph 内部 expert、critic、synthesizer 的真实开销不可见。

## 7. 性能指标

### 7.1 Offered requests

对每个 system：

```text
offered_requests = workload 中计划发送的请求数
```

分母必须是 offered requests，而不是成功请求数。这样错误、超时、取消都会影响结果。

### 7.2 Success rate

```text
ok = count(status == "ok")
failed = offered_requests - ok
success_rate = ok / offered_requests
```

### 7.3 Request latency

```text
latency_ms = time_after_http_response - time_before_http_request
```

它衡量 gateway/backend 处理时间，不包含 scheduled arrival 后等待 client worker 的 queueing。

聚合：

```text
p50 = percentile(latency_ms, 50)
p95 = percentile(latency_ms, 95)
p99 = percentile(latency_ms, 99)
mean = average(latency_ms)
max = max(latency_ms)
```

当前 percentile 使用 nearest-rank：

```text
ordered = sorted(values)
index = ceil(pct / 100 * len(values)) - 1
index = clamp(index, 0, len(values) - 1)
percentile = ordered[index]
```

注意：当样本很小时，p99 不稳定。`n=40` 时，p99 等同于最大值附近的离群点指标，不应作为 headline。

### 7.4 End-to-end latency

```text
e2e_ms = completed_at_s - scheduled_at_s
```

它包含：

- client queue delay
- HTTP request latency
- executor 调度开销

正式用户体验 SLO 必须使用 `e2e_ms`，不是只用 `latency_ms`。

### 7.5 Queue delay

```text
queue_delay_ms = max(0, started_at_s - scheduled_at_s)
```

解释：

- 接近 0：load generator 能按计划发出请求。
- 变大：client worker 或系统响应已经形成积压。
- p95 queue delay 高：tail latency 中有明显排队成分。

如果 queue delay 很高，说明测试配置本身也要检查，例如 `--max-client-concurrency` 是否过低。

### 7.6 Goodput 和 SLO violation

正式 headline 指标使用 goodput 口径。

给定：

```text
SLO = slo_ms
```

定义：

```text
good_request = status == "ok" AND e2e_ms <= SLO
good_requests = count(good_request)
goodput_ratio = good_requests / offered_requests
slo_violation_rate = 1 - goodput_ratio
```

错误、超时和失败请求全部算违约：

```text
error_or_timeout => not good_request
```

可选辅助指标：

```text
service_slo_violation_rate = count(status == "ok" AND latency_ms > SLO) / offered_requests
```

但该指标不能替代 e2e goodput。

### 7.7 Throughput

请求吞吐：

```text
request_throughput_per_min = ok / elapsed_s * 60
```

其中：

```text
elapsed_s = max(completed_at_s) - benchmark_start_s
```

如果系统能跟上 offered rate，该指标会接近 offered rate，因此不能单独代表容量。正式容量结论必须来自 rate sweep。

输出 token 吞吐：

```text
output_token_throughput_per_s = sum(completion_tokens) / elapsed_s
```

在完整内部账单未实现前，该指标只统计可见 usage，可能低估多模型策略。

### 7.8 Rate sweep 和最大可持续速率

正式 load benchmark 必须做 request-rate sweep，而不是只跑一个 rate。

示例 rates：

```text
0.25, 0.5, 1, 2, 4, 8 req/s
```

每个 rate 记录：

- offered rate
- actual offered rate
- goodput ratio
- p50/p95/p99 e2e latency
- error rate
- queue delay

最大可持续速率定义：

```text
max_sustainable_rate = max(rate)
where p95_e2e_ms <= SLO
  and error_rate <= 1%
  and goodput_ratio >= 99%
```

阈值可以按业务修改，但必须在报告前固定，不能事后调参。

### 7.9 Peak in-flight

对每个成功请求生成事件：

```text
(started_at_s, +1)
(completed_at_s, -1)
```

扫描事件：

```text
current += delta
peak_in_flight = max(peak_in_flight, current)
```

该指标用于判断测试期间实际并发是否达到预期。

## 8. 质量指标

### 8.1 Judge 要求

正式质量评测必须使用池外 judge：

- judge 不在 candidate backend pool 中。
- judge 不作为任何被测 system 的 baseline。
- 固定 provider、model、version。
- `temperature=0`。
- 记录 judge 配置到 `run_config.json` 和 `summary.json`。

推荐：

- 池外单 judge 作为默认。
- 有预算时增加第二个不同家族 judge，并报告 agreement。

### 8.2 Pairwise judgment

对同一问题比较两个 system：

```text
Assistant A: target answer
Assistant B: baseline answer
```

同时交换顺序：

```text
Assistant A: baseline answer
Assistant B: target answer
```

这可以缓解 position bias，但不能解决 verbosity bias 或 self-enhancement bias。

judge 输出：

```json
{
  "winner": "A",
  "score_a": 8,
  "score_b": 7,
  "confidence": 0.8,
  "reason": "short reason"
}
```

### 8.3 Target score

```text
target_score = 1.0  if target wins
target_score = 0.5  if tie
target_score = 0.0  if target loses
```

对同一问题的两个 order 取平均：

```text
question_score = average(target_score over orders)
```

### 8.4 Average score

```text
average_score = mean(question_score)
```

解释：

- `> 0.5`: target 优于 baseline。
- `= 0.5`: 大体打平。
- `< 0.5`: target 弱于 baseline。

### 8.5 答案长度和长度偏置

多模型、critic、synthesizer 策略经常输出更长答案。pairwise judge 对长答案有 verbosity bias，因此必须报告：

```text
avg_completion_tokens
median_completion_tokens
p95_completion_tokens
avg_answer_chars
median_answer_chars
```

正式报告应同时给出 length-controlled win rate。可选实现方式：

- 使用 AlpacaEval 2.0 风格的 length-controlled win rate。
- 对 judge score 做长度回归校正。
- 分桶比较相近长度的答案。

如果未实现长度控制，质量结论必须标注为 preliminary。

### 8.6 Bootstrap confidence interval

对问题级别分数做 bootstrap：

```text
for iteration in 1..N:
    sample = resample(question_scores, with_replacement=True)
    bootstrap_mean = mean(sample)

CI = [percentile(bootstrap_means, 2.5), percentile(bootstrap_means, 97.5)]
```

质量评测必须报告 CI。小样本 pressure judge 结果只作为诊断，不作为正式质量结论。

## 9. Cost 和 Pareto 指标

自动组网比单模型质量更好并不充分，因为它通常使用更多计算量。正式结论应关注质量、成本和延迟的 Pareto 位置。

完整内部账单实现后，至少计算：

```text
cost_tokens_per_request = internal_usage.total_tokens / offered_requests
prompt_tokens_per_request = internal_usage.prompt_tokens / offered_requests
completion_tokens_per_request = internal_usage.completion_tokens / offered_requests
backend_call_count_per_request = internal_usage.call_count / offered_requests
```

质量成本比：

```text
quality_per_1k_tokens = average_score / (cost_tokens_per_request / 1000)
```

也可以报告：

```text
quality_gain_per_extra_1k_tokens =
    (score_strategy - score_baseline)
    / ((tokens_strategy - tokens_baseline) / 1000)
```

正式图表建议：

- average score vs p95 e2e latency
- average score vs tokens/request
- goodput vs offered rate
- p95 e2e latency vs offered rate
- quality gain vs extra token cost

在内部账单未实现前，这些指标不能作为正式结论。

## 10. 负载均衡指标

### 10.1 Selection count 不是真实负载

当前 `selected_backends` 只能表示 backend 被选择参与了请求。它不是：

- backend 的真实 token 负载。
- backend 的 GPU utilization。
- backend 的 KV cache 占用。
- backend 的真实 wall-clock busy time。

因此 selection-based 指标只能作为诊断信号。

### 10.2 Coverage

```text
coverage = used_backend_count / candidate_backend_count
```

其中：

```text
used_backend_count = count(backend where selection_count > 0)
```

coverage 衡量覆盖范围，不衡量已用 backend 之间是否均匀。

### 10.3 Conditional fairness

conditional fairness 只在已使用 backend 上计算。

```text
used_counts = [selection_count_b for b if selection_count_b > 0]
```

Gini：

```text
x = sorted(used_counts)
n = len(x)
gini_used = (2 * sum((i + 1) * x_i) / (n * sum(x))) - ((n + 1) / n)
```

CV：

```text
cv_used = std(used_counts) / mean(used_counts)
```

Jain fairness：

```text
jain_used = (sum(x)^2) / (n * sum(x_i^2))
```

解释：

- Gini 越低越均匀。
- CV 越低越均匀。
- Jain 越接近 1 越均匀。

### 10.4 Full-pool fairness

full-pool fairness 把未使用 backend 也计入：

```text
all_counts = [selection_count_b for every candidate backend]
```

该指标同时混合了 coverage 和均匀性。若 18 个 backend 中只均匀使用 3 个：

```text
coverage = 3 / 18 = 0.167
jain_full_pool = 0.167
gini_full_pool ~= 0.833
```

此时 Jain/Gini 基本退化为 coverage 的换皮，不应作为独立证据。正式报告可以保留 full-pool fairness，但必须和 coverage 分开解释。

### 10.5 Capacity-weighted load

异构 backend 下，请求数均匀不是目标。35B 模型和小模型的 capacity 不同，理想负载应按 capacity 归一。

完整 telemetry 实现后，定义：

```text
load_share_b = token_load_b / sum(token_load)
capacity_share_b = capacity_b / sum(capacity)
normalized_load_b = load_share_b / capacity_share_b
```

capacity 可以来自：

- 历史稳定 tokens/s。
- GPU 类型和模型大小估计。
- backend 自报 capacity。

capacity-weighted imbalance：

```text
capacity_weighted_cv = std(normalized_load_b) / mean(normalized_load_b)
```

目标是 normalized load 接近 1，而不是 raw request count 完全均匀。

### 10.6 最终判据

负载均衡是手段，不是最终目标。正式结论应按以下优先级解释：

1. goodput 是否更高。
2. p95/p99 e2e latency 是否更低。
3. error rate 是否更低。
4. cost/request 是否可接受。
5. fairness 指标是否解释了上述现象。

如果 fairness 更好但 goodput/latency 更差，不能声称策略更优。

## 11. TTFT、TPOT 和 Streaming

当前脚本主要记录整响应 latency。该指标会被输出长度强烈影响。

如果 gateway 支持 streaming，正式 benchmark 应增加：

```text
TTFT = first_token_time - request_start_time
TPOT = (last_token_time - first_token_time) / max(1, output_tokens - 1)
ITL  = inter-token latency distribution
```

其中：

- TTFT 衡量首 token 响应速度。
- TPOT 衡量生成阶段速度。
- ITL 衡量 token 间延迟和抖动。

如果暂不支持 streaming，应在报告中明确：

- latency 指标包含生成完整答案的时间。
- 输出更长的策略天然更吃亏。
- 必须同时报告实际输出长度。

## 12. 实验矩阵

### 12.1 Smoke test

目的：确认脚本和 gateway 通路正常。

```bash
python3 benchmarks/run_load_balancing_modelnet.py \
  --workload-source synthetic \
  --num-requests 1 \
  --request-rate 10 \
  --systems modelnet_auto,single_best \
  --synthetic-input-tokens 32 \
  --synthetic-input-tokens-stddev 0 \
  --synthetic-output-tokens 32 \
  --synthetic-output-tokens-stddev 0 \
  --max-tokens 32 \
  --max-client-concurrency 2 \
  --output-dir benchmarks/results/load-balance-smoke \
  --force
```

smoke test 不能支持性能或质量结论。

### 12.2 Diagnostic load run

目的：内部调试。

```bash
python3 benchmarks/run_load_balancing_modelnet.py \
  --workload-source mtbench \
  --num-requests 40 \
  --request-rate 0.5 \
  --arrival-mode poisson \
  --max-client-concurrency 16 \
  --systems modelnet_auto,adaptive_sparse_graph,single_best,parallel_consensus \
  --output-dir benchmarks/results/load-balance-mtbench-diagnostic
```

该配置只用于诊断，不用于正式结论，因为样本量小且没有重复运行。

### 12.3 Formal load benchmark

正式 benchmark 应做 rate sweep 和重复运行。

推荐矩阵：

```text
workload_source: trace or large prompt pool
arrival: trace replay or poisson
rates: 0.25, 0.5, 1, 2, 4, 8 req/s
seeds: 3 or more
measured_requests_per_seed: 300 or more
warmup: max(30 requests, 10% of run)
systems: modelnet_auto, adaptive_sparse_graph, single_best, random_single, round_robin, least_outstanding_requests
SLO: fixed before experiment
```

每个 run 必须记录：

```text
seed
system_order
offered_rate
actual_offered_rate
warmup_policy
candidate_backend_pool
judge_model, if quality is measured
```

system 顺序必须按 seed 随机化，避免先跑系统给后跑系统预热 cache 或留下状态污染。

### 12.4 Formal quality benchmark

推荐：

```text
datasets:
  - MT-Bench
  - Arena-Hard-Auto or newer equivalent

judge:
  - pool-external judge
  - fixed version
  - temperature=0

metrics:
  - pairwise win rate
  - length-controlled win rate
  - answer length distribution
  - bootstrap CI
  - cost/request, after internal bill is available
```

pressure benchmark 中的小样本 judge 可保留为 sanity check，但不作为正式质量结果。

## 13. 当前脚本需要修改的方向

本文档是修正版设计说明，不代表当前脚本已经全部实现。后续代码应按以下顺序改：

1. gateway metadata 增加完整 `internal_calls` 和 `internal_usage`。
2. load-balancing 脚本改用 `e2e_ms` goodput SLO，失败计入违约。
3. load-balancing 脚本增加 rate sweep、multi-seed、warm-up discard、system order randomization。
4. fairness 指标拆成 coverage、conditional fairness、full-pool fairness 和 capacity-weighted load。
5. 增加 random、round-robin、least-outstanding-requests baseline。
6. 质量脚本支持池外 judge、答案长度统计和 length-controlled win rate。
7. streaming 可用时增加 TTFT、TPOT、ITL。

## 14. 结果解读原则

### 14.1 质量结论

只有满足以下条件时，才能报告正式质量结论：

- judge 池外。
- 答案长度已报告。
- 长度偏置已控制，或明确标注未控制。
- 样本量足够，并报告 bootstrap CI。
- 若比较多模型和单模型，必须同时报告成本或至少报告内部调用次数和 token 用量。

### 14.2 性能结论

正式性能结论必须基于：

- offered requests 分母。
- e2e goodput。
- rate sweep。
- 多 seed 重复。
- warm-up discard。
- p95/p99 置信区间。

单点 request-rate 的吞吐和小样本 p99 只能作为诊断。

### 14.3 负载均衡结论

正式负载均衡结论必须基于：

- coverage 和 conditional fairness 分开报告。
- 异构 backend 下使用 capacity-weighted load。
- 最终以 goodput、tail latency 和错误率判断策略是否更好。
- selection fairness 只能作为中间诊断。

## 15. 已知局限

当前实现仍有以下局限：

1. gateway 尚未暴露完整内部调用账单，因此 cost/request 和 token load 不能正式计算。
2. 当前 selected backend 统计只衡量 selection，不衡量真实 backend work。
3. 当前 `synthetic-output-tokens` 不能强制模型实际输出长度。
4. 当前 load-balancing benchmark 不做质量 judge。
5. MT-Bench prompt pool 小，重复采样可能触发 prefix cache。
6. trace replay 若无真实 prompt，只能验证 arrival dynamics，不能验证内容相关路由。
7. 当前 Python thread-based load generator 在高 request-rate 下可能成为瓶颈，必须同时查看 queue delay。
8. 未实现 streaming metrics 前，TTFT/TPOT 不可得。

这些不是普通 future work，而是正式结论的边界条件。报告中必须明确哪些结论受这些限制影响。

## 16. 最小复现流程

确认 gateway 可用：

```bash
curl -s http://127.0.0.1:3092/v1/models | python3 -m json.tool | head
```

dry-run：

```bash
python3 benchmarks/run_load_balancing_modelnet.py \
  --dry-run \
  --workload-source synthetic \
  --num-requests 5 \
  --request-rate 10 \
  --systems modelnet_auto,single_best \
  --output-dir benchmarks/results/load-balance-dryrun \
  --force
```

smoke test：

```bash
python3 benchmarks/run_load_balancing_modelnet.py \
  --workload-source synthetic \
  --num-requests 1 \
  --request-rate 10 \
  --systems modelnet_auto,single_best \
  --synthetic-input-tokens 32 \
  --synthetic-input-tokens-stddev 0 \
  --synthetic-output-tokens 32 \
  --synthetic-output-tokens-stddev 0 \
  --max-tokens 32 \
  --output-dir benchmarks/results/load-balance-smoke \
  --force
```

查看报告：

```bash
sed -n '1,200p' benchmarks/results/load-balance-smoke/report.md
```

如果 smoke 通过，再运行 diagnostic 或 formal workload。不要把 smoke 结果写成正式性能结论。
