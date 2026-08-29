# Plan 460: REST Template Connector — 把 OAuth HTTP provider 的 invoke 也声明化

> **Status**: Planning
> **Priority**: P1
> **Created**: 2026-08-29
> **依赖**: [455-open-connector-registry](./455-open-connector-registry.md)（**必须先完成** Phase A/B——`AppConnectorId` 品牌类型 + 统一 `AppConnector` 类 + `.app.json` schema；本计划的 REST Template 是统一类 `rest` 绑定的实现）；[449-risk-tier-approval](./449-app-connection-approval-parity.md)（审批分级）；[450-app-connection-codex-alignment](./450-app-connection-codex-alignment.md)（@提及激活 + 目录缓存）
> **源码依据**: `E:\cloned-projects\codex` `codex-rs` + `docs/references/codex-deep-dive/17-plugin-marketplace-and-app-connector.md`
> **校验目标**: Slack（最简 OAuth HTTP provider）→ Microsoft 365 → Google Drive

---

## 1. Problem & Goal

Plan 455 把 `ProviderId` 从闭合 union 开放为 `AppConnectorId` 品牌类型，并把 **Remote MCP 形态的 connector** 接入"声明即注册"。但它**显式排除**了 OAuth HTTP API provider：

> 455 D4：「声明带 `remoteMcpUrl` 的 connector 全部路由到 `remote-mcp.ts`，不写专属 `connectors/*.ts`」。**专属模块只留给需要特殊 token 处理的一等方 provider**。

但当前 `connectors/` 下还有 4 个一等方 provider **不是因为有特殊 token 处理**，而是因为 invoke 函数是 TS 写的：

| Provider | 文件 | 行数 | invoke 是否需要 TS？ |
|---|---|---:|---|
| microsoft365 | `connectors/microsoft365.ts` | 112 | ❌ 纯 HTTP + Bearer token，REST Template 可覆盖 |
| slack | `connectors/slack.ts` | 123 | ❌ 纯 HTTP + Bearer token，REST Template 可覆盖 |
| wecom | `connectors/wecom.ts` | 257 | ✅ spawn 外部 `wecom-cli` 子进程，**必须保留 TS** |
| google | `connectors/google.ts` | 341 | ⚠️ 80% 是工具 descriptor + 标准 HTTP，REST Template 可覆盖；20% 是 multipart upload（保留 escape hatch）|

**Goal**: 让 `slack`/`microsoft365`/`google` 三者的核心工具集能通过插件 `.app.json` 里的 REST Template 声明（统一类的 `rest` 绑定）来定义，**不再需要专属 `connectors/*.ts`**。

最终目标：**改一个 provider 的工具集 → 只改 JSON → 重启即生效 → 0 TS 改动**。

---

## 2. Codex 参照与边界

codex 的 app connector 模型（`codex-rs/codex-mcp/src/auth_elicitation.rs`、`connectors/src/plugin_config.rs`）已经把 OAuth HTTP 类的 connector 全部走 **Remote MCP** —— 即"让 provider 自己去实现 MCP server"。这是 codex 没有 REST Template 抽象的根本原因：**所有 provider 都提供 MCP 端点**。

duya 不能复用这个假设，因为：
1. **Slack 没有官方 hosted MCP**（截至 2026-08-29）
2. **Google Workspace 没有统一 hosted MCP**（只有分散的 `https://github.com/google-a2a/...` 第三方）
3. **Microsoft 365 有 `https://mcp.microsoft.com/...` 但 duya 的 first-party tools 用了更细的 scope**

所以 duya 需要一个**仅属于自己的** REST Template 层（codex 不需要）。**这是 duya vs codex 的明确分歧点**，不是"落后于 codex"，是"duya 直连架构下必须自己解决"。

---

## 3. Non-Goals

