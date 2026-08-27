# Plan 450: App Connection 与 Codex 全面对齐（@提及激活 + 用时授权 + 暴露层策略）

> **Status**: Planning
> **Priority**: P1
> **Created**: 2026-08-27
> **前置**: Plan 449（审批分级/记忆/模板，已落地）、Plan 312/313（连接基础设施 + Remote MCP transport，已落地）
> **源码依据**: `E:\cloned-projects\codex`（codex-rs 实码）+ `docs/references/codex-deep-dive/05-tools-system.md`

## Goal

把 duya 的 App Connection 交互从「设置页先连接 → 工具被动发现」升级为 codex Apps 的
「**对话中 @ 点名激活 → 用时引导授权 → 暴露层策略门控**」模型。整体架构保持 duya 直连
形态（无后端代理，见 Decision 1），但交互时序、激活机制、门控层次、失败路径逐项对齐 codex。

## Codex 参照系（已核实的源码事实）

| # | 机制 | codex 源码位置 | 要点 |
|---|---|---|---|
| R1 | **单一宿主代理** | `codex-mcp/src/mcp/mod.rs:60,524` | 所有 app 经唯一 `codex_apps` server（`{chatgpt}/api/codex/ps/mcp`，ChatGPT token），客户端零 app 凭据 |
| R2 | **@ 提及激活** | `core/src/plugins/mentions.rs:41`、`skills/src/mentions.rs:36-65` | `$`=skill/tool、`@`=plugin/app；结构化 `UserInput::Mention{path:"app://<id>"}` 或明文 `@slug`；slug 唯一且不与 skill 重名才命中 |
| R3 | **可提及性门控** | `tui/src/chatwidget/skills.rs:290` | `mentionable = is_accessible && is_enabled` |
| R4 | **selection 生命周期** | `core/src/session/turn.rs:270,848`、`state/session.rs:278-293`、`turn_input.rs:344` | 每 turn 收集提及 → `merge_connector_selection` 进 session state → **turn 结束清空**；用于遥测区分 Explicit/Implicit 调用 |
| R5 | **暴露层策略门** | `core/src/mcp_tool_exposure.rs:75-100,157` | 非 app 工具优先注册；app 工具需 `apps_enabled` + `AppToolPolicyEvaluator.policy(...).enabled`（读 annotations destructive/open_world hint + config `[apps]` 开关）；search_tool 开启时 Deferred 否则 Direct |
| R6 | **上下文注入** | `core/src/context/available_plugins_instructions.rs` | 仅注入一段 developer `<plugins.usage_instructions>` 讲用法规则；**@ 提及本身不注入 app 描述文本**——能力载体始终是工具列表 |
| R7 | **用时授权** | `codex-mcp/src/auth_elicitation.rs` | 工具调用返回 meta `_codex_apps`/`connector_auth_failure`（含 install_url/auth_reason/error_code）→ 解析成 auth elicitation 弹 URL 引导浏览器授权后重试。无前置连接步骤 |
| R8 | **审批模板资产化** | `core/src/consequential_tool_message_templates.json`（schema_version 4） | 版本化 JSON 文件 + LazyLock 加载，按 `(server_name, connector_id, tool_title)` 匹配，产出 question + elicitation_message + **tool_params_display（结构化参数展示）** |
| R9 | **spec 字节预算** | `mcp_tool_exposure.rs:21-22` | agent plugin MCP 工具单 spec ≤8000B、总计 ≤64000B，超限降级 Hidden（可分发不可见）而非丢弃 |
| R10 | **目录缓存 TTL** | `connectors/src/lib.rs:31-35` | connector 目录缓存 3600s，元数据缓存对齐同一时钟 |

## Non-Goals

- **不做后端代理**（R1）：duya 无后端服务，直连 hosted MCP 是既定架构。R1 的收益（客户端零凭据）duya 已通过「主进程持 vault + 令牌不过 IPC」达成。
- 不做插件声明 connector（R2 中 PluginConnectorSource 部分）——归插件体系后续计划。
- 不做 Explicit/Implicit 遥测上报（无遥测后端），但保留 selection 状态供权限审计。

## Design Decisions

