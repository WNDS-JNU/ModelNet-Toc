# ModelNet Orchestrator 与 Agent Group 多助理协作总体实施计划

> 状态：待评审
> 版本：V1.1
> 日期：2026-07-21
> 适用范围：ModelNet App 桌面端、现有 modelnet Provider、现有 modelnet-router、Device Gateway、Agent Group /group/:gid
> 实施原则：开发与真实请求只在 modelnet-toc-dev 验证；生产环境在独立推广审批前保持不变。

## 一、结论

本计划同时改造模型编排和助理协作，但二者必须分层。

1. 保留且只保留 providerId=modelnet，不新增 modelnet-local Provider；精确模型 ID modelnet 作为旧别名彻底删除，不保留运行时识别、映射、410 特判或回滚开关。
2. modelnet Provider 按模型 ID 在 ModelNet App 服务端动态分流：
   - modelnet-auto、modelnet-parallel、modelnet-serial 进入 ModelNet Orchestrator。
   - Registry 中的具体模型由 ModelNet App 直接调用对应 K8S 推理后端，不经过 Orchestrator。
3. 现有 modelnet-router 演进为 ModelNet Orchestrator。它只向客户端公开模型编排能力，不再提供具体 K8S 模型的单模型代理。
4. ModelNet Orchestrator 可以编排 ModelNet App 中任何已启用、当前用户有权限访问的聊天 Provider，不限于 K8S 模型。
5. OpenRouter 只是 ModelNet App 已有的普通 Provider，与 OpenAI、Anthropic 等处于同一层，不是网关名称，也不是新增架构组件。
6. LiteLLM 已退役，不进入目标架构；清理残留服务、端口、变量、脚本和文档。
7. Agent Group 的调度单位只能是完整助理。普通助理、Claude Code 助理、Codex 助理都通过 agentId 被调度。
8. ModelOrchestrationRun 不能成为 AgentTask 节点。只有当某个完整助理自身选择 modelnet 虚拟编排模型时，它才作为该助理内部的子运行和子轨迹出现。
9. Model Plane 与 Agent Plane 放在同一个 ModelNet Orchestrator 部署单元中，但代码模块、状态、数据和故障边界必须隔离。
10. Agent Plane 使用新增的独立 PostgreSQL 逻辑数据库；不把长期任务状态塞进上游 App 的 JSONB。
11. 对上游项目采用“小接口、下游实现、默认关闭”的绞杀式改造，最大限度降低后续同步上游代码的冲突。
12. 首版协作模式只允许用户显式选择 single、broadcast、parallel_tasks、pipeline 或 debate，不实现 agent.auto。
13. A2A 1.0 作为外部完整 Agent 的标准通信边界加入计划；它不替代 Agent Plane 调度、Device Gateway、Task MCP 或本地事实源。
14. 外部 A2A Agent 必须先登记为具有稳定本地 agentId 的完整助理，不能以 Agent Card URL 或 A2A Task 直接进入群组拓扑。

## 二、成功标准

完成后必须同时满足以下结果：

- 现有 provider=modelnet 且使用具体 Registry 模型的助理继续可用，无需批量迁移数据。
- 精确模型 ID modelnet 从 Model Bank、API 输出、Router、配置生成、数据库活动配置、测试和文档中消失；传入该 ID 只得到普通 invalid_model，不触发任何兼容逻辑。
- 具体 ModelNet 模型的普通单聊不访问 Orchestrator。
- 三个 ModelNet 虚拟模型只访问 Orchestrator。
- 并联和串联实际节点数等于用户为本次运行启动并在发送时仍有效的模型数，不设置静态最小值或最大值；空集合才阻止发送。
- 模型编排可以显式混用 OpenAI、Anthropic、OpenRouter、自定义 Provider 和 ModelNet 具体模型。
- 未显式配置候选池时，只使用本地 ModelNet 具体模型，避免静默调用付费外部 Provider。
- Agent Group 可以让拥有不同提示词、模型、Provider 和工具的助理协同完成任务。
- Claude Code 和 Codex 可以作为完整助理参与分工、流水线、辩论和审查。
- 受信任的外部 A2A Agent 可以作为完整助理参与显式协作模式，群组配置仍只引用本地 agentId。
- 首版不会根据 Agent Card、skills 或运行时判断自动选择协作模式或成员。
- 普通助理原有工具能力得到保留，群组策略只能收窄权限，不能扩大权限。
- 每个群组运行可暂停、取消、恢复、重试和审计；桌面端重启后状态不丢失。
- 功能关闭时，未启用新执行器的旧群组和普通聊天行为保持不变。
- 模型调用密钥、Base URL 和 K8S endpoint 不进入浏览器、编排请求、事件或 Orchestrator 数据库。

## 三、统一术语与层级

### 3.1 核心对象

- Provider Runtime：ModelNet App 已有的模型提供商执行实现，例如 OpenAI、Anthropic、OpenRouter、ModelNet。
- 具体模型：可直接完成一次聊天请求的模型，例如 Registry 中的 inference-*、llama-cpp-*，或外部 Provider 的具体模型。
- 虚拟编排模型：代表编排算法入口的模型 ID，仅包括 modelnet-auto、modelnet-parallel、modelnet-serial。
- ModelOrchestrationRun：一次模型级串联、并联或自动组网运行。
- AssistantExecution：一次完整助理执行，包含该助理的系统提示词、Provider、模型、知识库、工具和权限策略。
- AgentGroupRun：一次群组协作运行。
- AgentTask：AgentGroupRun 内交给一个完整助理的任务。
- Device Gateway：桌面端与本机 Claude Code CLI、Codex CLI 等执行环境之间的受控进程通道。
- Task MCP：CLI 助理读取任务上下文、回传进度与产物、请求审批的协议面，不负责启动或管理 CLI 进程。
- A2A Remote Assistant：经受控 Agent Card 登记并获得本地 agentId 的外部完整 Agent；A2A 只承载跨系统 Message、Task、Artifact、状态和取消。

### 3.2 唯一合法的运行层级

~~~text
AgentGroupRun
├── AgentTask(agentId)
│   └── AssistantExecution
│       ├── Runtime：App 普通助理及其工具
│       ├── Runtime：Device Gateway → Claude Code/Codex
│       ├── Runtime：A2A Adapter → 外部完整助理
│       └── 可选嵌套：ModelOrchestrationRun
└── AgentTask(agentId)
    └── AssistantExecution
~~~

可选的内部 ModelOrchestrationRun 只表示该助理自己的模型配置使用了 ModelNet 虚拟模型。它不是群组成员，不接受群组任务依赖，也不能被 Agent Plane 直接调度。

三个 Runtime 分支按助理绑定三选一；可选 ModelOrchestrationRun 只允许嵌套在自身配置使用 ModelNet 虚拟模型的 App 普通助理执行中。

### 3.3 明确禁止的层级

- AgentTask 直接指向裸模型。
- AgentTask 直接指向 ModelOrchestrationRun。
- AgentTask 以 claude_code、codex 或 model_network 作为任务种类。
- Agent Group 直接保存模型候选池、模型 runner 或模型拓扑。
- AgentTask 直接保存 Agent Card URL、A2A endpoint、A2A taskId 或 A2A runtime 类型。
- 用裸模型临时充当 planner、reviewer、judge 或 synthesizer。
- 群组成员之间绕过 Agent Plane 任意建立点对点 A2A 连接。
- 从 ModelOrchestrationRun 反向创建 AgentTask。

Claude Code 和 Codex 的异构性属于助理 Runtime 配置。Agent Plane 始终只看到 agentId、助理版本引用和任务契约。

## 四、现状与需要纠正的问题

### 4.1 当前可复用能力

ModelNet App 已经具备：

- 统一 Provider Runtime 初始化和服务端密钥解密。
- /webapi/chat/{provider} 聊天执行入口。
- 普通助理的提示词、模型、工具与插件配置。
- Agent Group 页面和现有 Group Runtime 基础能力。
- 普通 Agent 工具循环。
- Claude Code、Codex 等异构助理配置与 Device Gateway 基础。
- ModelNet Provider 和 ModelNet 模型列表。

modelnet-router 已经具备：

- auto.network、response.parallel、response.serial、auto.role_graph 等 runner。
- 模型运行事件、内部 usage、tokens、调用账本和阶段耗时。
- Capability Registry 与本地 K8S 模型可用性信息。

### 4.2 当前架构问题

