# DUYA 架构文档

> 更新时间：2026-08-19（提示词系统章节重写：PromptSystem 声明式配置 + 四套 config + profile 段门控；Gateway 工具权限放开与完整提示词）
>
> 历史更新：2026-05-11（修正技术栈：移除不存在的 Zero Router，更新安全扫描器描述、BashClassifier 为 stub 实现、Gateway 组件名称）
>
> 历史更新：2026-04-24（新增安全扫描系统与提示词系统工程文档）
>
> 历史更新：2026-04-18（Golden Trident 数据架构重构：物理分离、单一职责、原子防御）

DUYA 是一个基于 Electron + Vite 的 AI Agent 客户端应用，采用 **Multi-Agent Process + SQLite 单点写入 + MessagePort 直连**架构。

## 技术栈

| 层 | 技术 |
|---|------|
| 桌面外壳 | Electron 28 |
| 前端框架 | Vite 6 + React 19（条件渲染，无 router 库）|
| Agent 核心 | `@duya/agent` + `@anthropic-ai/sdk` |
| 状态管理 | Zustand + SQLite (better-sqlite3) |
| 样式 | Tailwind CSS 4 |
| 构建工具 | esbuild (Electron) + Vite (Frontend) |
| 测试 | Vitest + Playwright |
| 定时任务 | croner |
| 更新 | electron-updater |

## 核心架构

### 当前架构：Multi-Agent Process + Main 总控

DUYA 采用 **Multi-Agent Process** 模式，每个 Agent 运行在独立的 **Child Process** 中：

- **进程隔离**：每个 Agent 实例运行在独立进程中，崩溃互不影响，LLM 调用和工具执行完全隔离
- **Resource Governor**：Main Process 中的 Resource Governor 限制并发 Agent 数量（CPU核数/2），防止 CPU/内存打爆
- **SQLite 单例写入**：数据库只在 Main 进程中操作，WAL 模式支持读写并发
- **消息先落库后转发**：Agent 发出的每条消息先通过 IPC 落库（SQLite-backed 队列），再转发给 Renderer，断线重连后可回放
- **Process Pool**：Main 维护进程池（spawn/kill），心跳监控检测僵尸进程并清理

```
┌─────────────────────────────────────────────────────────────────┐
│                    Electron Main Process（总控层）               │
│                                                                  │
│  ┌──────────────────────────┐  ┌────────────────────────────┐   │
│  │    SQLite 数据库          │  │    Resource Governor       │   │
│  │    唯一写入方             │  │    并发 Agent 上限（CPU/2） │   │
│  │    WAL 模式               │  │    心跳监控（杀僵尸进程）   │   │
│  └───────────┬──────────────┘  └────────────────────────────┘   │
│              │                                                   │
│  ┌───────────┴──────────────────────────────────────────────┐   │
│  │        持久化消息队列 (SQLite-backed)                      │   │
│  │  Agent 发出的每条消息先落库，再转发给 Renderer             │   │
│  └───────────┬──────────────────────────────────────────────┘   │
└──────────────┼──────────────────────┬───────────────────────────┘
               │ child_process IPC    │ ipcRenderer
               ▼                      ▼
┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐
│  Agent Process A    │  │  Agent Process B    │  │  Agent Process C    │
│  Session A          │  │  Session B          │  │  (排队等待)         │
│  LLM调用/工具执行   │  │  LLM调用/工具执行   │  │  等待 Resource       │
│  sub-agents         │  │  sub-agents         │  │  Governor 释放槽位  │
│  ⚙ TokenBucket     │  │  ⚙ TokenBucket     │  │  ⚙ TokenBucket     │
│  (进程内工具限速)   │  │  (进程内工具限速)   │  │  (进程内工具限速)   │
└─────────────────────┘  └─────────────────────┘  └─────────────────────┘
```

### 核心组件分工

| 组件 | 职责 | 文件 |
|------|------|------|
| **Main Process** | SQLite 单例（唯一写入方）、持久化消息队列、会话管理、配置管理、生命周期协调 | `electron/main.ts` |
| **ConfigStore** | 统一配置中心（指南针 + 保险箱），维护 `~/.duya/config.toml` + `~/.duya/secrets.json` 的内存快照、原子 TOML 持久化、MessagePort 广播 | `electron/config/store.ts` |
| **AgentProcessPool** | 并发 Agent 上限（CPU核数/2）、spawn/kill 管理、心跳监控（杀僵尸进程）、排队队列、每条消息落库 | `electron/agent-process-pool.ts` |
| **Session Manager** | Session 状态跟踪与会话生命周期管理 | `electron/session-manager.ts` |
| **Channel Manager** | MessagePort 通道管理（用于持久化连接）；invoke 通道用于主动查询（session 列表、历史加载）。注意：MessagePort 不可重连（窗口关闭即端口销毁） | `electron/message-port-manager.ts` |
| **ProviderStore** | Provider 配置读取（经 `ConfigStoreReader`），为 Agent/渲染层提供服务商与密钥 | `electron/services/providers/provider-store-config.ts` |
| **DB Handlers** | 数据库 IPC 处理器、Schema 管理、迁移、Safe Mode | `electron/db-handlers.ts` |
| **Agent Communicator** | Agent IPC 处理器、DB 请求分发 | `electron/ipc/agent-communicator.ts` |
| **Gateway Communicator** | Gateway/Bridge 进程管理、IPC 转发 | `electron/ipc/gateway-communicator.ts` |
| **Performance Monitor** | 性能指标采集、Prometheus 导出 | `electron/performance-monitor.ts` |
| **Automation Scheduler** | 定时任务调度、Cron 管理、执行历史 | `electron/automation/Scheduler.ts` |
| **Logger** | 结构化日志、文件轮转、日志级别管理 | `electron/logger.ts` |
| **Updater** | 自动更新检查、下载、安装 | `electron/updater.ts` |
| **Browser Daemon** | 浏览器扩展守护进程管理 | `electron/browser-daemon.ts` |
| **Agent Process** | 运行 duyaAgent 实例、LLM 调用、工具执行、**TokenBucket 工具限速**（进程内自管理）、sub-agents 管理、沙箱约束 | `packages/agent/src/process/` |
| **Renderer** | React UI（session tabs）、只读订阅状态，不直接操作数据库 | `src/` |

### 消息流

#### 标准 Agent 会话流

```
1. Renderer 发送 chat:start
   └─ MessagePort → Main Process

2. Main 通过 Resource Governor 检查并发限制
   └─ 有槽位：spawn Agent Process
   └─ 无槽位：进入排队队列，等待释放

3. Agent Process 启动 streamChat
   └─ 用户消息通过 IPC 发给 Main → Main 落库（message:add）

4. Agent 流式输出（每条消息先落库再转发）
   └─ Agent Process → Main（child_process IPC）
   └─ Main 落库（SQLite-backed 队列）→ 推 Renderer（MessagePort）
   └─ 断线重连后可从队列回放

5. 工具调用结果同样先落库再转发
   └─ tool_result/tool_progress → Main → DB → Renderer

6. 切换 session 时，Renderer 从 SQLite 读消息历史
   └─ ipcRenderer.invoke('db:message:getBySession', sessionId)
   └─ 即使 Agent 已崩溃或仍在运行，历史消息完整可用

7. 权限请求：Main 转发给 Renderer → 用户决策 → 发回 Agent
```

#### Gateway/Bridge 外部消息流

```
外部平台（Telegram/微信等）
         │
         ▼
┌─────────────────┐
│  Gateway Process │ 独立进程，管理外部平台连接
│  (gateway-communicator.ts)
└────────┬────────┘
         │ MessagePort
         ▼
┌─────────────────┐
│   Main Process   │ 转发到对应 Session
│  (查找或创建 Session)
└────────┬────────┘
         │ child_process IPC
         ▼
┌─────────────────┐
│  Agent Process   │ 处理消息，生成回复
└────────┬────────┘
         │
         ▼
    回复原路返回给外部平台
```

#### Gateway Agent runtime contract

- Gateway sessions use `agentProfileId: 'gateway'` and fixed
  `permission_profile='default'`; an inbound turn repairs legacy rows that still
  contain another permission profile.
- The configured `bridge_workspace` is prepared before use and defaults to
  `~/.duya/workspace`. `electron/gateway/message-bus.ts` passes it as the
  Agent Server request's top-level `workingDirectory` and
  `defaultWorkspaceDirectory`; placing it only under `options` does not
  initialize the worker cwd.
- The Gateway profile allows the full tool surface — write/edit, Bash/
  PowerShell, todo, duya_cli self-management, vision, browser, skill,
  send_artifact — and only denies desktop-only interactive tools
  (canvas:* / show_widget / AskUserQuestion / read_module), recursive
  subagent spawning (`task`), and plan-mode switching
  (EnterPlanMode/ExitPlanMode/SwitchMode). The shell security classifier
  retains confirmation requirements for risky commands.
- The Gateway system prompt is the full general composition (memory,
  skills, MCP, environment, session guidance, vision) plus the
  gateway-unique intro / gatewayRole / toneAndStyle sections;
  `duyaDesktopContext` is excluded (it self-describes as inapplicable to
  IM channels). AGENTS.md is loaded via the same preBuildHook as the
  desktop agents.
- Channel media delivery accepts accessible absolute paths through
  `MEDIA:<absolute-path>`; a file does not need to be copied into the Gateway
  workspace first.
- `SessionSearch` / `MessageSession` are optional continuity tools, not a
  default substitute for handling the user's task with local tools.

### Agent Message Domain (runtime-active)

`packages/agent/src/message/message-framework.ts` is the runtime message domain.
It separates append-only timeline entries, extensible Agent messages, provider
`Message[]` projection, runtime context, UI visibility, and compaction
checkpoints. Compaction appends a checkpoint; model context is projected from
its summary plus the retained suffix without deleting raw history.

The domain is wired into `DuyaAgent` (`packages/agent/src/agent/DuyaAgent.ts`):
`MessageTimeline` is the runtime authority for conversation history, the
`messages` getter is a durable projection of the timeline snapshot, compaction
goes through `MessageCompactionController`, and runtime context (mailbox,
attachment, task-notification) is injected via `runtime-context-adapters`. The
renderer reuses the same boundary projector (`projectTranscriptMessages`) for
visibility filtering (`src/lib/project-message-transcript.ts`).

It is exported through the bundle-safe subpath `@duya/agent/message`
(`packages/agent/src/message/index.ts`), not the main entry
`packages/agent/src/index.ts`, so it never pulls in native deps such as
better-sqlite3.

#### Compaction trigger guards (loop protection)

Auto-compaction fires from `shouldCompact()` when context usage exceeds 78%
of the window. Three guards sit in front of that threshold
(`packages/agent/src/compact/CompactionManager.ts`, constants in `compact/types.ts`):

- **Usage anchoring.** The agent feeds each provider `result` event's prompt
  volume back via `setObservedPromptTokens()`; threshold decisions prefer this
  real number over the character-heuristic estimate (estimator drift alone can
  no longer fire a compaction).
- **Post-compaction cooldown** (`AUTO_COMPACT_COOLDOWN_MS`, 2 min). Every
  successful compact blocks proactive re-triggering for the window; `shouldPrefire`
  respects it too. Manual `/compact` and emergency recovery are exempt.
- **Loop breaker.** If consecutive auto-compactions show <10% growth in
  `tokensBefore` (`COMPACT_LOOP_DELTA_RATIO`), strikes accumulate; two strikes
  emit `compaction_loop_suspected` and block auto-compaction for 10 minutes.
  A post-compact self-check flags `overThresholdAfterCompact` when the final
  projection still sits at/above the threshold.

These exist because session `5e930b44` (2026-08-26) compacted every ~50–90s:
a post-compaction projection still reading over threshold had nothing
preventing immediate re-triggering, burning one summarizer call per turn.

### Message Persistence

Message persistence converges on a single append-only writer with
stable-boundary batch writes.

- **Single writer = Agent worker.** All messages (user / assistant / tool_use /
  tool_result) are persisted by the worker to the `messages` table through
  `appendMessages` over IPC. The renderer no longer writes to the DB.
- **Stable-boundary batch persistence.** No time-based incremental saving (the
  5s incremental-save queue and the `existingMessageCount` correction chain are
  removed). Writes happen only at stable points where a message is already
  complete: user message arrival, completion of each tool round (tool_use +
  tool_result together), completion of an assistant reply (once `token_usage`
  is available), and turn end. Concretely the worker persists the whole turn's
  new messages (user + assistant + tool_use + tool_result) in a single
  end-of-turn `appendMessages`, and re-appends the full list after compaction
  (`INSERT OR IGNORE` is idempotent). A crash can lose only the in-flight
  assistant draft.
- **`conversation_entries` is sealed (not wired).** The dual data model is
  retired; persistence uniformly uses the `messages` table.
- **Front-end chat messages are optimistic only.** User messages live in the
  renderer store and are never written to the DB by the renderer.
- **Unified IPC transport.** `USE_IPC_MODE` is always true in production; the
  worker persists through the IPC `messageDb` client. The local open-DB branch
  is only for the CLI / tests.

### File-level Checkpoint / Rewind (Plan 429 #3)

Edit/Write/ApplyPatch capture a **pre-image snapshot** before every mutation so
a session rewind can roll files back together with the conversation timeline.

- **Store**: content-addressed `~/.duya/snapshots/<sha256>.blob`
  (`packages/agent/src/tool/file-snapshot-store.ts`). Same pre-image content is
  stored exactly once regardless of how many edits reference it. Snapshotting
  is best-effort — a failed snapshot never fails the tool.
- **Reference flow**: the tool result records `metadata.preImageSha` +
  `metadata.filePath` (Edit/Write) or `metadata.fileSnapshots: [{path,
  preImageSha}]` (ApplyPatch). The persistence adapter
  (`electron/ipc/core-db-adapters.ts`) whitelists exactly these keys into the
  persisted rollout payload; heavy renderer-only metadata (browser results,
  screenshots) is deliberately dropped.
- **Restore**: `db:message:truncateAfter` / `truncateFromInclusive` restore all
  pre-images referenced by the removed events BEFORE shrinking the timeline
  (`electron/services/file-snapshot-restore.ts`), and return `restoredFiles`
  for a UI toast ("Restored N files"). For any path edited multiple times
  inside the rewound span, the OLDEST edit's pre-image wins. A standalone
  `db:files:restore` IPC restores without truncating (manual recovery).
  Blobs are hash-verified before write-back; only absolute paths are honored;
  "created-new" files are never deleted.
- **GC**: `electron/services/snapshot-gc.ts` sweeps blobs at startup (delayed,
  fire-and-forget): a blob older than 24h that no rollout file references
  anymore (its turn was rewound away or its session deleted) is deleted.
  Known gap: shell-command file mutations (Bash/PowerShell) have no snapshots
  and cannot be restored.

### IPC 消息协议

**Main ↔ Agent Process (child_process IPC)**:

| 消息类型 | 方向 | 说明 |
|---------|------|------|
| `init` | Main → Agent | 初始化 Provider 配置 |
| `chat:start` | Main → Agent | 聊天请求 |
| `chat:interrupt` | Main → Agent | 中断当前操作 |
| `permission:resolve` | Main → Agent | 权限决策 |
| `spawn` / `kill` | Main → Agent | 进程生命周期 |
| `ready` | Agent → Main | Agent 就绪通知 |
| `chat:text/thinking/tool_use/tool_result/tool_output` | Agent → Main | 流式输出（先落库再转发） |
| `chat:permission` | Agent → Main | 权限请求 |
| `chat:done/error/status` | Agent → Main | 状态通知 |
| `chat:db_persisted` | Agent → Main | 数据库持久化结果通知 |
| `chat:token_usage` | Agent → Main | Token 使用量 |
| `chat:context_usage` | Agent → Main | 上下文窗口使用量 |
| `chat:tool_progress` | Agent → Main | 工具执行进度 |
| `db:request` | Agent → Main | 数据库操作请求 |
| `db:response` | Main → Agent | 数据库操作响应 |
| `ping/pong` | 双向 | 心跳检测（Process Pool 健康监控） |

**Renderer ↔ Main (MessagePort - agentControl)**:

| 消息类型 | 方向 | 说明 |
|---------|------|------|
| `chat:start` | Renderer → Main | 开始聊天 |
| `chat:interrupt` | Renderer → Main | 中断聊天 |
| `permission:resolve` | Renderer → Main | 权限决策 |
| `chat:text/thinking/tool_use/tool_result/tool_output` | Main → Renderer | 流式输出 |
| `chat:permission` | Main → Renderer | 权限请求 |
| `chat:done/error/status` | Main → Renderer | 状态通知 |
| `chat:db_persisted` | Main → Renderer | 数据库持久化通知 |
| `chat:token_usage` | Main → Renderer | Token 使用量 |
| `chat:context_usage` | Main → Renderer | 上下文窗口使用量 |
| `chat:tool_progress` | Main → Renderer | 工具执行进度 |

**Renderer ↔ Main (MessagePort - config)**:

| 消息类型 | 方向 | 说明 |
|---------|------|------|
| `config:get` | Renderer → Main | 获取配置 |
| `config:set` | Renderer → Main | 设置配置 |
| `config:subscribe` | Renderer → Main | 订阅配置变更 |
| `config:update` | Main → Renderer | 配置变更广播 |
| `config:response` | Main → Renderer | 配置查询响应 |

**Renderer ↔ Main (Electron IPC invoke)**:

| 通道 | 说明 |
|------|------|
| `db:session:*` | Session CRUD 操作 |
| `db:message:*` | Message CRUD 操作 |
| `db:task:*` | Task CRUD 操作 |
| `db:permission:*` | Permission 操作 |
| `db:setting:*` | Settings 操作 |
| `config:provider:*` | Provider 操作 (ProviderStore 管理) |
| `db:search:*` | 搜索操作 |
| `db:channel:*` | Channel 操作 |
| `db:project:*` | Project 操作 |
| `net:testProvider` | Provider 连接测试 |
| `dialog:openFolder` | 原生文件夹选择 |
| `shell:openPath` | 打开路径 |
| `projects:*` | 最近项目 |
| `gateway:*` | Gateway/Bridge 管理（启动、停止、状态查询） |
| `automation:cron:*` | 定时任务 CRUD 操作 |
| `updater:*` | 自动更新检查、下载、安装 |
| `logger:*` | 日志查询、导出 |
| `browser:*` | 浏览器扩展守护进程管理 |

**Main ↔ Gateway Process (MessagePort)**:

