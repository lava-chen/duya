# T23 — Desktop 首块接共享 RunSession：链路分析与接缝请求

- 卡片：19-fast-track-queue.md §「T23 Desktop 首块接共享状态」，车道 L-DESKTOP
- 分支：`codex/t23-desktop-shared-run-session`，基线 `19d780a8`（= `origin/master`）
- worktree：`.claude/worktrees/t23-desktop-run-session`
- 状态：**已实现（服务层）· 阻塞于一条接缝 · 未验收**
- 本卡独占：`apps/desktop/src/renderer/**`、`apps/desktop/src/main/ipc/**`、`packages/ui` 共享接线
- 本卡**不改**：`apps/desktop/src/main/agents/**`、`apps/desktop/src/preload/**`、`packages/host/**`、`packages/agent-runtime/**`

---

## 1. Desktop 真实链路（实测 file:line）

### 1.1 发送链（当前 Desktop 走的旧路）

```
renderer composer
  → packages/ui/src/App.tsx:722 enqueueMessage / startStream（legacy 分支）
  → packages/ui/src/lib/stream-session-manager.ts:1990 client.startChat(...)
  → agent server HTTP（apps/desktop/src/main/agents/server/router.ts:1605 handlePostChatSSE）
  → chat:start → worker（fork 子进程）
  → worker stdout 帧 → agent server 转 legacy `chat:*` SSE 事件
  → renderer stream-session-manager 归约
```

### 1.2 记账链（**已经是 Host durable ledger**）

```
worker 事件
  → apps/desktop/src/main/agents/db-bridge.ts:395-400
      case 'run:create' | 'run:append' | 'run:complete' | 'run:get' | 'run:events' | 'run:list-session'
  → getControlPlane().serve(...)（packages/host/src/control-plane-service.ts:306）
  → HostRunApiV1（packages/agent-protocol/src/run-api.ts:100）
  → RunStore（durable）
```

**结论：Desktop 的 run 本来就落在 Host durable ledger 上。** 终态权威性不需要新建机制，
缺的是 **renderer 读得到它** 的通道。

### 1.3 共享状态层（T10 产物，已就位）

- `packages/client-core/src/session/run-session.ts` — `RunSession`：准入/去重/跨 run 隔离/稳定快照
- `packages/ui/src/App.tsx:226-275` — `uiServices.runs.openSession(runId, sessionId, signal)`
- `packages/ui/src/App.tsx:291` — `uiServices.runs.listBySession(sessionId)`
- `packages/ui/src/App.tsx:324` — `uiServices.approvals.listPending(sessionId)`
- `packages/ui/src/App.tsx:378-385` — `uiServices.approvals.resolve(id, decision)`
- `packages/ui/src/App.tsx:683` — `uiServices.runs.start({...})`
- `packages/ui/src/App.tsx:145-151` — `resolveUiServices()`：**有 `electronAPI` 但无适配器 → `return null`**

`packages/ui` 的 Host 路径**已经写好了**，缺的只是「一个真的适配器」。

---

## 2. 本卡已实现（worktree 内）

| 文件 | 行数 | 作用 |
| --- | --- | --- |
| `packages/ui/src/services/sse.ts` | 125 | `SseFrameDecoder`（UTF-8 流式、CRLF 归一化） |
| `packages/ui/src/services/envelope.ts` | 119 | `decodeRunFrame` / `readRunEventEnvelope`（校验 runId/sessionId/seq/timestamp/traceId） |
| `packages/ui/src/services/run-session-stream.ts` | 339 | 传输抽象（`RunStreamOpener` 端口，非 URL）+ resume cursor + 增量 accept + stall watchdog + backoff |
| `packages/ui/src/services/host-api.ts` | 283 | `HostApiBridge` 端口 + `createHostHttpBridge`（bearer + SSE 流） |
| `packages/ui/src/services/ui-run-session.ts` | 201 | 组合层：**自己持有 `RunSession`**，流式与轮询回退投进同一 surface；**终态只报不发明** |

设计要点：

- 传输是**端口**（`RunStreamOpener`）不是 URL ⇒ Desktop 与 Web 共用同一套流状态机，差异只在「怎么开流」。
- 终态一律来自 Host durable ledger（`listRuns` 轮询），`getDurableStatus` 只报告、**不发明**状态。
- `RunEventStreamOptions.session?` 让组合层与调用方共享**同一** `RunSession` 投影，避免两份裁决状态。

### 2.1 门禁证据（实测）

| 门禁 | 结果 |
| --- | --- |
| `tsc -p packages/ui --noEmit` | **0 错误**（初次跑出 13962 条 TS2307 = 主仓库 `packages/*/dist` 未构建的**环境红**；主仓库 `npm run build:packages` 构建 23 包后归零，剩余 2 条真错误已修） |

修掉的 2 条真错误：`host-api.ts` 的 `toQueryValues` 形参原为 `Record<string, unknown>`，
而协议的 query 类型是**普通 interface**（无隐式索引签名）⇒ 赋值被拒。已放宽为 `object`，
调用点不必再写 cast。

---

