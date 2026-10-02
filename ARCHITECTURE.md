# Architecture

> Last updated: 2026-09

## Overview

DUYA is a Windows desktop AI agent client with a modular architecture:

- **Frontend**: Vite + React 19 + Zero Router (Electron renderer)
- **Desktop Shell**: Electron 28 (Main Process)
- **Agent Core**: `@duya/agent` workspace package
- **AI Layer**: `@duya/ai` multi-protocol adapter
- **Database**: SQLite via better-sqlite3

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Vite 6, React 19, Zero Router, Tailwind |
| Desktop Shell | Electron 28 |
| Build | esbuild, electron-builder |
| Agent Core | TypeScript |
| Database | better-sqlite3 (FTS5, trigram) |
| Testing | Vitest, Playwright |

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Desktop Shell (Electron)                  │
├─────────────────────────────────────────────────────────────┤
│  Main Process                                               │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐          │
│  │  Core   │ │ Config  │ │ Memory  │ │Agents   │          │
│  │   DB    │ │  Store  │ │  State  │ │Manager  │          │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘          │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐          │
│  │   IPC   │ │Services │ │Gateway  │ │Auto-    │          │
│  │ Handlers│ │         │ │         │ │mation   │          │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘          │
├─────────────────────────────────────────────────────────────┤
│              Agent Server (HTTP + SSE)                       │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              Agent Worker Processes                  │   │
│  │  @duya/agent (workspace package)                    │   │
│  │  @duya/ai (multi-protocol LLM adapter)             │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                    Renderer Process                          │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  React 19 + Zero Router                             │   │
│  │  Components: Chat, Layout, Settings, Automation...   │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## IPC Architecture

DUYA uses two communication patterns:

### 1. IPC Invoke/Handle (Request-Response)

For CRUD operations, config, database queries:

```
Renderer → preload → IPC Channel → Main Process Handler → SQLite/FileSystem
```

Channels: `db:*`, `config:*`, `gateway:*`, `automation:*`, `logger:*`

### 2. Agent Server (HTTP + SSE)

For streaming AI conversations:

```
Renderer → Agent Server (HTTP POST) → Worker Process → LLM
                                     ↓
                              SSE Stream → Renderer
```

- Agent Server runs as HTTP server in Main Process
- Each session spawns/is assigned to a Worker Process
- Streaming via Server-Sent Events

### 3. MessagePort

For high-frequency data: tool execution, tool streaming, config sync.

## App Connections (Connectors)

Unified AppConnector registry (Plan 455): first-party providers, plugin `.app.json`
declarations (`mcp-remote` / `rest` bindings), and custom connectors, resolved by
`apps/desktop/src/main/services/app-connections/app-connector.ts`. Tokens live in the main
process (encrypted vault) and never cross IPC.

Auth elicitation loop (Plan 450 Phase B + Plan 498):

1. Connector invoke fails with `connector_auth_required` → worker emits
   `chat:connector_auth_required` → agent server SSE → renderer auth card.
2. Tool result tells the model to end its turn and wait (no retry, no links).
3. `appConnection:connect` (card button or Settings) completes the OAuth
   loopback → main broadcasts `app-connection:connected` to all windows.
4. Card flips to its real connected state and ChatView sends a localized
   resume message (mailbox-queued if a stream is active) so the model re-issues
   the failed call; per-provider dedup keeps it to one resume.

The system prompt carries a persistent "Apps (Connectors)" section
(`packages/agent/src/mentions/index.ts` — connected-app catalog plus the
help-the-user-connect guidance: prefer connectors over browser workarounds,
name missing services, never paste authorization URLs).

### Channel Attachments (Plan 507)

Per-bot channel connectors (`apps/desktop/src/main/channels/*-connector.ts`) and the gateway
route path carry inbound media to the bot and upload outbound files to the
platform. Two data flows:

- **Inbound persist + path injection**: adapters (`gateway-manager.ts`
  `forwardInbound`, Feishu/Weixin/TG deep adapters) download media to temp
  cache; the main process persists each to stable storage via
  `apps/desktop/src/main/channels/attachment-store.ts` →
  `~/.duya/agents/<ownerId>/attachments/inbound/<platform>/<ts>_<name>`
  (shared agents root, plan 526; atomic write, per-kind size caps mirroring
  `attachment-builder.ts`, traveral
  guard on owner/platform/name). The `ChannelInboundEnvelope.attachments`
  (`packages/agent/src/channels/types.ts`) feeds
  `packages/agent/src/channels/prompts.ts`, which renders
  `[attachment saved to: <path> (...)]` lines under each inbound message so the
  bot can Read/Bash the file. Oversize/unreadable entries become
  `[attachment skipped: <reason>]` lines instead.
- **Outbound real upload**: `SendMessage type:"attachment"` with a `file://` url
  becomes a `MediaReply` (`gateway` `NormalizedReply.type==='media'`) mapped in
  `apps/desktop/src/main/channels/connector-runtime.ts` (feishu/weixin live adapters) or a
  multipart send in `apps/desktop/src/main/channels/channel-delivery.ts` (`file-url.ts`
  decodes `file://` and infers MIME/key); media type follows MIME:
  image→photo, audio→voice, video→video, else document. A missing/empty file or
  `https://` url degrades to the existing text-with-link. Slack stays
  text-with-link.

### Gateway = Router + Status Broadcast (Plan 520)

`packages/gateway` serves the **legacy direct-channel line** only (settings
BridgeSection bindings). Bots ride the per-bot `apps/desktop/src/main/channels` pipeline
and never touch it. The gateway subprocess no longer:

- resolves sessions (`user-mapper.ts` deleted) — Main resolves/creates the
  session from the `gateway_user_map` row in
  `message-bus.ts:resolveOrCreateGatewaySession`;
- executes slash commands — `commands/dispatcher.ts` detects known commands
  and wraps them as `gateway:inbound { kind: 'command', command, args }`;
  Main executes help/new/reset/clear/status/stop and answers via
  `requestChannelSend`;
- gates senders — pairing (`gateway:pairing:*`, `/pair` `/approve` `/deny`) is
  fully removed;
  Main enforces a per-platform channel allow-list
  (`channel-directory.ts`, settings key `gateway_allowlist`, empty list =
  open) and replies `gateway:inbound:response { authorized }`.

Busy handling is a Main→Gateway broadcast:
`gateway:agent_busy { platform, platformChatId, busy, ok }` — set when a wake
is enqueued, cleared by `forwardToGateway` on the terminal
`chat:done`/`chat:error`. Each adapter's `busy_input` option decides
queue (buffer + flush on idle) / steer / interrupt locally; the working
reaction (🤔→👍/👎) and typing indicator are the user-facing bot-status
signal. Retained: CLI control-plane proactive send
(`duya channel send` → `POST /v1/channels/send` → `requestChannelSend` →
`gateway:send` → `GatewayManager.sendMessage`) and plan 507 inbound
attachment persistence.

## Database

### Location

- Windows: `%APPDATA%/DUYA/databases/duya-main.db`
- macOS: `~/Library/Application Support/DUYA/...`
- Linux: `~/.local/share/DUYA/...`

### Schema

Managed via `boot.json`. Core tables:

- `sessions` - Session metadata
- `message_index` - Chat message index (FTS5 indexed)
- `memory_schema` - Memory RAG storage bookkeeping (`memory_entries` / `memory_evidence` were dropped by memory-state migration 0009)
- `settings` - User configuration
- `tasks` - Task state
- `permission_requests` - Permission requests
- `session_goals` - Session goals
- `mode_state_snapshots` - Mode state snapshots
- `attachments` - Message attachments
- `mailbox_items` - Mailbox items
- `rollouts` - Experiment tracking (Plan 326)

### Rollout Files

Chat history stored in rollout JSONL files under `workspace/rollouts/`:

```
workspace/
  rollouts/
    2026-09/
      session-id.jsonl
```

`message_index` table references these files.

### Rollout as First-Class Data (Plan 506)

The JSONL rollouts are the source of truth; `message_index` is a rebuildable projection. Core: `apps/desktop/src/main/db/core/message-log.ts` (export/import/reconcile + non-bot generation rotation), `apps/desktop/src/main/db/core/session-fork.ts` (checkpoint fork). IPC (`apps/desktop/src/main/ipc/db-handlers.ts`) + preload (`session.forkAt/archive/unarchive/listArchived`, `rollout.export/import/reconcile`):

- **Export** (`db:rollout:export`): one file is one session — bot sessions concatenate `archive-<g>.jsonl` generations in order + `active.jsonl`; read-only.
- **Import** (`db:rollout:import`): `restore` builds a new session from an external .jsonl; `continue` appends onto an existing session. All-or-nothing validation (1-based line numbers); ids colliding on the `message_index` GLOBAL PK are remapped into `import:<sessionId>:<oldId>` with every cross-reference (parentId / replyToId / compaction refs / rebase newMessages) following.
- **Reconcile** (`db:rollout:reconcile`): explicit whole-store index rebuild from the rollout files, reporting missing/orphan files; orphans are never deleted.
- **Fork** (`db:session:forkAt`): new session seeded from the source's projected timeline through a message id; fresh ids (`fork:<newSessionId>:<oldId>`), `parent_session_id` + `session_spawn_edges` edge of type `fork`.
- **Archive** (`db:session:archive/unarchive/listArchived`): status flip only — archived sessions leave the default `list()` result (`includeArchived` to reveal) but rollout files stay on disk.
- **Non-bot rotation** (Plan 506 C1): long ordinary chats rotate on the same `archive-<g>.jsonl` layout as bots once they cross `NON_BOT_ROTATION_THRESHOLD_BYTES` (4 MB) — compaction triggers rotation for already-rotated sessions; the active file's generation directory is sticky so segments never split.

