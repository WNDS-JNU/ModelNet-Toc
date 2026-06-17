# ModelNet Gateway 技术方案领导汇报

**汇报对象：** 项目负责人、平台负责人、研发管理者
**汇报主题：** 模型服务统一入口、智能路由与多模型协作网关
**日期：** 2026-06-13
**状态：** 技术方案与当前实现说明

## 1. 一页摘要

ModelNet Gateway 的定位不是普通 HTTP 代理，而是模型服务的统一入口和调度层。它把上层应用、LiteLLM、OpenAI-compatible SDK、ModelNet Native 请求统一接入，再根据模型注册表、租户权限、模型能力、健康状态、K8s/Prometheus 负载和协作策略选择后端模型服务。

这套网关的直接价值是：减少上层系统对具体模型后端的耦合，把模型新增、替换、限权、降级、观测和多模型协作集中在统一平台层处理。对业务侧来说，调用方式更稳定；对平台侧来说，模型资源调度和治理能力更集中；对研发侧来说，后续新增模型、后端类型和协作策略都有明确扩展点。

## 2. 当前要解决的问题

| 问题 | 没有网关时的表现 | 网关方案的处理方式 |
|---|---|---|
| 模型入口分散 | 不同后端协议、鉴权、URL、流式格式不一致 | 对外提供 OpenAI-compatible 和 ModelNet Native 两类入口 |
| 模型治理困难 | 上层服务直接绑定模型，新增和下线成本高 | 通过注册表、能力描述和租户策略统一治理 |
| 资源状态不可见 | 请求可能打到不可用或高负载后端 | 结合健康检查、K8s 状态和 Prometheus 负载做路由 |
| 协作能力难复用 | 多模型投票、验证、自动组网容易散落在业务代码里 | 在 runner/aggregator 层沉淀通用协作机制 |
| 排障成本高 | 很难解释为什么选中或跳过某个模型 | 输出 trace、capability diagnostics 和 metrics |

## 3. 总体技术方案

线上链路可以概括为：LobeHub / SDK / 业务服务 -> LiteLLM。LiteLLM 对 `modelnet` / `modelnet-auto` 这类聚合或自动路由入口转发到 modelnet-router；对具体后端模型 ID 则按生成配置直接转发到 vLLM、llama.cpp、OpenAI-compatible、Ollama 等模型后端。

`modelnet-router` 位于 LiteLLM 的聚合/自动路由入口与真实模型后端之间。它对上承接标准聊天请求和 ModelNet Native 协作请求，对下屏蔽不同模型后端的协议差异。核心设计是先把请求转换为统一内部 IR，再进入鉴权、能力匹配、路由评分、后端适配和结果输出流程。

## 4. 核心能力分层

| 层级 | 主要职责 | 管理价值 |
|---|---|---|
| 接入层 | OpenAI-compatible、ModelNet Native、SSE 输出 | 兼容现有生态，减少业务侧改造 |
| 契约层 | 统一请求 IR、事件模型、能力描述 | 降低模块耦合，便于后续扩展 |
| 控制面 | 模型注册表、租户权限、K8s/Prometheus 状态 | 把模型资源治理集中到平台层 |
| 路由层 | 能力过滤、健康过滤、负载评分、故障 cooldown | 提升可用性和资源利用效率 |
| 执行层 | 单模型调用、多模型并行、自动组网、Claim Graph | 支持从普通调用升级到复杂协作 |
| 观测层 | trace、metrics、capability diagnostics | 便于解释、排障和管理复盘 |

## 5. 关键技术设计

第一，统一内部请求模型。不同入口的请求先被转换为 `ModelNetRunRequest`，后续执行层不直接依赖 OpenAI 或 Native 原始 payload。这使得协议适配和执行策略可以分开演进。

第二，能力驱动的模型选择。系统不会只按模型名转发，而是会综合租户权限、模型别名、required capabilities、健康状态、ready pod 数量、Prometheus 负载、in-flight 请求和失败 cooldown。

第三，runner/aggregator 插件化。`route.once` 支持普通单模型调用，`token.parallel` 和 `response.parallel` 支持多模型协作，`auto.network` 支持根据任务特征和资源状态自动选择拓扑，`auto.claim_graph` 支持对关键事实进行拆解和验证。

第四，后端协议适配集中化。后端适配层统一处理 vLLM、llama.cpp、OpenAI-compatible、Ollama 等后端的 body 转换、URL 选择、非流式调用、流式转发和失败状态判断。

## 6. 当前实现状态