## 3. 阻塞点（逐条证据）

### 3.1 renderer 到 Host HTTP API 不通

| 障碍 | 证据 |
| --- | --- |
| Host 强制 bearer | `packages/host/src/http-server.ts:594-598` |
| Host 拒绝带 `Origin` 的请求 → 浏览器 fetch 必带 Origin | `packages/host/src/http-server.ts:603-604`（403 `origin_not_allowed`） |
| Desktop Host 未注入 `runExecutionApi` → start/cancel 404 | `packages/host/src/http-server.ts:2774,2784,2799`（`agent_run_execution_unavailable`）；`apps/desktop/src/main/cli/desktop-host-api.ts:204-271` 只注入了 `runApi`(259)/`permissionRequestApi`(265)/`toolApprovalApi`(266) |
| port/token 只写文件，preload 不暴露 | `apps/desktop/src/main/cli/desktop-host-api.ts:184,270,274-284` → `<dataRoot>/runtime/host-api.json` |
| BrowserWindow 安全 | `nodeIntegration:false` + `contextIsolation:true` ⇒ renderer 不能自带进程外能力 |

### 3.2 renderer 可达通道全集清点（`apps/desktop/src/preload/index.ts`，共 442 个通道）

- **有**：`db:session:*`（→ `getDesktopHostSessionApi()`，sessions 平面已 Host-backed）、
  `db:permission:create|get|resolve`、`db:toolApproval:get`、
  `agent-server:get-port` / `agent-server:getUrl` / `agent-server:getPort`
- **无**：`db:run:*`、pending approval 列表、run start/cancel、通用 `db:request`

`db-bridge.ts` 的 `run:*` 分支**只**在 agent server 进程内经 `deps.dbRequest` 可达，**没有**暴露成 renderer 可触达的通道。

### 3.3 agent server 不提供 `/v1` 路由

`apps/desktop/src/main/agents/server/router.ts` 无 `/v1/*` 路由，其 SSE 是 worker 的 legacy `chat:*` 帧流，
**不含 `RunEventEnvelope`**。且该文件属 19-plan §3 **公共单写者清单**，本卡不得改。

---

## 4. 接缝请求（给 App 桥接 / Host owner）

### 请求 A（必需）— renderer 读 Host durable ledger + pending approvals

**改哪个函数**：`apps/desktop/src/main/agents/server/router.ts` 新增只读路由（该文件是公共单写者，故走接缝）

**为什么不能放自己车道**：19-plan §3 把它列入公共单写者清单。

**建议形态**（renderer 经 preload 已有的 `agent-server:getUrl` 直连；agent server CORS `*`，无 Origin 拒绝、无 bearer）：

| 路由 | 后端 | 复用 |
| --- | --- | --- |
| `GET /v1/agent-runs?sessionId=` | Host Run API | `deps.dbRequest('run:list-session')`（`db-bridge.ts:400`） |
| `GET /v1/agent-runs/{runId}/events?afterSeq=` | Host Run API | `deps.dbRequest('run:events')`（`db-bridge.ts:399`） |
| `GET /v1/permission-requests?sessionId=` | Host Permission API | `getDesktopHostPermissionRequestApi()`（`desktop-host-api.ts:480`） |

**备选 B**：在 `apps/desktop/src/main/ipc/**`（L-DESKTOP 独占）加 IPC handler，Main 进程内直调
`getDesktopHostRunApi()`（`desktop-host-api.ts:500`）/ `getDesktopHostPermissionRequestApi()`，
再由 **preload owner** 在 `apps/desktop/src/preload/index.ts` 暴露命名空间。
preload 本卡不可改，故仍需接缝。

> 选 A 的理由：改动面最小（只加路由，router 内已有 `deps.dbRequest`），且不新增 preload 通道。

### 请求 B（必需）— 取消动作送达

取消要「只在 Host ledger 确认后显示完成」，因此需要两件事：

1. 读账 → 已在请求 A 内；
2. 取消送达执行中的 worker → Desktop 现有取消是 agent server 侧 `chat:interrupt` 路径，
   **本卡需先确认该路径在 Host 模式下的落点**（候选：请求 A 的路由加 `POST .../cancel`，
   转发到 agent server 的 interrupt 通道）。**此项属实现阶段待定，不在本次请求范围内拍板。**

### 请求 C（可选，若选 B 方案）— Host 侧补 `runExecutionApi`

`apps/desktop/src/main/cli/desktop-host-api.ts:204` 的 `new HostSessionHttpServer({...})` 补
`runExecutionApi`（契约见 `packages/agent-protocol/src/run-api.ts:262`），
使 `POST /v1/agent-runs/start` 与 `POST /v1/agent-runs/{id}/cancel` 不再 404。
**本卡不需要它**——Desktop 的执行发起已由 agent server 闭环（§1.1），Host 只需提供账本读写。
若最终决定让 Desktop 改走 Host 发起执行，则此项升为必需。

---

## 5. 能力保留清单（不能为接适配器静默删除现有功能）