### Memory State DB (Plan 479)

Separate SQLite file (`memory-state.db`, next to `duya-main.db` in the same boot.json directory), managed by `apps/desktop/src/main/memory-state/`. Holds the memory control plane: projects / rollout catalog (0001), leases + stage1 outputs (0002-0003), curation runs / publications (0008), and the bot memory tier index (0010).

`memory_tier_index` (migration 0010, Plan 479 Phase 1) is a rebuildable query index over the file-manifest memory tree — the files remain the source of truth. Tiers: `agent` (own, `~/.duya/agents/<agentId>/memory/`), `user` (shared, `~/.duya/memory/`), `project` (`~/.duya/memory/projects/`). `entry_id` = sha256 of tier+writer+project+dedupe_key; shard-unique index enforces one entry per (tier, writer, project, key). Conflict rules live in `apps/desktop/src/main/memory-state/tierConflicts.ts`: newest-wins within a shard, earliest-via across shards, tier precedence agent > project > user. Store API in `apps/desktop/src/main/memory-state/tierIndex.ts` (`upsertTierEntry`, `listTierEntries`, `mergedTierRecall`, `rebuildTierIndexFromFiles` with dry-run).

## @duya/ai - Multi-Protocol LLM Adapter

三层架构 (Plan 451):

### 1. API Layer (`packages/ai/src/api/`)

- `anthropic-messages.ts` - Anthropic Messages API
- `openai-completions.ts` - OpenAI Completions API
- `openai-responses.ts` - OpenAI Responses API
- `ollama-chat.ts` - Ollama API
- `bedrock-converse.ts` - AWS Bedrock Converse API
- `google-generative-ai.ts` - Google Generative AI API
- `local-runtime.ts` - Local runtime API
- `degrade.ts` - Degradation handling
- `emit-sse.ts` - SSE emission
- `transform-messages.ts` - Message transformation

### 2. Provider Layer (`packages/ai/src/providers/`)

- Factory: `createProvider()`
- Catalog: `createProviderCatalog()`
- Auth: OAuth, API Key, Device Code

### 3. Models Layer (`packages/ai/src/models/`)

- Model capability detection
- Thinking level mapping
- Cost calculation

### Supported Protocols

| Protocol | Provider |
|----------|----------|
| anthropic | Anthropic |
| openai-chat | OpenAI, Azure OpenAI, DeepSeek, Qwen, MiniMax, Kimi, GLM |
| openai-responses | OpenAI Responses API |
| ollama | Ollama |
| openrouter | OpenRouter |
| bedrock | AWS Bedrock (P2) |
| gemini | Google Gemini (P2) |
| vertex | Google Vertex (P2) |

### System One Decision Client (Plan 551)

决策形态 ≠ chat 形态——Jev（TypeSafe "System One" 模型）接入独立于 `providers/` chat 抽象：

- `packages/ai/src/system-one/` — `DecisionClient` 接口 + `SystemOneClient`（state + 多问题单请求 → choice/score/noul typed 决策；timeout 预算 + 瞬态重试；基数 255 校验）。`DecisionClient` 是可替换后端抽象（未来：LLM structured-output / 本地 SemIf）。
- `packages/agent/src/decisions/` — `DecisionService`（降级链 Jev → LLM fallback → 抛上层规则）、`policy.ts` 阈值策略（灰区 → `uncertain`，绝不静默猜）、`calibration.ts` (p, outcome) 校准日志、`config.ts` 读 `config.toml [system_one]`。419 权限总线预筛通道默认关闭（`prescreen.permissions`，只产建议不改语义）。
- `packages/computer-use/src/decide/` — "LLM plans, Jev decides" 内循环：describe（代码可算摘要全进 state）→ 每轮一次 fan-out（target/value/done/error/blocked/irreversible）→ 代码门控 → act；status 契约 `done | likely_done | needs_confirmation | error | stuck | ambiguous | blocked | max_actions`。agent 侧 `computer_use_decide` 工具经既有 `computer-use:execute` IPC 驱动，审批复用主进程审批卡。
- **零行为破坏**：无 key / 未启用时所有路径与现状一致——`computer_use_decide` 不注入，419 预筛不触发。

### Workflow Engine (Plans 415 + 552)

独立后台 run 管理系统（非 mode,不进 popover、不套 413 检查点）。代码位于
`packages/agent/src/modes/workflow/`：

- **定义层**：`schema.ts`（zod:六类节点 tool/gui/decision/human/agent/noop + map/when 原语 + params/triggers）、`validate.ts`（引用存在/无环/跨阶段前向引用拦截/decision 阈值/human timeout 必填）、`workflow-files.ts`（`~/.duya/workflows/` save-as 注册表,load 全量重校验）。
- **表达式**：`expr.ts` 受限四类表达式（引用/比较/逻辑/聚合）+ decision answers 进 when 作用域 + `${...}` 插值;无 eval、无时钟/随机（§6.5 确定性铁律）。
- **状态机**：`engine/run-lifecycle-tracker.ts` 小内核（纯转移矩阵 + paused/terminal 判定 + history cap 64 + from_snapshot 折叠,与 GoalTracker 共享词汇不共享结构体）;`tracker.ts` WorkflowRunTracker 挂 phase/epoch/预算/journal 字段。
- **执行器**：`engine.ts`（阶段 → 拓扑 → journal;SuspensionSignal → 签名 resumeToken waiting outcome）、`node-runner.ts`（reqHash 缓存 + on_error 动态策略 + output_schema 校验重试）、`map-runner.ts`（per-item 缓存 + soft-fail null）、`gui-runner.ts`（确定性步骤 → suspected_noop 阶梯 → decide 通道八态契约 → 498 审批门）、`human-runner.ts`（§6.3 marker 语义）、`decision-adapter.ts`（551 DecisionService,阈值覆盖 + 灰区 → on_low_confidence）。
- **可靠性**：`journal.ts`（`nodeId+reqHash` 缓存命中即跳过 = "可复跑/可修正";BudgetExceeded/Cancelled 不落 journal;trailing failure 剪除;live listener 三用:持久化=SSE=审计）、`resume-token.ts`（HMAC + timingSafeEqual）、`host.ts`（BudgetLedger reserve→commit/release 与 Semaphore 分离）、`manager.ts`（dedup 幂等 launch、崩溃对账 reconcileStaleRuns → interrupted 绝不盲目重跑、wait-tracker tick 应用 on_timeout、`onRunFinished` 完成自动唤醒钩子）。
- **触发层**：`trigger.ts` 统一入口 `launchFromTrigger`（cron 触发分钟 / bot 消息 id / http 幂等键 / manual 无——dedup 命中返回既有 run）。
- **存储**：core-db `workflow_runs`（元数据行,dedup_key UNIQUE,wait_till 索引,迁移 26/27）+ `workflow_run_snapshots`（1:1 blob:冻结 YAML + 节点栈 + journal;截图外置于 artifact store,日志只存引用）。渲染端经 `workflow:*` IPC 只读（`WorkflowPanel` 控制台）。**每 run 文本日志**：`run-log.ts` 在 `launchSavedWorkflow` 落 `~/.duya/workflow-logs/<workflow>-<runId>.log`（launch args + 逐条 journal 投影 + 终态错误;best-effort,fs 失败降级 no-op;`DUYA_WORKFLOW_LOGS_ROOT` 可覆盖,测试必须指到 tmp）。
- **控制台（ZCode 交互对齐）**：`WorkflowPanel` 双 tab——定义库（双 scope:项目 `.duya/workflows/` shadows 全局 `~/.duya/workflows/`;卡片含参数/触发器/阶段节点数/可复制权威路径;定义只读,修改走对话）+ 运行（进行中/已结束双区计数;活跃可停止、结束可删除）。run 详情渐进披露:血缘(`retry_of`)、四格统计（时间/tokens/子代理/阶段,纯代码从 journal 推导）、阶段 trail N/M、逐步证据行（`nodeKind`/`action`/`exitCode`/`durationMs`/`outputSize`/`childSessionId` + 可展开缓存结果）、产物区、逐条 verified/unconfirmed 标注。journal 证据字段为**展示专用**,不进 reqHash payload（缓存经济学不受影响）。**节点链接（2026-09-27 升级）**:run 卡片 agent chip（带 `childSessionId`）与证据行的子会话链接直接 `setActiveThread` 进入子会话 ChatView（只读侧栏 `SessionMessagesPanel` 仍服务 subagent 工具行/任务抽屉入口）;decision/human/browser/agent 节点 chip/行走 `duya:open-workflow-node-panel` → run 详情顶部的按类型专属查看器（`run-display/node-detail.tsx`，命令/判断依据/审批结论/落在 URL 等;截图 ref 经 `workflow.artifactPath` → `duya-file://` 渲染画廊,点开复用 `ImagePreview` lightbox）。
- **规划器**：`planner.ts`（LLM 生成 YAML + 一次带错重试;规则 regex + Jev risk noul 预筛;高风险 → awaiting_confirm 必停）、`verify.ts`（确定性标注 → decision over 机器摘要 → verification agent 三档 fresh-eyes;`verified/unconfirmed` 标注落 journal）。
- **执行接线（ZCode 同构,worker 是唯一 runner）**：renderer `WorkflowPanel` 定义库 run 按钮 → `WorkflowLaunchDialog` 实参窗（项目目录 + frontmatter args 表单,required/number/JSON 校验）→ `workflow.run` IPC → router `POST /:session/workflow/:name/trigger`（锚点 `sessionId ?? mostRecentWorkerSessionId()`,sendCommand false → 409 不自动 spawn）→ worker 命令 `{type:'workflow:run'}` → `packages/agent/src/process/workflow-runner.ts` `launchSavedWorkflow`：SavedWorkflowStore.resolve → args 默认值+required 校验（建行前 fail）→ `workflowRunDb.create`（id=runId,SSE 卡片==DB 行）+ snapshot 播种 → journal listener 进度帧（`chat:workflow_run` start/progress/done/error 走 worker→router→SSE）→ `runDwfScript` → complete。DwfHostPorts 生产绑定：runTool=fresh builtin registry、runAgent=SubagentTool executor（子会话+进度,token 省略）、requestApproval=worker `chat:permission`（5 分钟 deny 上限）、runGui=loud-failure stub。v1 边界：resume 未接、runTool 无 MCP。`workflow:runBackground` 主进程模拟已删除。

