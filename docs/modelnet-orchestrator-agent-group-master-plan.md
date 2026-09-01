# ModelNet Agent 级协作互联总体实施计划

> 状态：实施中（M1、M2、M3、M4、M5 已通过 Dev 评审；阶段 8 外部 A2A 出站适配已完成生产推广，外部信任列表默认保持关闭）
> 版本：V2.0
> 重构日期：2026-08-30
> 代码基线：4A100，/home/duxianghe/ModelNet-toc，33190eda5f
> 替代版本：V1.1（2026-07-21）
> 适用范围：ModelNet App、AgentRuntime、Agent Group、Device Gateway、Work / Verify、外部 Agent 适配
> 实施原则：所有代码、配置和真实请求先在 modelnet-toc-dev 验证；生产环境必须经过独立推广审批。

## 一、这次重构的结论

2026 年 8 月合入的几次上游大升级已经改变了计划的前提。当前代码不再是“缺一套 Agent Plane”，而是已经同时具备服务端持久 AgentRuntime、群组成员执行、异构 Agent 路由、Device Gateway、任务与目标、Work 产物、Verify 验收和人工 Intervention 等基础能力。

因此，V2.0 不再新建一个位于 modelnet-router 内、拥有独立数据库的 Agent Plane。真正的 Agent 级协作应当通过收拢现有能力实现：

1. **ModelNet App Server 是唯一 Agent 协作控制面。** 群组调度、成员执行、状态、审批、产物与验收都落在 modelnet-app/apps/server 及现有数据库域内。
2. **modelnet-router 只负责模型级能力。** 具体模型和 modelnet-auto 等聚合入口都继续经过 Router；Agent Group、CLI Agent、A2A Agent 不进入 Router。
3. **不新增独立 Agent Plane 数据库。** 复用 App PostgreSQL、Redis、RustFS 和现有领域表，只增加最小的群组运行、节点和尝试记录。
4. **服务端群组执行是目标路径。** 当前客户端 GroupOrchestration 只作为迁移期兼容路径；达到语义对齐和恢复验收后删除重复调度逻辑。
5. **调度单位始终是完整 agentId。** 普通助理、Claude Code、Codex、其他异构 CLI 和未来外部 A2A Agent，都必须先成为有权限、有配置、有稳定 agentId 的助理。
6. **执行位置只由现有 ExecutionPlan 决定。** 协作层不得重新发明 local、sandbox、device 或 auto 路由，也不得绕过 Device Gateway。
7. **首版只做显式协议。** single、broadcast、parallel_tasks 先收口；pipeline、debate 在持久计划和恢复能力完成后加入；不实现 agent.auto。
8. **消息、任务、运行、产物和验收各有唯一事实源。** 新表只记录协作拓扑和运行谱系，不复制消息正文、任务正文、Work 内容或 Verify 结果。
9. **Agent Signal 只用于事实发生后的事件和自动化。** 它不是群组调度器，也不承担运行状态机。
10. **A2A 是最后接入的外部执行适配器。** 先完成内部普通 Agent 和异构 Agent 的持久协作，再做受控的出站互联；首版不开放任意入站执行。

## 二、旧计划的处置

| V1.1 内容                                     | V2.0 处置                         | 原因                                                                             |
| --------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------- |
| LiteLLM 退役                                  | 已完成，不再作为阶段              | 2026-08-24 已从 dev 栈和项目脚本中清理                                           |
| Router 同时承载 Model Plane 与 Agent Plane    | 作废                              | AgentRuntime 和业务状态已经在 App Server 形成完整边界                            |
| Agent Plane 使用独立 PostgreSQL               | 作废                              | 会制造双事实源、双权限模型和跨库恢复问题                                         |
| 具体 Registry 模型由 App 绕过 Router 直连 K8S | 从本计划移除                      | 当前约束是聚合别名和具体模型都进入 modelnet-router                               |
| 重构 Provider 与 Router 北向模型接口          | 从本计划移除                      | 属于独立的模型路由演进，不再阻塞 Agent 协作                                      |
| 新建普通 Agent / Claude / Codex 执行端口      | 改为复用和收拢                    | 当前已有 execAgent、异构执行器、Device Gateway 和统一 executionTarget            |
| 从零实现群组任务状态机                        | 改为扩展现有 durable AgentRuntime | 当前已有 agent_operations、父子 operation、异步工具等待、K=N 屏障和回调          |
| A2A 1.0 + Python SDK 直接放入 Router          | 作废                              | 当前服务端是 TypeScript；协议适配应位于 App Server，并在实施时选定和锁定兼容版本 |
| Task MCP 作为新事实源                         | 作废                              | Tasks、Goals、Work、Verify、Intervention 已经提供更完整的领域事实源              |

较早的 docs/agent-group-collaboration-master-plan.md 保留为历史背景，不再作为实施入口。后续 Agent 协作开发只以本文为准。

## 三、当前代码基线

### 3.1 已具备的能力

| 能力                     | 当前代码锚点                                                                                                                                                    | 当前判断                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 持久 Agent Operation     | modelnet-app/packages/database/src/schemas/agentOperations.ts                                                                                                   | 已有运行状态、父子关系、成本、用量、trace 和群组关联         |
| AgentRuntime Host / Port | modelnet-app/packages/agent-runtime/src/transport/host.ts                                                                                                       | 已有可注入消息、流、LLM、工具、子 Agent 和存储端口           |
| 服务端 AgentRuntime 组装 | modelnet-app/apps/server/src/modules/AgentRuntime/buildHost.ts                                                                                                  | 已把服务端适配器注入通用 runtime                             |
| 服务端群组工具           | modelnet-app/apps/server/src/services/toolExecution/serverRuntimes/groupManagement.ts                                                                           | speak、broadcast、delegate、executeAgentTask(s) 已可延迟执行 |
| 群组成员分叉与屏障       | modelnet-app/apps/server/src/modules/AgentRuntime/executorHelpers.ts                                                                                            | 已支持 in_group、isolated、K=N 等待和失败回填                |
| 群组成员完成回调         | modelnet-app/apps/server/src/router-hono/agent/handlers/groupMemberCallback.ts                                                                                  | 已有鉴权回调和父运行恢复桥接                                 |
| 完整助理执行             | modelnet-app/apps/server/src/services/aiAgent/index.ts                                                                                                          | 群组成员最终复用完整 Agent 执行链                            |
| 统一执行位置             | modelnet-app/src/helpers/executionTarget.ts                                                                                                                     | none、auto、local、sandbox、device 已有单一解析规则          |
| 异构 Agent               | modelnet-app/packages/heterogeneous-agents、modelnet-app/src/store/chat/slices/agentRun                                                                         | Claude、Codex 等已有执行器、会话和事件处理                   |
| Device Gateway           | modelnet-app/apps/device-gateway、modelnet-app/packages/device-gateway-client                                                                                   | 已有 WebSocket、恢复、重放、干预和中断能力                   |
| 人工干预                 | modelnet-app/packages/database/src/schemas/agentIntervention.ts                                                                                                 | 已有持久审批、租约、幂等、敏感参数隔离和恢复状态             |
| Work / WorkVersion       | modelnet-app/packages/database/src/schemas/work.ts                                                                                                              | 已有稳定产物身份、不可变版本和 operation 归因                |
| Verify                   | modelnet-app/packages/database/src/schemas/verify.ts、modelnet-app/apps/server/src/services/verify                                                              | 已有标准、计划、证据、裁决、修复和验收流程                   |
| Tasks / Goals            | modelnet-app/packages/database/src/schemas/task.ts、modelnet-app/packages/database/src/schemas/goal.ts、modelnet-app/packages/database/src/schemas/goalGraph.ts | 已有任务树、依赖、目标图、决策和事件                         |
| Agent Signal             | modelnet-app/packages/agent-signal、modelnet-app/apps/server/src/workflows/agentSignal                                                                          | 已有完成/失败事件后的自动化入口                              |

### 3.2 仍然存在的关键缺口

