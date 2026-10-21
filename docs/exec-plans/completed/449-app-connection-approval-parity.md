# Plan 449: App Connection 审批体验对齐 Codex（annotation 分级 + 审批记忆 + 模板）

> **Status**: Implementation
> **Priority**: P0
> **Created**: 2026-08-27
> **Source**: codex-deep-dive 第 10 章（`10-app-server-and-mcp.md` §10.4.2/§10.4.3）对照审计
> **Depends on**: Plan 312（App Connection 基础设施，已落地）、Plan 313 Phase 2a（Remote MCP transport，已落地）

## Goal

让 Remote MCP 连接器工具的审批体验达到 codex Apps 的水平。当前所有 remote 工具被硬编码为
`riskTier: 'modify'`——每次调用都弹确认；UI 的"本会话允许"按钮在 worker 侧退化为单次
allow，没有任何记忆；审批文案是通用一句话。结果是 Notion/GitHub 这类几十个工具的连接器
根本无法流畅使用。

三项交付：

1. **Annotation 驱动的风险分级**（对应 codex `AppToolPolicyEvaluator`）：读 MCP
   `tools/list` 返回的 `annotations`（`readOnlyHint` / `destructiveHint` / `title` 等），
   自动推导 `riskTier`，只读工具不再弹确认。
2. **审批记忆**（对应 codex `McpToolApprovalKey` 分层持久化）：会话级（worker 进程内
   Set，`allow_session` 真正生效）+ 全局级（ConfigStore `appConnections.toolApprovals`，
   UI"总是允许"写入，随 descriptor 下发 `preApproved`）。`destructive` 永不跳过强确认。
3. **审批文案模板**（对应 codex 版本化模板表）：按 provider + 工具元数据渲染人话审批问题，
   替代通用 `createPermissionRequestMessage(toolName)`。

## Non-Goals

- 不做 elicitation 桥接（server 反向询问 UI），后续单独立项。
- 不改本地 stdio MCP 工具的权限路径（`decideMcpSource` 管线归 Plan 419）。
- 不做 per-provider 的策展式模板内容运营——首版用「provider 模板 + 通用回退渲染器」。
- 不动 Plan 92 企业策略与 Plan 443 bash 审批缓存。

## Research Findings（已核实）

| 事实 | 位置 |
|---|---|
| remote 工具 riskTier 硬编码 `'modify'`，注释明言 fail-closed | `electron/services/app-connections/connectors/remote-mcp.ts:47` |
| 权限门 4.5 步读 `getToolRiskTier` → `riskTierToBehavior`：write/modify → ask，destructive → strong-confirm | `packages/agent/src/permissions/permissions.ts:403-437`、`policy.ts:1230` |
| UI 已有"本会话允许"按钮发 `allow_session`，但 worker 侧 `allow_for_session` 折叠为单次 allow，无记忆 | `src/components/chat/PermissionPrompt.tsx:242`、`packages/agent/src/process/agent-process-entry.ts:3605` |
| MCP SDK `tools/list` 的 Tool 带 `annotations?: ToolAnnotations`（readOnlyHint/destructiveHint/idempotentHint/openWorldHint/title），duya 目前丢弃 | `@modelcontextprotocol/sdk/types.js` |
| descriptor 经 `appConnection:listDescriptors` IPC 推给 worker，缓存于 `setCachedAppConnectionDescriptors` | `packages/agent/src/process/agent-process-entry.ts:616-668` |
| 权限事件载荷 `{ id, toolName, toolInput, mode, expiresAt, decisionReason }` 由 worker `createPermissionHandler` 构造 | `agent-process-entry.ts:1606-1650` |
| ConfigStore 支持点路径写 + 广播（memoryRag flat key 先例） | `electron/config/store.ts` |
| `appConnection:*` handlers 已有完整注册模式 | `electron/ipc/app-connection-handlers.ts` |

## Design Decisions

