# Agent Group 服务端收口迁移契约

> 状态：阶段 0 基线
> 日期：2026-08-30
> 主计划：docs/modelnet-orchestrator-agent-group-master-plan.md
> 默认行为：不变

## 1. 目的

本文冻结当前 Agent Group 的执行语义，作为客户端旧编排路径退役和持久 Run / Node / Attempt 投影接入时的对照契约。

当前事实不是“群组仍默认在客户端编排”。新群组消息已经由以下链路启动服务端 supervisor operation：

```text
sendGroupMessage
  → aiAgent.execGroupAgent
  → AiAgentService.execGroupAgent
  → AiAgentService.execAgent
  → server AgentRuntime
  → lobe-group-management server runtime
  → buildServerAgentMemberRunner
  → AiAgentService.execGroupMember
```

客户端 GroupOrchestrationRuntime 仍存在，用于兼容旧的客户端工具回调与客户端异步任务语义。迁移期间不得让同一个工具调用同时进入两条路径。

## 2. 当前所有权

| 对象                         | 当前 owner                     | 事实源                                         |
| ---------------------------- | ------------------------------ | ---------------------------------------------- |
| 新群组用户消息               | App Server                     | execGroupAgent 返回的 operationId              |
| supervisor 循环              | 服务端 AgentRuntime            | supervisor agent_operations 行与 Redis state   |
| speak / broadcast / delegate | 服务端 groupManagement runtime | supervisor tool call + member child operations |
| isolated member task         | 服务端 execGroupMember         | member operation、thread 和完成 bridge         |
| 旧客户端编排 loop            | 浏览器 Store                   | 客户端 operation 内存状态，仅兼容旧入口        |
| 消息                         | App PostgreSQL                 | messages / topics / threads                    |
| 成员执行摘要                 | App PostgreSQL                 | agent_operations                               |

## 3. 行为对照

| 动作               | 客户端旧语义                                                                | 服务端当前语义                                                                          | 收口要求                                                                               |
| ------------------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| speak              | 在共享消息历史中以 subAgentId 执行一个成员；instruction 是虚拟 user message | in_group 子 operation；instruction 是 suppressUserMessage 的临时 speaker prompt         | 消息中不得持久化 supervisor instruction；成员完成后按 skipCallSupervisor resume/finish |
| broadcast          | 并行 executeClientAgent，成员响应挂在同一 tool message，默认 disableTools   | in_group 并行成员，AgentCouncil 元数据，K=N 屏障，默认 disableTools                     | 成员数、顺序、工具禁用和结果归因一致                                                   |
| delegate           | 执行一个共享会话成员，delegated 后结束旧 loop                               | in_group 子 operation，onComplete 固定 finish                                           | 成员完成后 supervisor 不再运行                                                         |
| executeAgentTask   | 创建 isolated thread；服务端任务轮询，runInClient 时可走桌面                | isolated 子 operation + completion bridge + timeout watchdog                            | 服务端不解释 runInClient；执行位置后续统一交给 ExecutionPlan                           |
| executeAgentTasks  | 并行 isolated tasks，等待整批结果                                           | 并行 isolated 子 operations，K=N 屏障，当前取最长 timeout                               | 后续持久层记录每个节点自己的 timeout；兼容期保持现状                                   |
| skipCallSupervisor | 成员/任务完成后状态机直接 finish                                            | runner onComplete=finish                                                                | 所有支持动作必须一致                                                                   |
| 成员启动失败       | 客户端 executor 返回失败结果                                                | 回填失败 anchor；至少一项启动则等待屏障，全部失败则删除 placeholder 并返回 inline error | 不允许 supervisor 永久停在 waiting_for_async_tool                                      |
| cancel             | 客户端检查 operation cancelled                                              | supervisor/child operation 中断能力存在，但 server interrupt 工具仍是占位               | 阶段 2 前不得宣称完整取消闭环                                                          |

## 4. 迁移开关