1. 客户端 GroupOrchestration 和服务端 groupManagement 同时存在，语义和生命周期可能分叉。
2. 服务端 summarize、vote 仍是占位实现；createWorkflow 与 createDebate 均已收口为用户确认后创建持久 Run，interrupt 已具备运行级实现。
3. 现有父子 operation 能表达执行关系，但缺少稳定、可查询、可重试的群组 Run / Node / Attempt 计划快照。
4. dev 默认 LocalQueueServiceImpl 使用 setTimeout；App 进程重启时，排队工作本身不具备持久恢复保证。
5. 群组工具只有 disableTools 布尔量，尚未形成成员权限、群组权限和节点权限的交集策略。
6. 普通 Agent 的服务端群组执行已成立，但异构 Agent 是否在所有群组入口都严格复用 ExecutionPlan 需要补齐契约测试。
7. pipeline 与固定轮数 debate 已具备不可变计划校验、持久依赖推进、ready-node 原子认领、自动 Dispatcher、稳定派发 / 恢复补投、结构化输出交接和用户确认后创建运行的入口闭环；vote 仍无可恢复状态机。
8. Work / WorkVersion、代码补丁与 Verify 已建立 Attempt 关联契约并可从运行历史定位；Tasks、Goals 继续保持各自事实源，统一关联留待独立后续设计，不阻塞 M4 退出条件。
9. 群组节点级只读代码协作、隔离写工作区、变更交接、Integrator、Verify 门禁、历史展示和人工清理手册已完成；自动破坏性清理保持关闭，commit / push / PR / merge / deploy 继续作为运行时之外的显式人工发布动作。
10. 外部 A2A 已具备出站执行适配器、受信任 binding、credentialRef、安全策略和协议测试；公网入站与任意 Agent Card 执行仍保持关闭。

## 四、目标架构

```text
Desktop / Web / API
        │
        ▼
ModelNet App Server
├── Agent Group API / UI BFF
├── Group Collaboration Service                 唯一协作控制面
│   ├── Plan Validator
│   ├── Run / Node / Attempt Repository
│   ├── Protocol State Machine
│   ├── Policy Resolver
│   └── Recovery / Cancel / Retry Coordinator
├── Durable AgentRuntime
│   ├── Supervisor operation
│   ├── group-management deferred tools
│   ├── parent / child operation bridge
│   └── intervention + stream + trace
├── Member Dispatcher
│   ├── Normal Agent ────────→ Server execAgent
│   ├── Heterogeneous Agent ─→ ExecutionPlan ─→ Device Gateway / Sandbox
│   └── External Agent ──────→ A2A Adapter
├── Domain Facts
│   ├── PostgreSQL：群组、运行、operation、任务、目标、Work、Verify、Intervention
│   ├── Redis：活跃状态、事件流、持久队列
│   └── RustFS：trace 和大产物
└── Model calls ─────────────→ modelnet-router ─→ K8S inference backends
```

### 4.1 边界规则

- Router 不知道 AgentGroupRun、agentId、Work、Verify 或人工审批。
- Group Collaboration Service 不直接选择模型 endpoint，也不解析 Capability Registry。
- Member Dispatcher 输入只能是 agentId、不可变执行快照和节点任务契约。
- 所有成员执行都创建 agent_operations；不得创建只有内存 ID 的“影子任务”。
- 所有跨进程回调必须带 operationId、runId、nodeId、attemptId 和幂等键。
- 成员之间不建立任意点对点通道；消息、状态和产物都经过服务端控制面。
- 浏览器不得收到 Provider 密钥、A2A 凭据、Router 后端地址或设备服务令牌。

## 五、统一领域模型

### 5.1 运行层级

```text
AgentGroupRun
├── GroupRunNode(agentId, protocol role, dependencies)
│   ├── GroupRunAttempt #1
│   │   └── AgentOperation
│   │       ├── Normal Agent runtime
│   │       ├── Heterogeneous runtime
│   │       └── External A2A runtime
│   └── GroupRunAttempt #2（显式重试时）
└── GroupRunNode(...)
```

- **AgentGroupRun**：一次用户可见的群组协作，保存协议和策略快照。
- **GroupRunNode**：计划中的稳定节点，表达角色、任务、依赖和完成条件，不等同于一次具体执行。
- **GroupRunAttempt**：节点的一次执行尝试，绑定且只绑定一个 agent_operations.id。
- **AgentOperation**：AgentRuntime 的真实执行和计量事实。
- **Task / Goal**：只有当协作工作本身需要长期管理或用户可操作时才建立；不为每个内部节点机械复制一条 Task。
- **Work / WorkVersion**：成员输出的持久产物事实源。
- **VerifyRun**：对 Work、Task 或 Agent Operation 的验收事实源。

### 5.2 最小新增表

新增表放在现有 App 数据库中，遵循当前 Drizzle schema 和 workspace 权限模型。

#### agent_group_runs

- id
- user_id、workspace_id、chat_group_id、topic_id、thread_id
- supervisor_agent_id、supervisor_operation_id
- protocol：single、broadcast、parallel_tasks、pipeline、debate
- plan_version、plan_snapshot、plan_hash
- policy_snapshot、budget_snapshot
- status、completion_reason、error
- idempotency_key
- started_at、completed_at、created_at、updated_at

约束：同一所有者范围内 idempotency_key 唯一；运行开始后 plan_snapshot 不原地修改。

#### agent_group_run_nodes

- id、run_id、node_key
- agent_id、role、instruction
- dependencies、barrier_key、sort_order
- execution_policy_snapshot、tool_policy_snapshot
- status、completion_reason
- max_attempts、timeout_ms
- created_at、updated_at

约束：run_id + node_key 唯一；依赖只能引用同一运行中更早的合法节点；首版拒绝环。

#### agent_group_run_attempts

- id、run_node_id、attempt_no
- operation_id
- runtime_kind、execution_target_snapshot
- external_execution_ref（仅保存非敏感关联 ID）
- output_snapshot（有界最终摘要 + WorkVersion ID 引用，不复制 Work 内容）
- status、started_at、completed_at、error
- created_at、updated_at

约束：run_node_id + attempt_no 唯一；operation_id 唯一；重试创建新 Attempt 和新 Operation，不覆盖历史。

### 5.3 不新增或不复制的数据

- 不在群组表复制消息正文；共享发言继续进入现有 message / topic / thread。
- 不在节点表复制 Agent 完整配置；只保存 agentId 和执行时的非敏感快照或哈希。
- 不在群组表复制 Work 内容；只通过 operationId / WorkVersion 关联。
- 不在群组表复制 Verify 结果；通过 verify_runs 关联。
- 不保存 Provider API Key、A2A token、设备 token、K8S endpoint 或完整原始工具参数。

## 六、协作执行契约

### 6.1 计划创建

1. API 校验用户、workspace、group 和所有成员的访问权限。
2. 把显式协议配置编译为稳定 plan_snapshot。
3. 解析每个 agentId 的有效配置，记录配置哈希、工具策略和执行位置快照。
4. 在同一数据库事务中创建 Run、Node 和 supervisor operation 关联。
5. 事务提交后通过队列启动，不在请求事务内直接执行 Agent。

### 6.2 成员分发

Group Collaboration Service 不直接判断“普通、Claude、Codex”。它调用统一 Member Dispatcher：

1. 加载 agentId 和当前用户/工作区可见配置。
2. 调用现有 resolveExecutionPlan / executionTarget 规则。
3. 创建 Attempt 和 Agent Operation。
4. 普通 Agent 进入服务端 execAgent；异构 Agent 进入现有 hetero / gateway 链；外部绑定进入 A2A Adapter。
5. 把运行时选择和目标快照写回 Attempt，禁止静默切换执行位置。
6. 统一产出 AgentStreamEvent、Intervention、Work 和 terminal result。

如果目标设备离线、执行目标不受支持或外部绑定不可用，节点进入明确的 blocked / failed 状态，不自动换到另一个设备、模型或 Agent。

### 6.3 工具权限

有效工具集合必须满足：

```text
effective tools
= agent allowed tools
∩ group policy
∩ protocol policy
∩ node policy
∩ runtime enforceable capabilities
```

- broadcast 默认是观点收集，继续禁用工具。
- parallel_tasks 可以使用工具，但必须经过交集计算。
- 子 Agent 不能继承 supervisor 超出自身配置的权限。
- shell、文件写入、网络发布、Git 提交等高风险动作复用 AgentIntervention。
- “允许一次”“本次运行允许”和长期记忆权限必须沿用现有 intervention resolution 语义，不另建简化审批表。

### 6.4 取消、中断和重试

