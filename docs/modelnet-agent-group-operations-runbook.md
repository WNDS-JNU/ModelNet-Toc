# ModelNet Agent Group 运行与恢复手册

本文对应 Agent Group 主计划阶段 7，覆盖协作 Run 的定位、队列与租约监控、设备失败、死信、trace 生命周期、数据清理和恢复边界。本文以隔离 Dev 为默认环境；生产操作必须在 Dev 验证后另行授权。

## 1. 首选入口与标识链

群组会话右上角的“协作运行”是首选入口。定位顺序固定为：

1. runId：一次已确认的协作计划实例。
2. nodeId：计划中的持久节点，保存依赖、屏障和调度租约。
3. attemptId：节点的一次不可变执行尝试；重试必须创建新 Attempt。
4. operationId：一次 Agent Runtime 执行，关联队列、设备、trace、成本和 Token。
5. claimId：Dispatcher 短租约 fencing token；过期 token 不得创建或完成 Attempt。
6. WorkVersionId 和 verifyRunId：不可变交付版本和验证事实。

不要先按宽泛时间窗口扫容器日志，也不要只凭聊天消息推断运行状态。

## 2. 无日志状态判断

Run History 同时展示全局运行时和当前 Run 指标：

- 运行时：队列积压、处理中、成功投递、失败投递、死信数量和 Redis 健康。
- Run：成本、Token、LLM/工具调用、处理时间、审批次数、等待屏障、活跃/过期租约、Attempt 失败率、设备离线次数、WorkVersion、VerifyRun 和 trace 数量。

| 可见状态             | 含义                                    | 首个动作                                            |
| -------------------- | --------------------------------------- | --------------------------------------------------- |
| 运行时异常           | 队列实现无法完成健康检查                | 检查 app、worker、Redis；不要重试节点制造更多投递   |
| 死信大于 0           | 投递已耗尽 worker 重试                  | 先导出死信并按 operationId 对齐 Attempt，再决定恢复 |
| 积压增长且处理中为 0 | worker 未消费或 consumer group 异常     | 检查 worker 和 Redis pending，不要清空 stream       |
| 过期租约增长         | Dispatcher 未在租期内完成 prepared 边界 | 按 nodeId/claimId 检查 recovery sweep               |
| 等待屏障大于 0       | 节点等待审批、Verify 或协议依赖         | 查看 completionReason 和 Verify 链接                |
| 设备离线大于 0       | 异构 Attempt 返回明确设备错误           | 恢复设备后创建新 Attempt；禁止重放旧写请求          |
| Verify 未通过        | 已产生交付但验证门禁未解除              | 处理 Verify 失败项，不覆盖原 WorkVersion            |

指标是快照，不是告警阈值。是否异常应结合连续两个 10 秒刷新周期、Run 是否仍前进以及 worker 健康共同判断。

## 3. Dev 只读检查

所有命令在 /home/duxianghe/ModelNet-toc 执行。

```bash
docker compose --env-file .env --env-file .env.dev -f docker-compose.dev.yml ps
curl -fsS http://127.0.0.1:3181/signin >/dev/null
curl -fsS http://127.0.0.1:3192/healthz
curl -fsS http://127.0.0.1:3193/healthz
```

Dev Redis 队列根键为 modelnet-toc-dev:agent-runtime。以下命令只读：

```bash
docker exec modelnet-toc-dev-redis redis-cli XLEN modelnet-toc-dev:agent-runtime:queue
docker exec modelnet-toc-dev-redis redis-cli XPENDING modelnet-toc-dev:agent-runtime:queue modelnet-toc-dev:agent-runtime:workers
docker exec modelnet-toc-dev-redis redis-cli ZCARD modelnet-toc-dev:agent-runtime:delayed
docker exec modelnet-toc-dev-redis redis-cli XLEN modelnet-toc-dev:agent-runtime:dead-letter
docker exec modelnet-toc-dev-redis redis-cli XREVRANGE modelnet-toc-dev:agent-runtime:dead-letter + - COUNT 20
```

数据库定位必须带明确 ID；禁止无条件扫描或修改全表。

```bash
docker exec modelnet-toc-dev-postgres psql -U postgres -d modelnet_dev -c "select id,status,protocol,completion_reason,updated_at from agent_group_runs where id = '<runId>';"
docker exec modelnet-toc-dev-postgres psql -U postgres -d modelnet_dev -c "select id,node_key,status,dispatch_claim_id,dispatch_claim_expires_at from agent_group_run_nodes where run_id = '<runId>' order by sort_order;"
docker exec modelnet-toc-dev-postgres psql -U postgres -d modelnet_dev -c "select id,run_node_id,attempt_no,operation_id,status,completion_reason from agent_group_run_attempts where id = '<attemptId>' or operation_id = '<operationId>';"
docker exec modelnet-toc-dev-postgres psql -U postgres -d modelnet_dev -c "select id,status,total_tokens,total_cost,trace_s3_key from agent_operations where id = '<operationId>';"
```

## 4. Run 恢复决策

恢复前先记录 Run History 中的完整标识链、最后事件和当前 Work/Verify 引用。

### 4.1 pending / running 长时间无进展