- modelnet Provider 固定把请求送往 Router，具体模型单聊和编排请求没有清晰分流。
- Router 的北向接口同时承担编排和具体模型代理，职责混杂。
- Router 的候选模型来源偏向 K8S，尚不能安全调用 App 中所有 Provider Runtime。
- UI 和请求层存在内部候选字段、运行时地址和 Provider 概念混杂的风险。
- 当前群组能力偏向共享会话发言，没有成为持久、可恢复的多助理任务执行器。
- broadcast 观点模式默认禁用工具，但这不能代表所有群组模式都应禁用工具。
- 项目自有 LiteLLM 运行服务、端口、变量和生成脚本已于 2026-08-24 清理；历史材料与上游通用 Provider 兼容代码不属于运行依赖。
- 直接在上游 App 内堆叠 ModelNet 业务逻辑会扩大未来同步上游的冲突面。

## 五、目标总体架构

~~~text
ModelNet Desktop / Web
├── 普通聊天 UI
├── Agent Group UI
└── ModelNet App Server
    ├── 现有 Provider Runtime
    │   ├── OpenAI
    │   ├── Anthropic
    │   ├── OpenRouter
    │   ├── 自定义 Provider
    │   └── modelnet 动态 Runtime
    │       ├── 虚拟模型 ───────────────┐
    │       └── 具体 Registry 模型 ──→ K8S Backend
    ├── /webapi/chat/{provider}
    ├── 助理执行 Adapter
    │   └── 异构助理 Runtime → Device Gateway → Claude Code/Codex CLI
    ├── 外部 Agent 注册与信任策略 BFF
    └── Agent Group BFF
                                      │
                                      ▼
                         ModelNet Orchestrator
                         ├── Model Plane
                         │   ├── auto.network
                         │   ├── response.parallel
                         │   ├── response.serial
                         │   └── Provider Invocation Port
                         │       └── 回调 App 现有 Provider Runtime
                         └── Agent Plane
                             ├── Run/Task 状态机
                             ├── 协作协议
                             ├── 审批/租约/恢复
                             ├── Assistant Binding Resolver
                             ├── App Assistant Execution Port
                             └── A2A Execution Adapter → Remote A2A Agent
~~~


内部普通助理和 Claude/Codex 仍通过 App Assistant Execution Port 执行；只有已登记为本地完整助理的外部 Agent 由 A2A Execution Adapter 调用。所有成员通信继续经过 Agent Plane，不开放成员之间任意点对点直连。
部署上暂时保留 modelnet-router:8000 的容器名和内部 DNS，降低切换风险；代码和产品名称逐步迁移到 ModelNet Orchestrator。不得因此继续保留 Router 的具体模型代理职责。

## 六、现有 modelnet Provider 的重构

### 6.1 单 Provider、双执行路径

保留 providerId=modelnet。服务端根据模型 ID 判定路径：

| 模型类型 | 示例 | 执行目标 |
|---|---|---|
| 虚拟编排模型 | modelnet-auto | Orchestrator Model Plane |
| 虚拟编排模型 | modelnet-parallel | Orchestrator Model Plane |
| 虚拟编排模型 | modelnet-serial | Orchestrator Model Plane |
| 具体 Registry 模型 | inference-*、llama-cpp-* | App 服务端直连 K8S |

前端不得自行判断 endpoint，也不得接收 K8S 地址。动态分流必须发生在 App 服务端 Runtime。

### 6.2 Registry 解析

ModelNet App 以只读方式加载与 Orchestrator 同源的 Capability Registry，并生成服务端 ModelNet 模型解析结果：

- modelId。
- chat 能力。
- functionCall、vision、structuredOutput 等模型能力。
- 可用状态。
- context window。
- 服务端 endpoint。
- 服务端鉴权引用。
- 可选的本地性能标签。

浏览器只得到经过净化的模型卡片，不得到 endpoint、内部主机名、密钥或挂载路径。

具体模型的普通聊天按 Registry 能力保留 tools 和多模态字段，不得因为 providerId=modelnet 就统一删除。只有虚拟编排模型以及 Model Plane 的内部候选调用强制无 tools。

Registry 不可用时：

- 具体模型请求返回 modelnet_registry_unavailable。
- 禁止静默退回 Orchestrator。
- 虚拟编排模型仍可独立检查 Orchestrator 健康状态并给出明确错误。

### 6.3 兼容与离线迁移策略

- 现有 providerId=modelnet 加具体 Registry modelId 的助理数据保持不变。
- 精确 modelId=modelnet 的历史记录必须在切流前离线审计，并由用户或管理员显式迁移到 modelnet-auto、modelnet-parallel、modelnet-serial 或一个具体模型；无法确认语义的记录保持阻塞，不做猜测。
- 请求时不得识别、重定向或特殊响应精确 modelId=modelnet；它与任意未知模型一样返回普通 invalid_model。
- 对历史 provider=openai 加 modelnet-* 的误配置先做审计、告警和离线迁移，再移除 OPENAI_PROXY_URL 指向 Router 的兼容覆盖。
- modelnet Provider 模型列表只显示三个虚拟模型和具体模型；不得保留精确模型 ID modelnet。
- 具体模型标记为“本地直连”；虚拟模型标记为“ModelNet 编排”。
- 回滚只允许恢复执行路径，不允许恢复 modelnet 模型别名。

## 七、Provider 无关的 Model Plane

### 7.1 候选引用

新的编排契约只传结构化引用：

~~~ts
interface ModelCandidateRef {
  providerId: string;
  modelId: string;
  capabilities?: string[];
  contextWindow?: number;
}
~~~

不得包含：

- API Key。
- Base URL。
- K8S endpoint。
- Provider 数据库配置。
- 可被 Orchestrator 长期复用的用户凭据。

### 7.2 候选来源和规则

- 候选来自 ModelNet App 当前已启用的 Provider 与模型。
- App 服务端按用户、工作区和 Provider 权限校验，并为每次 ModelOrchestrationRun 生成不可变候选快照。
- 不新增独立 Candidate Catalog 服务；候选快照直接复用现有 Provider 配置和模型列表。
- 未显式选候选时，默认池只包含当前可用的 ModelNet 具体模型。
- 外部 Provider 只有被用户显式加入时才可调用。
- provider=modelnet 的具体模型可以作为内部候选。
- modelnet-auto、modelnet-parallel、modelnet-serial 不得成为内部候选，防止递归。
- OpenRouter 的自动路由模型若被显式选择，只视为一个不透明候选，不展开其内部模型。
- 历史 user-provider:* 和本地裸 modelId 只做兼容读取；新保存格式统一为 providerId 加 modelId。

模型算法的节点数由用户本次实际启动的模型决定：

- 定义 N 为用户为本次运行显式启动或选择、完成去重且在发送时仍有效的逻辑模型节点数。
- 同一 providerId/modelId 的多个推理副本仍算一个逻辑模型节点；副本数属于容量和负载均衡，不得冒充多个协作节点。
- modelnet-parallel 恰好调用这 N 个逻辑节点，不静默截断、补齐、替换或扩大集合。
- modelnet-serial 按用户确认的顺序使用这 N 个逻辑节点，并校验为单一线性链，边数严格等于 N-1。
- N 就是用户实际启动的有效逻辑模型数，不设置静态最小值或最大值；N=0 阻止发送，N=1 也按所选模式执行。
- serial 在 N=1 时是一个节点、零条边的合法单节点线性链。
- 实际可运行规模由该 Run 的并发、内部调用、token、费用、时间预算、用户配额和当前资源容量共同约束；超出时明确拒绝或要求调整预算，不能偷偷裁剪模型。
- modelnet-auto 未显式选模型时使用默认本地可访问模型；显式选择后使用用户启动的完整集合，不静默扩大范围。具体 strategy 的最低能力要求由算法元数据声明。
- Auto strategy 支持 adaptive_sparse_graph、role_graph 和 single_best。
- strategy 值 role_graph 对应事件与实际 runner 标识 auto.role_graph，不新增第二套 runner 别名。
- 新配置默认可选择 adaptive_sparse_graph；历史配置没有 strategy 时继续省略该字段，保持现有 Router 默认行为。
- 这些算法配置属于助理自己的 modelnet 模型参数或普通聊天请求，不能写入 Agent Group 拓扑。

### 7.3 复用现有 Provider Runtime

Orchestrator 不保存各 Provider SDK、Key 或 Base URL。模型节点固定通过 App 现有入口执行：

~~~text
ModelNet Orchestrator
→ /webapi/chat/{providerId}
→ 服务委派鉴权
→ initModelRuntimeFromDB
→ 现有 Provider Runtime
→ Provider
~~~

这条路径只增加服务委派能力，不新增 Provider Execution Facade、OpenRouter 专用 Adapter 或另一套 Provider 配置中心。

### 7.4 服务委派令牌

App 为单次 ModelOrchestrationRun 签发短期令牌，至少绑定：