| 消息类型 | 方向 | 说明 |
|---------|------|------|
| `gateway:init` | Main → Gateway | 初始化 Gateway 配置 |
| `gateway:start` | Main → Gateway | 启动平台连接 |
| `gateway:stop` | Main → Gateway | 停止平台连接 |
| `gateway:message` | 双向 | 消息转发 |
| `gateway:status` | Gateway → Main | 连接状态更新 |
| `gateway:error` | Gateway → Main | 错误通知 |

### Resource Governor

Resource Governor 负责防止 CPU/内存被打爆，是 Main Process 中的核心调度组件：

#### ① 并发 Agent 上限（进程级）

限制同时运行的 Agent Process 数量，防止系统过载：

- **`maxConcurrent`** 动态计算：`Math.min(os.cpus().length / 2, 4)`
- 且空闲内存 > 2GB 时才允许开新槽位
- 超出限制的请求进入 **排队队列**，等待槽位释放

#### ② Token 桶限速（进程内，Agent Process 自管理）

**TokenBucket 在每个 Agent Process 内独立运行**，不属于 Main Process：

- **位置**：每个 Agent Process 内部（`agent-process-entry.ts`）
- **容量**：最多 5 个并发工具调用
- **补充速率**：每秒补充 2 个令牌
- **理由**：工具调用频率不需要跨进程协调，每个 Agent Process 独立限速即可，Main 无法感知 Agent 内部工具调用频率
- 工具调用前必须获取令牌，无令牌则等待（进程内自旋，不阻塞 Main）

#### ③ 健康监控（心跳 + 僵尸清理）

AgentProcessPool 对每个 Agent Process 定期发心跳，超时未响应则强杀并清理：

```typescript
setInterval(() => {
  for (const [sid, proc] of this.running) {
    proc.send({ type: 'ping' });
    setTimeout(() => {
      if (!this.lastPong.get(sid) || Date.now() - this.lastPong.get(sid) > 5000) {
        proc.kill('SIGKILL');
        this.release(sid);  // 释放槽位，让排队的新请求有机会运行
      }
    }, 3000);
  }
}, 10000);
```

#### 进程池生命周期

```
Main 收到 chat:start
  │
  ├─ AgentProcessPool 检查 maxConcurrent
  │    └─ running.size < maxConcurrent → spawn Agent Process
  │    └─ running.size >= maxConcurrent → 进排队队列（Queue）
  │
  ├─ Agent Process 启动完成，发送 ready → Main
  │
  ├─ Agent 运行中，心跳监控持续检测
  │    └─ ping 超时 → kill → release 槽位 → 触发队列下一个
  │
  └─ chat:done → Agent 退出 → release 槽位 → 触发队列下一个
```

### 自定义 Agent（config.toml `[agents.<id>]`）

用户自定义 agent 完全由 `~/.duya/config.toml` 驱动（Plan 424 + custom-agent-creation），不落 DB。每个 agent 有独立 `workspace` + 全局指令文件（`agents_md`，默认 `<workspace>/AGENTS.md`），`model` 覆盖会话模型，`tools`/`plugins` 决定工具面。

```toml
[agents."frontend-expert"]
name = "Frontend Expert"
description = "前端专家，专注 React/TS"
model = "anthropic/claude-sonnet-4-20250514"   # 覆盖会话模型（省略 → 回退默认）
workspace = "~/duya-workspaces/frontend"        # 该 agent 自己的工作目录
agents_md = "~/.duya/agents/frontend-expert/AGENTS.md"  # 全局指令路径（省略 → <workspace>/AGENTS.md）
tools = { profile = "coding", allow = ["file:*", "search:*"], deny = ["browser"] }
plugins = ["mcp:github"]                        # 本版本仅存储+暴露，per-agent MCP 门控为 follow-up
```

- **schema**：`CustomAgentConfig` + `DuyaConfig.agents`（`electron/config/schema.ts`），默认 `{}`。
- **读链路**：
  - 主进程/前端：renderer IPC `config:agents:list`（`electron/ipc/db-handlers.ts`）→ `electron/preload.ts` `configAgents.list` → `src/lib/agent-profile-ipc.ts` `listCustomAgents()`；picker/快捷位用 `listMainAgentProfiles()` 与 3 个预设合并展示；选自定义 agent 建会话时用其 `model`/`workspace` 覆盖（`NewChatView.tsx`）。
  - 运行时：`packages/agent/src/agent-profile/config-agents.ts` `readConfigAgents()`/`toAgentProfile()` 直接读 config.toml（复刻 `readUserMcpToml` 先例），`DuyaAgent._resolveAgentProfile` 对非预设 id 构建 `AgentProfile`，`agent-shell.ts buildSystemPrompt` 把 `agents_md` 内容作为独立 `<system-reminder>` 块注入。
- **写链路（三端统一）**：`electron/config/agents.ts` 共享写模块（`listConfigAgents`/`upsertConfigAgent`/`deleteConfigAgent`，校验 id 格式 + name 必填，经 ConfigStore 持久化 + hot-reload）。
  - 表单：renderer IPC `config:agents:create/update/delete`（`db-handlers.ts` + `preload.ts`）→ `src/lib/agent-profile-ipc.ts` 写客户端 → `AgentsSection.tsx` CRUD 表单。
  - CLI：`duya agent create/list/delete`（`packages/cli/src/commands/agent.ts`）→ HTTP `GET/POST /v1/config/agents`、`DELETE /v1/config/agents/:id`（`electron/cli/handlers/config.ts` + `cli-api-server.ts`）→ 写模块。CLI 侧先 `fs.mkdirSync` 建 workspace / 写 AGENTS.md，再调 HTTP 写 config。
  - 对话式：内置 `packages/agent/skills/development/agent-create/SKILL.md` skill 用现有文件工具直接写 config.toml + workspace（`~/.duya` 已在 allowed-dirs），不经 IPC。
- **约束**：id 需匹配 `/^[a-z0-9][a-z0-9-]*$/`；删除仅移除 config 段，不动 workspace/AGENTS.md。

### 安全设计

#### Golden Trident 数据架构："物理分离、单一职责、原子防御"

DUYA 的所有本地数据以 `userData` 目录下的若干物理文件承载，按职责分层：

| 文件类别 | 路径 | 管理者 | 核心内容 | 加密策略 |
|:---|:---|:---|:---|:---|
| **统一配置·明文** (指南针 + 保险箱) | `~/.duya/config.toml` | `ConfigStore` (`electron/config/store.ts`) | `storage.database_path`、`providers` (服务商元数据)、`agentSettings`、`uiPreferences`、`migrations` 等 | **明文** (不含任何密钥) |
| **统一配置·机密** (保险箱) | `~/.duya/secrets.json` (0600) | `ConfigStore` | `apiKeys`/`tokens` 等服务商密钥 | **文件权限 0600** (密钥与 config.toml 物理分离) |
| **业务流水·状态与索引** (账本) | `/databases/duya-core.db` | `CoreDatabase` (`electron/db/core/`) | 六大核心聚合的状态与索引：`sessions` (会话元数据)、`message_index` (消息轻量索引)、`mailbox_items`、`tasks`、`permission_requests`、`session_runtime_locks` | **明文** (依赖系统文件权限保护) |
| **业务流水·消息载体** (账本) | `/databases/sessions/` (rollout 目录) | `MessageLog` (`message-log.ts`) | 每条会话一个 append-only JSONL rollout 文件，逐行存消息/压缩事件的完整 payload | **明文** (依赖系统文件权限保护) |
| **旧库** (封存) | `/databases/duya-main.db` | 仅 `LegacyImport` 只读 | 六大核心表已冻结 (LEGACY FROZEN)，仅供升级导入 + conductor/research/gateway 等子系统自有表 | **明文** |

核心存储是**两层结构**：`duya-core.db` 仅存状态列与轻量索引（无消息 payload），消息的完整内容落在 `sessions/` 的 rollout JSONL 文件里，`message_index.file_offset`/`byte_len` 指向文件内精确行。首启会将旧库六大核心表只读搬入（`legacy-import.ts`，幂等可重试），此后运行时读写全部走 core store，旧表物理保留作为回滚保险（物理删除留给未来版本）。

写入纪律：单一写者（Main Process DB 层）、稳定边界、消息 append-only（Plan 441：所有写路径已统一到 `appendBatch` + `appendRebase`；`rewriteSession` 保留为兼容接口但生产路径不再调用）。崩溃恢复靠 `MessageLog.scan()` 对账文件行数与索引行数。搜索无 FTS：会话走参数化 LIKE，正文走 `searchText` 扫 rollout 文件。

**Plan 441 事件级 journal**：每个语义事件（`user_msg_added`、`assistant_message_finalized`、`tool_result_added`、`rebase`、`hook_invoked`）由 `packages/agent/src/journal/Journal.ts` 在 `_pushDurable` 边界立即写盘（IPC `message:append` / `journal:emit`），不再依赖 turn 末尾批量。崩溃粒度从一个 turn 缩到最后一个工具调用；任意日志前缀合法（`repairInterruptedToolCalls` 在读侧合成中断的 tool_result）。组提交 fsync 政策见 `electron/db/core/fsync-policy.ts`（200ms 组窗口 + `user_msg` / `turn_end` 屏障立即 fsync）。

#### 主进程生命周期时序

各文件在主进程启动时的介入时机有严格的先后顺序：

1. **第 0 步：独占锁检查** — `app.requestSingleInstanceLock()`，防止多开引起的文件争抢
2. **第 1 步：读取引导文件 (Boot)** — 通过 `electron/config/compass.ts` 同步读取 `~/.duya/config.toml` 的 `storage.database_path`（空则用默认路径），拿到 `databasePath`
3. **第 2 步：初始化数据库网关 (DB Init)** — 根据拿到的路径，实例化 `better-sqlite3`，持有 SQLite 文件排他锁
4. **第 2.5 步：初始化核心数据库 (Core Init)** — `initCoreDatabase()`：建 `duya-core.db` + rollout 目录，跑全部迁移，并在**任何会话服务接受请求前**执行旧库只读导入（`LegacyImport.needsImport()` → `run()`，失败记 WARN 下次重试；无旧库则写 `none@<ts>` 标记）
5. **第 3 步：初始化配置中心 (Config Init)** — 实例化 `ConfigStore`（加载 `~/.duya/config.toml` + `~/.duya/secrets.json`）、`ProviderStore`（经 `ConfigStoreReader` 读取服务商与密钥）
6. **第 4 步：拉起 Daemon 与 UI** — 数据库和配置双双就绪后，启动子系统并加载前端窗口

#### 数据库迁移 (搬家) 工作流

当用户要求将数据库转移到其他位置时，遵循 **"锁定 → 迁移 → 篡改引导 → 重启"** 的流程：

1. **暂停 I/O**：通知 Daemon 暂停所有后台流式写入任务
2. **安全复制**：主进程获取用户选择的新路径，将 `.db`、`.db-wal`、`.db-shm` 三个文件完整复制到新位置
3. **更新指南针**：将 `~/.duya/config.toml` 的 `storage.database_path` 覆写为新路径（`ConfigStore` 原子写入）
4. **强制重启**：主进程调用 `app.relaunch()` + `app.exit(0)` 释放旧锁并接管新库

#### Bulletproof 防御策略

* **防御 1：原子写入 (防断电损坏)** — 使用 `write-file-atomic` 库，先写入临时文件 `.tmp`，落盘成功后由 OS 执行原子级 Rename 覆盖原文件
* **防御 2：Safe Mode 回退 UI (防幽灵磁盘)** — 数据库寻址失败时不退出应用，渲染极简的"安全恢复模式"页面，提供"重新定位文件"或"重置到默认路径"按钮
* **防御 3：防止 API 密钥裸奔 (防黑客拖库)** — 服务商密钥必须且只能由 `ConfigStore` 掌管，写入权限 0600 的 `~/.duya/secrets.json`，与明文 `config.toml` 物理分离

#### API Key 保护

- **Provider 存储**：API Provider 配置统一由 ConfigStore 管理，密钥写入权限 0600 的 `~/.duya/secrets.json`，服务商元数据存于 `config.toml`
- Provider 查询结果返回给 Renderer 时，API Key 自动脱敏（`sk-xxxx***xxxx`）
- Agent Process 获取完整 API Key 用于实际 API 调用（Main 在 `init` 消息中传递）

#### IPC 输入验证

- `shell:open-path`：验证路径类型、长度、空字节
- `projects:add-recent-folder`：验证路径合法性
- `notification:show`：验证标题和内容长度

#### 崩溃恢复

Process Pool 对每个 Agent Process 心跳监控，僵尸进程自动清理：

```typescript
// Process Pool 检测到 Agent 崩溃
proc.on('exit', (code) => {
  // 1. 从 running Map 移除
  this.running.delete(sessionId);
  // 2. 释放槽位，触发队列下一个
  this.release(sessionId);
  // 3. 通知 Renderer
  broadcastToRenderers('agent:disconnected', { sessionId, code });
  // 4. 如果有排队请求，spawn 新的 Agent
  if (this.queue.length > 0) {
    const next = this.queue.shift()!;
    this.spawn(next.sessionId);
  }
});
```

Renderer 通过 `agent:disconnected` 感知 Agent 崩溃，已落库的消息不丢失。

### Provider 模型（多服务商并存）

DUYA 采用**多服务商并存**（multi-provider）模型：用户可以在 `~/.duya/config.toml` 中配置任意数量的 LLM 服务商，每位服务商都**可独立选用**。系统不再强制全局"唯一活跃服务商"约束。

> **服务商目录单一数据源**：`@duya/ai` 现为 provider 的单一数据源（`ProviderCatalog`，见 `packages/ai/src/providers/catalog.ts` + `catalog-data.ts`）。前端"服务商设置"快速添加目录（`VENDOR_PRESETS`）与模型预设元数据统一从 `@duya/ai` 派生，不再在 `src/lib/provider-presets.tsx` 各自硬编码维护。

#### 数据结构

- **`AppConfig.apiProviders: Record<string, ApiProvider>`** — 全部已配置服务商，按 id 索引。
- **`AppConfig.defaultProviderId: string | null`** — **软默认**。仅作为隐式回退，不锁定其他服务商。
- **渲染层 DTO (`RendererLlmProviderDTO.isDefault`)** — 由 `defaultProviderId` 派生；取代旧字段 `isActive`。

#### 路由优先级

会话、视觉、网关、标题生成、嵌入、定时任务等子系统，按以下优先级选择服务商：

1. **会话级 pin** — 主进程 `AgentProcessPool` 接收渲染层 `setSessionProvider(sessionId, providerId)`，将该会话钉到指定服务商。
2. **任务级显式选择** — 视觉 / 网关 / 嵌入等子系统可以显式传入 `providerId`。
3. **软默认** — `AppConfig.defaultProviderId`。
4. **首个可用服务商** — 配置中第一个 `hasApiKey` 为 `true`（或 `providerType === 'ollama'`）的条目。
5. **未配置** — `sendProviderInit` 记录 WARN 日志并跳过 init，UI 暴露"未配置默认服务商"提示。

#### 迁移

`multi-provider-v1` 迁移已折叠进 `electron/config/migrate.ts` 的 `migrateSettingsJson`，在配置加载时执行一次：

- 若 `defaultProviderId` 未设置且**有且仅有一个** `isActive=true` 的服务商，则将该 id 写入 `defaultProviderId`。
- 清除所有 `isActive` 标志（让 `isDefault` 成为唯一权威状态）。
- 标记 `migrations['multi-provider-v1'] = true`，防止重入。

#### 受影响的子模块

| 子模块 | 行为 |
|:---|:---|
| Agent Process Pool | 优先使用 `RunningProcess.providerId`，回退到 `defaultProviderId`；切换 provider 触发 `reinitProcess` |
| 视觉 | `providerId` → `defaultProviderId` → 首个可用 |
| 网关 / 标题生成 / 嵌入 | 同上 |
| 定时任务 | 同上 |
| Provider UI 卡片 | 旧 "In use" / "Enable" 改为 "Default" / "Set as default"；不再隐藏非默认卡片的 delete 按钮 |
| 设置面板 | 新增 **Default Provider** 区块，使用 `ProviderPickerView` |
| CLI | 新增 `duya config provider set-default [id] --clear`；`provider activate` 标记为 deprecated |

### 安全扫描系统

DUYA 实现了多层安全扫描机制，防止提示词注入和恶意代码执行：

#### 扫描器架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        Security Scanners                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐ │
│  │ ContextScanner  │  │  SkillScanner   │  │ BashClassifier  │ │
│  │                 │  │                 │  │                 │ │
│  │ - AGENTS.md     │  │ - SKILL.md      │  │ - Command       │ │
│  │ - ARCHITECTURE  │  │ - External      │  │   classification│ │
│  │   .md           │  │   skills        │  │ - Dangerous     │ │
│  │ - SOUL.md       │  │ - Trust levels  │  │   pattern detect│ │
│  │                 │  │                 │  │                 │ │
│  │ 24+ threat      │  │ 80+ threat      │  │ Stub (ant-only   │
│  │ patterns        │  │ patterns        │  │ classifier perm) │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘ │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

#### ContextScanner（上下文文件扫描）

扫描上下文文件（AGENTS.md、ARCHITECTURE.md、SOUL.md 等）中的提示词注入攻击：

**文件位置**：`packages/agent/src/security/contextScanner.ts`

**检测的威胁类型**：

| 威胁ID | 描述 | 严重程度 |
|--------|------|----------|
| `prompt_injection` | "ignore previous instructions" 等指令覆盖 | Critical |
| `deception_hide` | "do not tell the user" 隐藏信息指令 | Critical |
| `sys_prompt_override` | 系统提示词覆盖尝试 | Critical |
| `bypass_restrictions` | 绕过限制指令 | Critical |
| `html_comment_injection` | HTML注释隐藏指令 | High |
| `hidden_div` | display:none 隐藏内容 | High |
| `env_exfil_curl` | curl泄露环境变量 | Critical |
| `read_secrets` | 读取.secret文件 | Critical |
| `invisible_unicode` | 零宽字符等不可见字符 | High |
| `jailbreak_dan` | DAN越狱模式 | Critical |

**使用示例**：

```typescript
import { scanContextContent } from './security/contextScanner.js';

const result = scanContextContent(content, filename);
if (!result.safe) {
  console.warn('Blocked:', result.blockedContent);
  console.log('Findings:', result.findings);
}
```

#### SkillScanner（技能安全扫描）

扫描技能文件的安全威胁，支持信任等级系统：

**文件位置**：`packages/agent/src/security/skillScanner.ts`

**威胁分类**：