- 取消 Run 必须先原子标记 cancelling，再向所有非终态 Attempt 发中断。
- server groupManagement.interrupt 必须接通 Coordinator、Device Gateway 和外部适配器，不能继续返回占位成功。
- 超时必须产生明确 completionReason，并触发父屏障收敛。
- 同一 Attempt 的回调至少一次投递；状态更新使用幂等键和版本条件。
- 节点重试创建新 Attempt；Run 可继续、失败或等待用户决定，由协议策略明确指定。
- App / worker 重启后，恢复器根据 PostgreSQL 非终态事实和 Redis 队列重新认领，不依赖浏览器在线。

## 七、显式协作协议

### 7.1 首批收口协议

| 协议           | 当前基础                | V2.0 要求                                    |
| -------------- | ----------------------- | -------------------------------------------- |
| single         | speak / delegate 已存在 | 固化 Run/Node/Attempt，完成取消和恢复        |
| broadcast      | 并行 in_group 已存在    | 工具禁用、K=N 屏障、部分失败策略、结果归因   |
| parallel_tasks | isolated 并行已存在     | 持久节点、独立超时、重试、Work 聚合和 Verify |

### 7.2 第二批协议

#### pipeline

- 首版只接受显式、无环 DAG；UI 可以先只暴露线性流水线。
- 下游节点读取上游节点的结构化摘要和 Work 引用，不拼接无限消息历史。
- 任一必需依赖失败时，下游进入 blocked；可选依赖失败由节点策略处理。
- 每个节点仍是完整 Agent，不允许裸模型节点或任意脚本节点。

#### debate

- 配置固定参与者、轮数、judgeAgentId、每轮预算和终止条件。
- 发言轮次只读前序结构化观点；工具默认关闭。
- Judge 必须是完整 Agent，最终裁决可挂 Verify，但不能以匿名裸模型执行。
- 首版不自动添加成员、不动态改变辩论拓扑。

### 7.3 延后能力

- vote 在 pipeline 和 debate 的持久状态机稳定后实现。
- summarize 复用结构化上下文压缩能力，不建立独立事实源。
- createWorkflow 只生成待确认计划，用户确认后才创建 Run。
- agent.auto、动态扩员、自发改图、成员间任意协商全部延后。

## 八、耐久性与队列

### 8.1 现状

- AgentRuntime 活跃状态和事件流可使用 Redis，终态摘要写入 PostgreSQL。
- queue 模式已有 QStash 实现，但需要 QSTASH_TOKEN。
- 当前 dev 默认 LocalQueueServiceImpl，基于 setTimeout，不能作为“重启不丢任务”的验收依据。
- dev Redis 已启用 AOF，并使用独立 dev volume，可作为自托管持久队列基础。

### 8.2 目标

保留 QueueServiceImpl 抽象，支持三种实现：

- local：只用于单测和轻量开发，不通过恢复验收。
- qstash：保留现有托管部署能力。
- redis-stream：ModelNet 自托管 dev 的目标实现。

新增 RedisStreamQueueServiceImpl，并增加独立 agent-worker 服务。worker 使用 consumer group、消息去重、可见性/租约、失败转移、延迟重试和死信记录；App Server 只负责入队和查询。

关键规则：

- 队列 payload 只携带 ID 和版本，不携带密钥或大上下文。
- 数据库事实先提交，再投递队列；投递失败由 outbox / sweeper 补发。
- worker 处理前读取最新 Run / Node / Attempt 状态，终态任务直接幂等跳过。
- 超出租约的消息可被重新认领，但不会创建重复 Attempt。
- Redis 暂时不可用时不得退化成隐式内存执行；应明确报 unavailable 并等待恢复。

## 九、产物、验收与代码协作

### 9.1 Work 与 Verify

- 工具产生的文档、任务、PR 或外部资源继续由 Work / WorkVersion 登记。
- 每个 WorkVersion 已有 rootOperationId，可反查到 Attempt、Node 和 Run。
- parallel_tasks 和 pipeline 的聚合结果只保存 Work 引用和摘要，不复制全文。
- 节点可以配置 Verify rubric；VerifyRun 仍是唯一验收事实源。
- Verify 失败后的 repair 必须新建受控执行或节点 Attempt，不覆盖原始产物版本。

### 9.2 代码写任务分级

1. **只读阶段**：允许搜索、分析、审查和生成建议，不改文件。
2. **隔离写阶段**：每个写节点获得独立 workspace / worktree，产出 patch 和 WorkVersion。
3. **集成阶段**：专门的 integrator Agent 读取多个 patch，解决冲突并再次 Verify。
4. **发布阶段**：提交、推送、PR、合并、部署仍要求显式用户授权，不因群组模式自动发生。

需要新增 WorkspaceIsolationService，但它只封装当前 executionTarget、workingDirectory、sandbox/device 能力，不绕过现有安全检查。每个 Attempt 必须记录隔离目录标识、基线 commit、变更摘要和清理状态。

## 十、外部 Agent 互联（A2A）

### 10.1 定位

A2A 是 Member Dispatcher 的外部执行 Adapter，不是 Router 协议，也不是群组成员之间的自由网络。外部 Agent 只有先登记成稳定本地 agentId，才能进入 chat_groups_agents 和协作计划。

### 10.2 首版范围

- 只做 App Server 出站客户端。
- 实施前做协议兼容性 spike，选定并锁定具体协议版本和传输 profile；领域层不得直接暴露 SDK 类型。
- 支持任务创建、状态查询或流、消息、Artifact、取消和终态映射。
- 远端 task / context ID 只记录为非敏感 external_execution_ref。
- 远端 Artifact 转换为 Work / WorkVersion；远端需要人工输入时转换为 AgentIntervention。
- endpoint 必须通过 allowlist、DNS/IP 复验和 SSRF 防护；凭据只以 credentialRef 引用服务端秘密存储。
- 日志、事件、错误和数据库中不得出现 bearer token、私有 header 或未清洗请求体。

### 10.3 首版不做

- 不开放公网入站 A2A server。
- 不允许用户临时输入任意 Agent Card URL 直接执行。
- 不让远端 Agent 回调任意本地 URL。
- 不支持远端动态扩员、本地 agentId 冒用或跨 workspace 共享凭据。
- 不把 A2A SDK 或协议版本绑定进 AgentRuntime 核心包。

## 十一、API、事件和 UI

### 11.1 App API

优先扩展现有 Agent Group tRPC / Hono 边界，避免再建第二套网关。最小 API：

- createGroupRun：校验并创建显式计划。
- getGroupRun：返回 Run、Node、Attempt、Operation、Work 和 Verify 摘要。
- cancelGroupRun：幂等取消运行。
- retryGroupNode：对终态节点创建新 Attempt。
- resolveGroupIntervention：复用现有 Intervention 服务，不接受旁路审批。
- listGroupRunEvents：基于现有 stream / replay 返回增量事件。

内部 worker 和外部回调继续使用 Hono 路由，并执行服务令牌、签名、所有权和状态版本校验。

### 11.2 事件

在现有 AgentStreamEvent 上补充最小群组事件：

- group_run_started / group_run_terminal
- group_node_ready / started / waiting / terminal
- group_attempt_started / terminal
- group_barrier_waiting / passed
- group_intervention_required / resolved
- group_work_registered / group_verify_updated

每个事件必须带 runId、nodeId、attemptId、operationId 中适用的标识，并支持 replay cursor。Agent Signal 只消费已持久化的终态或业务事件，不反向控制调度。

### 11.3 UI

继续使用现有 /group/:gid 产品入口，逐步增加：

- Collaboration 设置：协议、成员角色、顺序/依赖、预算、超时、失败策略、工具策略。
- Run 视图：节点状态、Attempt 历史、实际执行位置、成本、工具调用和屏障状态。
- Intervention 面板：复用统一审批 UI。
- Work / Verify 面板：展示产物版本、证据、裁决和修复链。
- 设备与外部 Agent 状态：只显示可理解状态，不暴露 endpoint 和凭据。

## 十二、实施阶段

### 阶段 0：冻结边界与特征测试

目标：在改行为前把当前服务端群组语义固定下来。

- 接受本文 ADR：Agent 控制面在 App Server，Router 保持模型面。
- 为 speak、broadcast、delegate、executeAgentTask(s) 增加服务级特征测试。
- 补齐父子 operation、K=N、超时、回调重复、成员启动失败的测试。
- 建立 client / server 行为对照表和迁移 flag。
- 明确旧 V1.1 的 Model Plane 工作不属于本计划。

