# ModelNet Claim-Graph 落地计划

本文档给出 `claim_graph_v1` 的工程落地计划。目标是在现有 ModelNet router 中引入基于 claim 级记忆和多模型交叉验证的动态组网方法，同时避免把未经验证的模型幻觉持久化。

目标仓库：

- 远端主机：`4A100`
- 仓库路径：`/home/duxianghe/ModelNet-toc`
- 当前主入口：`modelnet_router/app.py`
- 当前主方法：`adaptive_sparse_graph`，复杂请求默认走 `rank_fuse_v2`

## 1. 总目标

`claim_graph_v1` 的目标不是替换所有多模型协作，而是在复杂事实型、代码型、推理型任务中，把协作粒度从“整篇答案”降到“原子 claim”，并把已验证 claim 持久化复用。

成功标准：

- 同等质量下内部调用 token 成本下降，或同等成本下质量提升。
- 相同项目/用户域内的 second-time cost 随记忆积累下降。
- 已验证 claim 的抽审精确率保持在 0.95 以上。
- 植入错误测试中，高风险/load-bearing 错误 claim 的前沿召回率达到 0.85 以上。
- `claim_graph` 出错时可退回 `rank_fuse_v2` 或 `route.once`，不影响现有 API。

非目标：

- v1 不做外部向量数据库部署。
- v1 不把纯模型共识直接作为强 verified 事实。
- v1 不立刻替换 `rank_fuse_v2` 的默认路径。
- v1 不试图优化创作类、审美类、闲聊类任务。

## 2. 关键设计取舍

### 2.1 先灰度，不直接替换

初始上线方式：

- 显式配置 `runner_config.strategy = claim_graph` 时才启用。
- `adaptive_sparse_graph` 默认仍走 `rank_fuse_v2`。
- 稳定后再增加灰度开关，让复杂事实型任务进入 `auto.claim_graph`。

原因：

- 当前 `rank_fuse_v2` 已经有完整路径和测试。
- `claim_graph` 最大风险在 claim 拆解、对齐、记忆污染，不能一次性替换默认流量。

### 2.2 证据分级，而不是单一 verified

claim 的可信度必须区分证据来源。

建议证据等级：

| 等级 | 含义 | 默认注入权重 |
| --- | --- | --- |
| `user_confirmed` | 用户明确确认或纠错 | 高 |
| `executable_checked` | 测试、命令、配置探测等可执行检查通过 | 高 |
| `source_grounded` | 来自明确文件、日志、接口返回、文档片段 | 高 |
| `model_consensus_verified` | 跨家族盲复核一致 | 中低 |
| `quarantine` | 单源或未验证 claim | 不注入 |
| `contested` | 存在反驳边 | 不作为事实注入，只作为升级信号 |
| `superseded` | 被更新事实替代 | 不注入，仅审计 |

默认规则：

- 只有前三类强证据可以作为高可信事实注入。
- 纯模型共识最多进入 `model_consensus_verified`，不能与用户确认或执行检查等价。
- 项目本地事实、端口、部署状态、实验结果必须优先走执行检查或来源证据。

### 2.3 blind 判定必须依赖注入溯源

后续模型看到已注入 claim 后再表示同意，不能算独立票。

必须记录：

- 本次请求注入了哪些 claim。
- 每个内部调用的 source、stage、backend、family。
- 每条投票是否在未见过该 claim 的上下文中产生。

核心字段：

- `auto_plan.injected_claims`
- `auto_plan.claim_frontier`
- `auto_plan.votes`
- `auto_plan.assembly_actions`
- `metadata.call_ledger`

缺少注入溯源时，不允许 claim 自动晋升。

## 3. 分阶段路线

## P0: 可观测性与评测基座

目标：先让系统能准确回答“多模型方法花了多少钱、慢在哪里、错在哪条 claim”。

时间量级：1 到 2 天。

主要工作：

- 给所有 runner 标准化内部调用账单 `call_ledger`。
- 扩展 router trace，记录内部调用 token、latency、stage、status。
- 建立植入错误测试集，作为 `claim_graph` 生死门槛。
- 修改 benchmark 读取完整内部 token 账单，而不是只看最终答案 usage。

涉及模块：

- `modelnet_router/app.py`
- `benchmarks/run_mtbench_modelnet.py`
- `benchmarks/run_load_balancing_modelnet.py`
- `benchmarks/run_pressure_modelnet.py`
- `modelnet_router/test_adaptive_auto.py`

新增 metadata：

