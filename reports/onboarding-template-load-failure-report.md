# 注册后“加载模板失败”问题调查报告

调查时间：2026-06-17  
调查范围：`4A100:/home/duxianghe/ModelNet-toc`  
相关服务：`lobehub-toc-lobe`、`lobehub-toc-lb`

## 结论

注册流程本身已经完成，失败点不在本地账号注册，而在注册/引导末尾的 Agent 模板选择组件加载 Marketplace 模板时，后端代理接口 `market.agent.getOnboardingFull` 调用上游 `https://market.lobehub.com/api/v1/agents/onboarding-full` 被拒绝。

当前运行容器没有可用于 Lobe Market 的认证凭据：

- 没有配置 `MARKET_TRUSTED_CLIENT_ID` / `MARKET_TRUSTED_CLIENT_SECRET`，因此无法生成 `x-lobe-trust-token`。
- 新注册的本地用户没有 Market OIDC access token，`settings.market.accessToken` / `mp_token` 也无法提供 `Authorization: Bearer ...`。
- 上游接口现在要求 bearer token；无凭据请求会返回 `401 Unauthorized`，响应体为 `{"error":"unauthorized","error_description":"Missing bearer token"}`。

因此前端拿到 tRPC 错误后显示中文文案“加载模板失败。请稍后再试。”

## 现象对应代码

前端错误文案来自：

- `lobehub/locales/zh-CN/tool.json:38`
  - `agentMarketplace.picker.failedToLoad`: `加载模板失败。请稍后再试。`
- `lobehub/src/routes/onboarding/features/AgentPickerStep/index.tsx:162`
  - 注册/引导末尾的模板选择页在 `error` 存在且模板为空时显示该文案。
- `lobehub/packages/builtin-tool-web-onboarding/src/agentMarketplace/client/Intervention/PickAgents/index.tsx:163`
  - Web onboarding 工具的模板选择交互也复用同一个失败文案。

## 调用链

1. `AgentPickerStep` 调用 `useOnboardingAgentTemplates()`。
2. `useOnboardingAgentTemplates()` 调用 `fetchOnboardingAgentTemplates()`。
3. `fetchOnboardingAgentTemplates()` 通过 `lambdaClient.market.agent.getOnboardingFull.query(...)` 请求本地 tRPC。
4. 本地 tRPC 路由在 `lobehub/src/server/routers/lambda/market/agent.ts:459` 实现 `getOnboardingFull`。
5. 该路由继续请求 `MARKET_BASE_URL/api/v1/agents/onboarding-full`；未设置 `MARKET_BASE_URL` 时默认是 `https://market.lobehub.com`。
6. 请求头只会在以下两种情况下带认证：
   - `generateTrustedClientToken(userInfo)` 成功时设置 `x-lobe-trust-token`。
   - 存在 `marketOidcAccessToken` 时设置 `Authorization: Bearer ...`。

## 现场证据

### 1. 运行容器缺少 Market 认证环境变量

在 `lobehub-toc-lobe` 容器中检查与 Market/代理/认证相关的环境变量，只看到：

```text
APP_URL=http://123.56.135.150
```

未看到 `MARKET_TRUSTED_CLIENT_ID`、`MARKET_TRUSTED_CLIENT_SECRET`、`MARKET_BASE_URL`、`HTTP_PROXY`、`HTTPS_PROXY` 等配置。

### 2. 上游接口无 token 直接返回 401

在 4A100 主机上直接请求：

```text
GET https://market.lobehub.com/api/v1/agents/onboarding-full?locale=zh-CN
http_code=401
body={"error":"unauthorized","error_description":"Missing bearer token"}
```

在 `lobehub-toc-lobe` 容器内用 Node `fetch` 请求同一接口：

```text
status=401 Unauthorized
content_type=application/json
body_prefix={"error":"unauthorized","error_description":"Missing bearer token"}
```