| 分类 | 说明 | 示例 |
|------|------|------|
| `injection` | 提示词注入 | 角色劫持、指令覆盖 |
| `exfiltration` | 数据外泄 | 环境变量读取、密钥泄露 |
| `destructive` | 破坏性操作 | rm -rf /、mkfs |
| `persistence` | 持久化攻击 | crontab、SSH后门 |
| `network` | 网络攻击 | 反弹shell、隧道 |
| `obfuscation` | 混淆攻击 | base64解码、eval |
| `privilege_escalation` | 权限提升 | sudo滥用、SUID |
| `credential_exposure` | 凭证泄露 | 硬编码API密钥 |

**信任等级**：

```typescript
type TrustLevel = 'builtin' | 'trusted' | 'community' | 'agent-created';

// 安装策略
const INSTALL_POLICY = {
  builtin: ['allow', 'allow', 'allow'],
  trusted: ['allow', 'allow', 'block'],
  community: ['allow', 'block', 'block'],
  'agent-created': ['allow', 'allow', 'ask'],
};
```

#### BashClassifier（命令分类器）

**文件位置**：`packages/agent/src/security/bashClassifier.ts`

**当前状态**：Stub 实现（`isClassifierPermissionsEnabled()` 返回 `false`），分类器权限仅在 Claude Code（ant）中使用。

BashClassifier 在 DUYA 中未启用，命令分类由 SkillScanner 的 `execution` 类别处理。

### 提示词系统

DUYA 采用**声明式配置驱动**的提示词组装：一个 `PromptSystem` 类 + 四份 `PromptSystemConfig`
（general / code / research / gateway），由 `PromptsRegistry` 按 agent profile 解析。

#### 架构概览

```
┌───────────────────────────────────────────────────────────────┐
│                  Prompt System Architecture                   │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌───────────────┐   ┌────────────────┐   ┌───────────────┐  │
│  │  AgentProfile │   │ PromptsRegistry │   │  PromptSystem │  │
│  │ .promptSystem │──▶│ (name→config)  │──▶│ (单一具体类)  │  │
│  └───────────────┘   └────────────────┘   └───────┬───────┘  │
│  ┌─────────────────┐         ┌────────────────────┘          │
│  │ .promptProfile  │         │  staticSections（缓存）       │
│  │ enable/disable  │────────▶│  dynamicSections（每轮重算）  │
│  │ 段级门控        │         │  preBuildHook / contextExtender│
│  └─────────────────┘         └────────────┬────────────────┘  │
│                                            ▼                  │
│                    ┌──────────────────────────────────┐       │
│                    │ [Static] + BOUNDARY + [Dynamic]  │       │
│                    └──────────────────────────────────┘       │
└───────────────────────────────────────────────────────────────┘
```

#### 核心组件

| 组件 | 文件 | 职责 |
|------|------|------|
| **PromptSystem** | `packages/agent/src/prompts/PromptSystem.ts` | 单一具体类：static 缓存 + dynamic 每轮重算 + profile 段门控 + hooks |
| **PromptSystemConfig** | `packages/agent/src/prompts/configs/{general,code,research,gateway}.ts` | 四套声明式配置：静态段 / 动态段 / preBuildHook / contextExtender |
| **PromptsRegistry** | `packages/agent/src/prompts/registry.ts` | 注册表 + `resolvePromptSystemName`（profile 未指定时默认 general） |
| **Profile 段门控** | `packages/agent/src/prompts/modes/index.ts` | `isSectionEnabled`：按 profile 的 enableSections/disableSections 过滤段落 |
| **General 段** | `packages/agent/src/prompts/general/sections/*.ts` | identity/communication/finalAnswer/system/tasks/destructiveActions/tools/skillUsage/project 等 |
| **Code 段** | `packages/agent/src/prompts/code/sections/*.ts` | code 自有 identity/system/personality/workingWithTheUser/rules |
| **Gateway 段** | `packages/agent/src/prompts/gateway/sections/*.ts` | intro（渠道身份）/ gatewayRole / toneAndStyle（渠道独有） |
| **Research 段** | `packages/agent/src/prompts/research/sections/*.ts` | research 状态机相关段落 |
| **Dynamic 段** | `packages/agent/src/prompts/sections/dynamic/*.ts` | language/outputStyle/platform/environment/mcp/skills/scratchpad/memory/sessionSearch/recentSessions/sessionGuidance/vision 等（每轮重算） |
| **Mode modifiers** | `packages/agent/src/prompts/modes/` | plan-task/research/conductor/goal 叠加：工具注入 + prompt 前缀/后缀 + ToolUseContext |

#### 四套配置的组成

| | general | code | research | gateway |
|---|---|---|---|---|
| 身份/行为段 | identity + communication + finalAnswer | code 自有 identity/system + workingWithTheUser | research 自有 | **intro（渠道身份）+ gatewayRole + toneAndStyle** |
| 静态段 | 10 | 8 | research 自有 | 11（general 主体 + gateway 3 独有） |
| 动态段 | 13 | 12 | research 自有 | 13（与 general 一致） |
| duyaDesktopContext | ✅ | ✅ | — | ❌（段落自述不适用于 IM 渠道） |
| AGENTS.md（preBuildHook） | ✅ initializeAgentsMd | ✅ | — | ✅ initializeAgentsMd |

#### Section 类型

**Static Sections（可缓存）**：内容在会话内不变，例如 intro、system、tasks、destructiveActions、tools。

**Dynamic Sections（每轮重算）**：`buildSystemPrompt` 每次 `streamChat` 调用一次，例如 language、environment、memory、mcp、skills、sessionGuidance。

**缓存边界标记**：

```typescript
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__';

// 提示词结构：
// [Static Sections] + BOUNDARY + [Dynamic Sections]
```

#### AGENTS.md 注入（Plan 408 Phase 5）

AGENTS.md 以 `<system-reminder>` 包裹拼入 **system 字段**（`AgentsMdManager.buildAgentsMdSection()`），落在 system-prefix 缓存断点上；`preBuildHook`（initializeAgentsMd）在构建前刷新快照，`omitClaudeMd` 子代理跳过。详见下文 Plan 408 章节。

#### Project-grounded harness invariants (Plan 226)

Workspace-capable prompt profiles share a governance layer before their
role-specific instructions:

- `projectContinuity` is enabled for coordinating/full agents and defines the
  canonical plan, checkpoint, handoff, and reconciliation contract for work
  spanning sessions or agents.

`AgentsMdManager.refreshForTask()` reloads resolved project instructions at a
prompt-build boundary and invalidates the cached section only when the snapshot
changes. Full, minimal, and bare workspace profiles retain `agentsMd`; profiles
without a project workspace explicitly disable the project sections.

Subagent role prompts are composed with the shared minimal harness rather than
replacing it. This preserves project rules, environment constraints, language,
tool guidance, and grounding while leaving long-horizon integration ownership
with the coordinating agent. `SessionSearch` is tool-aware evidence recovery;
repository plans and specifications remain the durable source of truth.

#### AGENTS.md 加载与注入防护 (Plan 408)

`AgentsMdManager` 在每次 prompt-build 边界刷新 AGENTS.md 快照（mtime 快路径）。
自 Plan 408 起：

- **注入位置**：AGENTS.md 以 `<system-reminder>` 包裹内容拼入 **system 字段**
  （`buildAgentsMdSection()`），不再作为首轮 user message 注入。这样它落在
  system prefix cache 断点上（配合 Plan 408 Phase 4 的 `applyCacheControlToSystem`），
  每轮请求命中缓存，省 5-50K input token。`DuyaAgent._buildSystemPrompt` 与
  `agent-shell.buildSystemPrompt` 两处拼接。
- **注入防护**：`stripHtmlComments`（marked 块级剥离，保留 fenced/inline code）
  在加载时剥除 AGENTS.md 内的 HTML 注释；`stripSystemReminder` 在 provider
  投影（provider-projector）时剥除所有消息文本中的伪造 `<system-reminder>`。
- **sub-agent 省 token**：read-only 内置 sub-agent（Explore/Plan/CodeReview/
  Research）定义 `omitClaudeMd: true`，经 `runAgent` 传播为 `omitAgentsMd`，
  `preBuildHook` 跳过 AGENTS.md 刷新、DuyaAgent 跳过 system 拼接。由
  `duya_slim_subagent_agentsmd` feature flag（默认开）门控。
- **嵌套目录按需加载（Plan 408b）**：eager 加载只覆盖 cwd→root 祖先链；
  cwd 以下子树的 AGENTS.md / `.duya/rules/*.md` 由 PostToolUse 点按需发现——
  read/edit/write/grep/glob 触碰项目内路径时，`nested-loader.ts` 沿触发文件
  所在目录链（cwd 以下）探测指令文件，并匹配祖先链上带 `paths:` frontmatter
  的条件规则（picomatch），经 `applyHookInjection` 作为一次性 user 角色
  `<system-reminder>` 注入（`metadata.source = 'nested-agents-md'`）。会话级
  Set 去重，每份文件只注入一次；`omitAgentsMd` 子代理跳过；由
  `duya_nested_agents_md` feature flag（默认开，env `DUYA_NESTED_AGENTS_MD`
  可关）门控。对齐 claude-code-haha nested_memory 语义。

#### Recent session directory (Plan 229)

Full, tool-capable prompt profiles can include a volatile directory of recent
root sessions: up to five from the current project and three from other
projects. `recent-session-directory.ts` normalizes project paths, folds child
and subagent sessions into their root, excludes the current root lineage, and
sanitizes title/project metadata. It never injects message bodies or absolute
working-directory paths.

The directory is an untrusted discovery index. Agents use scoped
`SessionSearch` (`same_project`, `other_projects`, or `all`) to recover evidence
before acting. `MessageSession` remains an explicit follow-up for one clearly
relevant session, with a focused minimal-mode request; recency alone never
triggers cross-session contact. Minimal and bare prompt profiles do not receive
the directory. The same query model backs the dynamic prompt and no-query
`SessionSearch`, including Electron agent subprocesses through async DB IPC.

#### PromptManager 使用

```typescript
import { PromptManager } from './prompts/PromptManager.js';

// 创建管理器（默认 full 模式）
const promptManager = new PromptManager({
  workingDirectory: process.cwd(),
  language: 'zh-CN',
});

// 构建系统提示词
const systemPrompt = await promptManager.buildSystemPrompt(enabledTools, mcpServers);

// 切换模式（清除缓存）
promptManager.setPromptMode('minimal');
```

#### 与 AgentTool 集成

子Agent使用精简提示词模式：

```typescript
// packages/agent/src/tool/AgentTool/AgentTool.ts

const promptManager = new PromptManager({
  promptMode: 'minimal',  // 子Agent使用精简模式
  workingDirectory: options.workspaceDir,
});

const systemPrompt = await promptManager.buildSystemPrompt(enabledTools);
```

#### 未来扩展：PromptMode

计划支持多种提示词模式以适应不同场景：

```typescript
type PromptMode = 'full' | 'minimal' | 'none' | 'coding' | 'chat';

// full: 完整提示词（主Agent，默认）
// minimal: 精简提示词（子Agent，节省~50% token）
// none: 仅基础身份（特殊场景，节省~95% token）
// coding: 编程专用（保留代码风格指导）
// chat: 对话专用（简化工具说明）
```

**详细设计**：参见 [docs/exec-plans/active/26-prompt-mode-architecture.md](./docs/exec-plans/active/26-prompt-mode-architecture.md)

### 数据库设计

#### 设计原则

1. **唯一写入点**：SQLite 实例只在 Main 进程，避免多进程写入冲突
2. **WAL 模式**：启用 `journal_mode = WAL`，支持读写并发；`busy_timeout = 5000` 防止写锁冲突
3. **稳定边界批量落库**：Agent worker 是消息唯一写者，在稳定边界（用户消息到达、tool round 完成、assistant 回复完成、turn 结束）一次性 `appendMessages` 落库 `messages` 表，不再逐条写穿
4. **两条访问通道**：
   - **Agent Process → Main**：通过 child_process IPC `db:request`/`db:response`（稳定边界批量落库）
   - **Renderer → Main**：通过 IPC invoke（主动查询，如切换 session 时加载历史）
5. **API Key 脱敏**：返回给 Renderer 的 Provider 数据自动遮蔽 API Key
6. **Provider 存储**：Provider 配置由 ConfigStore 管理（密钥在 `~/.duya/secrets.json`，元数据在 `config.toml`），不存储在数据库
7. **Generation 冲突解决**：使用 generation 编号避免并发写入冲突（用于最终快照替换）
8. **数据库路径由 config.toml 管理**：数据库文件路径由 `~/.duya/config.toml` 的 `storage.database_path` 字段决定（经 `compass.ts` 读取），支持迁移到自定义位置
9. **原子写入**：config.toml 和 secrets.json 均使用原子写入，防止断电损坏

#### 数据库表结构

| 表名 | 用途 | 访问方 |
|------|------|--------|
| `chat_sessions` | Session 元信息 | Renderer (列表) / Agent Process (状态查询) |
| `messages` | 聊天消息历史 | Agent Process (单一写者，稳定边界 `appendMessages`) / Renderer (加载历史，只读) |
| `permission_requests` | 权限请求记录 | Agent Process (写入) / Renderer (查询) |
| `settings` | 应用设置 | Renderer / Agent Process |
| `tasks` | 任务管理 | Agent Process (写入) / Renderer (查询) |
| `session_runtime_locks` | Session 运行时锁 | Agent Process (写入) / Renderer (查询) |
| `channel_bindings` | Bridge 通道绑定 | Bridge |
| `channel_offsets` | Bridge 通道偏移 | Bridge |
| `channel_permission_links` | Bridge 权限链接 | Bridge |
| ~~`weixin_accounts`~~ | ~微信账户（已迁移至 ConfigStore `channels.adapters.weixin.accounts`，见下说明）~ | Bridge |
| `weixin_context_tokens` | 微信上下文 Token（运行时上下文，仍留 SQLite） | Bridge |
| ~~`automation_cron_state`~~ | ~定时任务运行时状态（已废弃，Plan 409：状态并入 `cronjob.toml`）~ | — |
| ~~`automation_cron_runs`~~ | ~定时任务执行历史（已废弃，Plan 409：历史 = cron session 的 rollout）~ | — |
| `conductor_canvases` | Conductor 画布 | Renderer / Agent Process (via Main) |
| `conductor_widgets` | Conductor Widget 实例 | Renderer / Agent Process (via Main) |
| `conductor_actions` | Conductor 操作日志（可审计、可回放） | Main Process (唯一写入) / Renderer (只读) |
| `_schema_migrations` | Schema 迁移记录 | Main Process |

> **Provider 配置说明**：API Provider 配置不再存储在数据库，统一由 **ConfigStore** 管理（服务商元数据在 `config.toml`，密钥在 `~/.duya/secrets.json`）。
>
> **Channel/Gateway 配置收敛（Plan 335）**：`mcp_servers`、`channels`、`gateway_proxy`、`weixin_accounts` 的读写已全部收敛到 ConfigStore（`config.toml` + `secrets.json`）。`mcp.toml` 与 SQLite `settings`/`weixin_accounts` 直读路径已移除：MCP 用户列表经 `electron/services/mcp-config.ts` 读写 `mcp_servers.*`；channel 键经 `electron/config/gateway-setting-adapter.ts` 与 `electron/services/weixin-account-store.ts` 读写 `channels.*`；gateway 代理经 `gateway_proxy`。SQLite `settings` 表仅保留非 channel 键，`weixin_context_tokens` 作为运行时上下文仍留 SQLite。

#### 自动化定时任务（Plan 409：单一来源）

**`~/.duya/cronjob.toml`** - 定时任务**唯一权威源**（定义 + 运行时状态写回）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `version` | INT | 文档版本（当前 1） |
| `jobs` | ARRAY | 任务数组（见下） |

每个 job：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT | 主键，UUID（手写可省略，加载时生成） |
| `name` | TEXT | 任务名称 |
| `prompt` | TEXT | 执行提示词 |
| `enabled` | BOOL | 用户意图：启/停 |
| `schedule` | OBJECT | 调度：`{kind="every", every="1d"}` / `{kind="once", at="..."}` / `{kind="cron", expr="0 9 * * *", tz=...}` |
| `working_directory` | TEXT | 执行工作目录 |
| `model` | TEXT | 模型 ID（可选 → provider 默认） |
| `concurrency` | TEXT | 并发策略：`skip`/`parallel`/`replace` |
| `max_retries` | INT | 最大重试次数 |
| `last_run_at` / `last_error` / `retry_count` | INT/TEXT/INT | 运行时状态（写回同文件） |

- **`next_run_at` 不持久化** —— 60s 轮询 tick 由 `(schedule, lastRunAt, now)` 派生（`electron/automation/schedule.ts`），崩溃恢复天然。
- **执行 = 普通 agent session**：创建 `mode='chat'`、`extensions.source='cron'`、id 前缀 `cron:<jobId>:` 的 session → `POST /sessions/:id/chat`（主 agent HTTP 通道，与聊天/gateway 同路，`electron/automation/agent-run.ts`）。历史 = session 的 rollout，经 `SessionStore.listByPrefix('cron:<jobId>:')` 查询。
- headless 交互工具抑制靠 `cron` agent profile deny 集（AskUserQuestion/show_widget/Agent/canvas:*/mode-switch）—— 通用安全网，非 cron 身份。
- 迁移：`migrateCronJobsToFile`（`electron/config/migrate.ts`，main.ts 启动时调用）把 legacy `automation_crons` 表 + config.toml `cron.jobs`（Plan 405 interim）收敛进 cronjob.toml。

#### Conductor 表

**`conductor_canvases`** - 画布：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT | 主键，UUID |
| `name` | TEXT | 画布名称 |
| `description` | TEXT | 画布描述 |
| `layout_config` | TEXT | 布局配置（JSON） |
| `sort_order` | INTEGER | 排序顺序 |
| `created_at` | INTEGER | 创建时间戳 |
| `updated_at` | INTEGER | 更新时间戳 |

**`conductor_widgets`** - Widget 实例：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT | 主键，UUID |
| `canvas_id` | TEXT | 所属画布 ID（FK → conductor_canvases） |
| `kind` | TEXT | Widget 类型：`builtin` / `template` / `dynamic` |
| `type` | TEXT | Widget 具体类型（如 `TaskList`, `NotePad`） |
| `position` | TEXT | 位置和大小（JSON: `{x, y, w, h}`） |
| `config` | TEXT | Widget 配置（JSON） |
| `data` | TEXT | Widget 数据（JSON） |
| `data_version` | INTEGER | 乐观锁版本号（每次更新 +1） |
| `source_code` | TEXT | 动态 Widget 源码 |
| `state` | TEXT | 状态：`idle` / `loading` / `error` |
| `permissions` | TEXT | 权限配置（JSON: `{agentCanRead, agentCanWrite, agentCanDelete}`） |
| `created_at` | INTEGER | 创建时间戳 |
| `updated_at` | INTEGER | 更新时间戳 |