- userId 和 workspaceId。
- runId。
- 允许调用的 providerId/modelId 集合。
- scope=modelnet:model:invoke。
- 有效期。
- 最大调用次数。
- 可选 token 预算。
- recursionDepth。
- 幂等键或调用序号。

执行规则：

- 委派请求必须走现有 Provider 权限校验。
- 只能调用令牌白名单中的候选。
- 内部模型调用强制不携带 tools。
- 支持流式返回、usage 汇总、超时和取消传播。
- 令牌只用于该运行，不写入事件、日志正文或数据库。
- 委派请求不得再次选择任何 ModelNet 虚拟模型。

### 7.5 Model Plane 北向接口

目标原生接口：

- POST /orchestration/v1/model-runs
- GET /orchestration/v1/model-runs/{runId}/events
- POST /orchestration/v1/model-runs/{runId}/cancel
- GET /orchestration/v1/algorithms
- POST /orchestration/v1/plans/validate

迁移期保留以下兼容外观：

- /v1/chat/completions。
- /v1/responses。
- /v1/runs/stream。
- /v1/models。

迁移完成后：

- /v1/models 只返回虚拟编排模型。
- 顶层传入具体模型返回 422 direct_model_not_supported。
- route.once 只允许作为算法内部降级，不再是公开具体模型代理。
- auto.network 不自动生成显式 response.serial。
- auto.role_graph 继续承担“并行专家到串行合成”的已有混合路径。
- 暂不实现通用 hybrid.graph。

### 7.6 Model Plane 的隔离要求

- Model Plane 的算法领域对象不得依赖 K8S modelId 格式。
- K8S 与 Prometheus 数据仅通过只读遥测 Adapter 参与本地模型评分。
- Agent Plane 数据库故障不得影响 Model Plane 请求。
- Agent Group 功能关闭或故障不得改变普通 modelnet 编排行为。
- 原有 internal_total_tokens、internal_usage、call_ledger_summary 和阶段耗时继续保留。

## 八、Agent Group 的产品定义

### 8.1 群组成员

每个群组成员引用一个已保存的完整助理。助理可以是：

- 普通聊天助理。
- 带工具的研究、代码、搜索或数据助理。
- Claude Code 助理。
- Codex 助理。
- 经受控 Agent Card 登记并分配本地 agentId 的外部 A2A 完整助理。

群组配置不复制助理密钥和工具凭据，只保存 agentId、角色、版本策略与协作约束。运行开始时由 App 解析不可变的助理执行版本引用；Orchestrator 只保存引用和摘要哈希。

### 8.2 智能角色也必须是助理

以下角色如需要模型判断，必须绑定 agentId：

- Supervisor。
- Planner。
- Reviewer。
- Judge。
- Synthesizer。

可以存在确定性的协议控制器，例如依赖检查、轮次计数和 fan-out/fan-in，但它不能生成智能内容，也不能偷偷选择裸模型代替助理。

### 8.3 协作模式

第一组显式协议：

- single：指定一个成员执行。
- broadcast：所有成员在共享上下文中给出观点；为兼容现状默认禁用工具。
- parallel_tasks：不同成员在隔离任务上下文中并行执行；默认继承各助理工具权限。
- pipeline：按依赖图传递上游产物，后续助理继续处理。
- debate：多轮观点、反驳和裁判；参与者与裁判都必须是助理。
首版不实现 agent.auto，也不根据 skills 或运行时判断自动选择协议和成员；协作模式、成员与角色均由用户或群组配置显式确定。

工具策略只有 inherit、read_only 和 disabled。群组或任务策略可以从 inherit 收窄到 read_only/disabled，绝不能给助理增加其原本没有的工具或权限。

### 8.4 普通助理及工具

普通助理继续复用 App 现有 Assistant/Agent Runtime：

- 使用助理自己的系统提示词。
- 使用助理自己的 Provider 和模型。
- 使用助理自己的知识库、插件和工具。
- 使用现有工具循环和消息落库。
- 沿用用户、工作区和工具级权限。
- 副作用工具仍触发现有或新增的审批规则。

不得对整个 Agent Group 全局设置 functionCall=false。只有 broadcast 观点模式和 Model Plane 的内部模型调用默认禁用工具；parallel_tasks、pipeline 等任务模式应按助理配置执行。

V1 的三个 ModelNet 虚拟编排模型继续声明 functionCall=false；配置这类模型的助理不能承接“必须调用工具”的 AgentTask。任务创建前必须根据助理模型能力和任务工具需求预检，不满足时阻止运行并给出可操作错误。ModelNet 具体模型是否可调用工具则完全以 Registry 能力为准。

### 8.5 Claude Code 与 Codex

Claude Code 和 Codex 先被配置为完整异构助理，再由 Agent Plane 按 agentId 调度。

执行链：

~~~text
AgentTask
→ AssistantExecution
→ App 异构助理 Runtime
→ Device Gateway
→ Claude Code CLI 或 Codex CLI
~~~

Device Gateway 负责：

- 启动、监控和终止进程。
- 绑定工作目录与 Worktree。
- 限制环境变量和凭据暴露。
- 流式转发日志和结构化事件。
- 传播取消、超时和审批结果。
- 采集退出码、补丁、产物和资源使用。

MCP 只承担 CLI 与任务系统之间的协议通信，例如 get_task_context、report_progress、publish_artifact、request_approval、complete_task。MCP 不负责拉起、杀死或守护 CLI 进程。

### 8.6 外部 A2A 完整助理

A2A 可行，但定位固定为“Agent Plane 调用外部完整 Agent 的标准执行协议”，不能替代群组调度器。

截至本计划版本：

- 协议契约固定为 A2A 1.0，请求使用 A2A-Version: 1.0。
- 官方规范仓库当前补丁版本为 v1.0.1；补丁号不作为线上协商版本。
- 首版在 Orchestrator 中封装官方 Python A2A SDK，并只启用 HTTP+JSON/REST Client；SDK 版本必须精确锁定并通过官方兼容测试。
- SDK 只存在于 A2AExecutionAdapter 后，业务状态机不能依赖 SDK 私有类型。

登记与执行链：

~~~text
外部 Agent Card
→ App/Orchestrator 受控登记与信任审核
→ 创建稳定的本地完整助理 agentId
→ AgentTask(agentId)
→ Assistant Binding Resolver
→ A2A Execution Adapter
→ Remote A2A Agent
~~~

登记后的助理版本固定 Agent Card digest、Origin、协议版本、允许的 skills、credentialRef、数据出域策略和远程副作用策略。AgentSkill 只用于展示、准入和任务匹配；A2A 核心协议没有通用 invokeSkill 操作，不能把 skill 描述误当成可直接调用的工具。

A2A Execution Adapter 负责：

- 受控获取、校验、缓存和固定 Agent Card。
- 将本地 AgentTaskAttempt 映射为 A2A Message、Task、Artifact 和状态事件。
- 保存 remoteTaskId、remoteContextId、消息游标、Agent Card digest 与 endpoint Origin。
- 支持 SendMessage、流式订阅、GetTask 恢复和 CancelTask。
- 流断开时改用 GetTask 轮询恢复，不盲目重新发送已创建的远程任务。
- 把 INPUT_REQUIRED 和 AUTH_REQUIRED 映射到本地用户输入与审批流程。
- 把远程 Artifact 作为不可信输入，经大小、MIME、哈希和内容检查后写入本地产物系统。
- 将取消标记为 best-effort；远端拒绝取消或迟到返回时，不得覆盖本地已终止状态。

A2A 不负责：

- 选择成员、自动拆任务或选择协作协议。
- 群组 DAG、并发、预算、Lease、重试、审批和事实状态。
- 启动 Claude Code/Codex CLI、创建 Worktree 或管理本地工具。
- 不假定 Claude Code/Codex CLI 原生提供 A2A Server 或 Agent Card；当前 CLI 继续走 Device Gateway，未来只有在外部 Runtime 明确提供合规 A2A endpoint 时才按外部助理登记。
- 约束远程 Agent 内部实际使用的工具和副作用。
- 替代 MCP。MCP 继续负责 Agent 与工具/资源，A2A 负责独立 Agent 之间的跨系统通信。

首版边界：

- 只实现出站 A2A Client，不把 ModelNet 暴露为通用 A2A Server。
- 只允许用户或管理员显式登记可信 Agent Card，不做公网自动发现、自动选择或自动组网。
- 外部助理必须由用户显式加入群组和显式协议。
- 首版使用 SSE 加轮询，不开放公网 Push Notification webhook。
- 不把本地 Task MCP 暴露给不受信任远端。
- 远程 Agent 的内部 toolPolicy 无法由 A2A 标准强制执行；首版只准入无副作用或已有外部治理保证的 Agent，其他 Agent 必须显式风险确认且不得获得自动审批。

官方依据：