这说明不是 DNS 或公网不可达问题；请求已经到达上游，失败原因是缺少认证。

### 3. Lobe 服务日志记录了同一路径失败

`docker logs --since 6h lobehub-toc-lobe` 中出现：

```text
Error in tRPC handler (lambda) on path: market.agent.getOnboardingFull, type: query
Error [TRPCError]: Failed to get onboarding full: Unauthorized
  code: 'INTERNAL_SERVER_ERROR',
  [cause]: Error: Failed to get onboarding full: Unauthorized
```

同一时间段还有多条 Market 相关请求报：

```text
Request error: {"error":"unauthorized","error_description":"Missing bearer token"}
```

## 为什么注册完成后仍然会失败

这里有两个账号/认证域：

- 本地 LobeHub 注册登录：让用户可以进入本地应用，满足 `authedProcedure`。
- Lobe Market API 认证：用于访问 `market.lobehub.com` 的模板、连接、市场资源。

当前“注册完成”只解决了第一个认证域。模板接口属于第二个认证域，仍需要 trusted-client token 或 Market OIDC bearer token。由于当前部署没有配置 trusted-client，也没有给新用户完成 Market OIDC 授权，所以本地服务向 Market 转发请求时没有带任何有效 token，上游返回 401。

## 影响范围

- 影响注册/引导末尾的 Agent 模板推荐/选择模块。
- 也可能影响其它依赖 Lobe Market 的功能，例如 Market connection 列表，日志中已经看到 `market.connectListConnections` 也因 `Missing bearer token` 失败。
- 不影响本地账号创建本身，也不直接说明 ModelNet 路由、LiteLLM 或数据库注册链路有问题。

## 修复建议

### 方案 A：生产部署配置 trusted-client

适合希望本地注册用户自动访问 Lobe Market 模板的部署。

1. 向 Market 服务侧确认可用的 trusted client 配置。
2. 在 `/home/duxianghe/ModelNet-toc/.env` 中配置：
   - `MARKET_TRUSTED_CLIENT_ID`
   - `MARKET_TRUSTED_CLIENT_SECRET`
3. 重启 `lobehub-toc-lobe`。
4. 验证 `getOnboardingFull` 返回 200，前端模板卡片正常显示。

注意：`MARKET_TRUSTED_CLIENT_ID` 必须被上游 Market 白名单接受；仅本地随便生成 secret 不够。

### 方案 B：走 Market OIDC 授权

适合希望用户显式登录/连接 Lobe Market 的部署。

1. 确认 Market OIDC 登录流程可用。
2. 确认授权后 token 被写入用户设置中的 `settings.market.accessToken`，或请求 cookie 中存在 `mp_token`。
3. 再触发模板加载。

### 方案 C：自托管 fallback，避免注册流程依赖外部 Market

适合内网、自托管、离线或不希望依赖 Lobe Market 认证的场景。

1. 将一份 curated onboarding templates 本地化到仓库或数据库。
2. `fetchOnboardingAgentTemplates()` 或 `getOnboardingFull` 在 401/无 Market 凭据时返回本地模板。
3. 前端可继续显示模板；同时记录 warning，避免用户看到“加载模板失败”。

这个方案对用户体验最稳，但需要决定本地模板数据源与更新策略。

## 建议验证步骤

修复后执行：

1. 检查容器环境变量存在：

```bash
docker exec lobehub-toc-lobe sh -lc 'env | grep -E "^(MARKET_TRUSTED_CLIENT_ID|MARKET_TRUSTED_CLIENT_SECRET|MARKET_BASE_URL)="'
```

2. 重新进入注册/引导末尾模板选择页。
3. 查看服务日志不再出现：

```text
market.agent.getOnboardingFull
Failed to get onboarding full: Unauthorized
Missing bearer token
```

4. 模板卡片应正常显示；若仍失败，下一步应检查 trusted client 是否被上游白名单接受，或 Market OIDC token 是否已写入用户设置。