退出条件：现有服务端行为有可重复测试；没有生产变更。

### 阶段 1：持久群组运行模型

- 新增 Run / Node / Attempt schema、迁移、model 和 repository。
- 新增 GroupCollaborationService，编译并校验显式计划。
- 将现有服务端 single、broadcast、parallel_tasks 写入新运行谱系。
- 建立 operationId 与 Attempt 的唯一映射和幂等键。
- API 仍通过 feature flag 默认关闭。

退出条件：同一运行可完整查询节点、尝试、operation、成本和错误；重复请求不重复执行。

### 阶段 2：持久队列与恢复

- 实现 RedisStreamQueueServiceImpl 和 agent-worker dev 服务。
- 增加 outbox / sweeper、租约重领、死信和恢复协调器。
- 接通 cancel / interrupt / timeout；实现 server interrupt，移除占位成功。
- 做 App 重启、worker 重启、Redis 短暂不可用、重复回调测试。

退出条件：浏览器、App 或 worker 重启后运行不丢失、不重复，能继续、失败或等待用户。

### 阶段 3：服务端路径收口

- 新 Run 默认走服务端 Group Collaboration Service。
- 对齐共享会话与 isolated thread 的消息和流语义。
- 完成客户端运行的迁移规则：旧运行在旧路径完成，新运行不得中途切换。
- 观测期通过后删除客户端直接调度成员的重复代码，只保留 UI/事件消费。

退出条件：关闭客户端页面不影响运行；服务端路径覆盖现有协议且无语义回退。

### 阶段 4：统一成员路由与工具策略

- Member Dispatcher 统一复用现有 ExecutionPlan。
- 普通 Agent 先验收，再启用异构 Agent 和 Device Gateway。
- 实现工具权限交集、风险分级和 Intervention 接入。
- 验证设备离线、重连、事件重放、用户干预和中断。

退出条件：同一群组可混合普通 Agent 与 Claude/Codex 等异构 Agent，且执行位置、权限和失败原因可审计。

状态（2026-08-31）：M2 第一片及真实只读混合群组验收已在隔离 Dev 栈完成。群组 Member Dispatcher 不再把全部 Attempt 硬编码为 `normal`；普通成员与异构成员都在首次 queue / device / sandbox 分发之前经过 `onOperationPrepared` 边界，Attempt 在该边界先持久化真实 `runtimeKind`、operation / thread 桥接字段以及已解析的 `ExecutionPlan` 快照。prepared 后分发失败会终态化对应 Attempt，不再遗留 `running` 记录；重试会校验运行时类型未发生静默变化并写入新的执行计划快照。首次真实请求 `agr_GZerXX3KT82z` 暴露 prepared hook 使成员启动丢失 supervisor topic owner 的回归：两个 Node 均以 `start_failed` 结束且未创建 Attempt；修复为始终向成员启动传递父 operation 后，该测试 Run 已清理为 cancelled。v14 的真实 Run `agr_n9C2G7gDouw5` 随后以 completed 收敛，2 Node、2 Attempt 和 3 个 operation 全部完成；普通成员 Attempt 为 `runtimeKind=normal`，本机 ChatGPT 登录态 Codex 成员 Attempt 为 `runtimeKind=heterogeneous`，其持久快照为 `executionPlan={kind: device, target: device, deviceId: modelnet-m2-4a100-readonly}`，Codex 进程以退出码 0 完成。服务端定向 Vitest 152 项、项目 TypeScript、定向 ESLint、Worker bundle 和 Next standalone build 均通过；v14 开发镜像的 app / agent-worker 均为 healthy，Router 与 Device Gateway 未重建，生产栈未推广。当前未把 M2 标记完成：仍需继续工具权限交集、设备离线/重连/事件重放和 Intervention 验收。

状态续（2026-08-31，M2 工具权限第二片）：群组普通成员在工具可用时改为 `manual` Intervention，不再以 `headless` 自动批准；`disableTools` 会传入共享会话与 isolated thread 的真实执行。异构成员的相同硬上限由 server 追加 `--permission-profile read-only`，CLI 再把 Codex 固定为 `--ignore-user-config --sandbox read-only`、Claude Code 固定为 `--permission-mode plan`，并剥离可扩大权限的用户参数；当前无法可靠执行只读 profile 的其他异构 runtime 会显式拒绝，不再静默放宽。本机独立 smoke 由登录态 Codex 自动选择默认 `gpt-5.6-sol`，一次文件写入被 read-only sandbox 拒绝且 marker 未生成。v15 真实混合 Run `agr_4b2ewwa68iHP` 以 `broadcast / completed` 收敛；普通与 Codex 两个 Node / Attempt 均 completed，两个 `tool_policy_snapshot` 均为 `{disableTools: true}`，Codex Attempt 为 `runtimeKind=heterogeneous`，执行快照为 `executionPlan={kind: device, target: device, deviceId: modelnet-m2-4a100-readonly}`，connector 收到运行并以退出码 0 完成。CLI 84 项、服务端 69 项和异构 spawn 44 项定向 Vitest（合计 197）通过，TypeScript、定向 ESLint、CLI bundle、Worker bundle 与 Next standalone build 通过；v15 Dev app / agent-worker healthy，`3181/signin` 与 `3192/healthz` 均为 200。测试成员已恢复为 `modelnet/modelnet-auto`，临时 API key 已撤销，connector 已离线；生产容器未重建。工具权限“只能收窄不能扩大”验收项完成，M2 仍需继续设备离线/重连/事件重放与 Intervention 运行级门禁。

状态续（2026-08-31，M2 设备恢复第三片）：明确区分 Device Gateway 的写派发与 Agent Gateway 的事件流恢复。`agent_run_request` 不做自动重放；Device Gateway Client 以有界的进程内 ledger 记录 in-flight operation 和最近 256 个 ACK，同一进程断线重连后再次收到相同 `operationId` 时只重发原 ACK，不再触发 CLI/桌面 handler，也不会启动第二个本地进程；设备进程重启后仍要求服务端创建新 Attempt，保持“写任务不自动重放”。Gateway 的 503 JSON 现在归一化为 `DEVICE_OFFLINE`、`DEVICE_DISCONNECTED` 或 `DEVICE_REQUEST_TIMEOUT` 机器码，服务端将其持久为明确失败原因并映射到可读设备错误。事件流继续复用既有 Agent Gateway `resume_complete` 权威状态、按序 flush 和 event-id 去重，不从静默猜测完成。Device Gateway Client 87 项、真实 Gateway 协议 7 项、Agent Gateway Client 源码 34 项、异构服务端 54 项通过，TypeScript、定向 ESLint、Device Gateway build、Worker bundle 和 Next standalone build 通过。真实 Dev 3193 验收依次得到 `offline={error: DEVICE_OFFLINE, success: false}`、首次派发成功、断线离线、同连接重连和相同 `runtime-reconnect-operation-v16` 再派发成功，handler 启动次数始终为 1。v16 镜像 `624e5c88e09d...` 的 app / agent-worker healthy，`3181/signin`、`3192/healthz`、`3193/healthz` 均为 200；Router 与 Device Gateway 容器未重建，生产未推广。M2 现只剩 Intervention 运行级门禁与离线恢复验收。

状态续（2026-08-31，M2 Intervention 第四片）：成员运行进入 `waiting_for_human` 时不再被误判为完成，不写群组工具完成屏障，也不提前恢复 supervisor；Run、Node、Attempt 统一持久为 `waiting + waiting_for_human`，只有审批 continuation 进入真实 terminal lifecycle 后才清除门禁并结算原 Attempt。成员 operation 会把序列化群组回调、人工干预配置、父 operation 和 orchestration appContext 同步写入数据库，恢复路径采用 Redis 优先、数据库回退；审批 continuation 沿 source operation 谱系恢复这些桥接字段，停止待审批 operation 也复用普通 terminal lifecycle，使持久回调可以正确结算取消。Run History 直接根据持久 Run 恢复“等待审批”状态，浏览器刷新或重新连接不再依赖旧页面内存。真实 Dev PostgreSQL 事务 smoke `agr_DaRaVihXwJ1c` 经 `create -> running -> waiting_for_human -> 新 Model 实例读取 -> completed` 后，Run / Node / Attempt 先全部保持 `waiting`，再全部收敛为 `completed`；`attempt.intervention_required`、`run.intervention_required`、`run.intervention_cleared`、`run.terminal` 各精确出现 1 次，外层事务回滚后残留为 0。runtime / 审批续跑定向 Vitest 154 项与 PGlite 15 项通过，SPA、Next standalone 和 agent-worker bundle 构建通过；v17 镜像 `31d67092ea0a...` 的 app / agent-worker healthy，`3181/signin`、`3192/healthz`、`3193/healthz` 均为 200。生产未推广。阶段 4 退出条件满足，M2 Dev 评审完成。