- A2A v1.0 规范：https://a2a-protocol.org/latest/specification/
- A2A 与 MCP 的职责边界：https://a2a-protocol.org/latest/topics/a2a-and-mcp/
- A2A v1.0 发布说明：https://a2a-protocol.org/latest/announcing-1.0/
- 官方规范 v1.0.1 Release：https://github.com/a2aproject/A2A/releases/tag/v1.0.1
- 官方 Python SDK：https://github.com/a2aproject/a2a-python

### 8.7 写任务安全

第一版写任务采用：

- 每个写任务独立 Git Worktree。
- 同一仓库同一阶段最多一个 Writer。
- Reviewer 可以并行只读。
- 文件范围、命令范围和网络权限显式声明。
- 安装依赖、写工作区外文件、提交、推送、合并和部署分别审批。
- 第一版不自动 merge、push 或 deploy。
- 任务失败保留 Worktree、补丁和日志供人工恢复。
- 产物记录路径、摘要、digest 和生产者，不把大文件写入数据库。

## 九、Agent Plane 运行模型

### 9.1 核心状态机

AgentGroupRun 状态：

- queued。
- planning。
- running。
- waiting_approval。
- paused。
- synthesizing。
- completed。
- failed。
- canceled。

AgentTask 状态：

- pending。
- ready。
- leased。
- running。
- waiting_approval。
- waiting_device。
- waiting_input。
- waiting_auth。
- cancel_requested。
- succeeded。
- failed。
- canceled。
- rejected。
- skipped。

每次重试创建新的 AgentTaskAttempt，不覆盖历史 Attempt。Lease 到期后允许安全回收；副作用操作依靠幂等键和审批记录避免重复执行。

暂停与设备恢复语义：

- pause 后不再领取或启动新 Task。
- 已运行 Task 按 Run 的 pausePolicy 选择安全完成当前步骤或传播取消；默认安全完成当前无副作用步骤后停下。
- resume 只重新调度 ready、waiting_device、已满足输入/认证条件的 Task 或因暂停释放 Lease 的 Task，不重复已成功 Attempt。
- CLI 离线时 Task 进入 waiting_device，device_unavailable 只作为结构化 reasonCode。
- 绑定设备重新上线后，经用户权限与 execution profile 复验，waiting_device 可回到 ready；超过等待期限则进入 failed。

A2A 远程状态映射：

- TASK_STATE_SUBMITTED → running，并保留 submitted reasonCode。
- TASK_STATE_WORKING → running。
- TASK_STATE_INPUT_REQUIRED → waiting_input；收到用户输入后继续同一个远程 Task，不重新创建。
- TASK_STATE_AUTH_REQUIRED → waiting_auth；不得把本地凭据自动转交给远端，必须走显式授权或重新绑定。
- TASK_STATE_COMPLETED → succeeded。
- TASK_STATE_FAILED → failed。
- TASK_STATE_CANCELED → canceled。
- TASK_STATE_REJECTED → rejected。
- 本地 AgentTask/Attempt 始终是事实源；远端暂时不可达只更新 lastRemoteState 和 reasonCode，不得覆盖本地终态。

### 9.2 任务契约

~~~ts
interface AgentTaskSpec {
  taskId: string;
  agentId: string;
  assistantRevisionRef: string;
  role: 'member' | 'planner' | 'reviewer' | 'judge' | 'synthesizer' | 'supervisor';
  instruction: string;
  dependsOn: string[];
  inputArtifactRefs: string[];
  toolPolicy: 'inherit' | 'read_only' | 'disabled';
  executionProfileRef?: string;
  budget?: {
    maxAttempts?: number;
    timeoutMs?: number;
    maxTokens?: number;
  };
}
~~~

契约中不允许出现 modelCandidate、modelRunner、modelTopology、裸 CLI 类型、A2A URL、Agent Card 或 remoteTaskId。Runtime 与外部绑定只能由 agentId 对应的助理版本解析。

### 9.3 运行谱系

统一 trace 关系：

~~~text
AgentGroupRun
→ AgentTask
→ AgentTaskAttempt
→ AssistantExecution
   ├── 本地普通/CLI 助理执行
   ├── 可选 ModelOrchestrationRun
   │   └── Provider Model Call
   └── 可选 A2A Remote Task
~~~

UI 可以折叠展示内部 ModelOrchestrationRun 或 A2A Remote Task，但不得把它们渲染成群组成员或 AgentTask。
A2A taskId/contextId 只属于 Attempt 的 external execution link，本地 AgentTask 状态始终是群组事实源。

### 9.4 失败与降级

- 新 Agent Plane 执行失败不得静默切回旧群组执行器，否则会重复工具副作用。
- 创建 Run 前失败可以向用户明确建议重试旧路径；创建 Run 后必须在同一 Run 内恢复。
- 单个成员失败由协议决定重试、跳过、替补或中止。
- Judge 或 Synthesizer 失败不得伪装为成功；保留成员原始产物。
- CLI 离线时任务进入 waiting_device，并记录 device_unavailable reasonCode。
- 取消从 AgentGroupRun 传播到 Task、App 助理执行、Device Gateway、内部 ModelOrchestrationRun 和 A2A Remote Task。
- A2A CancelTask 是尽力取消：本地先进入 cancel_requested；远端确认后进入 canceled。远端拒绝、超时或返回迟到结果时保留审计，但不得复活本地终态。

## 十、接口与数据契约

### 10.1 Agent Plane API

目标接口：

- POST /orchestration/v1/agent-group-configs。
- PUT /orchestration/v1/agent-group-configs/{configId}。
- POST /orchestration/v1/agent-group-configs/{configId}/clone。
- POST /orchestration/v1/agent-group-configs/{configId}/archive。
- GET /orchestration/v1/agent-group-configs/{configId}/export。
- POST /orchestration/v1/agent-group-configs/import。
- POST /orchestration/v1/external-agents/a2a/inspect。
- POST /orchestration/v1/external-agents/a2a。
- GET /orchestration/v1/external-agents/a2a/{bindingId}。
- POST /orchestration/v1/external-agents/a2a/{bindingId}/reapprove。
- POST /orchestration/v1/agent-runs。
- GET /orchestration/v1/agent-runs/{runId}。
- GET /orchestration/v1/agent-runs/{runId}/events。
- POST /orchestration/v1/agent-runs/{runId}/cancel。
- POST /orchestration/v1/agent-runs/{runId}/pause。
- POST /orchestration/v1/agent-runs/{runId}/resume。
- POST /orchestration/v1/agent-runs/{runId}/approvals/{approvalId}。
- POST /orchestration/v1/agent-runs/{runId}/retry。

ModelNet App 对浏览器提供同源 BFF，不让浏览器直接持有 Orchestrator 服务凭据。

### 10.2 App 群组扩展指针

上游 chat group 的通用 extensions 字段只保存最小指针：

~~~json
{
  "modelnetAgentGroup": {
    "enabled": true,
    "configId": "agc_xxx",
    "schemaVersion": 1
  }
}
~~~

详细协议、角色绑定、预算和执行状态保存在 Orchestrator 数据库。功能关闭或指针不存在时，继续执行上游原有群组行为。

### 10.3 群组配置

~~~json
{
  "schemaVersion": 1,
  "groupId": "app_group_id",
  "participants": [
    {
      "agentId": "agent_a",
      "role": "member",
      "revisionPolicy": "pin_at_run_start"
    },
    {
      "agentId": "agent_b",
      "role": "reviewer",
      "revisionPolicy": "pin_at_run_start"
    }
  ],
  "protocol": {
    "mode": "parallel_tasks",
    "maxRounds": 1
  },
  "roleBindings": {
    "supervisorAgentId": "agent_supervisor",
    "synthesizerAgentId": "agent_synthesizer"
  },
  "executionPolicy": {
    "maxConcurrency": 3,
    "defaultToolPolicy": "inherit",
    "approvalProfile": "safe_default"
  }
}
~~~

这里不能出现任何模型候选池或 Model Plane 算法配置。

### 10.4 群组配置生命周期

- 复制群组时创建新的 configId；不能让两个可独立编辑的群组共享同一可变配置。
- 删除群组时对配置执行幂等 archive；保留已有 Run、事件和产物的审计引用。
- 导出时写入脱敏的配置快照，不只导出 configId 指针，也不包含凭据、设备标识或内部服务地址。
- 导入时校验 schemaVersion 并创建新的 configId。
- 导入配置中的 agentId 缺失或当前用户无权访问时，返回阻塞式 assistant_mapping_required；用户完成映射前不能运行。
- config API 增加 clone、archive、export 和 import 动作，并为每个动作定义幂等键。

### 10.5 A2A 外部助理绑定