1. 确认运行时、队列和 worker 健康。
2. 节点有未过期 claimId 时等待当前租约，禁止第二次派发。
3. claim 过期后由 recovery sweep 用新 token 接管；观察 node.dispatch_lease_expired 事件。
4. Attempt 已有 operationId 但缺队列 ACK 时，由恢复边界使用原稳定 dedupe key 补投；不得手工复制 Redis envelope。
5. 只有节点进入允许重试的终态时，才在 UI 使用“重试节点”；它会创建新 Attempt。

### 4.2 waiting

- waiting_for_human：回到对话完成审批、拒绝或停止。
- waiting_for_verify：打开 Verify 报告；修复产生新 WorkVersion/Verify 链，不能改写旧事实。
- manual_pause：确认成员工作已到屏障后，在 UI 恢复。
- pipeline/debate 依赖屏障：检查上游 Node 是否真实 terminal，不能手工把下游改成 ready。

### 4.3 设备离线或断线

DEVICE_OFFLINE、DEVICE_DISCONNECTED、DEVICE_REQUEST_TIMEOUT 都是明确失败，不是可静默重放状态。恢复设备连接后，使用节点重试创建新的 attemptId/operationId。原写请求不能重放。

### 4.4 终止

“取消运行”会持久中断活跃 operation 并让 Run 收敛。不要直接停 Redis 或删除数据库行来模拟取消。若取消后未终态，按 operationId 检查终态回调与 recovery sweep。

## 5. 死信处置

Redis dead-letter entry 保存原 envelope、最终错误和 dead-letter 时间。处置顺序：

1. 只读导出目标 entry，并提取 operationId。
2. 确认它所属的 attemptId、nodeId 和 runId。
3. 判断 operation 是否已终态、是否已有后续 Attempt、是否涉及写工作区。
4. 通过 Run 恢复或 UI 节点重试创建合法的新 Attempt。
5. 验证新 Attempt 终态、WorkVersion 和 Verify 后，才把旧 entry 标为已处置。

禁止把 dead-letter 的 body 直接 XADD 回主队列；这会绕过新 Attempt、claim fencing、人工审批和工作区隔离。阶段 7 不提供“一键重放死信”。

当前自动删除死信保持关闭。需要裁剪时，必须先导出目标 entry，确认每个 operationId 已终态且无调查需求，再提交明确 stream ID 范围的变更；不得使用 DEL modelnet-toc-dev:agent-runtime:* 或无范围的 XTRIM。

## 6. Trace 生命周期

- 执行中 partial：agent-traces/_partial/<operationId>.json.zst。
- 终态 final：agent-traces/<agentId>/<topicId>/<operationId>.json.zst。
- 数据库引用：agent_operations.trace_s3_key。
- 读取：经 owner/workspace 作用域检查的 agentTrace.getSnapshotUrl 生成短期预签名 URL。

final 写入后，运行时会尽力删除新旧 partial。Run UI 只显示 trace 是否存在，不暴露存储 key 或长期公开 URL。

阶段 7 的清理规则：

1. 活跃 operation 的 partial 和 final 都不得清理。
2. final 对象必须先通过 trace_s3_key 引用审计；删除对象和清空引用必须属于同一受控任务。
3. 安全/事故调查、失败 Verify、未处理死信关联的 trace 必须保留。
4. 当前没有自动 final-trace 保留期任务；在实现可 dry-run、可审计、引用安全的 job 前保持关闭。
5. S3 生命周期规则不得单独删除 agent-traces/，否则数据库会留下悬空引用。

## 7. Run、Work 与隔离工作区清理

- 删除 Run 可级联 Node、Attempt、Event，但 AgentOperation、Work/WorkVersion、VerifyRun 是独立事实，不能假设随 Run 安全删除。
- retained_for_review 的隔离 worktree 是用户审阅现场；自动清理保持关闭。
- 只有 Run terminal、Verify 成功或明确豁免、patch 已登记 WorkVersion、没有待审批/事故/死信引用、且发布动作已独立结束后，隔离工作区才具备清理资格。
- 用户删除群组/工作区的既有级联规则优先；运维不得用绕开模型的 SQL 删除制造孤儿记录。

阶段 7 采用“先 dry-run 报告，后显式批准执行”的清理模式。当前交付只建立规则和可观测引用，未开放自动或 UI 删除；后续清理 job 必须输出候选 runId、operationId、trace key、WorkVersionId、verifyRunId 和 worktreePath，并逐项记录结果。

## 8. Dev 重建后的验收

```bash
docker compose --env-file .env --env-file .env.dev -f docker-compose.dev.yml ps
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3181/signin
curl -fsS http://127.0.0.1:3192/healthz
curl -fsS http://127.0.0.1:3193/healthz
```

在 UI 中打开已有 Run，确认运行时统计可见，四级 ID 可读取，成本/失败率/设备离线/租约/屏障有值或明确为 0，且 WorkVersion、工作区、Verify 和 trace 能按 Attempt 对齐。最后确认生产容器镜像和启动时间未变化。

## 9. 事故记录最小字段

每次恢复或清理至少记录：环境、时间、操作者、runId、nodeId、attemptId、operationId、claimId、死信 stream ID、错误码、原状态、所选动作、新 attemptId/operationId、WorkVersionId、verifyRunId、最终状态以及是否触碰生产。