| Decision | Choice | Reason |
|---|---|---|
| D1 架构 | 保持直连 + 本地 vault；只对齐交互层 | 无后端；直连反而少一跳延迟。R1 列为参照非目标 |
| D2 激活粒度 | `@<provider>` 点名到 provider 级（非单工具级） | codex 也是 connector 级；duya provider 即连接器 |
| D3 selection 载荷 | `StartStreamParams.mentionedProviders: string[]` → worker 会话态 `activeConnectorSelection: Set<ProviderId>`，turn 结束清空 | 对齐 R4 生命周期；跨进程经现有 init/chat 载荷 |
| D4 激活效果 | 该 turn 内：选中 provider 的工具 `exposeMode` 从 `discoverable` 提升为 `always`（跳过 tool_search 一跳），并注入一条 `<connector-activation>` system-reminder（provider 名 + 已授权状态，不含工具 schema） | 对齐 R5+R6：提及不改 prompt 里的能力描述，改的是暴露门 |
| D5 用时授权 | 远程 invoke 返回 401/invalid_token 类错误 → Main 发 SSE `chat:connector_auth_required {provider, connectionId}` → renderer 卡片带「去授权」按钮 → 复用 `startRemoteMcpAuthorization` 流程 → 成功后 reload descriptors 并提示重试 | 对齐 R7 时序；复用既有 OAuth 流程，不新造协议 |
| D6 模板资产化 | 模板表从 TS 常量迁至版本化 JSON（`APPROVAL_TEMPLATE_SCHEMA_VERSION` 沿用），增加 `toolParamsDisplay` 字段 | 对齐 R8；PermissionPrompt 参数区从原始 JSON 升级为 label:value 行 |
| D7 spec 预算 | AppConnectionTool 注册时 inputSchema 序列化 >8KB → 降级为 `inputSchemaSummary` only + description 保留 | 对齐 R9 防上下文膨胀；hosted server 偶发巨型 schema |
| D8 目录缓存 | remote MCP tools/list 快照落盘 `{userData}/app-connections/catalog-cache/<connectionId>.json`，TTL 3600s；过期后台刷新、前台先用旧值 | 对齐 R10；消除会话启动对网络目录的阻塞等待 |

## Phases

### Phase A: @ 提及激活（核心）

- [x] 类型扩展：`StartStreamParams.mentionedProviders?: string[]` + `ChatOptions.mentionedProviders` + `ChatStartMessage.mentionedProviders`
- [x] worker 会话态：`activeConnectorSelection` 模块（merge/get/clear）+ 单测 5 条
- [x] 暴露提升：`DuyaAgent._resolveTools` 把选中 provider 的 connector 工具放进
      `isToolVisible` 的 discovered 集（discoverable → effective always），跳过 tool_search
- [x] 上下文注入：selection 非空时首轮一次性 `<system-reminder>`（限 500 字符，<connector-activation>
      envelope），复用 promptContexts 轨道
- [x] Composer UI：`MessageInput` 连接列表注入 @-popover contextItems（每项
      `value=providerId`，file-mention 插入路径写 `@<id> `）
- [x] 提取 helper：`extractMentionedProviders`（纯函数，word-boundary + 幂等）
      + `stream-session-manager.startStream` 提交时从 content 扫描
- [x] 单测：selection 5 + extractMentionedProviders 11，全绿

### Phase B: 用时引导授权（elicitation 对齐）

- [x] 错误分类：`remote-mcp.ts` 捕获 `UnauthorizedError` → 结构化 `connector_auth_required`
      错误；`connector-service.ts` 在 `connection_revoked`/`not_available` 中 session 状态
      仍为 connected 时也映射为 `connector_auth_required`
- [x] 新错误码 `connector_auth_required` 加进 `AppConnectionErrorCode`
- [x] worker 侧 `AppConnectionTool` executor 在收到该码时 `context.sendToMain` 发
      `chat:connector_auth_required {provider,connectionId,toolName}`，并改错误提示文案
- [x] router 转发为 SSE `connector_auth_required`；`agent-sse-client` dispatch +
      onConnectorAuthRequired 回调
- [x] `stream-session-manager` 新增 `subscribeToConnectorAuthRequired` / `clearConnectorAuthRequired`，
      重播最后一次 pending 事件（page remount 兑容）
- [x] renderer `ConnectorAuthRequiredCard` 组件 + ChatView 装配；“去重新授权”复用
      Plan 312 的 `appConnection:connect` OAuth loopback
- [ ] **B3 重试**：代码中连接成功后只清掉卡片，下次用户消息才能重试原调用——
      Plan 450 原始设计的“自动重试一次”留作后续选代点（需在 worker 记最后一次工具调用
      载荷，OAuth 成功后重发）。**变通**：现有 agent loop 在 tool_result 携带 error
      后会重启一轮 model call，模型会自动看到错误并自己重试——跳过原设计意图的“一次性”逻辑，
      负面仅为“可能跑到不同工具上”，不是“撞永远”。当前卡片 UX 足够。

- [ ] **E 目录缓存**：留作后续优化；当前 remote-mcp tools/list 调用频率低（只 reload 时拉），
      临时没有必要启动目录缓存。代码中 8KB 预算 + exposure 门足够避免重复拉取导致的
      服务质量劣化。