~~~ts
interface A2ARemoteBinding {
  bindingId: string;
  agentId: string;
  agentCardUrl: string;
  protocolVersion: '1.0';
  transport: 'HTTP+JSON';
  expectedOrigin: string;
  credentialRef?: string;
  selectedSkillIds?: string[];
  trustPolicyId: string;
  agentCardDigest: string;
  enabled: boolean;
}

interface A2ATaskLink {
  attemptId: string;
  remoteTaskId?: string;
  remoteContextId?: string;
  lastRemoteMessageId?: string;
  agentCardDigest: string;
  endpointOrigin: string;
}
~~~

- 群组配置和 AgentTask 仍只保存 agentId，不保存 A2A endpoint 或远端任务标识。
- binding 属于助理执行版本；Agent Card 的 endpoint、认证、skills 或安全声明变化后必须禁用旧 binding 并重新审核，不能运行时静默漂移。
- credentialRef 只指向 App 或密钥管理系统中的凭据；Orchestrator 数据库、事件和导出包都不得保存明文。
- selectedSkillIds 只表达允许委派的能力范围，不赋予本地工具权限，也不能作为自动选人依据。

## 十一、持久化与一致性

### 11.1 独立逻辑数据库

复用现有 PostgreSQL 实例，但新增独立逻辑数据库和数据库用户，例如 modelnet_orchestration。建议表：

- agent_group_configs。
- agent_group_config_versions。
- agent_group_runs。
- agent_tasks。
- agent_task_edges。
- agent_task_attempts。
- agent_events。
- agent_external_bindings。
- agent_external_task_links。
- agent_approvals。
- agent_artifacts。
- agent_outbox。
- agent_leases。
- idempotency_keys。

不与 ModelNet App 数据库建立跨库外键。只保存 App groupId、agentId、assistantRevisionRef 等外部引用；A2A 凭据只保存 credentialRef，不保存明文。

### 11.2 事实源划分

- Orchestrator 数据库是 AgentGroupRun、AgentTask、Attempt、Lease 和 Approval 的事实源。
- App 的 Thread、Message 和 agent_operations 是用户对话、助理执行记录和 UI 投影。
- 大产物进入 RustFS/S3；数据库只保存引用、digest、类型、大小和权限信息。
- 助理提示词、工具凭据、Provider Key 不复制到 Orchestrator 数据库。
- 事件写入与状态更新采用本地事务加 Outbox；App 投影失败可重放。

### 11.3 故障隔离

- Agent Plane 使用独立连接池、迁移、队列和健康检查。
- Agent 数据库不可用时，Model Plane 仍可处理模型编排。
- Provider 调用故障时，Agent Run 的查询、取消和审批仍可用。
- Agent Plane 不新增 Redis 依赖；任务获取先用 PostgreSQL Lease。
- Model Plane 保持短时、近无状态；必要审计采用独立 TTL，不与 Agent 状态表耦合。

## 十二、安全与权限

- 浏览器永远不接收 Provider Key、内部 Base URL、K8S endpoint 或服务委派密钥。
- App 是用户与 Provider 权限的最终裁决点。
- Orchestrator 仅凭短期、最小权限委派令牌调用现有 Provider Runtime。
- Agent Plane 只按 agentId 请求执行，不能修改助理权限。
- toolPolicy 只能收窄权限。
- 外部 Provider 候选必须显式选择，并显示费用与数据出域提示。
- CLI 执行采用命令、目录、网络和环境变量白名单。
- 审批记录包含申请动作、范围、发起助理、用户、时间和结果。
- 所有内部调用携带 runId、taskId、attemptId 和 traceId。
- 日志对 Authorization、Cookie、API Key、环境变量值和提示词敏感段做脱敏。
- 防递归规则同时在 App 和 Orchestrator 校验，不能只依赖 UI。
- A2A Agent Card 与 endpoint 默认只允许 HTTPS；Dev 回环地址只能由环境 Flag 显式放开。
- A2A 出站请求执行 SSRF 防护：协议、端口、Origin 和解析后地址均校验；默认拒绝 loopback、link-local、metadata 与私网地址，受管内网 Origin 必须单独 allowlist；重定向不得跨 Origin，并防止 DNS rebinding。
- Agent Card 必须通过 schema、大小、协议版本、transport 和安全声明校验；保存 digest，可用签名时验证签名；Card 发生安全相关变化后暂停 binding 并重新审核。
- A2A OAuth、Bearer 或 API Key 只以 credentialRef 解析，按 Origin 和 binding 隔离，不进入 AgentTask、事件、日志或导出包。
- 外发给 A2A Agent 的消息与产物必须执行数据分级、用户可见的出域提示和大小限制；敏感数据默认禁止外发。
- 远端返回文本与 Artifact 一律是不可信输入，执行 MIME、大小、哈希、恶意内容和提示注入隔离检查；远端内容不得直接获得本地工具权限。
- 每个 A2A Attempt 都设置连接、首包、总时长、轮询、消息、Artifact 和费用预算。
- CancelTask 只按尽力取消处理；取消后的迟到事件进入审计隔离区，不能触发下游任务或副作用。
- 外部 Agent 需要独立 trust policy、健康熔断、并发配额和审计保留期。
- 未通过重新授权的 AUTH_REQUIRED 不得自动使用 App、Provider、CLI 或用户个人凭据。


## 十三、与上游项目解耦的策略

### 13.1 App 侧只增加通用接缝

尽量将上游改动限制为：

- chat group 的 extensions 指针。
- 群组发送动作的可插拔执行 Hook。
- Agent Group 同源 BFF。
- 外部完整助理的登记/信任 BFF 与通用 external binding 指针。
- 不在 App 上游类型中加入 A2A SDK 对象、远端状态机或协议私有字段。
- 服务委派鉴权支持。
- 按 agentId 执行完整助理的 Adapter。
- 运行轨迹和配置卡片 UI Slot。
- Electron 的 Device Gateway 执行 Profile 接口。

ModelNet 专属协议、状态机、数据库和算法不进入上游通用组件。

### 13.2 下游模块边界

ModelNet Orchestrator 内建议拆分：

~~~text
model_plane/
  api/
  algorithms/
  domain/
agent_plane/
  api/
  domain/
  scheduler/
  protocols/
  assistant_binding_resolver/
execution_ports/
  app_provider_client/
  app_assistant_client/
  a2a_client/
platform/
  auth/
  persistence/
  observability/
~~~

app.py 只负责装配路由和依赖，不继续承载所有算法与业务状态。
App 是外部助理的注册与展示控制面；Orchestrator 是 A2A 执行与远端状态适配数据面。App 上游代码只保存稳定 agentId 和通用 binding 指针，不把 a2a 加入现有 heterogeneous runtime 的封闭联合类型。


### 13.3 上游同步治理

新增并维护 UPSTREAM_SEAMS.md，记录：

- 每个上游修改点。
- 修改原因。
- Feature Flag。
- 依赖的下游接口。
- 关闭后的原始行为。
- 上游升级时的冲突处理方法。

CI 至少包含：

- 所有扩展关闭时的上游基线测试。
- ModelNet Provider 动态 Runtime 测试。
- Agent Group 扩展开启测试。
- 固定上游版本的同步演练。
- 禁止 ModelNet 业务模块反向依赖上游私有 UI 实现的检查。

## 十四、实施阶段

整体拆分为 15 个可独立验收阶段（阶段 0–14）。所有阶段必须独立提交、默认可关闭，并有明确退出门禁；不得跨阶段提前启用生产流量。

### 阶段 0：基线、ADR 与 LiteLLM 退役（退役子项已完成）

交付：

- 冻结普通聊天、modelnet 三类请求、旧群组执行和 CLI 助理的基线行为。
- 编写模型编排与助理编排分层 ADR。
- 建立 UPSTREAM_SEAMS.md。
- 审计 provider=openai 加 modelnet-* 的历史助理。
- 全仓、Capability Registry、配置生成、Model Bank、API 输出、数据库活动配置、测试和文档专项审计精确模型 ID modelnet。
- 生成精确 modelId=modelnet 的历史记录迁移清单；语义不明确的记录标记为阻塞，不做自动猜测。
- 已从目标架构和 Dev 栈移除 LiteLLM 服务、3190 端口、环境变量和生成脚本。
- 保留上游通用 LiteLLM 响应兼容代码，不因名称相似误删。

退出门禁：

- Dev App 3181 和 Router/Orchestrator 3192 健康。
- 已确认无运行请求依赖 3190。
- 基线测试与历史配置清单可复现。
- 生产 Compose 未改动。

### 阶段 1：modelnet Provider 动态 Runtime 骨架

交付：