**`conductor_actions`** - 操作日志（只追加，可回放）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | INTEGER | 主键，自增 |
| `canvas_id` | TEXT | 所属画布 ID（FK → conductor_canvases） |
| `widget_id` | TEXT | 相关 Widget ID |
| `actor` | TEXT | 操作者：`user` / `agent` / `system` |
| `action_type` | TEXT | 操作类型 |
| `payload` | TEXT | 操作参数（JSON） |
| `result_patch` | TEXT | 操作结果 diff（JSON，用于 Undo/Redo） |
| `merged_from` | TEXT | 冲突合并来源 |
| `reversible` | INTEGER | 是否可逆 |
| `ts` | INTEGER | 操作时间戳 |
| `undone_at` | INTEGER | 撤销时间（NULL 表示未撤销） |

> **Conductor 架构约束**：
> - Main Process 是 Conductor 数据的**唯一写入方**，Renderer 和 Agent Process 只能通过 `conductor:*` IPC 提交意图。
> - 所有写入都在事务内完成：更新业务表 → 写入 `conductor_actions` → 广播 `conductor:state:patch`。
> - Widget Data 使用 `data_version` 乐观锁：用户写入优先，Agent 冲突时保留 `merged_from`。
> - Undo/Redo 基于 `result_patch` 逆操作，不使用原始 `payload`。
> - Canvas 直接拖拽只更新当前选中元素；元素重叠是合法状态，不做被动碰撞推挤。跨元素重排只能由显式 auto-layout 操作触发。
> - 自动 zoom-to-fit 的可读性下限为 `0.65`；用户仍可手动缩放到全局下限 `0.2`。短标签按紧凑节点渲染，避免为了全局概览把文字缩成不可读尺寸。

#### 数据库文件位置

数据库文件路径由 `~/.duya/config.toml` 的 `storage.database_path` 字段决定（经 `electron/config/compass.ts` 读取，空则用默认路径 `%APPDATA%/DUYA/databases/duya-main.db`）：

- **旧库**：`{databasePath}`（默认 `{userData}/databases/duya-main.db`）。六大核心表冻结（LEGACY FROZEN），仅由 `LegacyImport` 只读 + conductor/research/gateway 等子系统自有表使用。
- **核心状态库**：`duya-core.db`（由 `resolveCoreDatabasePath()` 从 `databasePath` 推导，位于库同目录），存六大聚合的状态与索引。
- **rollout 根**：`~/.duya/sessions/`（由 `resolveRolloutRoot()` 推导，对齐 Codex 的 `~/.codex/sessions/`），每条会话一个 JSONL rollout 文件。测试模式（`DUYA_TEST=1`）下追加 `test-namespaces/<ns>` 前缀隔离。
- **自定义路径**：用户可通过迁移功能将数据库移至任意位置；`duya-core.db` 紧随其目录，`sessions/` 固定于 `~/.duya/`。
- **向后兼容**：自动检测并重命名旧版 `duya.db` 为 `duya-main.db`
- **引导文件**：`~/.duya/config.toml` 的 `storage` 块仅含 `database_path`（明文，compass.ts 极早期读取）；密钥在 `~/.duya/secrets.json`（0600）

#### 日志存储策略

duya 的应用日志采用**纯文件**方案（`{userData}/logs/app.log`），而非独立 SQLite 日志库。这是与 Codex（`logs_2.sqlite`）的刻意差异，理由如下：

- **Node 生态的文件日志更成熟**：duya 使用结构化 logger（`electron/logging/logger.ts`），按 `WARN` 默认级别写入文件，日期 + 50MB 双触发轮转，7 天保留。Codex 用 SQLite 日志是因为其 Rust 生态的 `tracing-subscriber` 原生支持 SQLite sink，而 Electron 的 Node 文件日志方案更简单直接。
- **日志是操作型而非查询型**：排查问题靠 `tail -f` / `grep` 即可，无需 SQL 按字段查询。纯文件日志支持 `tail -f` 实时跟进，grep 跨会话检索，足够覆盖诊断场景。
- **避免额外 WAL / busy_timeout 管理成本**：独立 SQLite 日志库需要引入 WAL、busy_timeout、独立连接等额外的并发与生命周期管理，且日志高频写入会与业务库竞争资源，收益不抵成本。

| 维度 | Codex `logs_2.sqlite` | duya `app.log` |
|------|----------------------|----------------|
| 存储介质 | 独立 SQLite | 纯文件 |
| 轮转 | 数据库内部 | 日期 + 50MB 双触发 |
| 保留期 | 按查询语义 | 7 天 |
| 索引 | level / target / thread_id | 无（grep） |
| 查询 | SQL | `tail -f` / `grep` |

**未来触发条件**：若需要按 `thread_id`/`level` 跨会话查询日志，或日志量级超过 100MB/天导致 grep 性能不足，再考虑引入 SQLite 日志 sink（对齐 Codex）。

#### 分库策略

duya 采用 **3 个 SQLite 库**（core / legacy / memory-state），而非 Codex 的 6 库拆分。差异源于进程模型不同：

- **Codex 的 6 库**是因它的 Rust 进程模型有多个独立 binary（CLI / desktop / agent worker），每个 binary 需要独立 DB 连接。
- **duya 是 Electron 单进程 + agent child_process**，所有 SQLite 连接集中在 Main 进程（唯一写入点），3 库已足够隔离，无需按 binary 拆库。
- 日志走文件（见上节）、goals 汇入 core DB、无需独立桌面状态库——这些决策已由 331 和本 plan 落地。

| 存储 | duya | Codex |
|------|------|-------|
| 核心库 | `duya-core.db`（messages 索引 + sessions + mailbox + tasks + permissions + locks + goals + spawn_edges + attachments） | 多个状态库 |
| 旧库 | `duya-main.db`（LEGACY FROZEN，仅 LegacyImport 只读 + 子系统表） | — |
| 内存状态库 | `memory-state`（memory-state.db） | — |
| rollout JSONL | `~/.duya/sessions/<Y>/<M>/<D>/<sessionId>_rollout.jsonl` | `~/.codex/sessions/` |
| 配置文件 | `~/.duya/config.toml` + `~/.duya/secrets.json` | 对应配置 JSON |
| 附件文件目录 | `~/.duya/attachments/<id>/<filename>` | `attachments/<uuid>/` |

> **无新 SQLite 库文件**：spawn edges 与 attachments 都汇入核心库 `duya-core.db`，不新增独立库。

### 优雅关闭

应用退出时按以下顺序清理资源：

1. 停止所有 Agent Process（AgentProcessPool.shutdown）
2. 关闭所有 MessagePort 通道（ChannelManager.shutdown）
3. 停止性能监控（PerformanceMonitor.shutdown）
4. 停止 Bridge 进程（stopBridgeProcess）
5. 清理会话管理器（SessionManager.shutdown）— 不涉及写库
6. 刷新配置到磁盘（ConfigStore 持久化 config.toml + secrets.json）
7. 关闭数据库连接（Database.close）— **最后一步**，确保前面所有写操作完成后再关闭

## 目录结构

```
duya/
├── electron/                    # Electron 主进程
│   ├── main.ts                 # 入口、窗口管理、IPC、生命周期 (lock → boot → db → config → UI)
│   ├── preload.ts              # contextBridge API (含 SafeMode/Migration API)
│   ├── config/                 # 统一配置中心 (指南针 + 保险箱)
│   │   ├── store.ts            # ConfigStore - config.toml + secrets.json 内存快照、原子持久化、广播
│   │   ├── compass.ts          # 极早期引导 - 读取 config.toml storage.database_path (替代 boot.json)
│   │   ├── migrate.ts          # 旧配置迁移 (settings.json/boot.json/mcp.toml 等 → config.toml)
│   │   ├── gateway-setting-adapter.ts  # 旧 channel 写键 ⇄ ConfigStore 点路径互转 (Plan 335)
│   │   ├── provider-types.ts   # Provider 类型定义
│   │   ├── store-instance.ts   # ConfigStore 进程级单例 (指南针固定路径)
│   │   └── schema.ts           # config.toml 结构定义
│   ├── agent-process-pool.ts   # AgentProcessPool（并发上限 + 心跳 + 排队 + 消息落库）
│   ├── session-manager.ts      # Session 状态跟踪与生命周期管理
│   ├── db-handlers.ts          # 数据库 IPC 处理器 (账本) - config.toml 路径解析、Safe Mode
│   ├── services/providers/
│   │   └── provider-store-config.ts  # ProviderStore / ConfigStoreReader - 服务商与密钥读取
│   ├── message-port-manager.ts # MessagePort 通道管理（自动重连）
│   ├── performance-monitor.ts  # 性能监控（延迟、吞吐、内存）
│   ├── net-handlers.ts         # 网络相关 IPC 处理器
│   ├── port-types.ts           # Port 类型定义
│   ├── ipc/
│   │   ├── agent-communicator.ts  # Agent IPC 处理器 + DB 请求分发
│   │   └── gateway-communicator.ts # Gateway IPC 处理器
│   ├── db/
│   │   ├── core-connection.ts   # CoreDatabase 单例生命周期 + 首启旧库导入 (plan 329)
│   │   ├── core/                # 核心存储平铺 7 文件 (plan 326 决策 1)
│   │   │   ├── database.ts      # CoreDatabase / 迁移器 / WAL 提交
│   │   │   ├── message-log.ts   # MessageLog 两层存储 (rollout + message_index)
│   │   │   ├── session-store.ts # SessionStore (sessions + extensions)
│   │   │   ├── mailbox.ts       # Mailbox (mailbox_items 状态机)
│   │   │   ├── stores.ts        # TaskStore / PermissionLedger / LockStore
│   │   │   ├── legacy-import.ts # LegacyImport 只读旧库迁移 (plan 329)
│   │   │   └── index.ts         # core barrel
│   │   └── schema.ts            # 旧库 monolith schema (LEGACY FROZEN 段 + 子系统表)
│   │
│
├── packages/agent/src/
│   ├── index.ts                  # Pure barrel: re-exports public API + `duyaAgent` from `./agent/DuyaAgent.js`
│   ├── agent/                    # duyaAgent class implementation home (plan 334)
│   │   ├── DuyaAgent.ts          # `duyaAgent` 薄状态壳 (~740 LoC) + public surface
│   │   ├── session/
│   │   │   ├── agent-shell.ts    # streamChat 装配纯函数 + LoopEvent→SSEEvent 适配
│   │   │   ├── history.ts        # HistoryStore (timeline 写入/重建/清空)
│   │   │   ├── compaction.ts     # CompactionStore
│   │   │   ├── mailbox.ts        # MailboxClaimer
│   │   │   └── model.ts          # ModelRuntime (模型/思维级热换)
│   │   ├── utils/                # `extractTextFromContent`, `collectRecentImageAttachments` 等
│   │   └── visual-analysis.ts    # VisualAnalysisService
│   ├── process/
│   │   └── agent-process-entry.ts  # Agent Process 入口（ChildProcess 模式）
│   ├── ipc/
│   │   ├── PortClient.ts       # MessagePort 客户端（重连 + 消息队列）
│   │   └── db-client.ts        # IPC 数据库客户端
│   ├── prompts/                # 提示词系统工程
│   │   ├── PromptManager.ts    # 提示词管理器（组装、缓存、模式控制）
│   │   ├── types.ts            # 类型定义、PromptMode、常量
│   │   ├── cache.ts            # 提示词缓存系统
│   │   ├── constants/          # 提示词常量
│   │   │   └── promptSections.ts  # cached/volatile section 工厂函数
│   │   └── sections/           # 提示词 Sections
│   │       ├── intro.ts        # 身份介绍
│   │       ├── system.ts       # 系统指令
│   │       ├── taskHandling.ts # 任务处理指导
│   │       ├── actions.ts      # 谨慎行动准则
│   │       ├── toolUsage.ts    # 工具使用指导
│   │       ├── toneAndStyle.ts # 语气风格
│   │       ├── outputEfficiency.ts  # 输出效率
│   │       └── dynamic/        # 动态 Sections
│   │           ├── environment.ts   # 环境信息
│   │           ├── platform.ts      # 平台适配
│   │           ├── language.ts      # 语言偏好
│   │           ├── mcpInstructions.ts  # MCP指令
│   │           ├── skillsMetadata.ts   # 技能元数据
│   │           ├── sessionGuidance.ts  # 会话指导
│   │           ├── memorySection.ts    # 记忆片段
│   │           ├── memoryContextSection.ts  # 记忆上下文
│   │           ├── outputStyle.ts      # 输出样式
│   │           ├── scratchpad.ts       # 临时空间
│   │           ├── sessionSearchSection.ts  # 会话搜索
│   │           ├── agentsMdSection.ts  # AGENTS.md 内容
│   │           ├── widgetGuidelines.ts # Widget 指南
│   │           └── conductorCanvas.ts  # Conductor 画布
│   ├── llm/                    # LLM Provider 适配层
│   ├── tool/                   # 工具实现
│   ├── permissions/            # 权限系统
│   ├── compact/                # 上下文压缩
│   ├── skills/                 # Skill 系统
│   ├── sandbox/                # 沙箱安全
│   ├── security/               # 安全扫描
│   │   ├── contextScanner.ts   # 上下文文件扫描（AGENTS.md等）
│   │   ├── skillScanner.ts     # 技能安全扫描
│   │   └── bashClassifier.ts   # Bash命令分类
│   └── ...
│
└── src/                         # Vite + React（条件渲染，无 Router）
    ├── components/              # UI 组件
    │   ├── chat/               # 聊天相关组件
    │   ├── layout/             # 布局组件（sidebar、app shell）
    │   ├── settings/           # 设置面板组件
    │   ├── bridge/             # Gateway/Bridge 组件
    │   ├── automation/         # 自动化/定时任务组件
    │   ├── skills/             # Skill 管理组件
    │   ├── browser/            # 浏览器扩展相关组件
    │   ├── onboarding/         # 新用户引导组件
    │   └── ui/                 # 通用 UI 组件
    ├── contexts/                # React Context
    ├── hooks/                   # 自定义 Hooks
    ├── stores/                  # Zustand Store
    ├── lib/                     # 工具库
    └── types/                   # 类型定义
```

### userData 目录结构

```
~/.duya/                          # 统一配置根目录 (ConfigStore)
├── config.toml              # 统一配置·明文 (指南针 + 保险箱) - storage.database_path、providers、agentSettings、uiPreferences，原子写入
├── secrets.json             # 统一配置·机密 (保险箱) - API Keys / tokens，权限 0600，原子写入
├── databases/
│   ├── duya-main.db           # 业务流水 (账本) - 会话/消息/权限，SQLite WAL 模式
│   ├── duya-main.db-wal       # WAL 日志
│   └── duya-main.db-shm       # 共享内存
├── logs/                      # 应用日志目录
│   ├── app.log                # 主应用日志
│   ├── app.log.1              # 轮转日志
│   └── ...
├── recent-folders.json        # 最近打开的文件夹
└── crash-reports/             # 崩溃报告（如启用）
```

## 技术决策

| 决策 | 原因 | 当前状态 |
|------|------|----------|
| **ChildProcess 而非 Worker Thread** | 进程隔离更彻底，崩溃互不影响；LLM 调用和工具执行完全独立；沙箱通过进程边界实现 | ✅ 已实现（`agent-process-pool.ts` + `agent-process-entry.ts`） |
| **Multi-Agent Process** | 每个 Session 独立进程，AgentProcessPool 控制并发上限，防止系统过载 | ✅ 已实现 |
| **每条消息先落库再转发** | SQLite-backed 队列，断线重连后可回放，切换 session 历史不丢 | ✅ 已实现（`persistMessage()` in `agent-process-pool.ts`） |
| **AgentProcessPool** | 并发上限（CPU/2）+ 心跳监控（杀僵尸）+ 排队队列，在 Main 内统一管理 | ✅ 已实现 |
| **TokenBucket（进程内）** | 每个 Agent Process 内部独立限速，5容量/秒2补充，不跨进程协调 | ✅ 已实现（`agent-process-entry.ts`） |
| **SQLite 单例写入 + WAL 模式** | Main 进程唯一写入方，WAL 支持读写并发，`busy_timeout = 5000` | ✅ 已实现 |
| **Main 中转消息** | Renderer ↔ Agent 通信经 Main 转发，延迟在可接受范围 | ✅ 已实现 |
| **Generation 冲突解决** | 使用 generation 编号避免并发写入冲突 | ✅ 已实现 |
| **Provider 加密存储** | API Key 由 ConfigStore 管理，写入 `~/.duya/secrets.json` (0600)，不存数据库 | ✅ 已实现 |
| **Golden Trident 数据架构** | config.toml (明文) + secrets.json (机密) + duya-main.db (业务)，物理分离 | ✅ 已实现 |
| **原子写入 (write-file-atomic)** | config.toml 和 secrets.json 使用原子写入，防止断电损坏 | ✅ 已实现 |
| **Safe Mode 回退 UI** | 数据库寻址失败时渲染安全恢复模式，提供重新定位/重置按钮 | ✅ 已实现 |
| **数据库路径可迁移** | config.toml 的 storage.database_path 管理路径，支持迁移到自定义位置 + app.relaunch() | ✅ 已实现 |
| **安全扫描系统** | ContextScanner + SkillScanner + BashClassifier，多层防护 | ✅ 已实现 |
| **提示词系统工程** | 模块化 Section 架构 + PromptManager + 缓存优化 | ✅ 已实现 |
| **静态/动态 Section 分离** | cachedPromptSection + volatilePromptSection + BOUNDARY 标记 | ✅ 已实现 |
| **Next.js → Vite 迁移** | 前端构建从 Next.js 14 迁移到 Vite 6 + Zero Router | ✅ 已完成 |
| **API Routes → IPC 迁移** | 从 HTTP API 迁移到 Electron IPC + MessagePort | ✅ 已完成 |
| **Gateway/Bridge 系统** | 外部平台接入（Telegram、微信等）| ✅ 已实现 |
| **自动化定时任务** | CronJob 调度器 + 执行历史 + 重试机制 | ✅ 已实现 |
| **日志系统** | 结构化日志 + 文件轮转 + 级别控制 | ✅ 已实现 |
| **自动更新** | electron-updater 集成，支持检查/下载/安装 | ✅ 已实现 |
| **浏览器扩展** | 浏览器守护进程 + 扩展通信 | ✅ 已实现 |

## 运行中用户消息：排队与引导

运行中再次发送用户消息有两条互斥的消费路径：