### Computer-Use Native Backends (Plans 454/519/552/556/562/572)

五腿框架（capture / plan / record / execute / verify）在 `packages/computer-use/` 平台无关地组装，
两个平台后端按 `backend/factory.ts` 路由（`DUYA_CUA_DRIVER` 环境变量可强制 MCP `cua-driver` 兜底）：

- **Windows（UIA 栈）**：`ElectronDesktopBackend`（desktopCapturer + nut.js + sharp，文件名 `win32.ts`
  实为跨平台）+ `resources/recorder/uia-probe.ps1` 常驻 PowerShell 探测（probe/readUrl/enumerate/fg/
  apps/windows/selectText/invoke，JSON 行协议）+ `win32-injection.ts` 后台点击梯 + recorder（uiohook
  hook-worker / converter / element-matcher L1–L3）。三消费者共用 `createComputerUseDaemon` 管线
  （spawn/心跳/重启/recycle）。
- **CUA 14 工具面（plan 575，Windows）**：ZCode/Codex CUA 对齐的系统级面。契约层
  `packages/computer-use/src/cua/`（元素 token 台账 / 树归一化三步 prune-merge-flatten /
  `formatObservation` 优先级裁剪 / `diffSnapshots` full-delta-no_change / `CuaError` 错误码分类
  + action_sent-retry 语义）；服务层 `apps/desktop/src/main/services/cua/cua-service.ts`（14 工具逻辑：
  窗口解析 fail-closed（plan 578：minimized 窗口可解析——visible 优先、minimized 兜底、cloaked 拒绝；
  `includeScreenshot=true` 对最小化目标先 `ShowWindow(SW_SHOWNOACTIVATE)` 无焦点恢复
  （`window-restore.ts`）再重查 rect 后 enumerate+capture，纯树观察不恢复）、app_ref 作用域元素寻址（0 基模型索引 → 1 基 probe 槽）、隐式帧绑定坐标
  ——坐标目标只对 `get_app_state(includeScreenshot)` 交付过的最后一帧解析）；通道
  `computer-use:cua`（`apps/desktop/src/main/ipc/cua-handlers.ts` 拥有 CuaService 单例，agent 侧
  `computer_cua` 单工具 14-action，`packages/agent/src/tool/OSTool/ComputerCuaTool.ts`，
  builtin hidden 注册 + `.system/computer-use` 内置 skill）。非 win32 平台返回
  STRUCTURED_STATE_UNAVAILABLE。
- **macOS（AX 栈，plan 572）**：Swift CLI helper `resources/ax-helper/`（`scripts/build-ax-helper.sh`
  编 universal binary）经同一条 daemon 管线常驻——`enumerate/probe`（快照句柄制元素 + 真实坐标，
  `AXUIElementSetMessagingTimeout(0.5s)` 防阻塞）→ element-detector `axElements`(`axSource:'ax-tree'`)；
  注入梯 **AX action → CGEventPostToPid（键盘/滚动，不抢焦点）→ 前台 nut.js**（Chromium 过滤 pid
  鼠标事件，无 pid 点击梯）；AXManualAccessibility 配方唤醒 Chromium/Electron 树；AppleScript 词典
  读浏览器 URL；`AXSecureField` 脱敏；TCC 四权限面（`computer-use:permissions:*` IPC + Automation 页
  `MacPermissionsCard`）+ recorder 权限门/Secure Input 显性化；`capture({windowId})` 经
  ScreenCaptureKit 单窗捕获（SDK 14+ 门控，低版本回 unsupported 降级全屏）。客户端
  `apps/desktop/src/main/services/recorder/ax-helper.ts` 对齐 uia-probe 客户端语义（竞速超时/回收/降级重试/pid 缓存）。
- **坐标铁律**：AX/CGEvent/CGWindow 全 points（左上原点），截图像素 ↔ points 换算集中在
  `capturePxPerPoint`（检测侧）与 `computer-use-coords.ts`（点击侧 darwin 分支）——Retina 半坐标是
  第一大正确性风险。技术底稿 `docs/references/macos-accessibility-research.md`（本地不入库）。
- **机器门执行器**：`node scripts/mac-gate.mjs` —— TCC 检查 + Finder/Safari/Chrome 覆盖矩阵 +
  注入两梯读回验证一键跑（plan 572 §7）；`scripts/reset-mac-tcc.sh` 重置授权。剩余真机 Gate
  依赖 macOS 13+（Electron 44 硬性要求）与 TCC 授权。

## @duya/agent - Agent Core

### Entry Points

- `packages/agent/src/agent/DuyaAgent.ts` - Main agent class
- `packages/agent/src/session/MessageSession.ts` - Session management
- `packages/agent/src/session/TaskStore.ts` - Task state

### Tool System

- `packages/agent/src/tools/` - Built-in tools
- `packages/agent/src/mcp/` - MCP server integration
- Tool protocol adapter layer (Plan 418)

#### Tool Catalog and Exposure

`ToolRegistry` remains the source of definitions, executors, and source
metadata. Each `ToolSnapshot` (`packages/agent/src/tool/snapshot.ts`) projects
eligible entries into a catalog with stable `tool_id`, normalized schema,
`schema_revision`, source, discovery hints, and one of three exposure values:

| Exposure | Provider tool list | Discovery | Invocation |
| -------- | ------------------ | --------- | ---------- |
| `eager` | Full schema | Searchable for explanation; details say `direct` | Direct call by the provider-visible name |
| `deferred` | Not exposed directly | `tool_catalog({query})`, then one schema via `tool_catalog({tool_id})` | `tool_invoke({tool_id, arguments})` fallback |
| `hidden` | Not exposed | Omitted from catalog search and detail | Unavailable |

`tool_catalog` returns short, deterministically ranked matches without schemas.
The detail operation returns one schema and a revision receipt. The agent records
that receipt only after the tool result is committed to the conversation, so a
same-provider-response `tool_catalog` + `tool_invoke` batch cannot use a schema
the model has not read yet. Fallback dispatch resolves the stable ID against the
request snapshot and live registry, checks current scope and exposure, confirms
the prior-round schema revision, validates arguments, then applies the ordinary
permission / approval chain before executing the real tool.

Key wiring:

- Visibility policy: `agent-profile/ToolFilter.ts` keeps profile, exact
  allowlist, and mode restrictions in the same eligibility path. Infrastructure
  routers remain available when a target is eligible; they do not grant access
  to out-of-scope targets.
- Legacy MCP exposure: `[tools] exposure = "full" | "hint" | "search"` maps
  `full` and `hint` to `eager` to preserve direct availability, and `search` to
  `deferred`. Legacy `catalog` maps to `search`. The default remains `hint`
  (therefore eager) until representative provider measurements justify a
  default change (`config/tool-exposure.ts`).
- MCP and plugin identities use persistent connection IDs where available;
  schema revisions change independently of stable IDs. Full catalog schemas are
  retained separately from provider-facing schema-budget reductions.
- `tool_search`, `tool_schema`, and empty-schema hint stubs are retired. Native
  OpenAI / Claude search adapters are not currently wired; providers use the
  catalog + invoke fallback until capability checks and request contracts are
  implemented. Existing deferred-schema utilities alone do not establish native
  search support.

#### MCP Capability Core (plan 580)

MCP capability flows through four layers, all fed by one protocol-pure Core:

1. **Core** (`packages/plugin-core/src/mcp/core/`) — no I/O, no agent deps:
   transactional paginated discovery (`listAllTools` — commit only on normal
   cursor exhaustion; mid-page failure throws and discards), descriptor
   canonicalization, stable slug/alias allocation (D7), `DeadlineClock` (D5 —
   one deadline per pass, SDK receives `{ timeout, signal }`, a shared
   transport is never closed for one aborted request), error taxonomy (D9 —
   `classifyMcpError` + `breakerDisposition`), and ledger types. Both chains
   import this code; behavior cannot drift.
2. **Registry** (`packages/agent/src/tool/registry.ts`) — definitions,
   executors, owner-scoped replace-sets (`replaceByOwner`). Every successful
   mutation bumps a monotonic `catalogRevision` (D10).
3. **Catalog** (`ToolCatalogTool`) — three mutually exclusive modes: `search`
   (ranked matches, no schemas), `list(namespace)` (keyset paging with an
   opaque cursor bound to `(catalogRevision, namespace)`; a revision change
   mid-page-walk → `CATALOG_CURSOR_STALE`), and `detail(tool_id)` (canonical
   schema verbatim, deep-equal).
4. **Exposure** — `eager` / `deferred` / `hidden` as above; the connector
   Apps system section renders unconditionally so the model can always
   enumerate via `tool_catalog` list mode.

Two chains share Core and differ only in transport placement:

- **Chain A** (worker, `packages/agent/src/mcp/index.ts`): one `MCPClient` per
  stdio / streamable-http server inside the agent worker; tools land in the
  registry through `MCPManager` → `setOnToolsChanged` replace-set.
- **Chain B** (main, `apps/desktop/src/main/services/app-connections/connectors/remote-mcp.ts`):
  OAuth-capable remote connectors in the main process; the worker's
  `AppConnectionTool` calls over IPC with a `deadlineAt` stamp (+30s IPC
  buffer), and results round-trip through the same D8 last-mile
  (`composeResultFromBlocks`, lossless `ToolResult.blocks`).