### 阶段 5：pipeline 与 debate

- 实现无环计划验证、依赖就绪、屏障和结构化上下文交接。
- 实现 pipeline 后再实现固定轮数 debate。（已完成）
- 完成 createWorkflow 的“生成草案—用户确认—创建运行”闭环。（已完成）
- vote 和 summarize 只在有明确状态契约后开放。

退出条件：中途重启、单节点失败和人工暂停均不会破坏协议顺序或重复下游执行。

状态（2026-08-31，M3 pipeline 状态机第一片）：复用既有不可变 `planSnapshot`、Node `dependencies` 和无环校验，不新增表。`pipeline` 根节点创建时持久为 `ready`，其余节点保持 `pending`；Attempt 只允许从已就绪节点启动。节点成功后仅当全部必需依赖为 `completed / skipped` 才解锁下游，失败或取消会把未启动后代递归持久为 `blocked + dependency_failed`，Run 以失败收敛。显式重试成功后，原先因依赖失败而 blocked 的节点会按 DAG 顺序逐层恢复为 `ready`。依赖投影推进前对 Run 行加锁，避免多个上游并发完成时各自看不到对方提交、导致汇合节点永久停在 pending；事件写入和终态投影继续保持幂等。PGlite 与一次性隔离 Dev PostgreSQL 的 `agentGroupRun` 定向测试均为 18 项通过，定向 ESLint 和项目 TypeScript 通过，覆盖双根汇合、并发汇合、提前启动拒绝、递归阻断、重试恢复和跨 Model 实例读取；测试数据库已删除。v18 Dev 镜像构建在读取 `node:24-slim` 元数据时被当前 Docker mirror 的 403 阻断，未生成镜像也未替换容器；现有 v17 app / worker 继续 healthy，3181 / 3192 / 3193 均为 200。当前第一片只闭合持久状态机；下一片接入 ready-node 的原子认领 / 持久派发、重启恢复和结构化上游摘要 / Work 引用，`createWorkflow` 仍保持“草案—用户确认—创建运行”门禁，生产未推广。

状态续（2026-08-31，M3 ready-node 调度第二片前半）：迁移 `0156_agent_group_run_dispatch_claims` 为 pipeline Node 增加完整的短租约三元组（claim id / claimed at / expires at）、完整性约束和调度索引。认领与依赖推进共同在 Run 行上串行化：活租约不会重复派发，过期租约用新 fencing token 接管并写入 `node.dispatch_lease_expired` 事件，旧 worker 无法释放或提交新 Attempt；`createClaimedAttempt` 只允许当前 token 在首次 queue 之前把 Node 原子推进为 running，重复 prepared 回调按 operationId 幂等返回。claim 同时返回直接上游的 node / Attempt / operation / runtime / external execution 引用，为后续摘要和 Work 查询提供结构化、非正文交接边界。PGlite 与一次性隔离 Dev PostgreSQL 的定向测试均为 22 项通过，覆盖并发只产生一个 winner、活租约跳过、到期接管、旧 token fencing、prepared 重放、租约释放和上游引用；项目 TypeScript 通过，测试数据库已删除，生产未触碰。当前尚未把 pipeline claim 接到 `execGroupMember` 的稳定 Redis dedupe / queue ACK 和恢复补投，也尚未持久化最终摘要 / WorkVersion 引用；这是下一片，`createWorkflow` 的用户确认门禁保持不变。

状态续（2026-09-01，M3 持久派发与输出交接第二片后半）：普通运行时的 durable Group Attempt 在首次 Redis 派发前同时把 `agentQueuePreparation` 写入运行状态和 `agent_operations.metadata`，稳定 dedupe 由 run / node / attempt / step 谱系唯一导出；provider 返回 message id 后再写 `agentQueueDispatch` ACK，数据库按 owner 和完整 preparation 字段 fencing。恢复 sweeper 对活跃 normal Attempt 检查该边界，缺 ACK 时以同一 dedupe 补投并记录 `redispatched`，已存在精确 ACK 时不再派发；即使 worker 已把状态推进到 running / done，也不以状态猜测 ACK。异构 Codex / Claude Code 成员不套用 Redis marker，继续由 Device Gateway 的 operationId ledger 去重。迁移 `0157_agent_group_run_outputs` 为 Attempt 增加 `output_snapshot`：终态回调保存最多 4000 字的最终成员摘要以及仅含 root operation / work / WorkVersion ID 的引用，下游 ready-node claim 直接携带该结构，不复制正文或 Work 内容。队列身份、恢复、normal / heterogeneous 分流和接线的 server Vitest 共 90 项通过；PGlite 与一次性 ParadeDB PostgreSQL 17 的 AgentGroupRun / AgentOperation 测试均为 48 项通过，完整迁移加载成功，测试容器已自动删除。项目全量 `tsc` 当前仍受既有 Desktop 别名、静态 Markdown/CSS 声明和前端全局类型基线错误影响；本次发现的摘要可空类型错误已修正，定向测试无失败。生产未触碰。下一片实现自动 Pipeline Dispatcher：消费 `claimReadyNodes`、把 claim / upstream snapshot 转为成员启动输入，并在 prepared 边界调用 `createClaimedAttempt`；`createWorkflow` 继续保持“草案—用户确认—创建运行”门禁。

状态续（2026-09-01，M3 自动 Pipeline Dispatcher 第三片）：恢复 worker 的定时 sweep 现会消费 `claimReadyNodes`，把节点任务、claim fencing token、直接上游摘要与 WorkVersion 引用转换为统一 `execGroupMember` 输入，并在其 `onOperationPrepared` 边界先调用 `createClaimedAttempt`，再允许首次 queue / device / sandbox 派发。启动失败分为三类：消息上下文暂不可用时释放租约；prepared 前失败仅以当前 claim token 终态化 ready Node；prepared 后失败中断 operation 并终态化已提交 Attempt。旧 worker 无法用过期 token 提交 Attempt 或标记已被接管的 Node，启动器绕过 prepared hook 时返回的孤儿 operation 也会先被中断。`maxParallel` 在 Run 行锁内同时计算 running、waiting 和活租约占用，避免并发 sweep 超额启动。终态回调后同一 sweep 会立即再次派发新解锁节点；pipeline 因必需依赖失败而留下 blocked 后代时，以 Run 终态投影结束共享群组工具屏障，不再等待永远不会启动的 anchor 数量达到 K=N。上下文提示明确把上游 summary 视为低优先级数据，持久执行快照只保存 ID 引用、不复制 summary 或 Work 正文。Dispatcher / recovery / runtime 定向 Vitest 140 项、PGlite 24 项、一次性隔离 ParadeDB PostgreSQL 17 同组 24 项、定向 ESLint、agent-worker bundle 与完整 Next standalone Docker 构建均通过；全量 TypeScript 的既有基线仍失败，但本次改动文件无诊断。首个 Docker 构建仍被阿里 mirror 的 `node:24-slim` 403 阻断，改用 Docker 配置中已有的 DaoCloud 官方镜像入口后成功生成 Dev 镜像 `5779d50aa942...`；隔离 Dev app / agent-worker 已重建并 healthy，`3181/signin`、`3192/healthz`、`3193/healthz` 均为 200，Router 与 Device Gateway 未重建，生产未触碰。自动 Pipeline Dispatcher 本片完成；`createWorkflow` 的“草案—用户确认—创建运行”闭环和可恢复 debate 仍是阶段 5 后续任务。