| 字段 | 含义 |
| --- | --- |
| `call_ledger` | 每个内部调用的完整账单 |
| `internal_call_count` | 内部调用次数 |
| `internal_total_tokens` | 内部调用总 token |
| `stage_latencies_ms` | 各 stage 延迟 |
| `call_ledger_summary` | trace 中的压缩摘要 |

`call_ledger` 单条记录：

| 字段 | 含义 |
| --- | --- |
| `stage` | `route.once` / `candidate.answer` / `ranker.select` / `claim.verify` 等 |
| `source_id` | 内部 source id |
| `backend_id` | 实际 backend |
| `family` | 模型家族 |
| `status` | `ok` / `error` / `timeout` |
| `latency_ms` | 调用延迟 |
| `prompt_tokens` | prompt tokens |
| `completion_tokens` | completion tokens |
| `total_tokens` | 总 tokens |
| `error` | 错误摘要 |

验收标准：

- `route.once`、`rank_fuse`、`cascade_verify`、`response.parallel` 都输出 `call_ledger`。
- benchmark 可以按完整内部 token 计算 cost-normalized 曲线。
- 植入错误测试集至少覆盖四类错误：数值错误、实体替换、结论反转、历史上下文错误。
- 现有 `python -m unittest modelnet_router/test_adaptive_auto.py` 通过。

失败处理：

- 如果 usage 缺失，则用已有 `estimate_token_count` 估算，并标记 `usage_source = estimated`。
- 不因单个内部调用缺 usage 影响主请求返回。

## P1: 只读 Claim Memory

目标：先引入可控、低风险的 claim 记忆注入，不做自动模型晋升。

时间量级：约 1 周。

主要工作：

- 新增 claim memory 存储模块。
- 建立 SQLite schema。
- 只允许强证据写入 verified。
- 在 planner 阶段检索 verified/contested claims。
- 在主答 prompt 中注入 verified claims。
- contested claims 只作为升级信号，不混入事实块。

新增模块：

- `modelnet_router/modelnet_gateway/claim_memory.py`

建议表：

| 表 | 作用 |
| --- | --- |
| `claims` | claim 主表 |
| `claim_votes` | 支持/反驳边 |
| `claim_events` | 用户确认、执行检查、状态变化审计 |
| `claim_spans` | claim 与答案片段的映射 |

claim 主字段：

| 字段 | 含义 |
| --- | --- |
| `claim_id` | 稳定 ID |
| `scope` | `tenant:*` / `user:*` / `project:*` |
| `text` | 原子断言 |
| `kind` | `fact` / `preference` / `decision` / `procedure` |
| `status` | `verified` / `quarantine` / `contested` / `superseded` |
| `evidence_level` | 证据等级 |
| `entities` | 归一化实体 |
| `valid_from` | 生效时间 |
| `valid_to` | 失效时间 |
| `last_verified` | 最近验证时间 |
| `usage_count` | 注入使用次数 |

默认存储：

- v1 使用 SQLite。
- 默认路径：`/tmp/modelnet_claims.sqlite3`。
- 通过 `MODELNET_CLAIM_DB_PATH` 覆盖。
- 生产灰度时应挂载到宿主机持久目录。

检索策略：

- v1 不引入 qdrant/pgvector。
- 使用实体命中、BM25/关键词、简单文本相似组合。
- 检索超时 50 ms，超时 fail-open。
- 只有项目实体、历史指代、用户/项目 scope 命中时才检索；纯通用问题跳过。

验收标准：

- 可手动写入 user confirmed claim。
- 请求命中 verified claim 时，`auto_plan.injected_claims` 可见。
- 注入 claim 不破坏现有 `route.once` 和 `rank_fuse`。
- contested claim 不进入事实注入块。

失败处理：

- claim DB 不可用时，系统退回无记忆路径。
- 检索超时时，记录 trace，但不阻塞请求。

## P2: `claim_graph` Runner 灰度上线

目标：实现在线 claim_graph 执行流，但默认只通过显式 strategy 启用。

时间量级：1 到 2 周。

新增模块：

- `modelnet_router/modelnet_gateway/claim_graph.py`

新增 runner：

- planner 内部 runner：`claim_graph`
- metadata runner：`auto.claim_graph`
- plan version：`claim_graph_v1`
- strategy：`claim_graph`

执行流程：

1. Phase 0: 记忆覆盖评估
   - 检索 verified/contested claims。
   - 估计 coverage。
   - 若高覆盖、无争议、低复杂度，则走捷径 1：`route.once + verified 注入`。