- 定义虚拟模型和具体模型的服务端判别函数。
- 将现有 ModelNet Runtime 改为动态分派 Runtime。
- 引入 MODELNET_ORCHESTRATOR_URL。
- 前端移除对 endpoint 的判断。
- 增加 Feature Flag 和 shadow 日志，暂不切换具体模型流量。
- 从模型判别、模型列表和请求处理移除精确 modelId=modelnet；未知 ID 统一走普通 invalid_model。

退出门禁：

- 三个虚拟模型稳定指向 Orchestrator。
- 具体模型能被准确分类。
- 普通 Provider 请求不携带任何 ModelNet 内部字段。
- provider=modelnet 且使用具体 Registry modelId 的历史助理可正常读取。
- 精确 modelId=modelnet 不再被识别、映射或返回专用 retired 错误。

### 阶段 2：App 直连具体 K8S 模型

交付：

- App 只读加载 Capability Registry。
- 服务端解析具体模型 endpoint 和能力。
- 把 Registry 的 functionCall、vision、structuredOutput 等能力映射到 ModelNet 模型卡和运行时校验。
- 具体模型使用 App Runtime 直连 K8S。
- 具体模型普通聊天按能力保留 tools；虚拟模型继续声明 functionCall=false。
- 增加 Registry 热更新、不可用错误和健康指标。
- 清理具体模型请求中的 Router runtime_candidates。

退出门禁：

- 具体模型单聊成功且 Orchestrator 无对应请求日志。
- Registry 不可用时明确失败，不静默回退。
- 使用具体 Registry modelId 的旧助理无需迁移；精确 modelId=modelnet 的旧记录已显式迁移或保持阻塞。
- 支持 Function Calling 的具体模型可正常收到 tools，不支持的模型在发送前明确阻止。
- 流式、usage、错误映射与取消行为通过服务测试。

### 阶段 3：结构化跨 Provider 候选

交付：

- 引入 ModelCandidateRef。
- 统一候选解析不包含精确 modelId=modelnet 的任何兼容分支。
- 从现有 enabled providers/models 生成候选快照。
- UI 支持按 Provider 选择候选并显示成本与数据边界。
- 默认 Auto 候选池保持本地 ModelNet 具体模型。

- UI 以用户本次启动的完整去重模型集合生成候选快照，不写死任何静态节点数范围。
- parallel 保持用户集合的 N 个逻辑节点；serial 保存用户顺序并自动生成 N-1 条线性边。
- 超出当前预算、配额或资源容量时明确拒绝或要求调整，不截断、不替换、不补齐候选。

退出门禁：

- 明确候选可跨 Provider。
- 无 Key、Base URL 或 endpoint 进入请求。
- 失效候选、越权候选和虚拟递归候选在发送前被阻止。
- 外部 Provider 不会被静默加入默认池。

- 小 N 与大 N 的结构校验都不因静态数量范围拒绝；资源门禁独立判断。
- N=0 阻止发送；N≥1 时实际节点数与用户启动数完全一致，serial 的边数始终为 N-1。

### 阶段 4：现有 Provider Runtime 的服务委派调用

交付：

- 为 /webapi/chat/{provider} 增加服务委派鉴权分支。
- 实现短期令牌签发、候选白名单、调用预算和递归深度。
- 实现流式、usage、超时和取消传播。
- Model Plane 内部调用强制无 tools。

退出门禁：

- OpenAI、Anthropic、OpenRouter、自定义 Provider 和 ModelNet 具体模型各完成小型委派测试。
- 越权、过期、超预算和递归请求全部拒绝。
- 日志和事件中无凭据。
- 普通用户会话鉴权行为不变。

### 阶段 5：Router 模块化为 Provider-neutral Model Plane

交付：

- 从 app.py 拆出 model_plane、execution_ports 和 platform。
- 现有算法改用统一 Provider Invocation Port。
- 保留 Registry/Prometheus 只读遥测 Adapter。
- 增加原生 Model Run API 和计划校验 API。
- 兼容现有 Chat Completions/Responses 入口。
- 计划校验 API 以动态 N 校验 parallel 节点集合与 serial 的单链/N-1 边，不使用固定节点数上限。

退出门禁：

- auto、parallel、serial 和 auto.role_graph 回归通过。
- 至少一个混合 Provider 编排运行成功。
- auto.role_graph 降级仍使用原始用户请求。
- internal usage、tokens、ledger 和阶段耗时完整。
- parallel 和 serial 在预算允许时完整执行用户启动的 N 个节点。
- 资源不足返回结构化 budget_or_capacity_exceeded，不静默裁剪节点。

### 阶段 6：退出具体模型北向代理

交付：

- /v1/models 改为只暴露虚拟编排模型。
- 具体模型顶层请求先告警，再切换为 422 direct_model_not_supported。
- route.once 限为内部 fallback。
- 更新 benchmark、脚本、Dify 或其他外部消费者。
- 清理 OPENAI_PROXY_URL 指向 Router 的历史覆盖。
- 删除 Router、配置生成、Model Bank、API、数据库活动配置、测试和活动文档中的精确模型 ID modelnet。

退出门禁：

- 全仓和运行时没有客户端依赖 Orchestrator 的具体模型代理。
- ModelNet App 具体模型路径稳定。
- 外部消费者完成迁移清单。
- 在约定保留期内只允许 Feature Flag 临时恢复具体模型北向代理；任何回滚都不得恢复精确 modelnet 模型别名。

### 阶段 7：Agent Plane 数据库与核心状态机

交付：

- 新建 modelnet_orchestration 逻辑数据库和独立用户。
- 实现 Config、Run、Task、Edge、Attempt、Event、Outbox、Lease、Approval、Artifact。
- 实现配置 clone、archive、export、import 和缺失助理映射校验。
- 实现幂等创建、Lease 回收、取消和事件流。
- 实现 pause/resume、waiting_device 恢复和 reasonCode。
- 在 Orchestrator 内形成独立 agent_plane 模块。
- 先对现有群组请求执行 shadow-plan，不执行任务。

退出门禁：

- shadow-plan 不影响旧群组结果和延迟边界。
- 重启后 Run/Task 状态可恢复。
- Agent DB 断开不影响 Model Plane。
- 状态机和并发竞争测试通过。

### 阶段 8：接入普通完整助理

交付：

- App 提供按 agentId 加 revision 执行完整助理的内部 Adapter。
- Agent Plane 只保存助理引用，不复制提示词与凭据。
- 接入普通助理工具循环、消息投影和产物回传。
- 落地最小工具风险分类，并强制执行 inherit、read_only、disabled。
- 在任务创建前校验助理模型能力与工具需求。
- 按群组 Feature Flag 从旧 Group Runtime 切换到新 Agent Plane。
- 首个执行协议为 single 和 parallel_tasks。

退出门禁：

- 两个不同提示词、Provider 和工具的普通助理可并行协作。
- toolPolicy 只能收窄权限。
- 关闭 Feature Flag 后旧群组路径完全不变。
- 新路径失败不会静默回退并重复副作用。

### 阶段 9：接入 Claude Code 与 Codex 助理

交付：

- 由 App 将现有异构助理 Runtime 接到 Device Gateway；Agent Plane 仍只调用 App Assistant Execution Port。
- 统一 CLI execution profile、日志、退出码和取消。
- 第一版只读工作区，不允许修改文件。
- 任务 API 中仍只使用 agentId。

退出门禁：

- GPT 普通助理与 Claude Code 助理可完成一次分工任务。
- GPT 普通助理与 Codex 助理可完成一次分工任务。
- CLI 未安装、离线、超时和取消均有明确状态。
- Orchestrator 不包含 Claude/Codex CLI 进程管理代码。

### 阶段 10：显式协作协议

交付：

- 完成 broadcast、parallel_tasks、pipeline 和 debate。
- Planner、Reviewer、Judge、Synthesizer 全部使用配置助理。
- 实现输入产物、依赖边和 fan-in 规则。
- 每个协议增加预算、最大轮数与终止条件。

退出门禁：

- 每个协议至少有一个确定性服务测试和一个 Dev 小型真实请求。
- broadcast 保持默认无工具。
- parallel_tasks 与 pipeline 可继承普通助理工具。
- debate 裁判缺失或失败时不伪造最终裁决。

### 阶段 11：Task MCP 与审批

交付：

- 实现 get_task_context、report_progress、publish_artifact、request_approval、complete_task。
- 在阶段 8 的最小工具分类之上增加交互式高风险审批。
- 建立统一审批对象与桌面通知。
- 把高风险工具、CLI 命令和权限提升纳入审批。
- MCP 会话绑定 taskId、attemptId 和 Device Gateway 进程。

退出门禁：

- MCP 无法创建或终止任意进程。
- 过期任务、越权任务和重复完成请求被拒绝。
- 审批前后状态可恢复。
- 用户拒绝后任务安全终止且保留证据。