状态续（2026-09-01，M3 createWorkflow 确认闭环第四片）：群组管理清单重新开放真实 `createWorkflow`，并强制 `humanIntervention=required`；模型先生成可编辑 DAG 草案，用户可在 Intervention UI 审核名称、并发预算、节点 Agent、依赖、角色、指令、重试和超时，只有显式批准才进入服务端执行。服务端拒绝缺少可信 user / group / supervisor / operation / topic / toolCall / toolMessage 上下文的调用，以 `create-workflow:${operationId}:${toolCallId}` 幂等创建固定 `planSnapshot` 与预算后立即交给 Pipeline Dispatcher；即时派发失败会保留持久 Run 供恢复 sweep 补投，已终态失败则直接返回，不让 supervisor 永久停在异步工具屏障。迁移 `0158_agent_group_run_tool_bridge` 为 Run 增加可空 `group_tool_message_id`，新入口持久绑定获批工具消息；Dispatcher 后续派发和恢复复用同一父工具消息、topic 与 supervisor 屏障，旧 Run 才回退稳定合成消息。服务端 createWorkflow / Dispatcher Vitest 15 项、PGlite AgentGroupRun 25 项、项目 TypeScript、定向 ESLint、SPA、Next standalone 与 agent-worker 构建均通过。DaoCloud Node 镜像入口成功生成 Dev 镜像 `81e23fcc2c2e...`；隔离 Dev app / agent-worker 已重建并 healthy，数据库列迁移存在，`3181/signin`、`3192/healthz`、`3193/healthz` 均通过，Router 与 Device Gateway 启动时间未变化，生产未推广。阶段 5 下一步只进入固定轮数、可恢复 debate；vote 与 summarize 继续保持关闭。

状态续（2026-09-01，M3 固定轮数 Debate 第五片）：新增真实 `createDebate` 并强制 `humanIntervention=required`；用户可在 Intervention UI 审核辩题、2–8 名参与者及视角、1–5 轮固定轮数、并发与超时 / 重试预算、独立 Judge 及裁决指令。批准后服务端以 `create-debate:${operationId}:${toolCallId}` 幂等创建不可变 Debate `planSnapshot`：每轮参与节点只依赖完整上一轮，形成持久轮次屏障，最终 Judge 只在末轮全部完成后就绪；Judge 不得与参与者复用身份，所有 Debate 节点强制禁用工具。既有 claim fencing、自动 Dispatcher、稳定 queue / device 派发、输出快照、失败阻断、显式重试恢复和终态 supervisor 投影已泛化到 pipeline / debate 共用的依赖图状态机；后续轮次上下文只携带已完成视角摘要与 WorkVersion ID 引用，并明确按不可信数据处理。PGlite AgentGroupRun 26 项和服务端 Debate / Dispatcher / runtime 定向 Vitest 164 项通过，覆盖跨 Model 实例逐轮解锁直至 Judge 和 Run 完成；相关文件定向 ESLint、`git diff --check`、SPA / Next standalone / agent-worker Docker 构建通过。全量 `tsc` 仍受既有 Desktop 资源 / 别名和前端全局类型基线错误影响，本次相关诊断已修正。DaoCloud Node 镜像入口生成 Dev 镜像 `4c65f0c0ed98...`；清理未使用 BuildKit 缓存释放空间后，隔离 Dev app / agent-worker 已强制重建并 healthy，`3181/signin` 与 `3192/healthz` 均为 200 / ok；生产 app / router 镜像与启动时间未变化，未推广。阶段 5 的 pipeline 与 Debate 已闭环；vote 与 summarize 继续保持关闭，下一阶段进入 Work / WorkVersion、Verify 与隔离代码协作。

### 阶段 6：Work、Verify 与隔离代码协作

- 先接 Work / WorkVersion 和 Verify。（已完成，Dev）
- 再开放只读代码协作。（已完成，Dev）
- 实现 WorkspaceIsolationService 后开放隔离写任务。（已完成，Dev）
- 最后实现 integrator + Verify；提交、推送和部署保持人工授权。（已完成，Dev；发布动作保持关闭）

退出条件：每项变更都有 operation、Attempt、WorkVersion、验证证据和审批谱系。

状态（2026-09-01，M4 阶段 6 Work / Verify 与隔离代码协作）：pipeline 与 debate 的节点策略新增不可变代码模式 `read_only / workspace_write / integrator`。写模式只允许在已确认的 pipeline 中使用，且必须同时具备人工写批准、明确 deviceId、workingDirectory、baseRef 和验证标准；Integrator 还必须显式依赖待集成节点。`WorkspaceIsolationService` 从源仓库 HEAD 派生确定性 branch / worktree，在复用或创建后再次校验路径和 HEAD，只把单个 Attempt 放入自己的工作区；运行结束先捕获 patch 为 `code_patch` 外部 Work / WorkVersion 引用，再进入 Verify gate，Verify 未成功会使 Attempt 失败。Intervention 与 Verify 可同时等待，只有最后一个门禁解除才恢复 Run。Claude Code 写模式固定为 `acceptEdits` 并限制为 Read / Write / Edit / MultiEdit，Codex 固定为 `workspace-write` 且关闭网络；两者的附加 CLI 参数均采用安全白名单，其他异构 runtime 不得静默忽略权限配置。运行时不会自动执行 commit、push、PR、merge 或 deploy；隔离 worktree 保留给用户审阅，发布仍需独立人工授权。验证通过：Plan 11 项、WorkspaceIsolation 4 项、Pipeline Dispatcher 10 项、AgentRuntime 132 项、AgentGroupRun PGlite 28 项、heterogeneous spawn 46 项及 aiAgent 权限拒绝定向回归，项目 TypeScript 无诊断；完整 Docker 构建生成 Dev 镜像 `995fe2a3aab2...`（`modelnet-toc-dev-app:agent-group-stage6-20260901`）。隔离 Dev app / agent-worker 已重建并 healthy，`3181/signin`、`3192/healthz`、`3193/healthz` 均为 200；Router 与 Device Gateway 未重建，生产未推广。阶段 6 退出条件满足；M4 的下一片进入阶段 7 UI、运维与可观测性。

### 阶段 7：UI、运维与可观测性

- 完成 Collaboration 配置、Run 树、历史、成本、审批、产物和 Verify UI。（已完成，Dev）
- 增加队列积压、租约超时、屏障等待、设备离线、失败率和成本指标。（已完成，Dev）
- 建立数据清理、trace 生命周期、死信处置和运行恢复手册。（已完成，Dev）

退出条件：用户无需查看容器日志即可理解运行状态，运维可定位到 runId / nodeId / attemptId / operationId。

状态（2026-09-01，M4 阶段 7 UI、运维与可观测性）：Run History 已扩展为运行详情入口，可直接查看 Run / Node / Attempt / Operation 谱系、节点依赖与 claim、执行位置、外部任务上下文、Work / WorkVersion、Verify、trace、隔离工作区和 patch 摘要；审批、屏障、租约、失败原因与运行时间均在界面内呈现。新增群组运行时健康接口和队列统计，Redis Stream 模式会报告 backlog、inflight、dead letter、completed 和 failed；界面同时汇总活跃/过期租约、屏障等待、设备离线、Attempt 失败率、LLM/tool 调用、tokens 与成本。新增 `docs/modelnet-agent-group-operations-runbook.md`，按 runId / nodeId / attemptId / operationId 给出只读定位、恢复决策、死信处置、trace 生命周期和数据/工作区清理的 dry-run 与审批边界；自动破坏性清理和死信自动重放仍保持关闭。验证通过：Queue 与运行指标定向 Vitest 44 项、变更文件 ESLint、项目 TypeScript 和 `git diff --check`；完整 Docker 构建生成 Dev 镜像 `ee91c1b27966...`（`modelnet-toc-dev-app:agent-group-stage7-20260901`）。隔离 Dev app / agent-worker 已重建并 healthy，`3181/signin`、`3192/healthz`、`3193/healthz` 均为 200，队列与死信当前均为 0；生产 app / Router 镜像与启动时间未变化。阶段 7 退出条件满足，M4 完成；下一阶段进入阶段 8 外部 A2A 出站适配，生产推广仍需独立审批。

### 阶段 8：外部 A2A 出站适配

- 完成协议 spike 和版本锁定。（已完成，A2A 1.0 wire / v1.0.1 patch）
- 增加外部 Agent binding、信任策略和 credentialRef。（已完成，Dev 迁移验收通过）
- 实现出站 Adapter、流/轮询、Artifact、取消、Intervention 映射。（已完成，Dev 端到端验收通过）
- 在 dev 使用受控 mock 和一个受信任真实端点做小流量验证。（已完成，单元传输 mock + 私有 Dev HTTP/SSE 端点）

