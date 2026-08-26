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

- [ ] 错误分类：`remote-mcp.ts` invoke 捕获 401/`UnauthorizedError`/token refresh 失败 →
      结构化错误 `{ code:'connector_auth_required', provider, installUrl? }`
- [ ] SSE 事件：worker `chat:connector_auth_required` → router 转发 → renderer
      `AuthRequiredCard`（provider icon + 文案 + 「去授权」「忽略」）
- [ ] 「去授权」：调 `appConnection:connect`(providerId) 走完整 OAuth loopback → 成功后
      `notifyAgentServerAppConnectionReload()` → 卡片转成功态并自动重发原工具调用
      （重试一次上限，防循环）
- [ ] 单测：错误分类映射、SSE 载荷形状、重试一次上限

### Phase C: 暴露层策略门 + spec 预算（细节对齐）

- [ ] `[apps]` 配置段：config.toml `[apps] default.enabled=true` + `[apps.apps.<id>] enabled`
      （zod schema + ConfigStore），`getProviderReadiness` 之外新增 `isProviderEnabledByConfig`
- [ ] 暴露过滤：descriptor 下发前过 config 门（禁用 provider 的工具不下发，而非下发后 deny）
      —— 对齐 R5 的「exposure 层拦截优于执行层拒绝」
- [ ] spec 字节预算：`registerAppConnectionTools` 单 descriptor `JSON.stringify(inputSchema)`
      >8192B → 只注册 summary 版（schema 置空对象 + description 保留），记 WARN —— D7/R9
- [ ] 单测：config 门、预算降级

### Phase D: 模板资产化 + 结构化参数展示

- [ ] `approval-templates.json`（schemaVersion:1，沿用 Plan 449 表内容迁移）+
      loader 带 schema 校验，坏文件回落内置默认 —— D6/R8
- [ ] `toolParamsDisplay`: 渲染器输出 `[{name,label,value}]`（取 input 前 3 个标量参数），
      PermissionPrompt 参数区改为 label:value 行 + 折叠原始 JSON
- [ ] 单测：JSON 加载/坏文件回落、params 展示截断

### Phase E: 目录快照缓存

- [ ] `catalog-cache.ts`：tools/list 结果按 connectionId 落盘（含 fetchedAt），TTL 3600s；
      `ensureSession` 先读缓存立即返回 descriptors，后台过期刷新 —— D8/R10
- [ ] 连接断开/撤销 → 删对应缓存文件
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