### 阶段 12：外部 A2A 完整助理接入

交付：

- 完成 A2A 1.0 与官方 Python SDK 的兼容性 spike，精确锁定 SDK 版本；业务代码只依赖 A2AExecutionAdapter。
- 首版只实现 HTTP+JSON/REST Client，请求声明 A2A-Version: 1.0。
- 实现 Agent Card inspect、手工登记、digest 固定、Origin/transport/skill/trust policy 审核和变更后重新批准。
- 实现 credentialRef，并支持按 binding 隔离的 OAuth、Bearer 或 API Key；凭据不进入 Agent Plane 数据库。
- 实现 SendMessage、流式事件、GetTask 恢复与 CancelTask，以及 INPUT_REQUIRED、AUTH_REQUIRED、Artifact 和终态映射。
- 持久化 remoteTaskId、remoteContextId、事件游标和 Card digest，使断流或 Orchestrator 重启后继续同一个远程 Task。
- 首版采用 SSE 加轮询恢复，不开放公网 Push Notification webhook，不提供入站 A2A Server。
- 实现 SSRF、DNS rebinding、跨 Origin 重定向、恶意 Card、恶意 Artifact、提示注入、预算和迟到事件测试。
- 外部助理只能由用户显式登记、加入群组并用于显式协议；不根据 Agent Card skills 自动选人或自动组网。

退出门禁：

- 一个受信任外部 A2A 助理可与一个 App 普通助理完成 parallel_tasks 和 pipeline 小型任务。
- 断流、重启和轮询恢复不会重复创建远程任务或重复下游副作用。
- INPUT_REQUIRED、AUTH_REQUIRED、取消、拒绝、超时和迟到结果均映射为可恢复、可审计的本地状态。
- Agent Card 安全字段变化会暂停 binding 并要求重新审核。
- A2A 路径不泄漏凭据，不绕过用户权限、工具审批、数据出域策略或 Agent Plane 调度。
- 关闭 AGENT_GROUP_A2A_EXECUTION 后，普通助理和 Device Gateway 路径完全不变。

### 阶段 13：隔离 Worktree 与受控写任务

交付：

- 自动创建和登记任务 Worktree。
- 实现单 Writer Lease、文件范围和命令策略。
- 产出补丁、测试结果和 Reviewer 结论。
- 清理与保留策略可配置。
- merge、push、deploy 保持人工操作。

退出门禁：

- 两个只读任务可并行，一个写任务受 Lease 保护。
- 取消和失败不会污染主工作树。
- 用户现有未提交改动不被覆盖。
- 所有物质性写操作都有审计与可恢复产物。

### 阶段 14：完整 UI、可观测性与 Dev 灰度

交付：

- /group/:gid 增加配置、任务图、成员状态、审批和产物界面。
- 展示完整嵌套 trace，但区分 AgentTask 与内部 ModelOrchestrationRun。
- 建立成功率、恢复率、成本、tokens、工具调用、CLI 时长和审批指标。
- 完成上游同步演练、故障演练和推广检查表。

退出门禁：

- 切换助理、刷新和桌面端重启后运行状态一致。
- Dev 小型真实请求矩阵全部通过。
- 生产推广方案、回滚点和数据备份经单独评审。

## 十五、里程碑

| 里程碑 | 包含阶段 | 可交付能力 |
|---|---|---|
| M1 单模型路径解耦 | 0–2 | 具体模型直连 K8S，虚拟模型进入 Orchestrator |
| M2 Provider 无关模型编排 | 3–6 | 任意 App Provider 可安全成为编排候选 |
| M3 基础多助理执行 | 7–8 | 持久 Agent Plane 与普通完整助理协作 |
| M4 CLI 与显式协议 | 9–10 | Claude/Codex、流水线、辩论 |
| M5 外部 Agent、安全写任务与完整交付 | 11–14 | MCP、审批、A2A、Worktree、完整 UI 与 Dev 灰度 |

每个里程碑都可以独立停止。不得为了展示 Agent Group 提前绕过前一里程碑的权限、取消或持久化门禁。

## 十六、测试与验收矩阵

### 16.1 单元测试

ModelNet Provider：

- 虚拟/具体模型判别。
- Registry 缺失、热更新和模型失效。
- 普通 Provider 字段隔离。
- provider=modelnet 加具体 Registry modelId 的历史助理可继续读取。
- 精确 modelId=modelnet 不出现在模型列表或 API，输入时只返回普通 invalid_model。

Model Plane：

- 候选归一化、去重、有效性和能力校验。
- parallel 的节点数严格等于用户启动的 N，serial 的顺序和 N-1 条边形成唯一线性链。
- N=0 阻止、N=1 合法、小 N 和大 N 合成计划均按用户启动数校验；预算/配额/容量门禁与结构数量分开测试。
- 虚拟模型递归阻止。
- 委派令牌过期、越权、预算和深度。
- auto、parallel、serial 和 auto.role_graph。
- 取消、超时、fallback 和原始请求保持。

Agent Plane：

- Run/Task/Attempt 状态迁移。
- pause/resume 与运行中 Task 的 pausePolicy。
- waiting_device 上线恢复、超时失败和 reasonCode。
- DAG 校验、环检测、fan-in。
- Lease 抢占和回收。
- 幂等、Outbox 和事件重放。
- 工具权限只减不增。
- Agent 到内部 Model Run 合法，Model Run 到 AgentTask 非法。
- A2A Agent Card schema、版本、digest、Origin、transport 与安全声明校验。
- A2A SSRF、DNS rebinding、跨 Origin 重定向和凭据隔离。
- A2A submitted/working/input-required/auth-required/completed/failed/canceled/rejected 状态映射。
- A2A stream 断开转 GetTask、重启恢复与远端任务幂等关联。
- A2A best-effort 取消、迟到结果隔离和本地终态保护。
- A2A Artifact 大小、MIME、哈希、恶意内容与提示注入隔离。
- A2A Card 变化后 binding 停用与重新审核。
- AgentTask 只含 agentId，不能注入 Agent Card URL、endpoint 或 remoteTaskId。

### 16.2 服务与集成测试

- provider=modelnet 具体模型请求只到 K8S。
- 三个 ModelNet 虚拟模型只到 Orchestrator。
- 五类 Provider 候选通过现有 Runtime 完成委派。
- 精确模型 ID modelnet 不在 /v1/models、Provider 模型列表、请求路由或活动配置中，且没有 retired/mapping 特判。
- Agent Plane 通过 App Adapter 执行完整普通助理。
- Device Gateway 执行 Claude Code 和 Codex 助理。
- Task MCP 回传进度、产物和审批。
- App 投影失败后通过 Outbox 重放。
- Mock A2A Agent 验证 SendMessage、流式、GetTask、CancelTask、输入、认证、Artifact 和全部终态。
- 外部 A2A 助理与普通助理完成显式 parallel_tasks 和 pipeline，且只能通过本地 agentId 入组。
- 关闭 A2A Flag 后 App 普通助理与 Device Gateway 行为不变。
- 配置 clone/archive/export/import 与缺失 agentId 映射阻断。
- Agent DB 故障不影响 Model Plane。
- Provider 故障不影响 Agent Run 查询和取消。

### 16.3 UI 与 Store 测试

- ModelNet 虚拟模型和具体模型清晰区分。
- 候选选择按 Provider 分组，无密钥或 endpoint。
- 精确模型 ID modelnet 不在 Model Bank、搜索结果、助理模型选择或历史回显中。
- 群组配置只选择助理，不选择裸模型节点。
- 角色绑定只能选择完整助理。
- 复制生成新 configId；导出为脱敏快照；导入生成新 configId；删除执行幂等归档。
- 切换群组、刷新和桌面重启后配置与运行状态保持。
- 嵌套 ModelOrchestrationRun 折叠在 AssistantExecution 下。
- 工具策略、外部 Provider 成本提示和审批状态可见。
- 外部 A2A 助理登记页显示 Card digest、Origin、skills、数据出域与信任状态；安全字段变化要求重新批准。
- A2A Remote Task 折叠在 AssistantExecution 下，不显示成额外群组成员。

### 16.4 Dev 真实请求

仅在 modelnet-toc-dev 执行，每项保持 1–2 个小请求：

1. 一个 ModelNet 具体模型普通单聊。
2. modelnet-auto 的本地默认候选池。
3. modelnet-parallel 的跨 Provider 显式候选。
4. modelnet-serial 的显式链。
5. 两个普通助理并行分工，其中至少一个使用只读工具。
6. 普通助理加 Claude Code 助理完成代码分析。
7. 普通助理加 Codex 助理完成代码分析。
8. 两个助理辩论加 Judge 助理裁决。
9. Judge 助理自身使用 modelnet-auto，验证内部嵌套 trace。
10. 一个受信任外部 A2A 助理与一个普通助理完成显式 parallel_tasks，并验证断流轮询恢复。
11. 取消、审批拒绝、Device 离线、A2A input/auth required 和重启恢复。