| 模块 | 当前状态 | 说明 |
|---|---|---|
| OpenAI-compatible 入口 | 已实现 | 支持 `/v1/chat/completions`，适配 LobeHub、LiteLLM 和 OpenAI SDK 风格调用 |
| ModelNet Native 入口 | 已实现 | 支持 `/v1/runs/stream`，用于显式控制 runner、aggregator 和 trace |
| 模型注册表 | 已实现 | 通过 `MODELNET_REGISTRY_PATH` 加载，支持 alias、capabilities、backend type |
| 租户鉴权 | 已实现 | 支持 JSON、多 key、legacy key 和匿名模式 |
| 普通路由 | 已实现 | 支持能力过滤、健康过滤、负载评分、cooldown |
| 多模型协作 | 部分实现 | 已有并行 runner 和 aggregator，部分高级 runner 处于 reserved/degraded 状态 |
| 自动组网 | 已实现基础能力 | `modelnet-auto` 可进入 `auto.network`，复杂策略仍需结合线上效果迭代 |
| Claim Graph | 已有实现 | 支持 draft、claim 抽取、验证和保守组装，记忆能力依赖配置 |
| 可观测性 | 已实现基础能力 | 提供 metrics、trace、capability diagnostics，后续可补齐管理看板 |

## 7. 技术亮点

- 从“请求转发”升级为“模型服务调度”。它不是固定目标代理，而是根据能力、权限、健康和负载动态选择模型。
- 从“单模型调用”扩展到“多模型协作”。runner/aggregator 让投票、并行回答、自动组网和事实验证可以平台化复用。
- 从“业务侧维护模型细节”转为“平台侧统一治理”。业务侧保留稳定调用方式，平台侧集中处理新增模型、下线模型、限权、降级和观测。
- 从“黑盒失败”改善为“可解释排障”。当没有可用后端时，capability diagnostics 和 trace 可以说明是权限、能力、健康还是负载问题。

## 8. 风险与边界

| 风险/边界 | 影响 | 建议动作 |
|---|---|---|
| 注册表配置质量依赖较高 | alias、capabilities 或 backend type 配错会影响路由 | 建立配置校验和变更 review |
| 负载感知依赖外部数据 | K8s/Prometheus 数据缺失时，评分会退化 | 明确降级策略并补齐监控告警 |
| 高级协作策略仍需线上验证 | 多模型协作可能增加延迟和成本 | 先在高价值场景灰度，记录收益和成本 |
| 鉴权策略需要运维规范 | key 管理不规范会影响安全边界 | 生产环境统一使用显式租户 key 配置 |
| 观测还需要产品化 | trace 和 metrics 已有基础，但管理视图不足 | 后续建设 dashboard 和排障手册 |

## 9. 下一步建议

近期重点是把 ModelNet Gateway 从“可运行能力”推进到“可长期运营能力”。建议优先做四件事：第一，补齐注册表校验和变更流程；第二，把 `/v1/capabilities`、`/healthz`、`/metrics` 的检查沉淀为固定巡检；第三，选择 1-2 个明确业务场景灰度 `modelnet-auto` 和 Claim Graph；第四，形成面向研发、运维和管理三类角色的文档与看板。

资源层面，建议继续保留平台研发投入，并为 GPU/K8s/Prometheus 观测数据质量安排明确责任人。没有高质量运行数据，智能路由会退化为静态规则；有了稳定数据后，网关才能真正承担模型资源调度层的角色。

## 10. 领导关注点回答

| 关注点 | 回答 |
|---|---|
| 这个项目的核心价值是什么 | 统一模型入口，降低业务接入成本，提升模型资源治理和调度能力 |
| 是否只是代理 | 不是。代理只转发请求，ModelNet Gateway 还负责能力匹配、租户权限、健康/负载感知、多模型协作和 trace |
| 当前是否可用 | 基础调用、鉴权、路由、后端适配和观测能力已经具备；高级协作策略需要继续灰度验证 |
| 最大风险是什么 | 配置质量、观测数据质量和高级协作策略的线上收益验证 |
| 下一步最应该投入什么 | 配置治理、运行监控、灰度场景和管理看板 |

## 11. 建议会议结论

建议将 ModelNet Gateway 定位为模型平台的基础能力，而不是单个业务项目的附属代理。下一阶段目标不是盲目增加新功能，而是把配置治理、运行监控和灰度验证补齐，让网关从“能跑”走向“可运营、可解释、可扩展”。

建议本次汇报后明确三项动作：确认平台能力定位；指定观测数据与注册表质量责任人；选择 1-2 个业务场景验证自动组网和 Claim Graph 的实际收益。