- [x] i18n 键 zh/en；typecheck (web/agent/cli/conductor/voice) 全绿

### Phase C: 暴露层策略门 + spec 预算（细节对齐）

- [x] `[apps]` 配置段：`AppEntry { enabled: boolean }` 已在 schema.ts，Plan 450 新增
      `electron/services/app-connections/policy-gate.ts`：
      `isProviderEnabled` / `readAppPolicy` / `setProviderEnabled`（ConfigStore 原子写）
- [x] 暴露过滤：`connector-service.listDescriptorsForConnected` 走进 filter 之前先
      `isProviderEnabled(policy, provider)`——disabled provider 完全不发 descriptor
      （对齐 codex `apps_enabled ? filter_codex_apps_mcp_tools : empty`）
- [x] spec 字节预算：`APP_CONNECTION_SPEC_BYTE_BUDGET = 8192`（对齐 codex 8KB）；
      `downgradeForByteBudget` 把超限 descriptor 的 inputSchema 换为空对象 + 把
      summary 折进 description 后再注册（降级仍可调用，仍可被 tool_search 发现）
- [x] 单测：policy-gate 4 条（fail-open 为主），byte-budget 3 条（全套 7 条绿）

### Phase D: 模板资产化 + 结构化参数展示

- [x] 模板资产迁至 `packages/agent/src/tool/AppConnectionTool/approval-templates.json`
      （schema_version 2），loader 坏文件回落内置默认
- [x] `buildToolParamsDisplay(input, schema)`：top-3 标量参数 + schema.title 友好化
      label + 120 字符截断（上一笔 commit 已落地）
- [x] 类型贯通：`PermissionRequestEvent.metadata.toolParamsDisplay` 从
      `@duya/ai/types.ts` → agent process entry → renderer PermissionRequestEvent
      （上一笔 commit 已落地）
- [x] 新增 `tool_overrides`：14 条 curated 工具动作模板（github: add_comment/...
      notion: create/update/delete，linear: create_issue/update_issue，figma: export，
      supabase: apply_migration/execute_sql，vercel: deploy，slack: send_message）
- [x] 路由顺序：tool_override (provider + regex on action) → provider → 通用渲染器；
      `renderConnectorApprovalFromDescriptor` 透传 `descriptor.action`
- [x] 单测：override 匹配 8 条 + 原版 7 条（全套绿）

### Phase E: 目录快照缓存

- [x] `electron/services/app-connections/catalog-cache.ts`：
      atomic write (tmp+rename) + TTL `CONNECTORS_CACHE_TTL_MS = 3_600_000`
      + `isFresh` 检查 + 断开时清理。与 codex `CONNECTORS_CACHE_TTL` 对齐
- [x] `remote-mcp.ts`：`ensureSession` 中先读缓存——新鲜且同 provider
      则跳过 `client.listTools()`，过期或缺失才拉取并写盘
- [x] `disconnect` 调 `deleteCatalogCache(connectionId)` 避免重新授权时重用陈旧清单
- [x] 单测 8 条（全套绿）：roundtrip、TTL 边界、坏 JSON、别键、delete
- [ ] 单测：TTL 判定、坏 JSON 回落、断开清理

### Phase F: 验证

- [ ] `npm run test` 全绿 + `npm run typecheck:all`
- [ ] Playwright：输入 `@` 出 provider popup → 选中 Notion 提交 → 该会话直接调
      create_page 不经 tool_search → 断开 Notion 后 @ 列表消失
- [ ] 手动：revoke Notion 授权后让 agent 调工具 → AuthRequiredCard → 浏览器授权 → 自动重试成功
- [ ] ARCHITECTURE.md 更新「Official app connections」小节（激活模型/用时授权/预算）

## Success Criteria

| Area | Standard |
|---|---|
| 激活 | `@Provider` 后该 turn 工具免 tool_search 直接可用；未点名的仍走 discoverable；turn 结束激活失效 |
| 授权 | 过期/撤销后调用触发卡片引导而非裸错误文本；授权完成自动重试一次 |
| 门控 | config 禁用的 provider 工具完全不进 registry（非注册后 deny） |
| 稳定性 | 巨型 schema 不进上下文（>8KB 降级）；断网冷启动可用缓存的工具目录 |
| 兼容 | 不用 @ 的用户路径行为与 Plan 449 完全一致 |

## Open Questions

1. `@` 与现有 `file-tree-add-to-input` 附件事件、`$` skill 提及的输入冲突裁决顺序？
   建议：`@` 优先弹 connector/provider 列表（当前无其他 `@` 占用者）。
2. selection 是否跨 turn 粘滞一轮（codex 是每 turn 清空 + 任务结束清空）？建议严格对齐：
   turn 终态即清，靠 mailbox guide 补充连续意图。