检查：

- 最终答案与成员产物。
- AgentGroupRun、AgentTask、Attempt 和 AssistantExecution 谱系。
- 内部 ModelOrchestrationRun 不成为群组节点。
- internal_total_tokens、internal_usage、call_ledger_summary。
- 工具调用、CLI 时长、阶段耗时和降级原因。
- Orchestrator、App 和事件中无凭据泄漏。
- 用户实际启动的模型数 N、parallel 实际节点数和 serial 的 N-1 条边一致。
- A2A remoteTaskId/contextId 只出现在 Attempt 外部链接中，Card、消息和 Artifact 无越权或凭据泄漏。

## 十七、发布、回滚与运维

### 17.1 Feature Flags

至少设置：

- MODELNET_PROVIDER_DYNAMIC_ROUTING。
- MODELNET_DIRECT_CONCRETE_MODELS。
- MODELNET_PROVIDER_DELEGATION。
- MODELNET_ORCHESTRATOR_MODEL_API_V2。
- AGENT_GROUP_ORCHESTRATION。
- AGENT_GROUP_CLI_EXECUTION。
- AGENT_GROUP_WRITE_TASKS。
- AGENT_GROUP_A2A_EXECUTION。

Feature Flag 应支持按环境、工作区和群组逐级启用。

### 17.2 灰度顺序

1. 单元和服务测试。
2. Dev 纯模拟 Provider。
3. Dev 本地 K8S 小型真实请求。
4. Dev 外部 Provider 显式候选小型请求。
5. Dev 内部团队群组。
6. Dev 受信任测试 A2A Agent，先只启用无副作用能力。
7. 故障、取消、重启和权限演练。
8. 单独提交生产推广申请。
9. 生产先只启用 ModelNet Provider 动态路由，再依次启用 Model Plane、Agent Plane 与按 binding 灰度的 A2A。

### 17.3 回滚原则

- 需要可回滚能力的阶段保留独立 Flag；已经明确删除的精确 modelnet 模型别名不保留入口。
- 回滚 Agent Plane 只影响尚未开始的新 Run；已创建 Run 必须完成、取消或迁移，不能切到旧执行器重复执行。
- 回滚具体模型直连前先确认 Router 具体模型兼容入口仍在保留期。
- 数据库迁移采用 expand/contract，不做同版本破坏性删除。
- Worktree 与产物在回滚后按保留策略可追溯。
- 生产回滚不依赖恢复 LiteLLM。
- 精确模型 ID modelnet 的删除不可回滚；回滚路径只能调整三个虚拟模型和具体模型的执行入口。

## 十八、风险与控制

| 风险 | 控制 |
|---|---|
| 上游同步冲突 | 通用接缝、下游模块、Feature Flag、UPSTREAM_SEAMS.md |
| 编排递归 | App 与 Orchestrator 双重禁止虚拟模型作为内部候选 |
| 外部 Provider 意外费用 | 默认本地候选池，外部候选显式 opt-in 和预算 |
| 密钥泄漏 | Provider 调用留在 App，短期委派令牌，日志脱敏 |
| 工具副作用重复 | 不静默回退，幂等键、Attempt、审批和 Lease |
| CLI 污染工作区 | 只读先行、隔离 Worktree、单 Writer |
| 两 Plane 相互拖垮 | 模块、连接池、健康检查和数据隔离 |
| App 与 Orchestrator 状态不一致 | Orchestrator 事实源、Outbox、可重放投影 |
| 群组配置偷偷退化为模型组网 | AgentTask 契约只允许 agentId，服务端 schema 强校验 |
| 迁移影响旧助理 | 保留 providerId=modelnet 与具体模型 ID；精确 modelId=modelnet 先审计并显式迁移，语义不明则阻塞 |
| 用户启动大量模型导致 fan-out、费用或时延失控 | 不设静态节点数范围；用显式 Run 预算、配额、并发、容量预检和整体拒绝控制，绝不静默裁剪 |
| A2A Card 或 endpoint 引入 SSRF/协议漂移 | HTTPS、Origin allowlist、地址复验、digest 固定、版本协商、变更后重新审核 |
| A2A 远端泄漏数据或返回恶意产物 | 数据分级与出域确认、最小上下文、Artifact 隔离扫描、远端输出按不可信输入处理 |
| A2A 远端副作用或取消不彻底 | 仅准入受管 Agent、风险策略、预算、best-effort 取消、迟到事件隔离和本地事实状态 |
| A2A 自动发现导致不可控调度 | 首版只手工登记并显式入组；不按 skills 自动选人，不允许成员点对点直连 |

## 十九、明确不在首版范围

- 不新增 modelnet-local Provider。
- 不重新引入 LiteLLM。
- 不让 Orchestrator 保存 Provider Key 或实现第二套 Provider Runtime。
- 不让 Agent Group 直接编辑模型串并联拓扑。
- 不让 ModelOrchestrationRun 成为 AgentTask。
- 不让模型编排内部节点调用普通工具。
- 不实现通用 hybrid.graph。
- 不自动使用外部付费 Provider。
- 不支持多个 Writer 同时修改同一工作树。
- 不自动 merge、push 或 deploy。
- 不在 Dev 验证通过前修改生产栈。
- 不实现 agent.auto、Supervisor 自动选成员或自动选协作协议。
- 不把 Agent Card skills 用作自动组网或自动路由依据。
- 不提供入站 A2A Server、公网自动发现或 Push Notification webhook。
- 不允许群组成员绕过 Agent Plane 建立任意点对点 A2A 通信。
- 不通过 A2A 自动授予远端 Agent 本地工具、CLI、Provider 或用户凭据。
- 不对无外部治理保证的 A2A Agent 自动批准副作用操作。

## 二十、最终验收清单

只有以下项目全部通过，整体计划才算完成：

- [ ] 精确模型 ID modelnet 已从代码、运行配置、活动数据、模型列表、API、测试和活动文档彻底移除，且不存在兼容或回滚分支。
- [ ] parallel/serial 使用用户实际启动的 N 个模型；serial 是 N 个节点、N-1 条边的单链，结构层不设置静态节点数范围。
- [ ] modelnet Provider 完成服务端动态分流。
- [ ] 具体 Registry 模型单聊绕过 Orchestrator。
- [ ] Orchestrator 北向只公开虚拟编排模型。
- [ ] 任意已授权 App Provider 可作为显式模型候选。
- [ ] Provider Key、Base URL 和 endpoint 不离开 App 安全边界。
- [x] LiteLLM 已从目标 Dev 运行链和活动文档移除。
- [ ] Agent Plane 拥有独立数据库和可恢复状态机。
- [ ] AgentTask 契约只引用完整 agentId。
- [ ] 普通助理原有工具得到保留且权限不会被扩大。
- [ ] 受信任外部 A2A 助理可通过稳定 agentId 参与显式协作，且登记、恢复、取消、认证、产物和安全门禁通过。
- [ ] Claude Code 与 Codex 通过 Device Gateway 作为完整助理运行。
- [ ] single、broadcast、parallel_tasks、pipeline 和 debate 均由用户显式配置并按阶段通过。
- [ ] 首版不存在 agent.auto、自动选成员或自动选协议路径。
- [ ] Task MCP、审批、取消、Lease、Outbox 和 Worktree 通过故障测试。
- [ ] 助理内部 ModelOrchestrationRun 仅作为嵌套 trace 展示。
- [ ] 功能关闭时上游旧聊天和旧群组行为不变。
- [ ] modelnet-toc-dev 验收完成，生产推广经过单独审批。

## 二十一、推荐的首个实施批次

第一次实施只做阶段 0–2，不同时启动 Agent Plane：

1. 锁定 ADR、基线、Feature Flag 和上游接缝。
2. 已清理 LiteLLM 的 Dev 残留，未修改生产栈。
3. 重构现有 modelnet Provider 的服务端动态路由，并彻底删除精确模型 ID modelnet。
4. 让具体 Registry 模型由 App 直连 K8S。
5. 保持三个虚拟模型继续访问现有 Router/Orchestrator 虚拟模型入口。
6. 用请求日志证明“具体模型不进 Router、虚拟模型只进 Router”。

这个批次完成后，模型边界才足够稳定，可以进入跨 Provider 委派和 Model Plane 模块化；Agent Group 则在 Model Plane 边界稳定后，通过独立 Agent Plane 分阶段接入。