- **排队**：renderer 先写 `agent_mailbox`，同时把带 `queuedMailboxId` 的
  `StartStreamParams` 放入 `stream-session-manager.pendingMessages`。当前 run 的
  `done/error` 到达后，manager 按 FIFO 调用 `mailbox:promoteQueued`，再以新的
  `role=user` turn 启动下一条。已取消或已被 agent 吸收的行会被跳过，避免重复。
- **引导**：`mailbox:guide` 只给仍为 `pending` 的行标记
  `apply_mode=runtime_instruction`，不提前标记为 `applied`。Agent 在
  `before_model_turn` 和 `before_final_answer` 两个安全 checkpoint 执行
  `claimBatch`，把内容作为临时 runtime user guidance 注入当前 run；该临时包装
  不会持久化到普通消息历史。

发送时写入的默认 kind 由 `agent.busy_message_mode`
（`'followup' | 'queued'`，默认 `'queued'`）决定；设置入口在
Settings → General（"Messages sent while the agent is busy"），气泡上的
Guide 按钮仍可对单条行事后翻转。

关键文件：`src/components/chat/ChatView.tsx`、
`src/lib/stream-session-manager.ts`、`electron/db/core/mailbox.ts`、
`packages/agent/src/agent/DuyaAgent.ts`。

关键文件：`src/components/chat/ChatView.tsx`、
`src/lib/stream-session-manager.ts`、`electron/db/core/mailbox.ts`、
`packages/agent/src/agent/DuyaAgent.ts`。

## Profile / Mode / Permission 三层正交（Plan 224）

DUYA 的"agent 配置"由三个正交层组合而成。每一层独立选择、互不干扰，最终在 `streamChat` 入口合成为一个完整的运行时配置。

### 三层职责

| 层 | 标识 | 来源 | 控制内容 |
|----|------|------|----------|
| **Profile** | `AgentProfile.id`（main / code / plan / …） | Agent Profile 选择器（侧栏顶部） | 基础工具集 + 基础 system prompt + 默认权限模式 |
| **Mode** | `ModeModifier.id`（plan-task / research / conductor / goal） | 输入框 popover "Mode" 项 | 在 profile 之上叠加：注入/屏蔽工具、追加 prompt 前缀/后缀、注入 ToolUseContext 字段 |
| **Permission** | `PermissionMode`（ask / auto / bypass） | 权限选择器（输入框右侧） | 工具执行前的授权检查策略 |

> **Profile 固定于会话创建（2026-08-12）**：agent profile 是每会话不可变属性。新建会话时在
> NewChat/Welcome 视图选择并写入 `chat_sessions.agent_profile_id`（经 `createThread` →
> `syncThreadToDatabase` → `createThreadIPC` 持久化），此后会话内不再提供切换 UI
> （底部 `AgentModeSelector` 已移除，改为只读 `AgentProfileBadge`）。ChatView 加载会话时
> 从 DB 读取该 profile 并固定，首轮与后续 turn 经 `handleSendMessage` 把它作为
> per-turn override 传给 `streamChat`。子会话（cron/gateway 等）仍由各自子系统显式指定
> profile，不受此约束。

三层的运行时合成由 `DuyaAgent.streamChat` 在 `_resolveAgentProfile` → `_buildSystemPrompt` → `applyModes` → `_buildPermissionContext` 顺序完成。Profile 与 Mode 通过 `applyModes` 合并工具集和 prompt；Permission 独立作用于 `canUseTool` 检查函数。

### ModeModifier 双范式架构

`ModeModifier` 接口（`packages/agent/src/modes/types.ts`）支持两种范式，一个 mode 选其一：

- **Modifier 范式**（声明式叠加）：声明 `tools` / `prompt` / `hooks`，由 `applyModes` 在 agent loop 之上组合。适合"修饰型" mode。示例：`conductor`（注入 11 个 canvas 工具 + 前置 prompt + 注入 canvasId）、`plan-task`（block 写工具 + 前置只读规划 prompt）、`research`（session 级状态机，声明 `tracker` + tools + 门控，见下）。
- **Orchestrator 范式**（接管整个 stream）：声明 `orchestrator.execute`，自己管 LLM 调用、工具执行、SSE 流、多阶段逻辑。适合"流程型" mode。（当前无 mode 使用此范式）

`research`（plan 423）与 `goal`（plan 411）是**状态机 session 模式**：除 modifier 声明外，额外声明一个 `tracker`（实现 `ModeTracker` 接口）挂到 `ModeTrackerEngine`，由 `ModeCoordinator` 每轮注入 `<research-state>`/`<goal-state>` continuation、round-end 持久化快照、按状态运行时工具门控。二者生命周期均跨消息存活，崩溃后折叠为 `awaiting_input` 供用户显式续做。

两种范式共享 `modeModifierRegistry` 的注册、互斥（`exclusiveWith`）、UI 元数据（`display`）机制。

Plan 242 已移除旧的独立 Conductor Agent：不再存在
`conductor:init` / `conductor:agent:start` worker 命令、Agent Server
`/conductor/*` HTTP/SSE 执行面、独立 prompt system 或
`@duya/agent/conductor/profile` 契约。当前 Conductor 只通过主 chat Agent
的声明式 `conductor` modifier 注入 `CanvasConductor` 工具；画布 IPC、状态
patch、截图、canvas management broadcast 和 executor RPC 仍由现有
Electron/`@duya/conductor` 路径负责。

### 互斥规则

`exclusiveWith` 字段定义两两互斥关系，对称声明：

- `plan-task` ↔ `research`、`conductor`（只读规划与所有写/接管 mode 冲突）
- `research` ↔ `plan-task`（不与 conductor 冲突 —— Research + Conductor 可叠加）
- `conductor` ↔ `plan-task`（不与 research 冲突）

前端 `src/types/mode-id.ts` 的 `MODE_EXCLUSIVE_WITH` 镜像此规则，供 popover 渲染"互斥"/"可叠加"提示与禁用态。

### 新增 Mode 标准流程（3 步）

1. 在 `packages/agent/src/modes/` 新建 `<mode>-mode.ts`，声明 `ModeModifier` 对象（modifier 或 orchestrator 范式）。
2. 在 `packages/agent/src/modes/index.ts` 调用 `modeModifierRegistry.register(<mode>);`。
3. 如需 UI 入口，在 `src/hooks/useSlashCommands.ts` 的 `modeItems` 数组追加一项（`kind: 'mode'`, `modeValue: '<id>'`），并在 `src/types/mode-id.ts` 的 `ModeModifierId` / `MODE_KIND` / `MODE_EXCLUSIVE_WITH` 补充对应条目。

无需改动 `DuyaAgent.streamChat` / `builtin.ts` —— `applyModes` 自动消费新注册的 modifier，`collectActiveModes` 自动转发 `options.mode` 字段。

### Goal 模式（Plan 411）

Goal 是 `kind:'session'` 的 Modifier 模式，让用户把一个长期目标交给 agent 跨多轮自主推进，直到独立核验通过（学习 grok goal mode）。

**状态机**：`GoalTracker` 实现 413 的 `ModeTracker` 接口，10 态（idle / active / verifying / user_paused / backoff_paused / no_progress_paused / infra_paused / blocked / budget_limited / complete）+ 3 段（idle / planning / executing），挂 `modeTrackerEngine`。快照经 413c `mode_state_snapshots` 表持久化；每轮 continuation 由 `ModeCoordinator.injectTurnReminders` 注入（合成 user 消息，goal-state + sentinel + gaps）。

**完成判定（不盲信模型自报）**：模型调 `update_goal(completed:true)` → 工具阻塞等待 `goal-evaluator` 核验 → N-skeptic 对抗面板（`verifier_count` 个 skeptic 子 agent **并行**跑，每个输出结构化 JSON verdict，`VERDICT:` 文本行作 fallback；保守聚合：任一 refuted → not_achieved；blocking=contradiction/unverifiable → blocked）→ verdict 回写 tracker（achieved → complete / not_achieved → active + gaps / blocked → blocked）。连续 not_achieved 触发 strategist 重构策略；gap fingerprint 停滞 → `no_progress_paused`；token 超预算 → `budget_limited`（可带新预算 resume）。

**Grok 学习点（已落地）**：
- **并行 skeptic + JSON verdict**（`goal-evaluator.ts`）：面板 `Promise.all` 并发（grok spawn_parallel）；JSON 契约 `{refuted, evidence, confidence, blocking, findings}` 权威，`VERDICT:` 行 fallback；JSON 的 contradiction/unverifiable 映射 blocked。
- **planner + next-step**（`goal-plan.ts` + `goal-reminders.ts`）：goal_start 写 `.duya/goal-plan.md` 初始 checklist（`writeGoalPlan`）；每轮 continuation 从 plan 挖第一个 `- [ ]` 未完成项（`extractNextStep`，Task checklist 段优先、Non-goals/Deviations/Acceptance criteria 排除、8 KiB 读上限）内联进 nudge（grok goal_planner + goal_next_step）。
- **提前停检测**（`goal-stop-detector.ts` + `DuyaAgent.ts`）：模型自然收尾且 goal 仍 active 时，检测最后一段的 surrender/hand-off 信号（unable_to_proceed / giving_up / stopping_here / agents_in_flight / check_back_later / verdict_line / commit_push_pr / ready_for_review / please_deflection，无正则依赖的轻量前缀匹配）→ 注入 bail 专属 nudge 强制续轮（grok goal_stop_detector）。
- **repo changes diff**（`goal-changes.ts`）：goal_start 捕获 git baseline（`captureBaselineCommit`）；核验时 `serializeRepoChanges` 产出 baseline 后的 stat + patch（12 KiB 上限），内联进 verifier prompt（grok repo_changes/）。
- **达成总结**（`goal-summarizer.ts`）：verdict=achieved 后跑一次 read-only 总结子 agent，产出 closing summary（fail-open，1200 字符上限）作为最终答复（grok goal_summarizer）。

**恢复安全**：`GoalTracker.restore` 冷启动时把 active/verifying 折叠为 `user_paused`（grok from_snapshot）——重启后绝不让 goal 自动续跑；同进程跨消息恢复跳过（保留内存状态）。`update_goal` 在核验进行中（verifying）再收 completed=true 拒绝（`goal_update_in_flight`）。

**配置**（`~/.duya/config.toml`）：
```toml
[goal]
enabled = true
verifier_count = 3
strategist_every = 3
max_not_achieved_rounds = 5
```

**事件流**：goal 工具在 start/verdict 后 emit `chat:goal_updated`（worker-protocol）→ `electron/agents/server/router.ts` 转发 SSE `goal_updated` → 前端 `subscribeToGoalUpdated` 驱动 `GoalStatusCard`。

**入口**：popover Goal 项（session toggle）或 `/goal <objective>` 命令；`/goal status|pause|resume|clear` 子命令。

### 关键文件

| 文件 | 作用 |
|------|------|
| `packages/agent/src/modes/types.ts` | `ModeModifier` / `ModeModifierContext` / `ResolvedMode` / `ToolRegistration` 类型定义 |
| `packages/agent/src/modes/registry.ts` | `ModeModifierRegistry`：注册 + `resolve(ids)` 合并互斥规则；Plan 242 已删除无注册项的旧 `ModeRegistry` / `BaseMode` 接管 API |
| `packages/agent/src/modes/apply-modes.ts` | `applyModes`：单入口执行 onEnter hooks → prompt prefix/suffix → tools 合并 → toolUseContextPatch → beforeStream hooks；`collectActiveModes` 从 ChatOptions 提取激活 mode ids |
| `packages/agent/src/modes/conductor-mode.ts` | Conductor modifier（session 级，注入 canvas 工具） |
| `packages/agent/src/modes/plan/plan-task-mode.ts` | Plan-task modifier（message 级，只读规划） |
| `packages/agent/src/modes/research-mode.ts` | Research modifier（session 级，状态机驱动 deep research，plan 423） |
| `packages/agent/src/modes/research-mode/research-tracker.ts` | ResearchTracker 9 态状态机（实现 `ModeTracker` 接口，挂 ModeTrackerEngine；session 化跨消息续做） |
| `packages/agent/src/modes/research-mode/research-reminders.ts` | research continuation 渲染（research-state / sentinel / 状态指导） |
| `packages/agent/src/modes/research-mode/research-tools.ts` | `research_start` / `research_report` / `research_continue` 工具（显式迁移 + 稳定错误码） |
| `packages/agent/src/modes/research-mode/research-fanout.ts` | `research_fanout` 工具：gathering 按子问题并行调研（复用 SubagentTool + researchAgent） |
| `packages/agent/src/modes/research-mode/research-config.ts` | `[research]` config.toml 配置读取（enabled / max_converge_rounds） |
| `src/components/chat/ResearchStatusCard.tsx` | 前端 research 状态卡片（订阅 `research_updated` SSE） |
| `packages/agent/src/modes/goal/goal-mode.ts` | Goal modifier（session 级，自主多轮目标追踪 + 核验，plan 411） |
| `packages/agent/src/modes/goal/goal-tracker.ts` | GoalTracker 10 态状态机（实现 `ModeTracker` 接口，挂 ModeTrackerEngine） |
| `packages/agent/src/modes/goal/goal-reminders.ts` | goal continuation 渲染（goal-state / sentinel / gaps） |
| `packages/agent/src/modes/goal/goal-evaluator.ts` | 独立核验：N-skeptic 对抗面板 + strategist + gap fingerprint 停滞检测 |
| `packages/agent/src/modes/goal/goal-tools.ts` | `goal_start` / `update_goal` 工具（阻塞 ack + 稳定错误码） |
| `packages/agent/src/modes/goal/goal-config.ts` | `[goal]` config.toml 配置读取（enabled / verifier_count / strategist_every / max_not_achieved_rounds） |
| `packages/agent/src/modes/engine/` | 413 框架层：`ModeTracker` 接口 / `ModeTrackerEngine` 容器 / `ModeCoordinator` / 持久化 |
| `src/components/chat/GoalStatusCard.tsx` | 前端 goal 状态卡片（订阅 `goal_updated` SSE） |
| `src/types/mode-id.ts` | 前端镜像：`ModeModifierId` / `MODE_KIND` / `MODE_EXCLUSIVE_WITH` / `toggleModeInSet` / `isModeExcludedByActive` |
| `src/components/chat/SlashCommandPopover.tsx` | popover UI：activeModes 状态 + 互斥可视化 + conductor toggle 视觉 |
| `src/components/chat/MessageInput.tsx` | `activeModes: Set<ModeModifierId>` 统一状态 + conductor slot 与 DB 双向同步 |

## 按需工具发现（Plan 241）

`tool_search` 是一个让 LLM 在运行中查询可用工具的元入口。它和 Profile/Mode/Permission 三层**正交** —— 不参与权限/工具过滤决策,只负责"按需暴露工具元信息"。详见 [docs/exec-plans/active/241-on-demand-tool-discovery.md](./docs/exec-plans/active/241-on-demand-tool-discovery.md)。

| 阶段 | 范围 | 状态 |
| --- | --- | --- |
| Phase 1 | `tool_search` 接入 registry + 返回 schema 摘要(`inputSchemaSummary`/`exposeMode`) | ✅ 实施完成 (2026-07-24) |
| Phase 2 | `ToolRegistry.register` 持久化元信息,按 `exposeMode` 裁剪 LLM 请求的 tools 数组;~40 个 builtin 工具打档 | ✅ 实施完成 (2026-07-24) |
| Phase 3 | tool dispatch 循环按需把目标工具 schema 注入后续 turn | ✅ 实施完成 (2026-07-24) |

Phase 1 改动要点:`ToolMeta` 扩两个 optional 字段(`inputSchemaSummary`、`exposeMode`,均独立导出 `ExposeMode` 类型),`ToolSearchTool.execute` 返回带稳定 marker 和工具标题的 Markdown 结果,`DuyaAgent.streamChat` 通过 `toolSearchTool.setSearchFn(searchToolsFromRegistry)` 注入关键词搜索实现。

Phase 2 改动要点:`ToolRegistry.register` 重载接受第三参数 `ToolMetaInput`(`{ inputSchemaSummary?, exposeMode? }`),新增 `getMeta(name)` / `getExposeMode(name)` accessor(后者在未持久化时默认 `'always'`);`searchToolsFromRegistry` 从 registry meta 字段填充 result 的 `exposeMode` / `inputSchemaSummary`;`createBuiltinRegistry` 默认暴露平台原生 shell、read/write/edit/grep/glob、Agent、Task 与 ToolSearch,其余 mode/browser/memory/session/vision/widget/module/skill/CLI/research 工具按需发现。**MCP runtime 注册条目固定为 `always`**(2026-08-11 调整:原 `discoverable` 会让所有 MCP 工具被排除在首轮 tool 列表外,agent 必须多一轮 `tool_search` 才能使用;`always` 直接进 base tools)。`DuyaAgent._resolveTools` 在 Layer 0/1/2 过滤之前按 `exposeMode !== 'internal'` 裁剪 baseTools。

Phase 3 改动要点:`DuyaAgent.streamChat` 维护 streamChat-local `discoveredTools: Set<string>`,每轮 while 开头把 `registry.getTool(name)` 合并到局部 `tools` 数组,实现"LLM 调 `tool_search` 后下一轮 LLM 请求的工具列表自动包含搜到的工具";扫描由 [packages/agent/src/agent/tool-search-discovery.ts](./packages/agent/src/agent/tool-search-discovery.ts) 提供 (`extractToolNamesFromSearchResult` + `harvestDiscoveredTools`),在每次 `executor.getRemainingResults()` 完成后从 messages 末尾 batch 抽取带稳定 marker 的 `## Tool: \`name\`` 标题。MCP 用 internal key 存储而搜索返回 provider-visible name，registry accessor 会双向解析这两种名称，确保搜到的 MCP 工具的 metadata、schema 与 executor 都能进入下一轮。首轮 system prompt 另加一个有上限的 MCP capability directory（server、来源、工具数量和少量示例），让 Agent 先知道每个已连接 server 的能力边界，再针对性调用 `tool_search`。边界:`Set` 自动去重;`registry.getTool(name)` 返回 undefined 时静默 skip(MCP server 断开 / plugin 卸载后)。

27 个单测覆盖 Phase 1/2/3 全链路([packages/agent/tests/unit/ToolSearchTool.test.ts](./packages/agent/tests/unit/ToolSearchTool.test.ts) 17 条 + [packages/agent/tests/unit/tool-search-discovery.test.ts](./packages/agent/tests/unit/tool-search-discovery.test.ts) 10 条),全绿。

## 图像生成（plan image-gen）