退出条件：外部 Agent 与本地 Agent 使用同一 Run / Node / Attempt、权限、产物和审计模型。

状态（2026-09-01，M5 阶段 8 Dev 评审）：协议 profile 锁定在 A2A `1.0` HTTP+JSON，跟随官方 `v1.0.1` 修复；支持 SSE、明确不支持时回退 send+poll、Task 查询/取消及 input-required 同 Task 续传，push callback 和动态协议扩展保持关闭。新增一对一本地 Agent binding、精确 Origin / 私网双白名单、仅 `env:A2A_*` 的 credentialRef、HTTPS 生产硬边界、无重定向 SSRF 安全请求以及响应大小/超时上限。`runtimeKind=external` 复用既有 Dispatcher claim fencing、确定性 AgentOperation、Run / Node / Attempt、Redis Stream 去重和恢复补投；远端 Task/Context 回填 `external_execution_ref`，Artifact 注册为 `a2a_artifact` Work/WorkVersion，input/auth required 映射到 `waiting_for_human` 与持久 Intervention，取消/超时尝试远端 cancel 后以本地生命周期为权威。个人 binding 按 user 隔离，workspace binding 对同 workspace 成员共享，并由数据库回归测试锁定。协议与安全说明见 `docs/modelnet-agent-group-a2a-outbound-profile.md`。定向单元、Dispatcher、恢复与数据库 Vitest 26 项（服务端 24 项、数据库 2 项）、变更文件 ESLint、`git diff --check`、Compose 配置、mock 脚本语法和完整 Docker 构建均通过；最终 Dev 镜像为 `b828de56d174...`（`modelnet-toc-dev-app:agent-group-stage8-20260901`）。迁移 `0159_external_agent_bindings.sql` 已在 Dev PostgreSQL 生效；App、agent-worker、A2A endpoint 均 healthy，`3181/signin`、`3192/healthz`、`3193/healthz` 与 A2A `/healthz` 均返回 200。真实 HTTP/SSE 小流量验收覆盖 `working → input-required → completed` 同 Task 续接、`report.txt` Artifact、`submitted → working → completed` 轮询和远端取消。生产推广同日完成：生产 App 与新增 agent-worker 均运行 `b828de56d174...`（`modelnet/modelnet-toc:agent-group-stage8-20260901`），迁移已在生产 PostgreSQL 生效，worker Redis 心跳正常且 backlog / inflight / dead letter 均为 0；`3081/signin`、`3092/healthz`、`3093/healthz` 和公网 HTTPS 入口均返回 200。生产 Router 与 Gateway 未重建；A2A 保持 HTTPS-only 且 Origin / 私网信任列表为空。阶段 8 退出条件与生产推广验收均满足，M5 完成。

## 十三、里程碑

| 里程碑             | 覆盖阶段 | 可交付能力                                                 |
| ------------------ | -------- | ---------------------------------------------------------- |
| M0 架构闭环        | 0        | 新旧边界明确，当前行为有测试                               |
| M1 持久内部协作    | 1–3      | 普通 Agent 的显式 single / broadcast / parallel 可恢复运行 |
| M2 异构 Agent 协作 | 4        | 普通 Agent 与 Claude/Codex 等安全混合执行                  |
| M3 协作协议        | 5        | 可恢复 pipeline 和 debate                                  |
| M4 产物闭环        | 6–7      | Work、Verify、隔离写入、UI 和运维闭环                      |
| M5 外部互联        | 8        | 受控出站 A2A Agent 参与同一协作模型                        |

每个里程碑独立评审和推广，不能以“最终目标需要”为理由一次性跨越多个安全边界。

## 十四、测试与验收

### 14.1 单元与契约测试

- Plan 校验：空成员、重复节点、越权成员、环、非法协议、非法预算。
- 状态机：合法迁移、终态幂等、取消竞争、超时竞争、重复回调。
- 屏障：K=N、部分启动失败、部分完成、成员超时、重试后收敛。
- 权限：成员/群组/协议/节点/运行时工具交集。
- ExecutionPlan：normal、hetero、local、sandbox、device、offline、workspace 安全。
- 数据：Run / Node / Attempt / Operation 唯一约束和 workspace 隔离。

### 14.2 集成与恢复测试

- App 重启时 supervisor 处于 waiting_for_async_tool。
- worker 重启时消息已领用但未确认。
- Redis 暂停后恢复，任务无丢失和重复 Attempt。
- group member callback 重复、乱序和迟到。
- Device Gateway 断线、重连、resume_complete 和事件重放。
- Intervention 在客户端离线期间产生并在重新连接后恢复。
- Work 注册重试不产生重复版本；Verify 修复链不覆盖原版本。

### 14.3 安全测试

- 跨用户、跨 workspace、跨 group 越权。
- Agent 配置变更与运行快照不一致。
- 工具权限提升、审批绕过和敏感参数泄露。
- 工作区路径逃逸、符号链接、非目标 worktree 写入。
- A2A SSRF、DNS rebinding、重定向、超大响应、凭据泄露和伪造回调。

### 14.4 dev 真实请求

- 所有真实请求只在 modelnet-toc-dev 执行，生产 3081/3092 不受影响。
- 每个 runner 保持 1–2 个小请求，避免无边界成本。
- 覆盖普通 Agent 单节点、双成员 broadcast、双成员 parallel_tasks。
- 异构阶段加入一个只读 Codex 或 Claude 任务；写任务在隔离阶段后才加入。
- 验证 UI、API、数据库、Redis、RustFS trace、Router 和 Device Gateway 的同一 ID 链。

### 14.5 每阶段通用门禁

- 相关 Vitest / unit tests 通过。
- modelnet-app 执行 bun run check 通过。
- 数据库迁移前进和回滚演练通过。
- git diff --check 通过。
- dev compose 健康；TOC、Router、Device Gateway、worker 的 health check 通过。
- 未在配置、日志、事件、数据库或文档中写入秘密。

## 十五、灰度、回滚与迁移

建议 feature flags：

- AGENT_GROUP_SERVER_ORCHESTRATION
- AGENT_GROUP_DURABLE_RUNS
- AGENT_GROUP_HETERO_EXECUTION
- AGENT_GROUP_ADVANCED_PROTOCOLS
- AGENT_GROUP_WORKSPACE_WRITE
- AGENT_GROUP_A2A_EXECUTION

队列实现继续由 AGENT_RUNTIME_MODE 选择，但新增明确的 redis-stream 模式，不复用含义模糊的 queue 值。

迁移规则：

1. flag 关闭时，现有行为不变。
2. 已开始的客户端旧运行在旧路径结束；不做中途接管。
3. 新运行按 group / user 灰度进入服务端路径。
4. 新路径产生的 Run 数据不回写成旧客户端内存状态。
5. 回滚只阻止新运行进入新路径；已运行任务由恢复器完成或明确取消。
6. 客户端调度代码只有在一个完整观察窗口无回退后才删除。
7. dev 验证通过不等于生产推广；生产 compose、数据库迁移和开关需单独审批。

## 十六、主要风险与控制

| 风险                               | 控制                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| 客户端和服务端双调度造成重复执行   | 新运行只选择一个 owner；operation / attempt 唯一约束；旧运行不接管           |
| Redis 队列与 PostgreSQL 状态不一致 | DB 先提交、outbox 补投、消费前读事实、幂等终态                               |
| 父子 operation 与 Run 节点关系漂移 | Attempt 强制唯一绑定 operationId，所有回调校验四级 ID                        |
| 异构 Agent 静默换设备或执行环境    | 保存 ExecutionPlan 快照；不可用即 blocked，不自动 fallback                   |
| 群组扩大单 Agent 工具权限          | 五层权限交集，只能收窄不能扩大                                               |
| 多成员写同一代码目录               | 每 Attempt 独立隔离目录，集成由专门节点完成                                  |
| 产物和消息被重复保存               | Work、Verify、Messages 保持唯一事实源，群组只存引用                          |
| 上游继续大规模升级                 | 尽量扩展既有 Host / Port / Service 边界，少改 route shell 和共享 UI 基础设施 |
| A2A 协议变化或供应方差异           | 先 spike、锁版本、Adapter 隔离、契约测试，不把 SDK 类型泄露到核心            |
| 成本失控                           | Run / Node 双层预算、并发限制、真实请求最小化、成本事件可见                  |