| Decision | Choice | Reason |
|---|---|---|
| annotation→tier 映射 | 无 annotations → `'modify'`（保持 fail-closed）；`readOnlyHint===true` 且非 destructive → `'read'`；`destructiveHint===true` → `'modify'`（仍需确认）；其余 → `'modify'`。**永不自动授予 `'destructive'` 或 `'write'` 以下免确认档** | MCP spec：destructiveHint 缺省 true、readOnlyHint 缺省 false，保守方向唯一安全；收益集中在海量只读工具免弹窗 |
| 会话记忆载体 | worker 进程内模块级 `Set<toolName>`（每个 session 一个 worker 进程，天然会话作用域） | 无需持久化；崩溃即失效符合预期 |
| 全局记忆载体 | ConfigStore `appConnections.toolApprovals: Record<"provider:toolAlias", "allow">` | Golden Trident：用户决策属配置态而非业务流水；复用原子写+广播；避免 core-db 迁移 |
| 下发方式 | main 在 `listDescriptorsForConnected()` 给 descriptor 盖 `preApproved: boolean`，随现有 init/reload 通道进 worker；批准后广播 reload | 复用既有推送链，权限门零 IPC 往返 |
| destructive 豁免 | `preApproved` / 会话记忆只豁免 write/modify 的 ask；strong-confirm 一律不免 | 对齐 codex：destructive 强确认不可记忆跳过 |
| UI 入口 | PermissionPrompt 对连接器工具追加"Always allow"次级按钮 → 新 IPC `appConnection:approveTool` → 写 ConfigStore → `/plugins/reload` 式广播刷新 descriptors | 权限事件新增 `connector` 元数据字段用于识别 |

## Phases

### Phase A: Annotation-driven riskTier

- [x] `electron/services/app-connections/risk-policy.ts`：`evaluateRemoteToolRiskTier(annotations?)`
      + 单测（无 annotations / readOnly / destructive / 双 hint / openWorld 不影响 tier）
- [x] `remote-mcp.ts`：session tools map 捕获 `annotations` + `title`；tier 用 evaluator；
      `ConnectorToolDescriptor` 增加可选 `title`、`tierSource: 'annotations' | 'fallback'`

### Phase B: Approval memory

- [x] agent 侧 `packages/agent/src/tool/AppConnectionTool/approvals.ts`：会话级 Set +
      remember/isSessionApproved/clear + 单测
- [x] `permissions.ts` 4.5 步：write/modify ask 前，若 `descriptor.preApproved` 或
      `isSessionApproved(toolName)` → 直接 allow（default 模式末尾兜底 ask 会吞掉 fall-through，
      故豁免必须短路返回；destructive 不豁免）
- [x] `agent-process-entry.ts` permission resolve：`allow_for_session` 时若命中连接器
      descriptor → `rememberSessionApproval(toolName)`
- [x] 权限事件增加 `connector?: { provider, riskTier, preApproved }` 字段（构造时查 descriptor 缓存）
- [x] main 侧：schema 增加 `app_connection_approvals`；`tool-approvals.ts` 读写模块；
      `connector-service` 盖 `preApproved`；新 IPC `appConnection:approveTool` /
      `appConnection:revokeToolApproval` / `appConnection:listToolApprovals`；
      preload + `src/lib/app-connection-ipc.ts`
- [x] PermissionPrompt：连接器工具显示"Always Allow"，点击 = 写全局批准 + 以 allow_session 继续
      （批准保存失败不阻塞会话内放行）
- [x] 单测：gate 豁免路径 ×6、resolve 记忆、模板渲染 ×9

### Phase C: Approval message templates

- [x] `packages/agent/src/tool/AppConnectionTool/approval-message.ts`：
      `APPROVAL_TEMPLATE_SCHEMA_VERSION` + provider 模板表 + 通用回退渲染器
- [x] `permissions.ts` 4.5 步 ask 分支改用渲染结果作为 `message`
- [x] 单测：模板命中、占位符替换、回退渲染

### Phase D: Verification & docs

- [x] 受影响 vitest 套件全绿（risk-policy 10 + approvals 4 + approval-message 7 + gate 6；
      既有 permissions / app-connection-tool / ipc __tests__ 无回归）
- [x] `npm run typecheck:all` 通过
- [ ] Playwright 手动验证：连接 GitHub/Notion remote MCP → 只读工具免确认执行 → 写工具
      弹模板化审批 → "本会话允许"后同工具不再问 → "Always Allow" 后新会话也不再问 →
      Disconnect 后工具下线（待 Electron 实机；better-sqlite3 ABI 交换需先关 DUYA 跑
      `npm run rebuild:node`）
- [x] ARCHITECTURE.md「Official app connections」小节补 approval memory 与 tier 策略

## Success Criteria

| Area | Standard |
|---|---|
| 分级 | 带 `readOnlyHint` 的 remote 工具在 default 权限模式下静默执行；无 annotations 工具行为不变（modify 确认） |
| 记忆 | "本会话允许"同工具不再问；"Always allow"跨会话生效且随断开连接自动失效（descriptor 消失）；destructive 永不被豁免 |
| 文案 | 连接器审批卡片显示 provider + 工具标题的人话问题，非裸工具名 |
| 安全 | token 边界不变；全局批准键含 provider 前缀，不跨连接泄漏 |