`image_generate` 是一个**可发现但不默认暴露**的媒体生成工具（`exposeMode: 'discoverable'`），Agent 通过 `tool_search` 按需发现，配置在 `~/.duya/config.toml` 的 `[image_generation]` 段：

| 项 | 说明 |
| --- | --- |
| `packages/agent/src/tool/ImageGenerateTool/image-generation-config.ts` | `[image_generation]` 配置读取：`enabled` / `provider` (`openai` \| `fal`) / `model` / `base_url` / `api_key` / `size` / `quality` / `output_dir` / `timeout_ms`，env 覆盖（`DUYA_IMAGE_*`、`IMAGE_GENERATION_API_KEY` / `OPENAI_API_KEY` / `FAL_KEY`），带进程级缓存 |
| `packages/agent/src/tool/ImageGenerateTool/provider.ts` | 双后端适配：OpenAI Images API（gpt-image-1/2、dall-e-3，支持参考图编辑）与 fal.ai（Flux 系，`fal-ai/` 前缀自动补全）；错误分类（401/429/超时/网络）映射为可操作提示；结果落盘到 `output_dir`（默认 `~/.duya/media/generated`） |
| `packages/agent/src/tool/ImageGenerateTool/ImageGenerateTool.ts` | 工具类（`image_generate`），携带 `getPrompt()` 使用指南；注册于 `createBuiltinRegistry`（discoverable + `inputSchemaSummary`） |
| `packages/agent/src/cli/imageCmds.ts` + `packages/agent/src/cli/index.ts` | `duya image "<prompt>"` 子命令（`--provider/--model/--size/--quality/--output/--output-name/--json`）与 `duya image:config`（查看生效配置，不打印密钥） |
| `packages/agent/src/cli/slash-commands.ts` | REPL `/image <prompt>` 指令（cliOnly） |

工具默认关闭（`enabled = false`）；配置 `enabled = true` + API key 后，Agent 搜到即可调用。29+6 个单测覆盖配置解析、双 provider 请求/落盘/错误映射、discoverable 生命周期（默认不可见 → `tool_search` 发现后注入）与 CLI 行为。

## 工具协议适配层 + Deferred Tools (Plan 418)

`tool_search`(Plan 241) 解决**应用层**的按需工具发现;Plan 418 解决**传输层**的协议兼容——不同 Anthropic 兼容端点的 content 块 schema 不同,直接按 Anthropic 标准发送 `tool_use`/`tool_result` 块会被拒绝(例:DeepSeek `/anthropic` 端点只接受 `text | tool_reference | image | document`)。详见 [docs/exec-plans/active/418-tool-protocol-adaptation.md](./docs/exec-plans/active/418-tool-protocol-adaptation.md)。

**能力声明**(`packages/ai/src/types.ts` `ModelCompat`):

- `toolResultTransport: 'tool-result-block' | 'text-user-message' | 'none'` —— 工具结果回传形态。`text-user-message` 把工具结果折叠为纯文本 user 消息(`tool_use` 保留);`none` 完全不传 tools 并在 system 提示工具不可用。
- `supportsToolReferences?: boolean` —— 是否支持 Anthropic tool-search 式延迟加载(`tool_reference` 块)。默认 false,仅显式声明开启。

**端点推导**（`packages/ai/src/api/anthropic-messages.ts`）:`isDeepSeekAnthropicEndpoint(baseURL)` 识别 DeepSeek `/anthropic` 兼容面;`resolveToolResultTransport(baseURL, compat)` 按「compat 显式 > 端点推导 > 默认 `tool-result-block`」解析。

**序列化适配**:`transform-messages.ts` 的 `textifyToolResults(messages)` 把 `role:'tool'` 消息(及遗留 `tool_result` 块)转成带 `[Tool result: ...]`/`[Tool result ended]` 标记的文本 user 消息,错误(`<tool_error>`)显式标记;`createAnthropicClient.streamChat` 按 transport 选择转换路径,`none` 时 tools 参数置空。

**渐进降级**(L0 标准块 → L1 文本回传 → L2 无工具):`streamChat` 内按「初始声明 + 会话级记忆」构建阶梯,捕获 400 反序列化错误(`isToolSchemaMismatchError`,`packages/ai/src/utils/errors.ts`)时降级重试一次并记住(closure 状态跨 turn 存活),避免每轮重复失败。

**Deferred tools**(对齐 pi / Claude Code):`packages/ai/src/utils/deferred-tools.ts` 提供 `getDeferredToolNames`(从历史 tool 消息的 `Message.addedToolNames` 收集)与 `splitDeferredTools`(把已加载工具从 tools 参数拆出);`toAnthropicMessages` 对 `supportsToolReferences` 端点在 tool_result content 内输出 `tool_reference` 块、普通内容移到 sibling text 块(Anthropic 拒绝引用与普通内容混排),同一工具只引用一次。agent 侧 `harvestDiscoveredTools`(plan 241) 把发现的工具名写回 tool 消息的 `addedToolNames`,打通「应用层发现 → 传输层引用」链路。

**测试**:`packages/ai/test/tool-protocol-adaptation.test.ts`(18 条,含 mock SDK 的降级阶梯集成测试 + SSE 坏帧跳过/修复 + start 事件 input 保真 + partial JSON 恢复)+ `packages/ai/test/deferred-tools.test.ts`(8 条)+ `packages/ai/test/json-repair.test.ts`(9 条,自 pi 移植的容错 JSON 解析)+ `packages/agent/tests/unit/tool-intent-detector.test.ts`(8 条,L2 意图-动作一致性)+ `tool-search-discovery.test.ts` 增量断言,全绿;`npm run typecheck:all` 通过。

**L2 意图-动作一致性**(`packages/agent`):`tool-intent-detector.ts` 检测 turn 结束文本中的强工具意图(中英文,保守锚定)但无 tool_use → 注入继续 nudge(上限 2 次);`max_tokens` 停止时 fail 全部工具(对齐 pi,防截断参数)。与 goal/todo/mailbox nudge 正交叠加。

## First-Party Plugin Catalog (Plan 313)

The first-party plugin catalog is the curated set of plugins shipped with
DUYA itself. They live under
`packages/plugin-core/src/plugins/builtin/<plugin-name>/` and are synced
at startup into `~/.duya/plugins/cache/builtin/<id>/<version>/` by
`syncBuiltinPlugins()`. The catalog scanner in
`electron/plugins/catalog.ts` reads each cache root via
`readPluginManifest` and exposes entries with `source: 'bundled'` and
`trustLevel: 'official'`. Catalog entries are
default-off: `installed: false, enabled: false` — the user opts in per
plugin.

### Directory convention

Every first-party plugin follows the v2 layout:

```
packages/plugin-core/src/plugins/builtin/<plugin-name>/
├── plugin.json              # v2 manifest (schemaVersion: 'duya.plugin.v1')
├── plugin.md                # human-readable overview, setup, and status
├── mcp/servers.json         # MCP server config (stdio until Phase 2a)
├── skills/<skill>/SKILL.md  # one subdirectory per skill (v2 layout)
├── workflows/<wf>.yaml      # WorkflowTemplateSchema-compliant templates
└── permissions/policy.json  # five-tier permission policy
```

`discoverSkills()` reads both the legacy flat `skills/*.md` layout and the
v2 subdirectory `skills/<name>/SKILL.md` layout. `deriveCapabilityCounts`
derives counts from the on-disk directory so the catalog stays in sync
with the actual files.

### Permission models (two distinct concepts)

- `packages/agent/src/permissions/` — **Tool permission gating**: per-tool
  allow/deny/ask decisions driven by user rules, permission modes, and the
  auto-mode LLM classifier. Applied at tool-execution time in the agent.
- `packages/plugin-core/src/security/` — **Plugin trust & policy**: trust
  levels, plugin permission requests, and enterprise policy for plugins.
  Decides what a plugin *may declare/install*, not what a *tool call* may do.

Put tool-call gating rules in `agent/src/permissions/`. Put plugin-oriented
trust/policy logic in `plugin-core/src/security/`. Do not merge the two.

### Five-tier permission model

`permissions/policy.json` maps each MCP tool call to one of five tiers.
The default safety posture is read-only; write actions require explicit
confirmation.

| Tier | Behavior | Example |
| --- | --- | --- |
| `read` | Automatic, no confirmation | `list_issues`, `get_file`, `query` (SELECT) |
| `draft` | Automatic, but visible in review surface | (reserved) |
| `write` | Confirm before execute | `create_issue`, `create_page`, `create_review` |
| `modify` | Strong confirm; mutates existing state | `apply_migration`, `deploy_edge_function`, `archive_*` |
| `dangerous` | Strong explicit confirm; irreversible or production-impacting | `merge_pull_request`, `promote_to_production`, `delete_issue`, `DROP TABLE` |

Unlisted actions are conservatively promoted one tier higher than `read`.

### Bundled plugin roster (9 plugins)

| Plugin ID | Directory | Category | Skills | MCP server | Transitional transport |
| --- | --- | --- | --- | --- | --- |
| `com.duya.postgres-readonly` | `postgres-readonly/` | `data` | 3 | `@modelcontextprotocol/server-postgres --read-only` | stdio (final) |
| `com.duya.github-development` | `github-development/` | `development` | 5 | `github-mcp-server stdio` | stdio → Remote MCP |
| `com.duya.playwright-web-operator` | `playwright-web-operator/` | `automation` | 5 | `@playwright/mcp` | stdio (final) |
| `com.duya.figma-design` | `figma-design/` | `development` | 5 | `figma-developer-mcp --stdio` | stdio → Figma Remote MCP |
| `com.duya.supabase-development` | `supabase-development/` | `development` | 4 | `@supabase/mcp-server-supabase` | stdio (final) |
| `com.duya.sentry-debugging` | `sentry-debugging/` | `development` | 4 | `@sentry/mcp-server` | stdio → Sentry Remote MCP |
| `com.duya.vercel-deployment` | `vercel-deployment/` | `development` | 4 | `vercel-mcp-adapter` | stdio → Vercel Remote MCP |
| `com.duya.notion-knowledge` | `notion-knowledge/` | `productivity` | 5 | `@notionhq/notion-mcp-server` | stdio → Notion Remote MCP |
| `com.duya.linear-project-execution` | `linear-project-execution/` | `development` | 5 | `@tacticlaunch/mcp-linear` | stdio → Linear Remote MCP |

### trustLevel mapping

| `source` | `trustLevel` | Meaning |
| --- | --- | --- |
| `bundled` | `official` | Shipped with DUYA, maintained by the DUYA team |
| `local` | `local` | Installed from the local marketplace, user-managed |
| (future) `marketplace` | `community` | Published by third parties (Plan 312) |

### Remote MCP transport status

Plan 313 Phase 2a (Remote MCP HTTP transport) is not yet implemented.
Until it lands, the six remote-MCP plugins (Figma, Supabase, Sentry,
Vercel, Notion, Linear) use official stdio MCP server packages as a
transitional transport. Each plugin's `plugin.md` marks
`_status: transitional` and documents the target Remote MCP endpoint.
When Phase 2a ships, these plugins migrate to HTTP transport without
breaking skills or workflows — only `mcp/servers.json` changes.

### PostgreSQL read-only defense-in-depth

`postgres-readonly` enforces read-only access through two independent
layers:

1. Permission policy: every write-capable tool call is pinned to the
   `dangerous` tier in `permissions/policy.json`.
2. Recommended role: the setup label instructs the user to connect with
   a Postgres role whose grants are read-only (e.g. `duya_reader`).

Note: `@modelcontextprotocol/server-postgres` does not support a
`--read-only` flag (its entrypoint parses `process.argv[2]` as the
connection string directly), so read-only posture relies on the database
role plus the DUYA permission policy.

### References

- Plan: [docs/exec-plans/active/313-first-party-plugin-catalog.md](./docs/exec-plans/active/313-first-party-plugin-catalog.md)
- Product definition: [docs/design-docs/2026-07-29-plugin-product-definition.md](./docs/design-docs/2026-07-29-plugin-product-definition.md)
- Catalog loader: [electron/plugins/catalog.ts](./electron/plugins/catalog.ts)
- Capability discovery: [packages/plugin-core/src/plugins/loader/capability-discovery.ts](./packages/plugin-core/src/plugins/loader/capability-discovery.ts)
- Workflow schema: [packages/plugin-core/src/workflows/schema.ts](./packages/plugin-core/src/workflows/schema.ts)

### Official remote MCP assets (2026-07-30)

`MCPServerConfig` supports both local stdio and HTTPS-only
`streamable-http` MCP servers. The agent constructs a Streamable HTTP client
for remote endpoints and expands optional request headers only from managed
configuration; plugin packages must not include credentials. Official endpoint
and upstream Skill provenance is centralized in
`packages/plugin-core/src/plugins/loader/official-assets.ts`. Provider-specific
OAuth token brokering remains the responsibility of the app-connection layer
(Plan 312), so a remote preset must retain its stdio fallback until it has an
authorized connection.

## Skills 系统

### 来源体系

| 来源 | 目录 | 加载方式 | 安全扫描 | 用户 GUI 可见 |
|---|---|---|---|---|
| `system`（系统级内置） | `packages/agent/skills/.system/`（同步副本 `~/.duya/skills/.system/`） | `loadSkills()` 末尾**无条件加载**（不受 `syncBundled` 影响；agent 跳过用户目录 `.system` 副本，只从内置目录加载） | **跳过**（信任） | **可见但只读**（plan 434 起；`skills:list` 返回 `source: 'system'`，不可禁用） |
| `bundled`（普通内置） | `packages/agent/skills/<category>/` | 生产不自动加载（`syncBundled: false`，走 plugin marketplace 按需安装） | 跳过 | 同步后可见 |
| `user` | `~/.duya/skills/` | `loadSkills()` | 扫描 | 是 |
| `project` | `<cwd>/.agent/skills/`（跨 agent 标准）+ `<cwd>/.duya/skills/` | `loadSkills()`（后者后加载，同名覆盖前者） | 扫描 | 是 |
| `plugin` | 插件 `installPath/skills/` | `discoverPluginSkillPaths()` → `additionalPaths` | 扫描 | 是 |

### 系统级 skills（`.system/`，Codex 式）

- 位置：`packages/agent/skills/.system/<name>/SKILL.md`（随打包到
  `resources/agent/skills/.system/`，由 `electron-builder.yml` 的
  `extraResources` 自动包含）。
- 特征：**永远加载**、**跳过安全扫描**（`source === 'system'`）、**不可被
  用户禁用**（跳过 `skillEnabledOverrides` 过滤与 agent 进程二次过滤；GUI
  开关隐藏 + `skills:setEnabled` 拒绝）。plan 414 起不进 CLI `GET /v1/skills`，
  但通过 `listModelInvocable()` 对 agent 可见可调用；plan 434 起**进 GUI
  `skills:list`**（只读展示，可查看 SKILL.md 内容）。
- 内容为"自我知识/自我配置"类：`self-config`（配置 `~/.duya/config.toml`、
  `secrets.json` 等）、`memory-search`（记忆 RAG 检索/钩子）、
  `self-knowledge`（仓库/文档地图）、
  `plugin-mcp-builder`（插件 + MCP 扩展指南）。
- 同名冲突：系统级 skills 在 `loadSkills()` **最后注册**，覆盖同名用户 skill。

### 关键代码

- 加载：`packages/agent/src/skills/loader.ts`（`loadSystemSkills()`、
  `getSystemSkillsDir()`）
- 类型：`packages/agent/src/skills/types.ts`（`SkillSource` 含 `'system'`）
- 禁用过滤：`loader.ts` + `agent-process-entry.ts`（均跳过 `source === 'system'`）
- 同步：`packages/agent/src/skills/skillsSync.ts`（跳过 `.` 前缀目录，`.system/`
  不会被同步到用户目录）
- GUI/CLI 列表：`electron/ipc/skills-handlers.ts`（`skills:list` 先同步内置 `.system` 到
  `~/.duya/skills/.system/` 再读取，见 `electron/skills/system-skills-gui.ts`）、
  `packages/agent/src/skills/skillService.ts`（plan 435 起 CLI `GET /v1/skills` 覆盖
  user/project/custom/system/plugin/bundled 全来源，system 恒 enabled 不可禁用）

### Skill 目录对模型暴露（plan 434，对齐 pi）

- 模型可见载体：prompt 动态段 `skillsMetadata.ts`（`<available_skills>` XML），
  每个 skill 带 `name` / `description` / `location`（SKILL.md 绝对路径），
  系统级排序置顶；加载指引 = read `<location>`（主，pi 式）或 `Skill` 工具
  （回退，按 name 返回指令）。
- 门控：`enabledTools` 含 `Skill` 或 `Read` 时注入；`Skill` 工具保留作回退
  （`tool/SkillTool/`，`exposeMode: 'always'`）。

## Memory: bounded projection and rg retrieval

SQLite is the authoritative memory state. `projects` and
`project_path_aliases` identify scope across moved or renamed roots; they do not
create a filesystem hierarchy. Agent-facing files under `~/.duya/memory` are
deterministic, replaceable projections:

- `summary.md`: always-read routing layer, hard-capped at 6000 characters. It
  contains up to 12 global essentials and 16 recent semantic project routes.
- `MEMORY.md`: the single normal `rg` target, grouped into global and project
  sections. Project headings use the root basename and canonical path, never a
  UUID directory. At most 30 recently seen projects are projected.
- `rollout_summaries/`: append-only evidence, searched only when a claim needs
  verification.
- `global/people/` and `global/areas/`: semantic entity projections with index
  files; these are queried explicitly rather than through a broad root search.
  Custom categories (e.g. `global/lessons/`) can be proposed by the curator
  via the curation protocol's `new_categories` action and are discovered
  dynamically by `packages/agent/src/memory-state/entity_dirs.ts` — the single
  enumeration point shared by the MEMORY.md projection, per-directory indexes,
  summary synthesis, the curator panorama, and the runtime prompt layout block.

The extractor emits at most five durable candidates with typed canonical keys
and explicit scope. The consolidator normalizes known aliases, transfers
evidence before retiring duplicates, keeps alias retirement scope-safe, and
limits active non-entity entries to 64 per global/project bucket. Overflow is
retired, not destroyed; the latest 50 consolidation runs are retained.

`raw_memories.md`, `global/{MEMORY,summary}.md`, and
`projects/<UUID>/{MEMORY,summary}.md` are legacy projections. Startup
reconciliation removes their managed files through the projection outbox and
prunes empty parents only. The prompt tells the Agent to read `summary.md`,
search only `MEMORY.md`, and consult rollout evidence on demand. No dedicated
recall tool is registered.

### Memory Phase 2 Curation Agent (Plans 401-406)