- **不做 OpenAPI 自动派生**（Layer 3）——留后续 plan；本 plan 只做 REST Template 的最小可用集
- **不做 GraphQL/SOAP/grpc**——duya 一等方 provider 没有这类
- **不做 webhook / 长连接 / SSE 流式响应**——tool 调用是 request/response 同步语义
- **不重写 wecom connector**——它的特殊 token 处理（CLI 子进程 + 环境变量注入）不属于本 plan 范围；保留 `customConnector` escape hatch
- **不做 per-provider 高级功能**——比如 Slack 的 `reactions.add` + emoji 解析、Microsoft 365 的 delta query、Google Drive 的 multipart upload；这些超出"声明式 REST 调用"语义，超出的部分继续走专属 `connectors/*.ts`
- **不改 OAuth 流程**——OAuth 路由仍在 `app-connection-service.ts`，本 plan 只接管 tool invoke 的 HTTP 调用部分
- **不做 connection-level 自定义**——比如 Slack workspace 多租户切换、Google 多账号切换；归 plan 314 后续

---

## 4. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│ .app.json (data declaration, per plugin root — 455 D3 统一文件)      │
│  {                                                                  │
│    "connectors": [{                                                 │
│      "id": "slack",                                                 │
│      "oauth": { ... },                                              │
│      "tools": [{                                                     │
│        "name": "slack_search_messages",                             │
│        "inputSchema": {...},                                        │
│        "riskTier": "read",                                          │
│        "invoke": {                                                  │
│          "method": "GET",                                           │
│          "url": "https://slack.com/api/search.messages",            │
│          "headers": { "Authorization": "Bearer ${accessToken}" },  │
│          "query": { "query": "${args.query}", "count": "${args.count ?? 20}" },
│          "response": {                                              │
│            "ok": "${body.ok}",                                      │
│            "errorPath": "body.error",                                │
│            "errorTemplate": "Slack API error: ${body.error}"        │
│          }                                                          │
│        }                                                            │
│      }}]                                                            │
│    }]                                                               │
│  }                                                                  │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ zod 解析 + 校验
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│ connector-service.ts: 在 455 Phase C 的 generic remote-mcp 旁      │
│ 的 `rest` 绑定（无 per-app TS 代码路径）                            │
│   - listTools() → 把 tools[] 转成 ConnectorToolDescriptor[]         │
│   - invoke()   → 把 invoke.action 映射到 invoke 字段，调通用 invoker│
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│ connectors/rest-template.ts（通用 invoker，~80 行 TS）             │
│   - 字符串模板插值（${args.x}、${accessToken}、${body.y}）          │
│   - HTTP 调用（fetch + retry）                                       │
│   - 错误映射（responseShape.errorPath + errorTemplate）              │
│   - OAuth token 自动注入（与 RemoteMcpConnector 同一 vault）        │
│   - 与 Plan 449 riskTier + Plan 450 spec 预算（≤8KB）兼容           │
└─────────────────────────────────────────────────────────────────────┘
```

**escape hatch**：即 455 D2/D4 的 `binding: 'custom'`——工具不声明 `invoke` 且其 connector 注册在首等方 `CustomConnectorImplementations` 时，落到原有专属 `connectors/<id>.ts` 模块（插件不可注册，仅 wecom / 过渡期 google）。

---

## 5. Design Decisions

| # | Decision | Choice | Reason |
|---|---|---|---|
| D1 | schema 路径 | 复用 455 Phase B 的 `.app.json`（统一 `AppConnector` 类的声明层），在 `tools[]` 上**新增 `invoke` 字段**；工具级形态由 455 D2 的 `binding`（'rest'\|'custom'\|'mcp-remote'）表达，声明 `invoke` 即隐含 `rest` | 一份声明文件覆盖所有 connector 形态；绑定枚举与 455 统一类完全同源 |
| D2 | 字符串插值语法 | `${path.to.value}`（支持 `args.*` / `accessToken` / `body.*` / `response.headers.*`）；不引入表达式引擎 | Slack test 验证足够；避免引入 jexl/handlebars |
| D3 | HTTP 调用复用 | 复用 `connectors/remote-mcp.ts:RemoteMcpConnector` 已有的 `fetchImpl` 注入模式（生产 `fetch`，测试可注入 mock） | 与现有测试 harness 对齐，零新依赖 |
| D4 | OAuth token 注入 | 模板里 `${accessToken}` 自动从 `token-vault.get(connectionId)` 取；invoker 不允许模板写死 token | 凭据永远不过 IPC、不进 manifest 落盘 |
| D5 | 错误映射 | `response.errorTemplate` 用 `${body.error}` 等模板；若 body.ok 路径存在且非 truthy → 错误；HTTP status `>= 500` 默认 retriable | 与现有 `ConnectorInvokeResult.error.retriable` 字段对齐 |
| D6 | 模板大小预算 | 复用 450 D7 的 8KB / 64KB spec 预算，**单 connector 的所有 tool spec 总和**计入 | 一等方 provider 通常 1-5 个 tool，预算足够 |
| D7 | 迁移策略 | slack 全量迁 → microsoft365 → google（80%）；wecom **保留** `customConnector` 不动 | 渐进式验证：最简 → 中等 → 复杂 |
| D8 | Backward compat | 一等方 provider 在 Phase B 阶段**双轨运行**（既有 `connectors/*.ts` + 新 REST Template 声明），UI 上选 REST Template 优先；Phase C 删 TS | 避免一次性破坏性重构 |
| D9 | 第三方 plugin | 第三方 plugin 可声明 REST Template connector（与 455 D3 安全边界一致：不含 client secret，仅 https） | 复用 455 D5 trust level 门控 |

---

## 6. JSON Schema（restTemplateTool）

```typescript
// packages/plugin-core/src/connectors/rest-template-schema.ts (新增；扩展 455 的 app-schema.ts)
export const RestTemplateToolSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),  // 与 455 D2 id 命名空间一致
  description: z.string().min(1).max(500),
  inputSchema: ConnectorInputSchema,             // 复用现有 schema
  inputSchemaSummary: z.string().max(2000),     // 450 D7 预算对齐
  riskTier: z.enum(['read', 'draft', 'write', 'modify', 'destructive']),
  title: z.string().optional(),
  invoke: z.object({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    url: z.string().url(),                       // 仅 https（继承 455 D3）
    headers: z.record(z.string()).optional(),    // 值是模板字符串
    query: z.record(z.string()).optional(),      // 值是模板字符串（自动 URL-encode）
    body: z.union([
      z.record(z.string()),                      // JSON body（值是模板字符串）
      z.string(),                                // 原始字符串 body（值是模板字符串）
    ]).optional(),
    response: z.object({
      ok: z.string().optional(),                 // 模板，返回 truthy 视为成功
      dataPath: z.string().optional(),           // 默认 body 整体；模板从 body 取子集
      errorPath: z.string().optional(),          // 模板取 error code
      errorTemplate: z.string().optional(),      // 模板拼 error message
      retryableStatus: z.array(z.number()).default([502, 503, 504]),
    }).default({}),
  }),
  customConnector: z.string().optional(),        // D7 escape hatch；与 invoke 互斥
})
```

---

## 7. 通用 Invoker 核心实现（设计稿，不在 plan 里写完整代码）

```typescript
// electron/services/app-connections/connectors/rest-template.ts (新增, ~120 行含注释)
export async function invokeRestTemplate(
  tool: RestTemplateTool,
  args: Record<string, unknown>,
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<ConnectorInvokeResult> {
  // 1. 模板插值
  const ctx = { args, accessToken }
  const url = interpolateUrl(tool.invoke.url, tool.invoke.query ?? {}, ctx)
  const headers = interpolateMap(tool.invoke.headers ?? {}, ctx)
  const body = tool.invoke.body
    ? (typeof tool.invoke.body === 'string'
        ? interpolate(tool.invoke.body, ctx)
        : JSON.stringify(interpolateMap(tool.invoke.body, ctx)))
    : undefined

  // 2. HTTP 调用（复用 RemoteMcpConnector 的 fetchImpl 注入 + retry）
  const resp = await fetchImpl(url, {
    method: tool.invoke.method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body && tool.invoke.method !== 'GET' ? body : undefined,
  })

  // 3. 解析响应
  const respBody = resp.headers.get('content-type')?.includes('json')
    ? await resp.json()
    : await resp.text()

  // 4. 错误映射
  if (!resp.ok) {
    const errorMessage = tool.invoke.response.errorTemplate
      ? interpolate(tool.invoke.response.errorTemplate, { body: respBody, status: resp.status })
      : `HTTP ${resp.status}`
    return {
      success: false,
      error: {
        code: `http_${resp.status}`,
        message: errorMessage,
        retriable: tool.invoke.response.retryableStatus.includes(resp.status) || resp.status >= 500,
      },
    }
  }

  if (tool.invoke.response.ok) {
    const okFlag = resolvePath(respBody, tool.invoke.response.ok)
    if (!okFlag) {
      const errorMessage = tool.invoke.response.errorTemplate
        ? interpolate(tool.invoke.response.errorTemplate, { body: respBody })
        : 'Provider returned non-OK response'
      return {
        success: false,
        error: {
          code: 'provider_error',
          message: errorMessage,
          retriable: false,
        },
      }
    }
  }

  // 5. 数据投影
  const data = tool.invoke.response.dataPath
    ? resolvePath(respBody, tool.invoke.response.dataPath)
    : respBody

  return { success: true, data }
}

// 模板插值（最小实现，~30 行）
function interpolate(template: string, ctx: object): string {
  return template.replace(/\$\{([^}]+)\}/g, (_, path) => {
    const value = resolvePath(ctx, path.trim())
    return value === undefined ? '' : String(value)
  })
}
```

**关键设计点**：
- `interpolate` 只做字符串替换，**不实现表达式/控制流**——避免引入复杂 DSL
- 模板插值失败（路径不存在）→ 返回空字符串 + warn log，**不抛错**——保持与 Slack 现有"参数缺失返回默认值"行为一致
- `resolvePath` 支持 `body.error` / `messages.matches.0.text` 等点分路径
- 错误码 `http_<status>` 与 `provider_error` 复用现有 `AppConnectionErrorCode`

---

## 8. Phases

### Phase 0: schema + 通用 invoker 骨架
- [ ] `packages/plugin-core/src/connectors/rest-template-schema.ts` —— zod schema（D6 字段；在 455 `app-schema.ts` 的 `tools[]` 上扩展）
- [ ] `electron/services/app-connections/connectors/rest-template.ts` —— `invokeRestTemplate()` + `interpolate()` + `resolvePath()`
- [ ] `electron/services/app-connections/connectors/rest-template.test.ts` —— 20 条单测：
      - 模板插值（6 条：基础、嵌套、缺失路径、特殊字符、Unicode、超长）
      - HTTP 调用（4 条：GET/POST/PUT/DELETE 各一）
      - 错误映射（4 条：HTTP 500、HTTP 401、provider error、retryable 判定）
      - dataPath 投影（3 条：默认/嵌套/不存在）
      - escape hatch（2 条：`customConnector` 跳过 invoker、accessToken 永不落日志）
- [ ] 验收：`npm run typecheck:all` + `npx vitest run electron/services/app-connections/connectors/rest-template.test.ts`

### Phase 1: 通用 invoker 接入 connector-service
- [ ] 455 Phase B 的 `AppConnectorRegistry` —— `binding: 'rest'` 分派从占位 not-implemented 接通 `invokeRestTemplate`（`listDescriptors` 已由统一工厂从 tools[] 构造，本 Phase 只补 invoke 路径）
- [ ] 与 455 Phase C 的"声明式 connector 注册"复用同一装载入口
- [ ] 单测：声明式 connector → listTools 返回正确 descriptor；invoke 走通用 invoker
- [ ] 验收：`npm run typecheck:all` + 现有 connector test 全绿

### Phase 2: Slack 迁移（验证 D7）
- [ ] 新增 `packages/plugin-core/src/plugins/builtin/slack/.app.json`（455 D3 统一路径；bundled marketplace 形态与 452 Phase B 打包对齐）
- [ ] 把 `connectors/slack.ts:listSlackDescriptors()` 的 1 个 tool（`slack_search_messages`）写成 REST Template 声明
- [ ] D8 双轨：`connectors/slack.ts` 保留，但 `connector-service` 优先走声明式；测试断言两者返回等价的 descriptor
- [ ] `packages/agent/tests/app-connection-tool.test.ts` 增加端到端：装 slack 声明 → OAuth mock → invoke `slack_search_messages` → 验证 response
- [ ] 手动 smoke（plan 450 D8 的 settings 页）：装 slack → 触发 search_messages → 看到结果
- [ ] 验收：所有现有 slack test 通过 + 新增 E2E 通过

### Phase 3: Microsoft 365 + Google Drive 迁移
- [ ] microsoft365：4 个 tool（mail_list / calendar_list / files_list / me_get）写成 REST Template
      - 关键：Microsoft Graph 的 `@odata.nextLink` 分页 → 用 `dataPath` + 简单 cursor 透传（不做自动分页合并，归 plan 461 backlog）
      - 关键：`me_get` 的 `Prefer: outlook.body-content-type="text"` header 通过 headers 模板注入
- [ ] google：核心 5 个 tool（drive_list / drive_get / gmail_list / gmail_get / calendar_list）写成 REST Template
      - 关键：`drive_list` 的 `pageToken` 分页同上
      - **保留** google.ts 中 `drive_upload`（multipart/form-data，超出 REST Template 语义）走 escape hatch
- [ ] D8 双轨保留 Phase C 删 TS
- [ ] 验收：所有现有 microsoft365/google test 通过 + 新增 E2E 通过

### Phase 4: 清理 + wecom escape hatch
- [ ] 删 `connectors/slack.ts` / `microsoft365.ts` / 80% `google.ts`（保留 `drive_upload`）
- [ ] `connectors/wecom.ts` 增加 `// KEEP: spawns external CLI, not REST-able` 注释，列入 plan 461 backlog
- [ ] `electron/services/app-connections/connector-service.ts` 移除 deleted provider 的特殊路由
- [ ] 单测更新：删除专属 module test，新增"wecom 走 escape hatch" test
- [ ] `npm run typecheck:all` + 全量 vitest + 手动 4 个 provider smoke

### Phase 5: 第三方 plugin REST Template
- [ ] 在 455 Phase B/C 的 `.app.json` zod schema 上验证第三方可用的 `invoke`（`rest`）绑定——schema 已在 455 Phase B 留位，此处补端到端
- [ ] 测试插件 fixture：声明 `.app.json` 含 `tools[].invoke` → 装插件 → 走通用 invoker → 验证 response
- [ ] 安全边界验证：第三方 plugin 不含 client secret 时，OAuth 流如何拉起用户自备 client（复用 455 D3）
- [ ] 验收：手动 E2E + 自动化 test

### Phase 6: 文档 + ARCHITECTURE.md
- [ ] `docs/references/codex-deep-dive/17-plugin-marketplace-and-app-connector.md` 增补 §17.11 "duya 分歧：REST Template 抽象"
- [ ] `ARCHITECTURE.md` 「App Connection」小节补 REST Template 章节
- [ ] `packages/plugin-core/README.md` 增加 connector manifest schema 章节

---

## 9. Files to Modify / Add

### 新增
- `packages/plugin-core/src/connectors/rest-template-schema.ts`
- `electron/services/app-connections/connectors/rest-template.ts`
- `electron/services/app-connections/connectors/rest-template.test.ts`
- `bundled-marketplaces/duya-official/connectors/{slack,microsoft365,google-drive,gmail,google-calendar}.json`
  （统一为 `packages/plugin-core/src/plugins/builtin/<id>/.app.json`，与 455 D3 收口）

### 修改
- `electron/services/app-connections/connector-service.ts`（声明式路由分支）
- `electron/services/app-connections/connectors/slack.ts`（Phase 4 删除）
- `electron/services/app-connections/connectors/microsoft365.ts`（Phase 4 删除）
- `electron/services/app-connections/connectors/google.ts`（Phase 4 缩到 70 行，仅保留 multipart upload）
- `packages/plugin-core/src/connectors/`（455 app-schema.ts + 本 plan rest-template-schema.ts）
- `packages/plugin-core/README.md`
- `ARCHITECTURE.md`
- `docs/references/codex-deep-dive/17-plugin-marketplace-and-app-connector.md`

### 不动
- `electron/services/app-connections/oauth/flow.ts`（OAuth 路由，450 D5 接管）
- `electron/services/app-connections/connectors/wecom.ts`（escape hatch，保留）
- `electron/services/app-connections/connectors/remote-mcp.ts`（455 已通用化）
- `electron/services/app-connections/app-connection-service.ts`（连接生命周期，不动）

---

## 10. Success Criteria

| Area | Standard |
|---|---|
| 声明化覆盖 | slack / microsoft365 / google 核心工具集 100% 走 REST Template；无对应 `connectors/*.ts` |
| Token 安全 | access token 永不出现于 JSON 声明、不进 manifest 落盘、不进 log |
| 兼容性 | Phase 2-3 双轨期间所有既有 test 通过；Phase 4 删 TS 后新 test 通过；既有 connection 不需重连 |
| 错误传播 | provider error / HTTP error / retryable 标记与现有 `ConnectorInvokeResult` 字段完全一致 |
| 性能 | REST Template invoker 调用延迟 < 5ms overhead（不含网络） |
| 类型安全 | zod schema 覆盖所有声明字段；坏 JSON 在 455 Phase B 的 lenient parser 路径下落 warn 而非 crash |
| 第三方 | 第三方 plugin 可声明 REST Template connector，通过 455 trust level 门控 |

---

## 11. Open Questions

1. **分页**：Slack cursor / Microsoft `@odata.nextLink` / Google `pageToken` —— REST Template 是否做"自动合并分页"？**建议不做**（plan 461 backlog：cursor token 透传为 `args.cursor`）；保持 invoker 极简。
2. **二进制响应**：Google Drive 文件下载返回 binary —— REST Template 的 `dataPath` 不能表达。**建议**：增加 `response.binary: true` 字段，返回 `ArrayBuffer`；仅 google.ts 用，slack/microsoft365 不需要。
3. **multipart upload**：Google Drive 上传 —— 是否扩 REST Template 加 `body.multipart` 字段？**建议不**（复杂度上升），google drive_upload 保留 escape hatch 走 `connectors/google.ts:uploadFile`。
4. **模板注入安全**：D2 的 `${path}` 模板会不会被恶意 manifest 利用做 SSRF？**缓解**：`url` 字段走 zod `.url()` 校验且必须 https（继承 455 D3）；headers/query/body 值虽然可模板，但执行前 `${args.x}` 已经过 inputSchema 校验；最终 HTTP 请求仍受主进程 fetch 同源 / CORS 约束。
5. **rate limit**：Slack 429 + Retry-After header、Google 403 userRateLimitExceeded —— REST Template 是否要内置 rate-limit 退避？**建议不**（与 `RemoteMcpConnector` 一致：无内置，依赖上层 retry）；plan 461 backlog。
6. **MCP 桥**：未来若 Slack 提供 hosted MCP，slack 的 `.app.json` 能否切到 `binding: 'mcp-remote'`？**建议**：可以——这正是 455 D2 三绑定的意义（同一 AppConnector 接口换绑定实现，descriptor/invoke 语义不变，仅 oauth 段的 remoteMcpUrl 生效）；迁移本身不归本 plan。
7. **声明的动态性**：能不能支持"插件运行时改 .app.json"？**建议不支持**（连接 manifest 是启动时解析 + 用户改 settings 才 reload）；运行时改属于 plan 461 风险更大的改动。

---

## 12. 一页速记

- **Layer 4 = REST Template invoker**，~120 行 TS，覆盖 slack / microsoft365 / google 核心 tools
- **schema**：`.app.json` tools[].invoke 字段（D1，455 统一类的 `rest` 绑定）；zod 校验（D6）
- **安全**：`url` https-only、`accessToken` 仅在 invoker 运行时注入、模板无表达式引擎
- **迁移**：Phase 2 slack → Phase 3 m365+google → Phase 4 删 TS；wecom 保留 escape hatch
- **与 455 衔接**：`rest` 是统一 `AppConnector` 类三绑定之一；复用 `AppConnectorId` 类型 + `.app.json` schema + `AppConnectorRegistry` + trust level 门控
- **与 codex 分歧**：duya 没有 hosted MCP，必须自己做 REST Template；不是落后，是架构分支

---

## 13. 延伸阅读

- [455-open-connector-registry](./455-open-connector-registry.md) — `AppConnectorId` 类型开放 + Remote MCP 声明注册
- [449-app-connection-approval-parity](./449-app-connection-approval-parity.md) — riskTier 审批分级 + tool_overrides
- [450-app-connection-codex-alignment](./450-app-connection-codex-alignment.md) — @提及激活 + 目录缓存 + spec 预算
- [312-app-connection-oauth](./312-app-connection-oauth.md) — OAuth 基础设施
- [313-first-party-plugin-catalog](./313-first-party-plugin-catalog.md) — bundled plugin catalog
- [314-global-connector-registry-design-suite](./314-global-connector-registry-design-suite.md) — canonical connectorId
- [docs/references/codex-deep-dive/17-plugin-marketplace-and-app-connector.md](../references/codex-deep-dive/17-plugin-marketplace-and-app-connector.md) — codex 三件套参考