Lifecycle truth (D2/D6): `transport.onclose`/`onerror` are the ONLY death
signals → status `degraded` → `callTool` fails fast with `MCP_TRANSPORT`;
`tools/list_changed` → 500ms debounce → transactional rediscovery → replace-set
commit; a failed discovery NEVER clears last-known inventory. Each chain keeps
an `InventoryLedger` (`discoveryStatus: complete|refreshing|failed|stale` +
five-layer metrics) surfaced through `mcp:status:snapshot` and the chain-B
connection status DTO (optional `ledger` field). Admission gate: conformance
L1–L9 (`packages/agent/tests/integration/mcp-conformance.test.ts`, AGENTS.md
Gates).

### Mode System (Plan 224)

Modes are declarative `ModeModifier` objects:

- `plan-task` - Plan + task execution
- `research` - Deep research (Plan 423)
- `conductor` - Orchestration
- `goal` - Goal tracking (Plan 411, v2 in Plan 553)
- `computer-use` - OS desktop takeover (Plan 454; structural-first in Plan 564)

Registration: `packages/agent/src/modes/index.ts`

#### Computer Use Mode — Structural Control (Plans 454/519/556/562/564)

`computer_use` 单工具 11-action（`packages/agent/src/tool/OSTool/`），双通道：

- **STRUCTURAL（主通道，plan 564，Windows）**：`tree`（常驻 uia-probe.ps1
  `enumerate`：TreeWalker + 交互 ControlType 白名单 + IsOffscreen 过滤 +
  Edit/Document/ComboBox 的 ValuePattern value 读取 → 1-based 元素表
  `[n]Role "Name" value @rect`，`som/structural-format.ts` 渲染）+
  `invoke`（probe 内元素缓存按 index 解析 + name/controlType 陈旧守卫 →
  ExecuteMethod：auto 按 ControlType 分派 Invoke/Toggle/ExpandCollapse/
  SelectionItem/Value/SetFocus，`no-pattern` 引导回落视觉）。`set_value(element=)`
  走 ValuePattern（原子、绕 IME）。probe 复用 556/562 管线（零新 spawn）；
  `stale-tree` 由客户端 fresh 重枚举后自动重试一次。审计/访问策略/审批门
  与视觉动作同轨（`invoke` 入审批集，focus-only 豁免）。
- **VISION（辅助通道）**：`capture`/`zoom`（SOM overlay 经 element-detector，
  优先消费 enumerate 缓存的 `axElements` 真实坐标，10s TTL）+ 坐标
  `click`/`drag`/`type`/`key`/`scroll`。无结构化通道的平台/窗口返回
  `STRUCTURAL_UNAVAILABLE`，模型按 mode prompt 回落视觉循环。

#### Goal Mode v2 (Plan 553)

`packages/agent/src/modes/goal/` — grok-lineage self-driving objective tracker with independent verification, hardened after the minimax Thread Goal comparison:

- **10-state machine** (`GoalTracker`, process singleton): `idle → active ⇄ verifying → complete | blocked`, plus `user_paused` / `backoff_paused` / `no_progress_paused` / `infra_paused` / `budget_limited`. Closed `GOAL_PAUSE_REASONS` catalog (`user_requested`, `blocked_worker`, `no_progress`, `no_progress_gaps`, `verifier_timeout`, `verifier_unavailable`, `backoff`, `infra`, `restart`) carries the WHY orthogonally to the state; surfaced in snapshots, `goal_updated` history rows, and the UI.
- **Session ownership**: the tracker records `boundSession` at `start`; every accessor/mutator takes an optional sessionId and a mismatched session reads `idle` / snapshots idle data, so a bystander session can neither read nor clobber another session's goal.
- **Verification**: `update_goal(completed:true)` is a blocking ack that runs an N-skeptic adversarial panel (1–5 parallel sub-agents, JSON verdicts, conservative aggregation, strategist + closing summarizer) under `verifyTimeoutSeconds` — a timeout settles `blocked(verifier_timeout)` before any tracker side effects. `[goal] verification = "panel" | "none" | "auto"` skips the panel (`none` everywhere; `auto` on ollama local runtimes) and settles the worker proposal verbatim (minimax BYOK cost parity). `get_goal` lets the model read the durable state.
- **Self-driving loop**: builtin PreFinalize hooks — `goal-reply-fingerprint` (priority 11: normalized final-reply streak, ≥2 occurrences nudge veto, ≥3 auto `no_progress_paused`) and `goal-continuation` (priority 12: veto the natural stop while the goal is active, bounded by `max_auto_continues`; engine invariants still outrank it). Bail endings are intercepted earlier by the priority-10 premature-stop detector.
- **Cross-session**: the goal persists in `mode_state_snapshots`; a restart folds `active/verifying → user_paused(restart)` (grok safety fold) and `[goal] auto_resume` (default on) re-resumes it in `ModeCoordinator.restore()`. DuyaAgent self-adds `goal` to the turn's activeTrackerIds from the persisted snapshot, so any next message re-drives the goal without re-selecting the mode. Deterministic `/goal status|pause|resume|clear` control is intercepted at streamChat entry (`goal-commands.ts`, also registered as a CLI/gateway slash command) — no LLM turn spent; `/goal <objective>` still flows to the model so work starts immediately.
- **UI**: `GoalStatusChip` + timeline-style `GoalStatusPanel` (Turn N · Verify M · tokens · live elapsed, vertical event timeline, Pause/Resume/Clear buttons sending the deterministic commands), fed by the extended `chat:goal_updated` event (`totalWorkerRounds`, `totalVerifyRounds`, `elapsedMs`, `pauseReason`, `executionWait`).

### Prompt System (Plans 550/551)

The system prompt is fully template-driven (Handlebars, `packages/agent/src/prompts/`):

- **Module registry** (`prompts/modules/registry.ts`): one entry per authored content module under `assets/modules/*.hbs` (identity, system, destructive-actions, config-protection, communication, tools, tasks, skill-usage, duya-desktop-context, final-answer, plus profile-specific `*-coding` / gateway / research modules). Keys double as the section name for profile gating (`isSectionEnabled`) and prompt-cache keys. Config references are type-checked (`ModuleName`) so a template rename is a compile error, not a runtime render throw.
- **Assembly** (`PromptSystemConfig.staticModules`): each profile config is a declarative list of `StaticModuleRef` (`module` + optional `name`/`params`/`enabledWhen`). References normalize onto `SectionDef.compute`, inheriting profile gating, prompt-cache keying, and empty-collapse; `HbsPromptSystem.renderModule` is the single render entry (registry path + module `slots` mapper + params).
- **Two render contracts** (plan 551 D1): *authored* modules are pure text with assembly-time params; *context-fed* sections live under `assets/dynamic/*.hbs` and use preBuildHooks + `promptContextExtension` for async I/O (memory, environment, recent sessions) — the legacy per-profile `sections/` TS trees and the Plan 550 monolith template are retired.
- **Variants** (plan 551 D3): no custom Handlebars helpers — mappers precompute booleans (`identity_style_clause`, `tone_never_analysis`, `system_capability_*`) and templates branch with plain `{{#if}}`.
- **Prompt caching**: static modules cache per section name; dynamic sections are volatile; `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` separates the halves; downstream `DuyaAgent` joins with `'\n\n'`.
- **Byte-discipline**: every migration landed with byte-level parity tests; the remaining known whitespace artifacts (stray blank lines where gated blocks collapsed in the old monolith/legacy paths) are documented in plan 551.

### Context Compaction (Plan 422)

Single grok-style strategy in `packages/agent/src/compact/` (`micro`/`snip`/`reactive` deleted; only `SessionMemoryCompactStrategy` remains):