## 十七、明确不在首版范围

- 重构 modelnet-router 的模型算法、模型 ID 或 Registry 生产链。
- App 绕过 Router 直连具体 K8S 模型。
- 恢复已退役 LiteLLM。
- 单独部署新的 Agent Plane 服务或独立 Agent 数据库。
- agent.auto、无限 DAG、动态扩员、自主改写协作图。
- 裸模型、任意脚本、Agent Card URL 直接作为群组节点。
- 成员之间任意点对点通信。
- 公网入站 A2A server。
- 无人工授权的 Git commit、push、PR merge 或生产部署。
- 未隔离工作区中的多 Agent 并发写入。

## 十八、推荐的首个实施批次

首批只建立“持久、可恢复、可审计的现有三种群组动作”，不碰异构 Agent、A2A、代码写入和高级协议。

### PR 1：行为冻结与 ADR

- 以本文作为架构入口。
- 扩充 groupManagement 和 groupMember executor 特征测试。
- 建立 client / server 语义对照和迁移 flag。
- 不改变默认运行路径。

### PR 2：运行谱系

- 新增 agent_group_runs、agent_group_run_nodes、agent_group_run_attempts。
- 新增 schema、migration、model、repository 和 workspace ACL 测试。
- 新增 GroupCollaborationService 骨架与 plan validator。

### PR 3：接入现有服务端群组动作

- speak、broadcast、executeAgentTask(s) 创建 Run / Node / Attempt。
- 回调统一更新 Attempt、Node、屏障和 supervisor operation。
- 补齐重复请求、部分启动失败、超时和迟到回调测试。

### PR 4：dev 持久队列

- 实现 redis-stream QueueService 和 agent-worker。
- 在 docker-compose.dev.yml 中增加 worker，但不改生产 compose。
- 通过 App / worker 重启和消息重领测试。

状态（2026-08-30）：已在 Dev 栈完成。Redis Stream consumer group、延迟重试、租约心跳与重领、DLQ、worker token 鉴权和相对 endpoint 固定到内部 App origin 均已通过定向测试与运行时验证；生产 compose 未改。

### PR 5：取消、恢复和观测

- 实现 server interrupt。
- 增加恢复 sweeper、Run 事件和最小查询 UI。
- 仅在 dev 为测试用户打开 AGENT_GROUP_DURABLE_RUNS。

状态（2026-08-31）：Dev 代码、部署和 M1 主协议真实恢复验收完成。Redis Stream 模式的内部成员回调改由 worker bearer 鉴权直投，不再依赖 QStash；取消会在请求内幂等终态化 supervisor 与全部 active member operation。真实 Dev 证据：`agr_HUYxYOPMquEK` 在 317 ms 内把 Run、2 Node、2 Attempt 和 3 个 operation 全部收敛为取消/中断终态；`agr_xRRyZU6mUWNh` 在 Redis pending 消息和 supervisor `waiting_for_async_tool` 两个时点重建 app / worker 后恢复完成，Attempt 始终只有 2 个且均为 attemptNo=1；`agr_HO8Ch2cttQrZ` 的 1000 ms watchdog 将 2 Node 收敛为 `failed + timeout`、2 Attempt 收敛为 `timed_out + timeout`；`agr_8y48G98pFfCj` 以 1 Node / 1 Attempt 完成 `single`；`agr_CgGkeaIlitzF` 以 2 Node / 2 Attempt 完成 `broadcast`；`agr_l0IsBNLsiYDM` 在 Dev Redis 暂停 8 秒并恢复后自动完成，2 个成员仍各只有 attemptNo=1，同一成员完成回调再重复投递两次均返回 `resumed=false`，没有新增 Attempt 或 operation；`agr_bezBBtFdWwtb` 首轮以 2 Node / 2 Attempt 完成 `broadcast`，随后对节点 `71e9e8ed-4c7c-45f7-a04c-f9d78b2fcab8` 显式重试，Run 从 completed 重开并以 attemptNo=2 再次完成，`node.retry_started`、`run.reopened` 和第二组 node/run terminal 事件完整，再次重试被 `PRECONDITION_FAILED` 拒绝，Attempt 总数保持 3、operation 总数保持 4。v11 又在该 Run 已完成 attemptNo=2 后重放旧 attemptNo=1 的矛盾 `error` 回调，回调返回 `resumed=false`，Run 仍为 completed，Attempt / operation / event 分别保持 3 / 4 / 19，旧 anchor 仍为 completed 且无 plugin error。v12 的 `agr_vs6KJTbhYPJ8` 在 supervisor 到达 `waiting_for_async_tool` 屏障后原子暂停为 Run `waiting + manual_pause` 和 operation `waiting_for_group_resume`；两名成员及各自 attemptNo=1 均完成后，Run 仍保持人工暂停，恢复前事件为 `run.paused=1 / run.resumed=0 / run.terminal=0`；显式恢复返回 `resumed=true` 并一次收敛为 completed，最终 `run.paused / run.resumed / run.terminal` 各 1，重复恢复被 `PRECONDITION_FAILED` 拒绝，Attempt / operation 总数保持 2 / 3。Attempt 的明确原因由迁移 `0155_charming_miracleman.sql` 持久化。PGlite 46 项、服务端定向 Vitest 188 项、项目 TypeScript、Worker bundle、Next standalone build、Dev 迁移和 v12 容器 health 均通过；既有更宽的服务端定向 Vitest 216 项恢复验证仍有效。`AGENT_GROUP_DURABLE_RUNS=1` 仍只存在于忽略版本控制的 `.env.dev`，生产 compose 和生产开关未改。M1 Dev 评审通过；下一步进入 M2 异构 Agent / ExecutionPlan 契约收口，不自动推广生产。

上述五个 PR 已完成 M1 Dev 评审；M2 已完成异构 Agent / ExecutionPlan 的 prepared-boundary 契约、工具权限收窄、设备离线/重连幂等、事件重放与 Intervention 运行级门禁，并通过真实只读普通 Agent + 本机登录态 Codex 混合群组、真实 Dev Gateway 和真实 Dev PostgreSQL Intervention 恢复验收。M3 已完成固定计划、固定预算、持久认领、稳定派发、恢复补投、结构化输出交接、自动 Pipeline Dispatcher、createWorkflow 用户确认闭环，以及固定轮数、可恢复 Debate 与 createDebate 确认入口。M4 已完成 Work / WorkVersion、Verify、只读与隔离写协作、Integrator 安全门禁、Run 详情 UI、运行时指标和运维手册并部署隔离 Dev。M5 已完成受控出站 A2A binding、信任与凭据边界、共享生命周期映射、隔离 Dev 验收及生产推广；外部 A2A 信任列表默认保持关闭，新增受信端点仍需显式配置。

## 十九、最终验收清单

- [ ] Agent 协作控制面只存在于 ModelNet App Server。
- [ ] Router 继续只承担模型级路由/聚合，不保存 Agent 状态。
- [ ] Run / Node / Attempt / Operation 谱系完整且可查询。
- [ ] single、broadcast、parallel_tasks 可暂停、取消、恢复和显式重试。
- [ ] App、worker 或浏览器重启不丢运行，不产生重复执行。
- [x] 设备离线明确失败；同一进程重连可安全重试 ACK，写任务不自动重放。
- [ ] 客户端 GroupOrchestration 重复调度路径已安全退役。
- [x] 普通 Agent 与异构 Agent 使用同一 Member Dispatcher 和 ExecutionPlan。
- [x] 群组工具权限只能收窄成员原权限。
- [ ] Intervention、Work、Verify、Tasks 和 Goals 均保持各自唯一事实源。
- [x] pipeline 在固定计划、固定预算下由自动 Dispatcher 可恢复执行。
- [x] debate 在固定计划、固定预算下可恢复执行。
- [x] 代码写任务具备独立隔离目录、变更谱系、Verify 和人工发布门禁。
- [x] 外部 Agent 只通过受信任绑定和出站 Adapter 接入。
- [x] dev 全链路验收通过，生产仍保持未推广状态。

---

本计划的核心不是再增加一个大型编排服务，而是把 2026 年 8 月升级后已经存在的运行、设备、任务、产物、验收与干预能力，收敛为一个可恢复、可审计、可逐步推广的 Agent 协作系统。