2. Phase 1: 主答起草
   - 选择 proposer。
   - 注入 preference block 和 verified claim block。
   - 当前用户消息优先级高于历史 claim。

3. Phase 2: claim 抽取与前沿标记
   - 从 draft 抽取原子 claim。
   - 对齐已有 claim。
   - 生成核查子问题。
   - 标记 `supported`、`novel`、`contested`。
   - 若 frontier 为空，走捷径 2：直接返回 draft，并异步写回 quarantine。

4. Phase 3: 定向核查
   - 对 frontier 中 top K claim 并行短调用。
   - 优先可执行检查，其次盲复核。
   - verifier 排除 proposer 家族。
   - 单次核查默认最多 160 tokens。

5. Phase 4: span 级组装
   - 通过的 span 保留原文。
   - 失败的 span 局部替换。
   - 争议的 span 明示分歧，或在预算内加一票仲裁。
   - 不做整篇 synthesis 重写。

6. Phase 5: 异步写回
   - 写入 claims、votes、injected source。
   - 模型投票结果默认进入 quarantine 或 contested。
   - 不在 P2 自动升级为强 verified。

新增配置：

| 环境变量 | 默认 | 含义 |
| --- | ---: | --- |
| `MODELNET_CLAIM_ENABLED` | `false` | 是否启用 claim memory |
| `MODELNET_CLAIM_FRONTIER_K` | `3` | 每请求最多核查 claim 数 |
| `MODELNET_CLAIM_VERIFY_MAX_TOKENS` | `160` | 单次核查输出上限 |
| `MODELNET_CLAIM_COVERAGE_SHORTCUT` | `0.8` | 高覆盖捷径阈值 |
| `MODELNET_CLAIM_MEMORY_TIMEOUT_MS` | `50` | 记忆检索超时 |
| `MODELNET_CLAIM_REVERIFY_DAYS` | `30` | verified 复检周期 |
| `MODELNET_CLAIM_MIN_FAMILIES` | `2` | 晋升所需独立家族数 |

新增 `auto_plan` 字段：

| 字段 | 含义 |
| --- | --- |
| `coverage` | Phase 0 覆盖率估计 |
| `shortcut` | `none` / `high_coverage` / `empty_frontier` |
| `claim_frontier` | 前沿 claim 列表 |
| `votes` | 每条 claim 的核查结果 |
| `injected_claims` | 本次注入的 claim |
| `assembly_actions` | 保留、替换、争议说明等动作 |

验收标准：

- 显式 `strategy=claim_graph` 能跑通。
- 高负载或预算不足时能降级到 `route.once`。
- `claim_graph` runner error 时能走现有 fallback repair。
- `auto_plan` 中能看到 frontier、votes、injected_claims、call_ledger。

失败处理：

- claim 抽取失败：返回 draft，记录 `shortcut = extraction_failed`。
- verifier 失败：未决 claim 不修改答案，高风险 claim 加 hedge。
- assembler 失败：返回 draft，记录 assembly error。

## P3: 自动晋升与默认切换

目标：在 P0 到 P2 的评测达标后，启用完整记忆飞轮。

时间量级：持续迭代。

主要工作：

- 启用后台补票。
- 启用复检。
- 启用争议仲裁。
- 增加池外 judge 抽审。
- 对复杂事实型任务灰度切换默认 runner。

晋升规则：

- 用户确认或纠错：直接进入 `user_confirmed`。
- 执行检查通过：进入 `executable_checked`。
- 明确来源证据：进入 `source_grounded`。
- 两个以上独立家族盲支持且无反驳：进入 `model_consensus_verified`。
- 任一有效反驳：进入 `contested`。
- 新 verified claim 与旧 claim 冲突且时间更新：旧 claim 进入 `superseded`。

自动晋升前置条件：

- `blind = true`。
- family 去重。
- 原 claim 未注入该 verifier 上下文。
- 支持票和反驳票均有 trace。
- 本地项目事实必须优先寻找执行或来源证据。

默认切换门槛：

- verified 抽审精确率大于等于 0.95。
- verified 精确率低于 0.9 时禁止默认启用。
- 高风险植入错误前沿召回大于等于 0.85。
- 捷径 1 占比在同域重复请求中上升。
- second-time cost 下降。
- `claim_graph` 的质量-成本 Pareto 不劣于 `rank_fuse_v2`。

## 4. Prompt 与行为约束