Desktop 旧路径 `client.startChat` 的 `ChatOptions`
（`packages/ui/src/lib/stream-session-manager.ts:1991-2034`）带 **20+** 字段；
而 Host 分支 `uiServices.runs.start`（`packages/ui/src/App.tsx:683-688`）只带 **5** 个
（`sessionId` / `prompt` / `model` / `effort` / `providerId`）。

**直接切换会静默丢掉下面这些。** 承载路径已查证：

`StartAgentRunInput.options`（`packages/agent-protocol/src/run-api.ts:167`）
→ `packages/host/src/run-execution.ts:366` `options: input.options ?? {}`
→ `packages/host/src/run-orchestrator.ts:2589,2603` `optionsWithManifestBudget(...)` → `ChatStartCommand.options`
→ `packages/agent-protocol/src/worker-protocol.ts:40-...` `ChatStartCommand.options`
→ worker `chat:start`（`packages/host/src/worker-process-entry.ts:3107`）

即：**能力字段经 `options` 可无损抵达 worker**，且 `ChatStartCommand.options` 已静态声明
`permissionModeOverride`(47) / `files`(48) / `agentProfileId`(60) / `outputStyleConfig` /
`displayContent` / `mentionedSkills` / `mentionedPlugins` / `effort` / `maxTurns` / `allowedTools`。

| 旧路径字段 | 承载点 | 状态 |
| --- | --- | --- |
| `model` / `providerId` | `StartAgentRunInput` 顶层 | ✅ 已通 |
| `workingDirectory` | `StartAgentRunInput` 顶层 | ✅ 已通 |
| `effort` | `options.effort` | ✅ `UiStartRunInput` 已扩展 |
| `permissionModeOverride` | `options.permissionModeOverride` | ⚠️ 需扩展 `UiStartRunInput` |
| `files`（附件） | `options.files` | ⚠️ 需扩展 + 需确认 worker 侧文件落盘 |
| `agentProfileId` | `options.agentProfileId` | ⚠️ 需扩展 |
| `outputStyleConfig` | `options.outputStyleConfig` | ⚠️ 需扩展 |
| `displayContent` | `options.displayContent` | ⚠️ 需扩展 |
| `mentionedSkills` / `mentionedPlugins` | `options.*` | ⚠️ 需扩展 |
| `mentionedProviders` | `options.*` | ⚠️ `ChatStartCommand.options` 未静态声明，**需确认** |
| `mode` | `options.mode` | ⚠️ 未静态声明，**需确认** |
| `conductorMode` / `conductorCanvasId` | `options.*` | ⚠️ 未静态声明，**需确认** |
| `maxTokens` / `maxTurns` | `options.maxTurns` 已声明 / `maxTokens` 未声明 | ⚠️ 部分 |
| `systemPrompt` / `language` | `options.*` 已声明 | ⚠️ 需扩展 |
| `titleGenerationModel(+Config)` | `options.*` | ⚠️ 未声明，**需确认** |
| `providerConfig` | `options.*` | ⚠️ 未声明，**需确认** |
| `defaultWorkspaceDirectory` | `options.*` | ⚠️ 未声明，**需确认** |
| `securityScanEnabled` | `options.*` | ⚠️ 未声明，**需确认** |
| `backgroundTaskResume` / `clientMsgId` | `options.*` / `traceId` | ⚠️ 未声明，**需确认** |

「未静态声明」= `ChatStartCommand.options` 的类型里没有该键。`options` 在 Host 侧是
`Readonly<Record<string, unknown>>` 自由字典，**能**透传；但 worker 侧是否读取该键
必须逐个查证，**不能假设**。这一列是 Task #4 的工作量主体。

---

## 6. 验收路径（必须走真实 Desktop 入口）

1. 两轮发送：含工具审批、工具结果回到下一次 provider 请求
2. 刷新 / 重连后无重复助手消息，工具状态正确
3. 取消只在 Host ledger 确认后显示完成
4. 慢历史恢复与快速发送不覆盖新 run
5. 覆盖 failed / cancelled、切换会话、迟到响应
6. 定向测试 + `npm run typecheck:all` + `npm run architecture:check`
7. 涉及模块入口时 `npm run electron:build` + Playwright 驱动真实 Electron
8. 记录既有失败 file/test/signature，不用旧基线掩盖新增回归

既有基线（2026-10-20 实测）：`npm test` 红（CI 64 文件 / Windows 45）；
`typecheck:all` 绿（需先 `build:packages`）；`architecture:check` 绿（2826 tolerated）。

---

## 7. 未覆盖 / 风险

- **请求 A 未落地前，本卡无法产出真实验收证据**：`packages/ui` 侧已就绪，但没有真实传输就没有真实 run。
- §5 表格中标「需确认」的能力字段：**逐个查证 worker 侧是否读取**，不得假设透传即生效。
- 旧 `subscribeSession` / `startStream` 路径与 Host 路径**不可同时运行**（两份裁决状态）——
  切换必须一次性，且放在适配完整并验证之后。
- `packages/ui/src/App.tsx:150` 的 `return null` 行为保留：没有适配器时 Desktop 仍渲染空白，
  这是现状，不在本卡改动范围内。