- **Trigger**: 85% context threshold; background prefire pass1 starts at 75% (two-pass with prefix-fingerprint invalidation).
- **Rebuild order**: `system → user_prefix → AGENTS.md → last_user_query → summary → system_reminder` (recent tail dropped by default, configurable).
- **Summary prompt**: 9 structured sections wrapped in `<summary>`, tool use disabled, prior summary carried forward as authoritative.
- **Robustness**: tool-call sanitize/validate (orphan ToolResult stripping, `historySanitize.ts`), degenerate-summary detection (<500 chars retry, `summaryGuard.ts`), `classifySuppressReason` failure classification feeding the 3-scope `Suppression` (size: sticky on budget change; auth: 5-min window, plan 552; other: turn-scoped), input ladder (Verbatim → Fitted → Lossy), wall-clock budget, dedicated `compact_model`, memory flush.
- **Storage**: append-only `CompactionEntry` (Plan 315) + rollout JSONL full retention (Plan 441). Original history is always recoverable from rollouts, so no separate segment/transcript store (won't-fix decision, plan 422 P3.4).

### Compaction Consolidation (Plan 552)

Convergence pass over the eight incrementally-stacked compaction plans (422 → 495 → 517 → 523 → 475 → 315 → 441 → 486), audited against minimax-code v2's single-path design:

- **Dead code removed**: the grok 5-state `CompactSuppression` machine (`compactErrors.ts`, zero production call sites), `adjustSliceBoundary` (imported, never called), `CompactionStore`, and the `SessionManager`/`SessionStoreManager` pair. Failure classification is single-sourced in `classifySuppressReason` (the live 3-scope `Suppression` inside `CompactionManager` is the only machine; plan 523 should extend it, not revive the deleted one). `auth` suppression is time-windowed (5 min) and self-heals — the previous `onAuthRefresh()` clear trigger had no callers, so one 401 permanently disabled proactive compaction.
- **Single token estimator + single window resolver**: all ad-hoc char divisors (`len/4`, `CHARS_PER_TOKEN = 3/4` copies in hooks/memory-rollout/session, a verbatim CJK-heuristic copy in `DuyaAgent`) now route through `@duya/ai`'s `estimateContextTextTokens` (plan 443 canonical); reverse (tokens→chars) budgets import the exported `CJK_CHARS_PER_TOKEN` / `ASCII_CHARS_PER_TOKEN`. Context-window resolution exists once in `@duya/ai` `resolveContextWindow` — the agent budget (`compact/contextWindow.ts` re-export) and the renderer ring (`useContextUsage.ts`) share one precedence chain (capability → catalog → 200K), closing the plan 517 R1 drift class.
- **Single context projection (plan 577)**: `ContextLedger` stores provider observations and epochs; `CompactionManager.getContextSnapshot(messages)` combines those with persisted timeline content and schema deltas. Budget probes and worker usage frames read the same `accounting.projectedNextInputTokens`; the renderer consumes that snapshot and uses its resolved context window for both percentage and denominator. Provider output volume never enters the prompt projection by itself.
- **Single trigger probe**: `CompactionManager.probeCompaction()` measures tokens, image count and both decision lines (`getTriggerLine` = max − reserve; `getHardLimit` = full window) from the manager's budget. The pre-turn proactive checkpoint (`CompactionCoordinator.runPreTurn`) and the mid-loop preflight overflow (`DuyaAgent`) both consume the probe — the mid-loop no longer compares against a local `contextWindow` copy that could drift from the budget. Suppression/cooldown gating stays with the callers; the image trigger keeps bypassing both (grok semantics).
- **Single reinjection channel**: `PostCompactReinjector.reinject` returns `systemSegments` instead of splicing system-role messages into the result array; the controller reads `result.reinjection.systemMessages` directly (no fragile re-scan of result messages). Producers (reinjector segments, `legacy_system` capture, bot `postSummarySections`) write into `CompactionEntry.reinjectedSystemMessages`; `extractLegacySystemSegments` is the sole reader at the model boundary. Over-threshold loop-brake accounting adds the restored segments' token cost back so totals match the pre-552 layout.
- **Summarizer input hygiene**: `SessionMemoryCompactStrategy.stripImagesFromMessages` was a no-op (images silently rode into the summarizer); image blocks are now replaced with a text note (mcode `[image]` flattening).

### Compaction Loop Brake + Capability Audit (Plan 517)

Three surgical fixes layered on top of the Plan 422 / Plan 495 stack after a user-reported compaction-loop bug in 2026-09-10:

- **Capability resolution audit log** (`apps/desktop/src/main/services/providers/provider-store.ts:resolveRuntimeCapability`): the silent `DEFAULT_CONTEXT_WINDOW = 200_000` fallback (`packages/agent/src/compact/types.ts`) was hidden from users on 1M-context models whose id is not in `allProviderModels` (custom OpenRouter-style ids, third-party relays). Each call now emits an info-level audit line with `{ providerId, modelId, contextWindow, source: 'config' | 'db' | 'preset' }` on the three success branches and a warn-level line with `{ providerId, modelId, apiFormat }` plus a concrete pointer to `[options].model_context[modelId]` in `config.toml` when all three layers miss. `DuyaAgent`'s constructor mirrors the same warn with `{ runtimeConfigHasCapabilities, model, apiFormat }`. Users can `grep 'fallback to 200000' app.log` and recover in one step. Override priority: `config.options.model_context[modelId]` > DB row > built-in `allProviderModels`.
- **Turn-based + token-based cooldown** (`packages/agent/src/agent/DuyaAgent.ts:1594`, gates `imageTriggered || compactionController.shouldCompact()`): the proactive checkpoint now skips when `turnsSinceLastCompact < MIN_TURNS_SINCE_COMPACT (3)` OR `tokensGrowthSinceCompact < MIN_TOKENS_GROWTH_SINCE_COMPACT (30_000)`. Cooldown baseline pins on every successful proactive compaction via the new `lastCompactionTurn` and `lastCompactionObservedTokens` instance fields. The Pi/grok-style design lets the agent run at least three tool-use turns after each compaction; image-volume triggers (`compact/imageParts.ts`, Plan 495) bypass the gate so multimodal floods are still handled immediately.
- **`overThresholdAfterCompact` becomes an active loop brake** (`packages/agent/src/compact/CompactionManager.ts:compact`): the flag that Plan 422 computed but never consumed is now wired. When `overThresholdAfterCompact === true` (e.g. system prompt + reinject overshoot), `suppression.trySuppress('size')` fires and a new `compaction_over_threshold` event emits with `{ tokensRetained, available }`. The next `shouldCompact()` returns false at the existing suppression gate until a future successful compaction shrinks `finalTokens` below `available` — breaking the loop where Plan 422 ran every other turn because the post-compaction context kept re-crossing the threshold. `Suppression.trySuppress(type): boolean` (idempotent) lives on the 3-state `Suppression` machine inside `CompactionManager`; the former 5-state `CompactSuppression` API in `compactErrors.ts` was deleted in plan 552 (zero production call sites).
- **Per-step lifecycle events** (`packages/agent/src/compact/CompactionManager.ts` + `packages/agent/src/process/worker-protocol.ts` + `apps/desktop/src/renderer/lib/stream-session-manager.ts` + `apps/desktop/src/renderer/stores/compaction-store.ts`): a new `compaction_step` event (`projecting | cutting | summarizing | rebuilding | reinjecting | trimming`, `started | finished`) plus `compaction_over_threshold` flow as `compact:step` and `compact:over_threshold` SSE frames. The renderer mirrors them into the `compaction-store` (`CompactionPhase` union extended) and into the inline `CompactSummary` row, replacing the legacy single-spinner `'Compacting context...'` with `Summarizing 32 messages...`, `Re-injecting files, skills and tools (6 cached)...`, `Trimming — still over budget`, etc. i18n keys live in `apps/desktop/src/renderer/i18n/en.ts` / `apps/desktop/src/renderer/i18n/zh.ts` under `streaming.toolAction.compact.step.{phase}`. `ActionRowChrome` accepts a `verbText?: string` precedence over `verbKey` for callers that need interpolation variables. `@duya/ai`'s `SSEEvent` union gained the four `compact:*` frame types so the legacy `as unknown as SSEEvent` casts in `DuyaAgent.ts` could finally be removed at a future cleanup.

### Long-Session Parity Additions (Plan 495)

Grok-parity gap closure on top of Plan 422, from the 2026-09-05 grok-bot compaction/epoch study:

- **Background prefire** (`compact/BackgroundPrefire.ts` + `CompactionManager.maybeStartPrefire`): when usage crosses 75% of the compaction threshold a passive pass1 summarization runs best-effort; `MessageCompactionController.compactProactive` consumes the completed pass as the `previousSummary` seed (grok two-pass semantics). Validity is a message-id prefix fingerprint — append-only growth keeps it valid; a rewrite (mid-pass compaction) discards the result as prefix-invalid. Kickoff happens at DuyaAgent's per-turn proactive checkpoint; failures never block the turn.
- **Image-parts trigger** (`compact/imageParts.ts`, `IMAGE_COMPACTION_TRIGGER_COUNT = 85`, grok parity): counted at the turn-start checkpoint and the mid-loop preflight-overflow checkpoint; firing forces compaction via `CompactOptions.force` even under the token budget (screenshot-heavy runs degrade attention before the budget does).
- **Summary retry ladder** (`compact/summaryRetry.ts`): up to 3 attempts; output-length errors get a one-shot shorter-output instruction; input-length errors shrink the summarized range (tool traffic drops first, `TOOL_MESSAGE_DROP_THRESHOLD = 0.25`, grok `reduceSelfSummaryInputMessages` parity); fatal errors throw immediately; empty/degenerate exhaustion returns '' so the strategy's placeholder path keeps the compaction successful.
- **Wake preemption / redrive / tail guard** (`apps/desktop/src/main/wake/wake-dispatcher.ts`, 476 §2.2 close-out): a preempting wake (user message / priority DM) interrupts a dispatcher-owned in-flight run at enqueue time (`interruptRun` dep, best-effort `DELETE /sessions/:id/chat`); the displaced item re-queues as `isRedriven` (exempt from the epoch-stale skip and the recently-dispatched dedupe) and runs after the preempting turn. A run whose epoch advanced mid-flight has its user-facing tail side-effects (DM auto-return) suppressed — grok turn-runtime parity. Dispatching a user-lane wake does not advance the epoch (existing 476/477 contract).

### Compact Lazy-Spawn Handshake (Plan 508)

Bot sessions whose worker has been idle-reaped and is being lazy-spawned by `POST /sessions/:id/compact` previously hit a misleading `Agent not initialized` error: the router's ready handshake only filtered on event type, never on `ready.status`, so a worker that emitted `ready { status: 'error' }` (e.g. bot session missing `provider_id`) was treated as ready and the subsequent `compact` command ran against a worker whose `initAgent` had thrown. Plan 508 fixes this:

- **`waitForWorkerReady(child, timeoutMs)`** (`apps/desktop/src/main/agents/server/router.ts`): typed `WorkerReadyOutcome` distinguishing `status: 'error'` (HTTP 503 + worker error verbatim), `status: 'deferred'` (HTTP 409), and timeout (HTTP 504). Extracted from `lazySpawnWorkerForCompact` so the contract is unit-testable.
- **`handleCompactMessage(msg)`** (`packages/agent/src/process/agent-process-entry.ts`): extracted from the `'compact'` switch case so it can be replayed from the init drain. When `!agent && initializing`, the message is stashed in `pendingCompactCommand` and replayed from the init finally block (same shape as `chat:start`'s drain); when `!agent && !initializing`, an `init-failed` reason surfaces so the renderer can recover via a fresh chat:start.

### Bot Run Scheduler (Plan 500, grok SandRunScheduler parity)

For `bot:<agentId>` sessions the wake dispatcher is the **authoritative run queue**: busy-time messages queue, queued work is graded into the three wake lanes assigned by source (user DMs → `user`, bot DMs / room member turns → `agent`, connector/automation/completion → `background`), and a priority judgment decides preemption. Normal (non-bot) sessions keep the mailbox path.

- **Run attribution** (`session_runtime_locks.origin`, Plan 500 P1): every chat run persists its origin (`user` / `agent` / `background`) on the runtime-lock row — the agent-server derives it from `options.runOrigin` (wake dispatches declare their lane; renderer chats are `user`), so main can classify ANY in-flight run, including renderer-driven ones. `LockStore.lockOrigin()` reads it.
- **Preemption rules** (`packages/agent/src/wake/preemption.ts`, grok "superseded" parity): a new user message preempts ANY in-flight run — including a user turn (displaced user runs are NOT redriven; the user replaced them on purpose and the partial transcript is persisted). Priority DMs still preempt only non-user runs. `tryPreemptRunning` classifies foreign lock holders via the lock origin and applies the same decision.
- **User-lane producer** (`bot:sendTurn` IPC, Plan 500 P2): every bot-DM send goes through the main gate. Idle → `{action:'start'}` and the renderer runs its normal streaming path; busy → the message parks on the user lane (preemption already applied at enqueue). When a queued user turn's slot arrives, main broadcasts `bot:scheduled-turn`; one renderer window claims it (IPC CAS) and streams it, otherwise a hidden user-turn fallback (`runUserTurnInSession`, session's own model, `userTurn` semantics) runs it. The renderer's queued bubble and the push are matched by the minted `messageId`.
- **Group integration** (Plan 500 P4): room member turns run through `dispatchBotTurn` as `group.turn` agent-lane items (`turnWaiters` resolve the room chain's promise when the run finishes). A busy member parks instead of 409-passing; user messages preempt member runs with redrive; room-level epoch/serialization is unchanged.
- **Watchdog + persistence** (Plan 500 P5): a user item parked longer than `DUYA_BOT_WATCHDOG_MS` (default 120 s) interrupts the wedged run; queued `user.message`/`agent.dm` items persist to `pending_wakes` and rearm after restart. `PendingWakeStore` is wired into `CoreStores` (it previously existed unwired).
- **Watchdog escape** (Plan 501 L3): if the interrupted run still holds the lock after a grace period (`DUYA_BOT_WATCHDOG_ESCAPE_MS`, default 30 s), the dispatcher escapes it grok zombie-parity — waiters resolve, displaced work re-queues, the drain generation bumps so the zombie run's eventual return is discarded, and a fresh drain pumps the queue (the wedged run keeps the lock; the lock TTL stays the correctness backstop).
- **Redrive narrative + cap** (Plan 501 L3): re-queued runs carry a hidden `[redriven]` prompt preamble (grok re-delivery note — the model knows its earlier attempt was interrupted); `redriveCount` increments per redrive and the item is dropped beyond `MAX_WAKE_REDRIVES` (3), posting a room narrative for `group.turn` items via `appendGroupTurnDroppedNotice`.

### Stability Layers (Plan 501)

- **Frozen-prompt discipline** (`packages/agent/src/prompts/bot/`): bot sections split into stable (identity/roster/promptConfig — content-hash keyed) and `volatile` (memory×3 / automations / channels / spotlight — keyed on the compaction epoch ALONE). Mid-epoch memory writes no longer invalidate any section render; volatile data refreshes at the next compaction boundary (grok `resolveFrozenMemoryPrompt` parity). Identity changes mid-epoch stay covered by the profileUpdate envelope.
- **Compaction → rotation trigger** (`apps/desktop/src/main/db/core/message-log.ts`): `appendBatch` rotating a bot session's rollout file whenever a compaction payload lands (plan 493 Phase B now actually fires) — each compaction bumps `chat_sessions.generation` and the compacted summary becomes the first data entry of the fresh generation, so the agent-side `countTimelineCompactions` (summaryEpoch) and the storage generation stay aligned. Rotation failure is fail-open (append proceeds).
- **Delivery counting** (`packages/agent/src/hooks/send-message-reminder.ts`): `post_to_room` counts as a delivery alongside `SendMessage`, so the mechanical delivery-owed backstops read a room turn that already spoke as delivered.

### Bot Identity & Avatar (Plans 483/485, 481 amendment)

A bot's runtime identity lives in `<duyaRoot>/agents/<id>/profile.json` (`apps/desktop/src/main/config/bot-profile.ts`): `name` / `description` (model-updatable via `update_state`), `title` (host-managed only), `avatarColor` (color token for the initial-circle avatar) and `avatarImage` (filename of an image inside the agent dir). `config.toml [agents.<id>]` name/description only seed the profile on first creation and act as fallback (485 §2.4). Avatars were (shape, color) tokens until 2026-09-05 — shape tokens are removed; legacy files' `avatarShape` is ignored on read.

Plan 502: `title` is fully wired for the host side — create/edit dialogs and `BotSettingsPanel` expose a role-title input, creation seeds it via `AgentUpsertInput.title` → `seedBotProfileIfMissing`, and the sidebar renders it as the contact subtitle (`BotContactListItem`: `title || description`). The model still cannot set it. Bot ids are minted at a SINGLE point in the main process (grok `agent-session.ts` parity: ids are never user-authored): `config:agents:create` accepts an empty id and slugs it from the display name via `slugifyBotIdFromName`, then `allocateBotId` allocates a collision-free id against config keys, on-disk trees, and `.deleted` tombstones; the old renderer-side `deriveBotIdFromName` duplicate is removed. Ids stay readable slugs (unlike grok's opaque uuids) because they double as config keys and `send_to_agent` addresses.

Avatar rendering priority (`apps/desktop/src/renderer/components/layout/sidebar/BotCharacterAvatar.tsx`): image → colored initial circle → deterministic-hue fallback. The image is served to the renderer over the `duya-file://` protocol (`apps/desktop/src/main/index.ts`); `listBots()` pre-builds the URL with a `?v=<mtime>` cache-buster, so the renderer never handles raw paths.

Write paths, all converging on profile.json:

- **UI edit** (`EditBotDialog` / `BotSettingsPanel`, shared `useBotContactForm`): identity via `config:agents:updateBotProfile` → `updateBotProfileIdentity`; avatar image upload via `config:agents:uploadBotAvatar` (file dialog + copy in the main process) and `config:agents:clearBotAvatarImage`.
- **Model self-edit** (`update_state` profile.set / avatar.set / avatar.clear): routed through the `bot-identity:rpc` channel (agent subprocess → agent-server-lifecycle → `apps/desktop/src/main/config/bot-identity-rpc.ts`), which binds the subaction to the session's `bot:<agentId>` identity (a bot can only edit its own profile), validates color tokens and image sources, and calls the same identity writers. `avatar.set` accepts `avatarColor` and/or `avatarImagePath` (e.g. the model's own `image_generate` output; validated extension whitelist + 5 MB cap + magic bytes, then copied to `agents/<id>/avatar.<ext>` by `setBotAvatarImage`).

### Shared Agents Root (Plan 526)

The ENTIRE `agents/<agentId>/` tree — identity (profile.json, settings.json,
avatar), sessions, memory shards, skills AND the channels subsystem
(`channels/<platform>/connection.json`, `connector-secrets/<platform>.json`,
`gateway/weixin/` state, `attachments/inbound/`) — lives under the shared
`<duyaRoot>/agents` root (`~/.duya/agents`), resolved via
`getSharedAgentsRoot()` (`apps/desktop/src/main/config/agent-paths.ts` →
`ConfigStore.getConfigDir()`). This is what makes a bot fully portable
across dev and packaged installs: previously channel bindings lived under
`<userData>/agents/`, which is namespaced per install mode (`duya-dev` vs
packaged), so a packaged app could never see bindings configured in dev.
The worker already read `connection.json` from the shared root
(`packages/agent/src/prompts/bot/loader.ts`), so main and worker now agree.
At boot, `apps/desktop/src/main/channels/legacy-root-migration.ts` merges any remaining
`<userData>/agents/*` channel data into the shared root (per-file,
target-exists wins, source kept). Soft delete/hard delete of a bot moves or
removes the whole directory, so credentials are purged with the bot.

### Bot Routines & Event Listeners (Plan 499, 476 P2.3b/P2.3d)

A **routine** is a `cronjob.toml` entry with `agent` set (bot binding): `name` + `prompt` (the standing order) + a time `schedule` and/or declarative `eventTriggers` (`apps/desktop/src/main/automation/trigger-match.ts` — github: repo/events/userAllowlist, slack: channel + mention/keyword/message). Fires wake the bot's **resident session** through the wake bus as hidden `[routine]` turns (`enqueueAutomationWake` in `apps/desktop/src/main/wake/wake-dispatcher.ts`, background lane); the prompt is built at **dispatch time** from cronjob.toml by the dispatcher's `resolveRoutinePrompt` dep (`apps/desktop/src/main/automation/routine-wake.ts`), so a queued fire wakes with the routine's current definition and a deleted/disabled one skips silently.

- **Scheduled/manual fires** (`apps/desktop/src/main/automation/Scheduler.ts`): the former agent-bound stubs now claim the fire (`lastRunAt`, at-least-once) and enqueue a wake; standalone cron behavior is unchanged.
- **Event fires** (`apps/desktop/src/main/automation/listener-hub.ts`): a poll-driven hub (grok SandTriggerHub collect→match→fire shape, no cloud arbitration — duya is local-first). Each tick it polls github `/repos/{r}/events` and slack `conversations.history` with the OAuth token from App Connections (`listener-polls.ts`, injectable fetch), persists per-listener cursors in cronjob.toml (`listener_state`), seeds cursors on first run without replaying history, keeps cursors on poll failure, and coalesces matches into ONE wake carrying a sanitized event summary + escaped `<github_event>`/`<slack_message>` context blocks (payload fields `eventSummary`/`eventContext`). A platform with no connected App Connection stays silent.
- **Bot tool** (`manage_routine`, `packages/agent/src/tool/ManageRoutineTool/`): single action tool (create/update/pause/resume/delete/list) over the existing `automation:cron:*` db-bridge channels; ownership enforced agent-side from the calling bot's session id (SendToAgentTool precedent — the bridge has no session context). Schedule etiquette (weekday daytime default, minute rule, self-expiry, auth-failure pause) lives in the tool description; wake-cue conduct plus the bot's inventory render in the `botAutomations` prompt section.
- **UI**: `BotSettingsPanel` embeds `BotRoutinesSection` (rakazo-style rows + inline editor; run history stays in the bot conversation); the global AutomationView badges bot-bound entries. Event-only routines keep their trigger set bot-managed (UI read-only).

### Shared Rooms / Group Chat (Plan 478, grok group-chat port)

Multi-bot rooms (≤6 members + user) in one shared transcript. The room is a **logical config room** (`~/.duya/groups.toml` `[groups.<id>]`: name / members / max_rounds=3 / max_member_turns=10) — it never runs an LLM; its transcript is the MessageLog session `room:<roomId>` (`apps/desktop/src/main/wake/group-turn-dispatcher.ts::ensureRoomSession`, `agentType: 'room'`).

- **Pure mechanics** (`packages/agent/src/wake/groupTurn.ts`): faithful grok `group-chat.ts` + `group-chat-orchestrator.ts` port — mention parsing (`@Name` word-bounded handles + `@everyone`/`@all`), `resolveResponders` (only messages since the last user post count; no mentions = all members), round-robin `orderRoundSpeakers`, `(pass)` silence, `GROUP_MAX_ROUNDS`/`GROUP_MAX_MEMBER_TURNS`/2-messages-per-turn caps, epoch-cancellable rounds, failed member turn = pass.
- **Delivery**: the member's only room voice is the `post_to_room` tool (in `BOT_TOOLSET`; discoverable via exact-name promotion). It validates the room + membership against groups.toml (`validateRoomTarget`, `packages/agent/src/session/room-db.ts`) and appends the authored entry (`source: 'group'`, `metadata.groupPost` — whitelisted in `PERSISTED_METADATA_KEYS`, surfaced as `group_post_meta`) directly to the room transcript session; the `message:append` db-bridge broadcast gives every renderer the room view in realtime. Turn budget Map uses a CONSTANT run key (Mimosa scanner false-positives on `Map.get(<tool input>)`).
- **Orchestration** (`apps/desktop/src/main/wake/group-turn-dispatcher.ts`): per-room turn epoch + promise chain; each member turn is one hidden wake on the member's `bot:<agentId>` session via `runWakePromptInExistingSession` (profile-bound, 409/失败 = pass), prompt = grok group member contract + transcript window since the member last spoke. Triggers: user post (`room:post` IPC — bumps epoch, interrupts the in-flight member run, voids the remaining plan) and bot post (db-bridge append hook); a group_system conclusion row closes each turn. Pending: automation seeding, DM-preemption redrive, token budget fuse.
- **Prompts**: groups render inside the agent-messaging contract — `loader.ts` reads groups.toml (worker-side) → `ctx.agentGroups` → `renderBotRoster` passes `AgentGroupSummary[]` into `buildAgentMessagingSystemPrompt`.
- **UI**: sidebar Bots section gains a 群聊 group (`buildRoomContacts` + `RoomContactListItem`, composite room avatar); `GroupRoomChatView` (source-filtered `useRoomTranscript`, speaker-name lines, group_system rows, @mention composer with member picker dropdown); `GroupSettingsDialog` (create/edit ≤6 members/delete) over `config:groups:*` + `room:ensure|post|getTranscript|members` IPC (`apps/desktop/src/main/ipc/group-handlers.ts`, preload `groups`/`room`). `App.tsx` mounts it for `resolveChatMode === 'room'`; ChatView no longer falls through for room sessions.

### Sub-agent Runtime & Side Panel (Plan 571)

**Lifecycle vocabulary.** A sub-agent run has exactly five states, defined once in
`src/lib/subagent-status.ts` and consumed by every surface:
`pending | running | completed | failed | killed`.
`killed` is first-class: `BackgroundAgentLifecycle.kill()` already records it agent-side, and
before plan 571 the renderer had **three** incompatible spellings of the same lifecycle
(`SubAgentRowInfo.status`, `ParsedSubAgentToolResult.status`, agent-side `TaskStatus`), none of
which could express a user cancel — so a stopped sub-agent rendered as a failure.
`deriveSubagentStatus(events)` derives state from the ordered progress events; the last terminal
event wins, and a kill (an `error` whose `data` starts with `killed`) resolves to `killed`.

**Event stream.** A sub-agent runs **in-process inside its parent's worker** — it has no process
and no SSE session of its own. Its events are multiplexed onto the parent's
`chat:agent_progress` channel and tagged with the child's own session id
(`agentSessionId` on the wire, remapped to `event.sessionId` by
`stream-session-manager.ts::handleAgentProgressEvent`).
`text` / `thinking` payloads are **incremental deltas**, not cumulative snapshots
(`DuyaAgent.ts:2520-2528`), so a renderer subscriber can rebuild the child's transcript from the
event log alone. `heartbeat` is a keepalive type carrying no content and must never enter a
transcript projection.

**Two buffers, on purpose.** `SessionState.agentProgressEvents` is scoped to one parent turn — it is
reset on run start (`:1708`) and dropped by the terminal slim (`:3309`). That is correct for the
parent transcript and wrong for a child, which routinely outlives the turn that spawned it. Plan 571
adds `subagentProgress`, keyed by **child** session id and never cleared on a turn boundary;
`subscribeToSubagentProgress()` replays retained history synchronously before streaming live, so a
panel opened mid-run renders what it missed. Entries are reclaimed once terminal, past a 5-minute
retention, **and** unlistened; a mounted panel pins its log. This is the same split ZCode reaches by
routing raw child events onto the child session's event topic
(`runtime/methods/subagent.ts:335-339`) — duya gets the equivalent by keying the multiplexed
channel, with no transport change.

**Side panel.** `SessionMessagesPanel` (registry id `session-messages`, `multiInstance`, opened
programmatically via `duya:open-session-panel`) renders any persisted session in the sidebar and
reuses the main `MessageList` — ZCode-parity reuse of the main chat view rather than a bespoke
renderer. It serves two kinds of session: sub-agents (live event stream available) and workflow
actor nodes (no event stream; historical only). Live sub-agents stream via
`useSubagentRuntimeStream` with **no polling**; the historical path keeps its reload as a fallback.
Emitters never touch panel state — they dispatch a CustomEvent carrying
`{ sessionId, parentSessionId, taskId, title }` and the panel provider resolves dedup/focus
(tabs dedup on `sessionId` only).

**Stop path.** `POST /sessions/:parentSessionId/subagents/kill { taskId }`
(`electron/agents/server/router.ts::handlePostSubagentKill`) → `workerManager.sendCommand(parentSessionId,
{ type: 'subagent:kill', taskId, reason: 'user_kill' })` → worker →
`backgroundAgentLifecycle.kill(taskId, 'user_kill')`.
It is keyed by the **parent** session because the child has no worker. A 404 means the parent
worker is no longer resident, which the panel treats as a no-op rather than an error.

**Result contract.** The `task` tool returns a discriminated shape keyed on `status`
(`pending | running | completed | failed | killed`) carrying `sessionId`, `taskId`, `outputFilePath`,
`totalToolUseCount`, `totalDurationMs`, `totalTokens`, `usage`, `workingDirectory`, `isolation`, and
`warnings`. `src/lib/subagent-result.ts` parses it and still accepts the pre-571 field names
(`childSessionId`, `backgroundTaskId`, `outputFile`, `isAsync`) so already-persisted history keeps
rendering. A background launch receipt is a *successful* result that says nothing about the child —
it must never be read as completion.

## Package Workspace

### Canvas Workbench Runtime (Plan 570)

Turns a canvas into a long-running workbench (stock consoles / learning
dashboards / project boards). The "backend" is the **Electron main process**:
agent-registered data sources and refreshed snapshots persist in SQLite and
flow to widgets over the existing conductor MessagePort channel — installed
apps need nothing extra.

- **Persistence** (`apps/desktop/src/main/conductor/workbench-store.ts`, schema via
  `ensureWorkbenchTables` on the legacy main DB): `conductor_data_sources`
  (id / canvas_id / name / type `http|project_db` / config / refresh_interval /
  last_snapshot / last_error) + `conductor_handlers` (forward-looking, unused
  in v1).
- **Service** (`apps/desktop/src/main/conductor/workbench-service.ts`, singleton
  `workbenchService`): CRUD + `refreshSource` — http fetch (main-process, no
  CORS; headers support `$env:NAME` refs) or project-DB query via
  `ProjectDatabaseService.invoke` — persisted then broadcast as
  `conductor:data:update`; scheduler tick every 5s refreshes due interval
  sources (≥15s, in-flight dedupe, ≤6 concurrent); widget action intake
  (`conductor:widget:action` IPC) validates element→canvas ownership and rate
  limits 10/min/element.
- **Agent tools**: `canvas_data_source`
  (`packages/agent/src/tool/CanvasConductor/CanvasDataSourceTool.ts`) over
  executor RPC actions `data_source.manage` / `data_source.refresh`
  (`apps/desktop/src/main/conductor/executor-proxy.ts`).
- **Renderer** (`packages/conductor/src/renderer/elements/workbench-runtime.ts`):
  dynamic widget srcdocs get the runtime injected — `window.duya.data`,
  `duya.onData(cb)`, `duya.action('refresh', sourceId)`, attribute-driven
  buttons (`data-duya-refresh`), and agent-authored inline `<script>` blocks
  re-enabled after the runtime (same trust model as the chat widget path).
  `WidgetShell` pushes canvas snapshots into the iframe on load/change and
  routes `workbench:action` intents to the main process. Store slice:
  `conductor-store.workbenchData` (per-canvas snapshot map, merged per source).

## Package Workspace

```
packages/
├── agent/            @duya/agent - Agent core
├── ai/               @duya/ai - Multi-protocol LLM adapter
├── cli/              @duya/cli - CLI tools
├── computer-use/     @duya/computer-use - Computer use capability
├── computer-use-demo/@duya/computer-use-demo - Computer use demo
├── conductor/        @duya/conductor - Conductor component
├── gateway/          @duya/gateway - Gateway component
├── plugin-core/      @duya/plugin-core - Plugin system
└── voice/            @duya/voice - Voice component
```

## Frontend Architecture

### Directory

```
src/
├── components/
│   ├── chat/           # Chat UI (MessageList, Input, etc.)
│   ├── layout/          # Panel, Sidebar, Header
│   ├── settings/        # Settings pages
│   ├── automation/      # Automation rules
│   ├── browser-use/    # Browser control
│   ├── browser-use-panel/
│   ├── extensions/     # Extension management
│   ├── providers/      # Provider configuration
│   ├── skills/         # Skill management
│   └── ui/             # Shared UI components
├── contexts/            # React contexts
├── hooks/              # Custom hooks
├── lib/                # Utilities (git-ipc, etc.)
├── stores/             # State management
└── types/              # TypeScript types
```

### State Management

- Zustand stores in `apps/desktop/src/renderer/stores/`
- React Context for global state

## Security

### IPC Security

- Path validation (reject absolute paths, traversal)
- Diff output bounded at 1 MB
- Safe partial output on buffer exhaustion

### Tool Execution

- Permission mode gates
- Tool protocol adapter validates inputs
- Stream size limits

### Durable Tool-Approval Cards (Plan 498)

When a tool permission check resolves to `ask`, the worker persists an
approval card instead of (or in addition to) the in-memory interactive wait:

- **Persist**: approval row in `tool_approval_state` (legacy main DB,
  `apps/desktop/src/main/db/toolApprovalState.ts`) + a chat card message
  (`msg_type='tool-approval'`, `metadata.sendMessage.approval` — rides the
  existing persistence whitelist). Deterministic ids
  (`approval-card-<requestId>`); re-writes are no-ops.
- **Surfaces**: bot sessions (`bot:<agentId>`, surface flag derived at
  chat:start) PAUSE the turn — the requestPermission handler returns
  `'paused'`, StreamingToolExecutor pushes a neutral "Waiting for user
  approval" tool result and the turn ends; interactive sessions keep the
  in-worker wait (SSE `permission` event → PermissionPrompt, 5-minute
  timeout) with the persisted card as crash fallback. AskUserQuestion-style
  two-phase prompts never pause.
- **Decide**: `db:toolApproval:resolve(id, allow|always|deny)` CAS-transitions
  the row (`pending → approved|denied`, terminal rows are no-ops), upserts a
  `tool_approval_rules` entry for `always` (scoped per bot/session), enqueues
  an `approval.resume` continuation wake, and broadcasts
  `tool-approval:updated`. The interactive fast path (`db:permission:resolve`)
  syncs card state via `syncApprovalCard` and burns the ledger entry.
- **Replay**: the continuation run's retried call is authorized by the
  one-shot ledger — `canUseTool` consumes the `approved` row on an exact
  tool-name + input-hash match (CAS `approved → consumed`), so nothing else
  is pre-approved and a replay can never double-execute.
- Renderer: `BotToolApprovalCard` (bot-direct transcript; hydrated from
  `db:toolApproval:listBySession`, live via `tool-approval:updated`).

### Provider Auth

- Credential store (in-memory by default)
- OAuth 2.0 PKCE flow
- Device code flow support

## Logging

### System

`apps/desktop/src/main/logging/logger.ts` - Structured logger

### Levels

| Level | Console | File |
|-------|---------|------|
| DEBUG | No | Yes |
| INFO | Yes | Yes |
| WARN | Yes | Yes |
| ERROR | Yes | Yes |
| FATAL | Yes | Yes |

Default: `WARN`. Set `LOG_LEVEL=DEBUG` for verbose output.

### Component Tags

Filterable by component: `LogComponent` constants (AgentProcess, IPC, DB, etc.)

### Output

- Console: stdout/stderr
- File: `%APPDATA%/DUYA/logs/app.log`
- Rotation: daily, 7 days retention

## Build System

### Frontend

- Vite 6: `vite.config.ts`
- Output: `dist/`

### Electron

- esbuild: `scripts/build-electron.mjs`
- Output: `dist-electron/`

### Agent Bundle

- Format: CommonJS
- Entry: `packages/agent/bundle/agent-process-entry.js`
- Production: `resources/agent-bundle/agent-process-entry.js`

### Packaging

- electron-builder: `electron-builder.yml`
- Output: `release/win-unpacked/`, `release/win/`

## Testing

### Unit Tests

- Vitest: `vitest.config.ts`
- Run: `npm run test`

### E2E Tests

- Playwright `_electron` API
- Run: `npm run test:e2e`

### UI Verification

- Playwright MCP
- Requires: `npm run dev` + MCP tools

## Development Commands

```bash
# Dev
npm run dev                    # Vite dev server only (port 3000)
npm run electron:dev           # Vite + Electron together

# Build
npm run build                  # Production build (Vite)
npm run build:web             # Web frontend only
npm run build:agent           # Build @duya/agent workspace (tsc)
npm run bundle:agent          # Bundle Agent subprocess entry (esbuild)
npm run electron:build         # Build Agent + bundle + Vite + Electron

# Typecheck
npm run typecheck:all         # Frontend + Agent

# Test
npm run test                   # Vitest tests
npm run test:watch            # Vitest watch mode
npm run test:coverage         # Tests with coverage
npm run test:e2e              # E2E tests

# Package
npm run electron:pack         # Package current platform
npm run electron:pack:win     # Windows (.exe installer)
npm run electron:pack:mac     # macOS (.dmg)
npm run electron:pack:linux   # Linux (AppImage, .deb, .rpm)
```

## Data Flow Examples

### Chat Message Flow

```
1. User types message in Renderer
2. Renderer calls Agent Server (HTTP POST /api/chat)
3. Agent Server spawns/gets Worker Process
4. Worker runs DuyaAgent.chat()
5. DuyaAgent calls @duya/ai for LLM
6. @duya/ai calls external LLM API
7. Response streamed back via SSE
8. Agent Server forwards to Renderer
9. Renderer updates UI
10. Message saved to DB + rollout file
```

### Tool Execution Flow

```
1. LLM returns tool_use in response
2. DuyaAgent emits tool_use event via SSE
3. Renderer displays tool call UI
4. User approves (or auto-approve)
5. ToolExecutor runs tool
6. Tool result streamed back to LLM
7. Continue conversation loop
```

### Tool-use Group Progress Titles

Tool-call groups may carry a short progress title with source metadata:
`provider_commentary`, `model_progress_tool`, or `tool_fallback`. The OpenAI
Responses adapter maps only output text explicitly marked with the
`commentary` phase; ordinary assistant text and reasoning stay on their
existing paths. Other adapters without a distinct commentary field can use
the private `progress_update({ title })` control call or the deterministic
fallback.

The agent intercepts `progress_update` before ordinary tool resolution,
permission checks, execution, and durable result persistence. It is replayed
only in the working model request context. Each emitted tool call captures a
stable group ID, title, and source, which travel through SSE to the renderer;
late tool results therefore remain attached to their original group. Fallback
titles use bounded, allowlisted display data and localized generic labels.

## Key Design Decisions

### Why SQLite?

- Single-file, portable
- FTS5 for full-text search
- Trigram for fuzzy matching
- ACID compliant

### Why separate Agent Server?

- Isolation: Agent runs in separate process
- Streaming: SSE requires HTTP server
- Memory: Long-running conversations in separate process
- Security: Limit blast radius

### Why Workspace Packages?

- Independent versioning
- Clear dependency boundaries
- Can be published separately
- TypeScript strict mode per package

## Glossary

| Term | Definition |
|------|------------|
| Agent | AI assistant that can use tools |
| Session | Chat conversation context |
| Rollout | Experiment/session data file |
| Skill | Composable tool set |
| Mode | Agent behavior modifier |
| Provider | LLM API adapter |
| MCP | Model Context Protocol |

### Chat attachment and mailbox delivery

- `packages/agent/src/utils/attachment-images.ts` loads image bytes by attachment object identity, so repeated clipboard filenames remain separate. Worker chat startup and checkpoint mailbox guidance share this pipeline. The worker passes the detected image-input capability to `ChatOptions`.
- `packages/agent/src/message/mailbox-attachment-context.ts` projects persisted mailbox attachments into text context and supported image blocks. Image-only followups and queued turns are valid; text-only models receive vision analysis when available. Runtime guidance retains the existing hidden/transient lifecycle.
- Chat edits restore text and attachments to `MessageInput`; transcript rewind happens on submission. Pending edits require a cancellation receipt before replacement. `MailboxPanel` is the single pending-message view and shows current-run versus next-turn routing with previews. Saved mailbox rows always enter the promotion path, including saves that finish after a run ends.