AGENT_GROUP_DURABLE_RUNS 只控制新增的 Run / Node / Attempt 持久投影，默认值为 0。

它不控制新群组消息是否走服务端，因为服务端已经是当前默认 owner；也不能把一个已开始运行从客户端接管到服务端或反向迁移。

开关规则：

1. 关闭时，当前服务端执行和客户端兼容路径行为不变。
2. 打开时，只为新建的服务端群组运行写入持久投影。
3. 已开始的运行固定在创建时的 owner 和数据契约上。
4. 写投影失败不得静默继续；在持久运行成为正式事实源前，灰度用户收到明确启动失败。
5. 生产环境在独立审批前保持关闭。

## 5. 阶段 0 特征测试

### groupManagement runtime

- speak 创建单个 in_group 成员，并正确选择 resume / finish。
- broadcast 创建 N 个 in_group 成员，强制 disableTools，并正确选择 resume / finish。
- delegate 固定 finish。
- executeAgentTask(s) 使用 isolated 模式并透传 timeout。
- 空参数、成员 runner 不可用、全部启动失败都返回 inline error，不 park supervisor。
- interrupt、summarize、createWorkflow、vote 继续返回非 deferred 占位结果，直到对应阶段实现。

### server member runner

- 缺失 execGroupMember、agentId、topicId 或 groupId 时不可用。
- 空成员集不创建消息。
- 单成员复用 group tool message 作为 barrier anchor。
- 多成员创建 K=N anchors；in_group 多成员标记 AgentCouncil。
- 成员显示名只在唯一精确匹配时解析为持久 agentId。
- 部分启动失败回填对应 anchor，成功成员仍可使屏障收敛。
- 全部启动失败清理全部 placeholder，不遗留永远 pending 的工具消息。

## 6. 进入阶段 1 的门禁

- 上述特征测试通过。
- @lobechat/env 的开关解析测试通过。
- modelnet-app 质量检查通过。
- git diff --check 通过。
- AGENT_GROUP_DURABLE_RUNS 在 dev 和生产均保持 0。
- 没有修改生产 compose、生产数据库或运行中的服务。

## 7. 实施记录（2026-08-30）

已完成：

- PR1：冻结服务端群组语义，补齐 groupManagement 与 group-member runner 特征测试；开关默认关闭。
- PR2：新增 `agent_group_runs`、`agent_group_run_nodes`、`agent_group_run_attempts` schema、0152 迁移、Model、Repository、workspace ACL、显式计划编译器和 GroupCollaborationService。
- PR3 代码接入：现有 group-member runner 在开关打开时创建持久 Run/Node/Attempt；同一 supervisor operation + tool call 使用稳定幂等键，重放不再启动第二组成员。
- PR3 完成接入：本地 Hook、QStash callback 与 timeout watchdog 携带同一 Run/Node/Attempt 引用；完成桥在消息 barrier 前幂等收敛 Attempt、Node、Run。
- 查询谱系包含 supervisor/member `agent_operations`，成本、错误和执行摘要继续只以 AgentOperation 为事实源，不复制到 Run 表。
- 隔离 dev Postgres 已完成 0152 前进、空表回滚、再次前进；最终三表存在，迁移哈希一致，dev app、Router、Device Gateway 均健康。

仍未完成：

- `modelnet-app` 新代码尚未部署进 dev 镜像。本次构建在解析 `node:24-slim` 时被 Docker daemon 配置的阿里云镜像端 `403 Forbidden` 阻断；随后项目要求的本地 `127.0.0.1:7890` 代理不可连接。
- 因此 dev 运行中的 app 只验证了 0152 迁移和旧路径健康；特性开关仍为 `0`，没有执行真实的 feature-on 群组请求。
- PR4 Redis Stream worker、恢复、取消和重领逻辑尚未开始。

生产状态：生产 Compose、数据库和 3081/3092/3093 服务均未修改或重启。