The Phase 2 curation layer is an LLM-driven agent that performs cross-rollout
semantic curation of memory. Files are the single source of truth; SQLite is
the run control plane.

**Architecture pivot (Plan 401-406, design doc
`docs/design-docs/2026-08-03-memory-phase2-curation-agent-design.md`):**

- Stage 1 LLM → `stage1_outputs` (material queue) + `rollout_summaries/*.md`
- memory-worker Hybrid scheduler (N=3 new outputs OR T=30min timeout)
- `curation_runs` ledger claims exact input versions (rollout_id + source_content_hash)
- Staging workspace (copy of managed memory + frozen input snapshot)
- Phase 2 Curator Agent (root-bound tools, sandboxed process)
- Atomic publish: leaf entity files → MEMORY.md → summary.md → indexes
- Publication journal + crash recovery (§8 of design doc)

**File truth (Phase C/D):**

- `memory/items/<claim_type>/<slug>.md` — non-entity claims (YAML frontmatter)
- `memory/entities/<type>/<slug>.md` — entity claims (people, areas, custom)
- `memory/MEMORY.md` — code-generated search projection (≤64KiB)
- `memory/summary.md` — code-generated routing projection (top 12, ≤6000 chars)
- `memory/entities/<type>/index.md` — code-generated entity index
- `memory/extensions/ad_hoc/*.md` — user-authored notes (curation input, read-only)

**Retired (Phase D, migration 0009):**

- `memory_entries` table — replaced by file manifest (rebuild cache was interim)
- `memory_evidence` table — dropped with `memory_entries`
- `phase2_runs` table (migration 0005, pre-redesign) — replaced by `curation_runs`
- `consolidator.ts` — replaced by `curation_publish_orchestrator.ts`
- `projectionContent.ts` Phase 2 renderers — replaced by `curation_projection.ts`
- `reconcile.ts` Phase 2 paths — downgraded to Stage 1 file-integrity check only

**Curation architecture pivot (Plan 417, 2026-08-11): single-shot LLM**

The streaming LLM-curator agent was the root cause of the Phase 2 hang:
MiniMax-M3 emits a `result` SSE event (with usage) but never `message_stop`,
leaving `for await ... streamChat` blocked until `withHardDeadline` fired
20 min later. Plan 417 replaces it with a deterministic single-shot path:

- `electron/memory/curation_single_shot.ts` — `runSingleShotCuration`: assembles
  a JSON prompt (1-3 rollout summaries + existing target area files), calls
  `llmClient.chat()` (non-streaming, 4 min `AbortController` timeout), parses
  the LLM's JSON response, applies actions. Never touches the AgentProcessPool.
- `electron/memory/curation_response_parser.ts` — Zod-validated response
  contract: `decisions[]` (absorbed/no_signal/uncertain) + `actions[]`
  (append/replace/no_op) with strict `area_path` whitelist.
- `electron/memory/curation_file_writer.ts` — deterministic file writes with
  path-traversal defense + atomic `.tmp`→rename.
- `electron/memory/curation_projection_refresh.ts` + `curation_projection_live.ts`
  — regenerate MEMORY.md / summary.md / global/{areas,people}/index.md from the
  live `global/` layout after each successful cycle (fixes the Aug-3 freeze).
- `curation_publish_orchestrator.ts` — cycle now: abandonExpiredRuns →
  queryEligibleInputs → claimRun → git backup → single-shot → dispositions →
  completeRun/failRun. `failRun` leaves inputs NULL (re-eligible).

**Stage 1 policy adaptive loop (Plan 433, 2026-08-18): incremental edits**

The stage1_policy adaptive loop moved from full-file rewrites to surgical,
id-anchored edits. Root cause of the old flow: the curator was told to emit
`op="update"` with the FULL new policy text, and `assembleUserPrompt` never
included the current policy — so every update regenerated the whole policy
from scratch, shaped only by the latest session (observed: 22 full rewrites
in 5 days, `+964/-917`, session details baked into the global policy).

- `packages/agent/src/memory-rollout/stage1_policy_editor.ts` — canonical
  anchored policy format: fixed sections `### S1..S9:` (eight dimensions +
  general rules, titles immutable) with `- [r:<id>]` rule bullets. Provides
  `parsePolicy`/`serializePolicy`/`migrateLegacyPolicy` (format-only legacy
  conversion with hash-stable ids)/`normalizePolicy`/`readPolicyForPrompt`/
  `applyPolicyEdits` (upsert_rule/remove_rule by section+rule id, ≤3 edits
  per run, ≤500 chars/rule, ≤8 KiB total, unknown ids recorded non-fatal,
  version bump only on real content change).
- `curation_response_parser.ts` — `stage1_policy` response contract is now
  `{op: "edit"|"no_change", edits: [{op, section, rule_id, text?, reason}]}`;
  the old full-content `update` shape is removed.
- `curation_single_shot.ts` — the current policy (anchored, with version) is
  included in the curator user prompt as `current_stage1_policy`; the
  self-improvement section mandates surgical edits, an evidence gate
  (missing dimension must recur in ≥2 rollouts), and content discipline
  (capture-when-X phrasing, no session facts, no inference licenses). A
  hard min-interval guard (default 30 min) between policy writes stops
  rapid-fire churn; `policyErrors` surfaces rejected edits non-fatally.
- Live policy migrated to the anchored format once (v22 → v23); legacy
  files auto-migrate in-memory on read and on-disk on first write.

**Retired (Plan 417):**

- `curation_agent_runner.ts` — streaming agent runner (deleted)
- `curation_prompt.ts` — CURATOR_SYSTEM_PROMPT / buildCuratorInitialMessage
  (deleted; the single-shot prompt lives in curation_single_shot.ts)
- `curation_publisher.ts` / `curation_staging.ts` — Plan 404 staging publisher
  (now unreferenced by the live flow; kept for historical reference)

**Live layout (Plan 406 + 417):**

- `memory/global/areas/<slug>.md` — area records (no YAML; key = `area:<slug>`)
- `memory/global/people/<slug>.md` — person records (key = `person:<slug>`)

**Consumers switched to file manifest:**

- Stage 1 `queryExistingKeys` (`packages/agent/src/memory-rollout/extractor.ts`) — reads `canonical_key` from active files
- Settings `memory:list` (`electron/ipc/memory-handlers.ts`) — reads entries from active files

### Memory RAG index (Plan 430)

After each successful curation cycle the worker rebuilds a retrievable index
over the memory files so user prompts can retrieve relevant memories:

- **Scan roots**: the memory root always scans first; `[memory.rag].scan_paths`
  appends arbitrary user directories (`~` expanded, deduped). Under the memory
  root only generated projections are excluded (`MEMORY.md`, `summary.md`,
  `**/index.md`, `stage1_policy.md`, `rollout_summaries/`, `memory-config/`,
  `.git`, `*.tmp`); `extensions/ad_hoc/**` is indexed. Other roots exclude only
  `.git` / `.tmp` / `node_modules`.
- **Index**: `electron/memory/rag_index.ts` writes `~/.duya/rag/memory-rag.db`
  (`documents` PK `(root, rel_path)` + `documents_fts` FTS5 trigram + `meta`).
  Embeddings are stored per document (batch 32); any embedding failure degrades
  to keyword-only (`meta.embedding_enabled`).
- **Embedding provider**: `electron/memory/rag_embedding_client.ts` resolves the
  client through the provider framework — explicit `[memory.rag]`
  `embedding_provider`/`embedding_model`, else the memory provider/model. No
  credentials or endpoints are stored under `[memory.rag]`. Anthropic has no
  embeddings API → keyword-only. `AIClient` gained an optional `embed()` in
  `packages/ai` (OpenAI `/embeddings`, Ollama `/api/embed`; retry wrapper and
  lazy proxy forward it).
- **Refresh hook**: `RunCurationCycleOpts.ragRefresh` is invoked at the end of
  every successful run (after Phase 3 summary synthesis), failure only logs
  `rag_index_refresh_failed` to the system log.
- **Retrieval hook**: `scripts/memory-rag-hook.mjs` (registered by adding a
  hook.json path under `[hooks] files` in `~/.duya/config.toml`, firing on
  `UserPromptSubmit`) reads the index + provider config, does cosine
  top-5 (vector) merged with FTS5 OR keyword hits, and emits
  `{"additionalContext": "### 相关记忆 …"}`. The agent injects
  UserPromptSubmit hook contexts into the first model turn via
  `buildPromptContextMessage` (`packages/agent/src/agent/DuyaAgent.ts`),
  same runtime-context channel as loop-hook nudges.
- **Self-service CLI + skill (plan 431)**: `duya memory doctor / setup /
  status / enable / disable / set` evaluates the machine (CPU / RAM tier /
  disk free / low-power, `electron/cli/handlers/memory.ts`), recommends an
  embedding provider/model through the provider framework, and writes
  `[memory.rag]` via `getConfigStore().set('memory.rag', …)`. The built-in
  `.system/memory-setup` skill teaches the agent to drive this flow
  (`packages/agent/skills/.system/memory-setup/SKILL.md`).
- **Settings UI (plan 432)**: the Memory settings panel
  (`src/components/settings/MemorySection.tsx`) hosts a `MemoryRagCard`
  (`src/components/settings/MemoryRagCard.tsx`) that edits `[memory.rag]`
  through the config MessagePort (`memoryRag` flat key) — enabled toggle,
  scan-path add/remove rows, index path, embedding provider/model, and the
  vector-embeddings toggle.

## Hook 设置与开关（plan 87 词汇面 + Settings 页面）

- **配置面**：`~/.duya/config.toml` 的 `[hooks] files` 记录 hook.json 路径；
  `[hooks] disabled` 记录被关闭的单个 hook id（`file:<entry>:<event>:<matcherIdx>:<hookIdx>`）；
  `[steering] disabled_loop_hooks` 记录被关闭的内置循环钩子 id（`builtin.*`，与
  `todo_gate=false` / `anti_dead_loop.enabled=false` / `tool_intent_nudge_max=0` 取并集）。
  两段都由 agent 每次 `streamChat` 热读（`packages/agent/src/hooks/config.ts`
  `readSteeringConfig` / `readHooksConfig`），修改下次运行即生效。
- **agent 侧过滤**：`filterDisabledHooks`（config.ts）按 `hookDisabledId` 从 hook.json
  加载结果中剔除被禁 hook；`createBuiltinLoopHooks`（builtin.ts）对 `disabled` 集合中的
  id 直接不注册。
- **故障策略（2026-08-19 修复）**：
  - 熔断：`HookCircuitBreaker`（`packages/agent/src/hooks/circuit-breaker.ts`）按
    `session:event:command` 统计连续基础设施失败（spawn 失败 / 超时 / 非零退出且无诊断
    输出）。连续 3 次失败后熔断 5 分钟（半开一次探针运行，失败立即重开，成功即复位），
    崩溃的 hook 不再每轮重复 spawn 刷屏。verifier 语义（进程正常运行并报告问题，
    非零退出带诊断）不计入熔断。
  - 不投递崩溃：后台（`async` + `asyncRewake`）hook 仅 `completed`（exit 0）才向
    agent 投递 `<task-notification>`；失败 / 被杀任务保留在 registry 与 Settings → Hooks
    可见，但原始崩溃文本（如 ERR_MODULE_NOT_FOUND 堆栈）绝不注入模型上下文
    （`packages/agent/src/hooks/notify.ts`）。
- **IPC**：`hooks:overview`（只读投影，`electron/ipc/hooks-handlers.ts`）返回每个 hook 的
  `id` / `enabled` / `json`（配置型 hook 的 JSON 视图）；`hooks:set-disabled(id, enabled)`
  写入 config.toml（builtin → `[steering] disabled_loop_hooks`，config → `[hooks] disabled`），
  preload `HooksAPI` / `src/lib/hooks-ipc.ts` 透传。`duya hook add/remove`（
  `electron/cli/handlers/hooks.ts`）持久化 `files` 时保留 `disabled`。
- **UI**：`src/components/settings/HooksSection.tsx` 每个 hook 行带开关（持久化到 config），
  配置型 hook 可点击弹出 JSON 配置弹窗（只读 + 复制）。
- **Chat-flow rows（plan 437）**：每次 `ConfigHooksRunner.run()` 调用
  通过 `onHookInvoked(hookEvent)` 回调向 agent core 报告本次 hook
  执行结果（事件名 / 匹配 hook / 状态 / 耗时 / additionalContext
  / async task id 等）。Agent core 在 SSE 上以
  `agent_progress { type: 'hook_invoked' }` 事件下发，渲染层把
  `StreamingEvent { type: 'hook_invocation' }` 转成
  `ActionItem { kind: 'hook', hook }`，由 `HookActionRow`（图标
  `WebhookIcon` + 事件名 + hook 名）渲染，展开卡片显示真实
  additionalContext / verifier 诊断 / async task id / 错误信息。hook
  行作为独立段（不与其他 tool / thinking 合组），与 tool_use 行
  一样点击展开。持久化：`agent-process-entry.ts` 在 turn-end 边界
  通过 `appendMessages` 把 hook 落库为 `msg_type: 'hook_invocation'`
  的系统消息（`tool_name` 存事件名、`tool_input` JSON 存结构化字段），
  reload / 跨设备同步会通过 `MessageItem.messageToActionItems` 重新
  读回。Settings → Hooks 增设 `display.showHookInvocations`（默认 ON），
  关闭后实时和重载路径都过滤掉 hook 行。

## 相关文档

- [AGENTS.md](./AGENTS.md) - 开发规则和流程
- [docs/SECURITY.md](./docs/design-docs/SECURITY.md) - 安全架构与防护机制详解
- [docs/exec-plans/active/26-prompt-mode-architecture.md](./docs/exec-plans/active/26-prompt-mode-architecture.md) - PromptMode 架构设计
- [exec-plans/README](./docs/exec-plans/README.md) - 执行计划索引
- [electron_multi_agent_architecture.svg](./docs/design-docs/electron_multi_agent_architecture.svg) - 架构图（目标架构）
- [bridge-design](./docs/design-docs/bridge-design.md) - Bridge 组件详细设计

## Office Workspace

The chat side panel includes an `office` page for local DOCX, PPTX, and XLSX
files. It reuses the session-scoped `PanelProvider` tab model and opens files
from either the project file tree or a filtered Electron dialog.

- Renderer: `src/components/layout/panels/OfficePanel.tsx`
- IPC: `dialog:open-office-files` and the existing `parser:*` handlers
- Parser: `packages/agent/src/file-parser/`, including the XLSX OOXML parser
- Chat bridge: selected content dispatches existing file and text reference
  events, so MessageInput attaches the source path and structural locator
- Write path: the Agent edits the local file through existing tools and
  permission review; structured OOXML patch/backup APIs are deferred to Phase 2

## File Preview Workspace

The session panel is a generic expandable surface: any active sidebar page can
cover the chat canvas while the normal `MessageInput` remains above it as a
floating layer. File and Office previews are master/detail surfaces with the
read-only preview and collapsible project tree kept in one panel. `PanelProvider`
persists expanded state, tree visibility, preview tabs, and the active tab per
session.

- Shell: `src/components/layout/PanelZone.tsx`
- File split: `src/components/layout/panels/PanelFileTreeSplit.tsx`
- Preview page: `src/components/layout/panels/FilePreviewPanel.tsx`
- Project tree: `FileTreePanel` resolves relative tree entries against the
  session working directory and opens either `preview` or `office` tabs
- Preview IPC: `files:preview(targetPath, rootPath)` resolves real paths and
  rejects targets outside the project root, truncates text at 1 MB, and caps
  image/PDF payloads at 12 MB
- Supported inline previews: Markdown, text/code, images, and PDF; DOCX, PPTX,
  and XLSX continue through the Office workspace
- Chat bridge: files and selected preview text reuse the existing
  `file-tree-add-to-input` and `browser-add-to-input` events

## Code Review Workspace

Code Review is a session-scoped, read-only panel that compares the current
working tree with `HEAD`. `PanelZone` supplies the session working directory to
`CodeReviewPanel`; the renderer calls typed `window.electronAPI.git.review` and
`reviewDiff` wrappers through `src/lib/git-ipc.ts`. The main-process handlers
in `electron/ipc/git-handlers.ts` use bounded, non-mutating Git commands to
return porcelain status, numstat totals, and a selected patch.

Each completed Agent turn also records its own working-tree delta. The Agent
captures start and end trees through a disposable `GIT_INDEX_FILE`, so the
user's real index and staging area are never changed. It persists the bounded
patch and file summary in `chat_turn_reviews`; `CodeReviewPanel` reads the
latest stored turn by default and can switch back to the live `HEAD`-to-working
tree review.

The diff request accepts only paths already reported as changed. It rejects
absolute paths, traversal, `.git` metadata, and untracked symlinks that resolve
outside the workspace. Diff content is capped at 1 MB; an `ENOBUFS` response
may return a marked partial patch rather than discarding safe output. The
renderer parses the patch for unified or expanded split presentation and hands
the selected file to the existing chat attachment flow; it never stages,
commits, pushes, or otherwise mutates Git state.

## Automation (CronJob) Phase 1

DUYA now includes a Phase 1 CronJob foundation in Electron Main Process:

- **Scheduler location**: `electron/automation/Scheduler.ts` (60s polling tick)
- **Storage**: single source — `~/.duya/cronjob.toml` (definitions + runtime state written back; `next_run_at` derived on each tick via `electron/automation/schedule.ts`). Run history is the cron session's own rollout (`SessionStore.listByPrefix('cron:<jobId>:')`). Modules: `cron-file.ts` / `schedule.ts` / `provider.ts` / `agent-run.ts`.
- **Execution target**: an **ordinary agent session** (`mode='chat'`, `extensions.source='cron'`, id prefix `cron:<jobId>:`) kicked off via the main agent HTTP channel `POST /sessions/:id/chat`.
- **Headless safety net**: `cron` agent profile deny list (AskUserQuestion/show_widget/Agent/canvas:*/mode-switch) — a generic headless guard, not a cron-specific identity.
- **IPC APIs**:
  - `automation:cron:list`
  - `automation:cron:create`
  - `automation:cron:update`
  - `automation:cron:delete`
  - `automation:cron:run` (returns `CronRunHandle`)
  - `automation:cron:sessions` (cron run history = its sessions)

### Scheduler behavior