### 4.1 Extractor

要求：

- 只抽取事实性、可判真伪的 claim。
- 每条 claim 单一谓词。
- 消解指代。
- 跳过观点、审美、计划性表述。
- 同时输出核查子问题。
- 输出必须是 JSON。

注意：

- 不从落选候选中产生新 claim。
- 落选候选只能对已有 claim 投票。

### 4.2 Verifier

要求：

- 不看原 claim 文本。
- 只回答由 claim 反推的子问题。
- 如有材料，提供来源材料；如无材料，明确是模型知识判断。
- 输出 JSON。

注意：

- 对本地项目事实，不能只靠模型常识。
- 没有证据时不得产生强 verified。

### 4.3 Assembler

要求：

- 它是装配器，不是重写器。
- 已通过核查的 span 保留原文。
- 被反驳的 span 只局部替换。
- 争议处明示分歧。
- 不允许整篇改写导致正确细节丢失。

## 5. Benchmark 与验收

### 5.1 单元测试

必须新增或扩展测试：

- `strategy=claim_graph` planner 选择正确。
- high load 下 `claim_graph` 降级。
- `call_ledger` 对所有 runner 存在。
- `blind` 判定排除已注入 claim。
- contested claim 不进入事实注入块。
- extractor JSON 解析失败时安全返回。
- assembler 只替换失败 span。

### 5.2 植入错误测试

测试集：

- 数值错误。
- 实体替换。
- 结论反转。
- 历史上下文错误。
- 部署/端口/配置类本地事实错误。

指标：

| 指标 | 门槛 |
| --- | ---: |
| 全量错误前沿召回 | >= 0.70 |
| 高风险错误前沿召回 | >= 0.85 |
| 核查判对率 | 持续上升并记录 |
| 端到端修复率 | 持续上升并记录 |

### 5.3 系统对比

对比系统：

- `claim_graph`
- `adaptive_sparse_graph` / `rank_fuse_v2`
- `single_best`
- `parallel_consensus`
- `fixed_qwen35b`

必须隔离：

- 每个 system 使用独立 claim namespace。
- 每个 run 之间重置 memory。
- judge 不得来自被测 backend pool。

报告指标：

- 质量-成本 Pareto。
- 完整内部 token 成本。
- e2e latency。
- goodput。
- SLO violation。
- second-time cost。
- verified 精确率。
- 幻觉持久率。
- 捷径 1 占比曲线。
- 跨 backend 事实一致性。

## 6. Rollout

### 6.1 开发环境

- 默认 `MODELNET_CLAIM_ENABLED=false`。
- 手动设置 `strategy=claim_graph` 做 smoke test。
- SQLite 路径可放 `/tmp`。

### 6.2 灰度环境

- 开启 claim memory。
- 只启用强证据 verified 注入。
- 模型共识只进入 quarantine。
- 记录所有 votes，但不自动影响默认答案。

### 6.3 生产切换

- 先对项目事实型和代码验证型请求灰度。
- 再对一般复杂事实型请求灰度。
- 创作、闲聊、审美任务继续回退 `route.once` 或现有策略。

### 6.4 回滚

任一条件触发回滚：

- verified 精确率低于 0.9。
- 植入错误高风险召回低于 0.85。
- `claim_graph` SLO violation 明显高于 `rank_fuse_v2`。
- contested 积压无法在预算内消化。
- 用户纠错集中指向同一类 injected claim。

回滚方式：

- 关闭 `MODELNET_CLAIM_ENABLED`。
- 将 `strategy=claim_graph` 灰度开关置零。
- 保留 claim DB，不删除，用于审计和离线修复。

## 7. 推荐执行顺序

1. 先实现 P0 `call_ledger` 和植入错误测试。
2. 再实现 P1 只读 claim memory。
3. 然后实现 P2 显式 `claim_graph` runner。
4. 运行 smoke benchmark 和植入错误测试。
5. 达标后启用 P3 后台晋升。
6. 最后再考虑替换 `adaptive_sparse_graph` 的复杂事实型默认路径。

## 8. 当前默认假设

- 代码改动集中在 `modelnet_router/app.py` 和 `modelnet_router/modelnet_gateway/`。
- v1 不新增外部服务依赖。
- SQLite 足够支撑开发、灰度和离线实验。
- 用户/项目本地事实优先依赖用户确认、执行检查和来源证据。
- 模型家族盲投票是弱证据，不是强事实来源。
- 所有 claim 注入必须可审计、可回滚、可禁用。