- Supports schedule kinds: `at`, `every`, `cron` (with optional IANA timezone).
- Renderer presets (hourly, daily, weekdays, weekly, monthly, custom, once) compile into the same `at` / `cron` contract; existing non-preset expressions remain editable as Custom.
- Repeating schedules can persist `schedule_end_at`; next-run calculation refuses candidates after that boundary and disables exhausted jobs.
- Supports concurrency policies: `skip`, `parallel`, `queue`, `replace`.
- Uses in-memory running state + DB run state tracking.
- Uses retry with default backoff `[30s, 60s, 300s]` and default `max_retries = 3`.
- Startup isolates invalid stored schedules instead of aborting the scheduler, and long waits are re-armed in safe `setTimeout` segments.
- Cron sessions default to `~/.duya/workspace`, create that directory before Agent init, and never fall back to the Electron process cwd.
- Agent readiness is subscribed before `init`; failed `init` and `chat:start` sends fail the run instead of waiting for a timeout.

### Frontend entry

- Sidebar adds **Automation** navigation.
- View: `src/components/automation/AutomationView.tsx`
- Shared frequency UI: `src/components/automation/CronScheduleCard.tsx`
- Preset adapter and next-run preview: `src/components/automation/cron-schedule.ts`
- Renderer IPC wrapper: `src/lib/automation-ipc.ts`

## Conductor connector geometry

Connector records persist semantic geometry rather than SVG paths. A current endpoint is either bound (`{ kind: 'bound', nodeId, bindingPoint: { u, v } }`) or free (`{ kind: 'free', point: { x, y } }`). Bound `u/v` coordinates identify a quantized reference inside the element. Elbow routing projects that reference perpendicularly onto its nearest rectangular edge; curve routing instead defines the complete path between the two references and clips only the portions inside the bound endpoint rectangles. The curve arrow tangent therefore continues toward its reference rather than following an elbow edge normal. References are independent of the opposite endpoint and peer connectors. Legacy `nodeId + anchorId + edgePosition` records remain readable. Elbow routes persist editable waypoints. Curve routes start with a straight three-control topology and persist a midpoint-relative offset plus two endpoint-relative controls after the midpoint is moved. The renderer recomputes paths from current node bounds. Connector stroke width is fixed at 3.5 px; users can change routing, stroke pattern, color, markers, and label text.

Agent-created editable diagrams default to elbow routing. Architecture fan-out/fan-in guidance aligns sibling nodes and uses direct semantic connectors whose overlapping orthogonal segments form a shared trunk/bus with short terminal branches; curve routing is an explicit organic-style exception.

Dragging any elbow segment uses zoom-aware screen-space snapping against nearby parallel segments from other elbow connectors. Internal segments translate normally; terminal segments insert an orthogonal dogleg so neither endpoint reference changes. Mixed horizontal/vertical endpoint routes connect the two exterior stubs before entering either bound edge. Endpoints facing the same direction use their shared outermost lane, and obstacle routing may only push that lane farther outward. These constraints prevent the middle route from crossing an endpoint element. Only spatially related segment ranges participate, so shared trunks can become exactly collinear without pulling toward unrelated routes. Default arrow markers use compact convex geometry aligned with the terminal route; the visible stroke is trimmed to the filled head's base so the terminal reads as one continuous shape.

## Conductor knowledge workspace

The Conductor canvas is a project knowledge workspace, not a sticky-note board.
Each canvas is bound to one project folder (`conductor_canvases.project_path`); a
canvas created from a session inherits that session's working directory, while a
standalone canvas prompts for a project folder.

- `native/document` is a Markdown source element. New documents are written to
  `<project>/.duya/canvas/<element-id>.md`; imported documents must be an `.md`
  file inside the same project. The canvas keeps a project-relative path plus a
  render snapshot, and both user edits and Agent `element.update_content`
  changes synchronously write the Markdown file.
- `native/shape` is the diagram primitive for frameworks, timelines, map
annotations, and flowcharts. `native/sticky` remains renderable only for
existing boards and must not be used for new diagrams.
- `native/table` is a canvas-native, individually editable grid. Its compact
  `{ title, headers, rows }` config is persisted through `element.update_content`.
- Files, PDFs, and images remain source-material elements. Text documents
  supply nearby notes/drafts, shapes and connectors express interpretation,
  and `native/link` connects canvases and sessions into a homepage canvas.
- Canvas document/import menus reuse the chat input command-popover surface
  (`--command-menu-*` variables and `conductor-popover-item`) so settings and
  canvas controls have one visual language.
- Canvas element selection toolbars share the connector-style capsule surface.
  Their More menu persists `metadata.locked` through `element.update`; locked
  elements remain selectable and editable, but direct drag, resize, connector
  geometry handles, and group movement cannot change their position.

### Project-local databases

Conductor database elements use a project-owned SQLite database at
`<project>/.duya/database.sqlite`. This is separate from DUYA's application
database: project data travels with the project folder, while application
sessions and canvas metadata remain in `duya-main.db`.

`electron/project-database/worker.ts` is the sole SQLite connection owner.
Renderer requests arrive through the typed preload API; Agent requests arrive
as `database.execute` commands through the Conductor executor proxy. Both paths
are validated by the shared command schemas before reaching the engine.

The normalized model separates sources, stable property and option IDs,
records, typed values, saved views, and per-view record positions. Records use
optimistic revisions and mutations append events for renderer invalidation and
audit. Archive flags preserve stable references instead of hard-deleting rows.

A `native/database` canvas element stores only `sourceId`, `viewId`, and display
preferences. It never embeds record data or a filesystem path. `native/table`
remains the lightweight self-contained grid for small static datasets. New view
renderers such as board and calendar must reuse the same source/record model
rather than create parallel storage.

### Canvas presentation modes

One Conductor canvas can be rendered through two view-local presentation modes.
The standalone Conductor view defaults to the existing infinite **Canvas** mode;
the sidebar defaults to finite **Document** mode. Switching modes does not create
or copy elements.

Document mode uses an explicit content allowlist on a finite twelve-column
surface. `native/document`, `native/table`, and `native/link` participate in a
vertically compacted drag/resize grid. Their widget geometry is persisted under
`conductor_canvases.layout_config.finiteWidgetLayout`, so it never overwrites
the canonical `CanvasElement.position` used by Canvas mode. `native/text`,
`native/image`, and `native/file` use a separate non-compacting layer and remain
independently draggable. Every other element family, including shapes,
stickies, mind maps, databases, generic widgets, connectors, and groups, is
Canvas-only until it is intentionally added to the document-mode contract.

Both modes reuse `ElementRenderer`, native editing sessions, selection state,
and content persistence. Presentation code owns only placement and viewport
behavior; it must not fork element content or editing contracts.

### Native element capability contract

Native renderer behavior is declared by
`packages/conductor/src/renderer/components/native/native-element-capabilities.ts`.
Each element kind declares its edit mode, selection-toolbar family, resize
handles, chrome ownership, and whether creation should enter editing. Renderer,
chrome, and canvas creation code consume this registry; they must not maintain
parallel element-kind lists. Non-editable elements such as images, files, and
links never enter `editingElementId` on double-click.

Text-like editors share `useElementEditSession` for focus, IME composition,
blur-save, Escape-cancel, Ctrl/Cmd+Enter-save, and external editing-state exits.
Config writes use `useElementPersistence`, which applies optimistic renderer
state and performs a stale-safe rollback if persistence fails. Element-specific
components only translate their local draft into config/position patches.

### Agent scene grammar

Complex canvas results are editable native-element scenes. The on-demand
`scene-blueprints` knowledge section defines spatial grammars for architecture
diagrams, timelines/roadmaps, project outlines, and knowledge homepages. The
Agent chooses one primary blueprint, creates the scene skeleton before details,
adds connectors last, then captures and refines the result. `widget/dynamic`
remains a compact auxiliary component and cannot replace a multi-element scene.

## Conductor multi-canvas target contract (Plan 233)

Conductor mode binds a chat session to one current canvas through
`chat_sessions.conductor_canvas_id`, but the workspace may contain many
canvases. The `canvas_manage` tool is the canvas-level control surface:
`get_current`, `list`, `create`, `switch`, and `rename`. Element tools never
accept a model-provided canvas ID; they resolve the current target from the
shared `ToolUseContext.canvasTarget` object.

A successful switch has three synchronized effects:

1. mutate `canvasTarget` so later tool calls in the same Agent turn use the
   new canvas and clear cross-canvas freshness state;
2. persist the new ID to `chat_sessions.conductor_canvas_id` through
   `ConductorExecutorProxy`;
3. publish `conductor:canvas:changed` so the conversation store and frozen
   sidebar Conductor tab follow the new target immediately.

Canvas identity is therefore durable session state, while element state
remains scoped to the selected canvas. Renderer state is never the sole source
of truth for Agent target selection.

## Background SubAgent lifecycle

- `SubagentTool` returns a launch receipt immediately with `background: true`
  and `status: running`. A successful tool invocation means the sub-agent was
  dispatched; it does not mean the delegated task completed.
- `BackgroundAgentLifecycle` owns the terminal `completed` / `failed` /
  `killed` transition and writes exactly one `background_notification` mailbox
  row (a `<task-notification>` envelope) for the parent session.
- `DuyaAgent` claims background notifications at its mailbox checkpoints
  (`before_model_turn` / `before_final_answer`), injecting them as transient
  runtime context. When a terminal notification arrives after the parent turn
  has ended, the renderer's mailbox listener sees the `background_notification`
  `mail:created` event and starts an empty `backgroundTaskResume` SSE turn. That
  turn claims the notification without persisting a synthetic empty user
  message. Wakeups that race the prior SSE terminal event are deferred until
  that stream is terminal.
- Renderer status is driven by the sub-agent's own `agent_progress` terminal
  event, not by the parent stream phase or the Agent tool launch receipt.
- Live sub-agent rows are consolidated in the TaskDrawer; the chat composer
  does not render a separate expanding sub-agent panel.

## Tool-history integrity

`messages.seq_index` is the durable ordering key for a session; message reads
use it before timestamps, and every rewritten history receives a contiguous
sequence. A completed tool round contains one logical assistant turn, with one
or more `tool_use` blocks, followed immediately by its `tool_result` blocks in
the same call order. The Agent normalizes complete legacy rounds before a
provider request or persistence, so a corrected canvas tool call cannot leave
strict Anthropic-compatible providers with an invalid history.

## 语音输入（Voice STT，Plan 410/411/427）

语音听写链路把麦克风 → 流式 STT → 文本追加进输入框，对齐 grok 的纯听写
体验（不接 xAI API）。默认本地 whisper.cpp（隐私、离线），云端 OpenAI 兼容
`/v1/audio/transcriptions` 可选。全链路代码在 `@duya/voice` + Electron Main +
Renderer 三侧，打包后 worker 以 `resources/voice/worker.js` 提供。

### 数据流

```
Renderer 采集                   Electron Main                    STT Worker (fork, Node)
AudioWorklet(PCM16 下采样)  →  voice:transcribe-chunk →  SttWorker →  whisper.cpp / cloud fetch
    200ms/块(~5 IPC/s)           [VoiceService + VAD]      fork IPC      → interim/final 事件
        │                            │ (advanced 序列化,
        │                            │  Int16Array 原生传递)
        └──────── 文本 ◀────────────────┴── voice:interim / voice:final
```

### 关键设计

- **传输**：Render → Main 用 IPC invoke；Main → Worker 改用 `fork` IPC 通道 +
  v8 advanced serialization，PCM `Int16Array` 原生传递——旧的 JSON-lines 会把
  `ArrayBuffer` 序列化成 `{}`，是历史致命断点。`stderr` 保留日志。
- **VAD（时间基准）**：`packages/voice/src/vad.ts` 按 16 kHz 样本计数折算毫秒，
  直接消费配置的 `endSilenceMs`/`noSpeechTimeoutMs`，与块大小无关（corrects
  旧实现按"200ms/块"数块导致的 ~13ms 自动 finalize）。
- **生命周期**：一次按压一个 worker；`start()` 先 dispose 旧 worker；
  `stop()`/`cancel()`/`autoFinalize` 后 dispose 防泄漏；`cancel()` 发
  `voice:cancelled`；autoFinalize 后 VAD reset。
- **输入设备**：`voice-capture.ts` 的 `buildAudioConstraints(deviceId)` 映射
  `input_device` → `{ exact }` 约束；设备断开（`track.onended`）触发中文提示并
  自停；`getUserMedia` 异常映射为可操作中文文案。
- **听写追加语义**：`src/lib/voice/dictation.ts` 纯函数——interim 显示为
  `base + interim` 不提交，final 以单空格 join 提交到 base。
- **引擎**（`electron/services/voice/index.ts`）：
  - 本地：`detectWhisperBinary`（配置 `binary_path` → `~/.duya/voice/bin` →
    PATH → 常见候选）+ `ModelManager`，缺失时经 `voice:runtime-download` /
    `voice:model-download` 一键安装，进度走 `voice:download-progress`。
  - 云端：provider 回退链 显式 → default → 第一个已配置；`voice:cloud-test`
    用 0.2s 静音 WAV 实测端点；30s 超时 + interim 1.5s 节流。
- **运行时管理**：`RuntimeManager` 从 GitHub Releases 拉取预编译 whisper.cpp
  （动态资产解析 + 静态兜底 + 镜像/自定义 URL）。
- **配置**：全部位于 `config.toml` `[voice]`，含 `stt.engine`、`stt.local.*`、
  `stt.cloud.*`、`input_device` 等，设置页可视可编辑。
- **CLI**：`duya voice doctor / setup / enable / disable / set`，走
  `GET /v1/voice/env`、`POST /v1/voice/setup`、`POST /v1/voice/config`。

### 关键文件

| 侧 | 文件 |
|----|------|
| @duya/voice | `packages/voice/src/{vad,env,config,model-manager,runtime-manager,worker,stt/*}.ts` |
| Main 服务 | `electron/services/voice/{index,stt-worker}.ts` |
| IPC | `electron/ipc/voice-handlers.ts`（含 download/cloud-test） |
| CLI | `packages/cli/src/commands/voice.ts` + `electron/cli/handlers/voice.ts` |
| Renderer | `src/lib/voice/{types,errors,voice-capture,voice-devices,useVoiceInput,dictation}.ts` |
| 设置页 | `src/components/settings/VoiceSection.tsx`；入口 `src/components/chat/VoiceButton.tsx` |

## Official app connections and Remote MCP

`AppConnectionService` is the sole owner of application credentials. Google,
Slack, and Microsoft 365 use OAuth authorization-code + PKCE; official hosted
MCP providers (Figma, Supabase, Sentry, Vercel, Notion, and Linear) use MCP
protected-resource discovery, dynamic client registration, PKCE, and a
127.0.0.1 loopback callback. Access tokens, refresh tokens, client registration
data, and PKCE state are stored only in the safeStorage-encrypted app-connection
vault.

For Remote MCP, Electron main owns the SDK client and attaches authorization
there. It fetches tool schemas, exposes only token-free descriptors to the
Agent through `appConnection:listDescriptors`, and executes selected tools
through `appConnection:invoke`. Remote tools default to the `modify` risk tier
until a provider adapter supplies an audited action-level classification.

### Connector approval experience (Plan 449, codex parity)

Remote MCP tools no longer all prompt on every call. Three layers, mirroring
codex `AppToolPolicyEvaluator` / approval memory / templates:

- **Annotation-driven tier** (`electron/services/app-connections/risk-policy.ts`):
  server-published `annotations.readOnlyHint === true` (without
  `destructiveHint`) maps to `read` (auto-execute); anything uninformative
  stays `modify` (fail closed). Annotations never promote beyond read —
  silent writes require a human decision. Each descriptor carries
  `tierSource: 'annotations' | 'fallback'` and the server `title`.
- **Approval memory**: session-scoped approvals live in the agent worker
  (`packages/agent/src/tool/AppConnectionTool/approvals.ts`; worker process =
  one session). The renderer's "Allow for Session" now records the tool so
  the gate (`permissions.ts` step 4.5) skips the write/modify ask for the rest
  of the session. Global "Always Allow" persists under ConfigStore
  `app_connection_approvals["provider:toolAlias"]`
  (`electron/services/app-connections/tool-approvals.ts`), is stamped onto
  descriptors as `preApproved` during `listDescriptorsForConnected()`, and is
  managed through `appConnection:approveTool` / `revokeToolApproval` /
  `listToolApprovals` IPC. A `destructive` tier strong-confirm is NEVER
  exempted by either layer.
- **Approval message templates**
  (`packages/agent/src/tool/AppConnectionTool/approval-message.ts`, versioned):
  provider-keyed table renders a human-readable question (provider label +
  scope + verb by tier + truncated primary argument) with a generic fallback;
  the permission event carries `connector: { provider, riskTier, preApproved }`
  so the card can offer "Always Allow".

### Connector activation, exposure gate, and prompt budget (Plan 450, codex parity)

- **@-mention activation** (`extractMentionedProviders` in
  `src/lib/app-connection-ipc.ts`): typing `@` in the composer surfaces every
  connected provider as a popover row; selecting one inserts
  `@<providerId> ` into the message. The renderer-side stream-session-manager
  scans the final content for those tokens, forwards `mentionedProviders`
  to the worker, and DuyaAgent promotes those providers' connector tools to
  expose-always (skipping tool_search discovery) plus injects a one-shot
  `<connector-activation>` system-reminder into the first model turn.
- **Exposure-layer policy gate** (`electron/services/app-connections/policy-gate.ts`):
  reads `[apps]` from ConfigStore and filters providers BEFORE descriptor
  emission, mirroring codex's `apps_enabled ? filter_codex_apps_mcp_tools : empty`.
  Disabled providers' tools never enter the agent registry.
- **Spec byte budget** (`APP_CONNECTION_SPEC_BYTE_BUDGET = 8192`,
  `downgradeForByteBudget` in `packages/agent/src/tool/AppConnectionTool/index.ts`):
  descriptors whose serialized inputSchema exceed 8 KB are registered with
  an empty-object schema + summary folded into description, mirroring codex's
  `MAX_AGENT_PLUGIN_MCP_SPEC_BYTES`. Keeps prompt size bounded when a
  hosted MCP server advertises a pathologically large schema.
- **Structured parameter display**: `buildToolParamsDisplay(input, schema)`
  renders the top scalar arguments as `label:value` rows on the approval card
  (Plan 450 Phase D). Wired through StreamingToolExecutor → agent worker
  → renderer; carried in `PermissionRequestEvent.metadata.toolParamsDisplay`.
- **Auth elicitation mid-call** (`connector_auth_required` error code,
  `ConnectorAuthRequiredCard`): a 401 / revoked-token during a tool call
  emits `chat:connector_auth_required` SSE; the renderer shows a re-auth
  card that reuses the existing Plan 312 OAuth loopback. The next model
  round naturally retries the failed call once the agent loop sees the
  error in the tool_result.

When a connection is disconnected its descriptors disappear, which makes any
orphaned global approval key inert until the same provider+tool reconnects.
