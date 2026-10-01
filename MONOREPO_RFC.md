# MONOREPO_RFC.md

> **状态**：Draft / 待 Review
> **作者**：Mavis（架构调查阶段）
> **日期**：2026-10-01
> **范围**：Monorepo package boundary + Persistent Agent Platform
> **配套文档**：`docs/architecture/01`–`06`（实测审计、参考仓库分析、目标结构、Harness 设计、治理、迁移计划）

---

## 0. 本文回答的问题

| 问题 | 结论 | 依据 |
|---|---|---|
| Workspace 是否值得独立 package？ | ⚠️ **部分值得** —— 只有 roots/policy 值得；env/worktree/connector/context **不值得** | 5 处路径包含检查重复实现，其中两处 symlink 语义不一致 |
| Agent Control Plane 是否值得独立 package？ | ✅ **值得定义，暂不建包** —— 职责真实且分散，但耦合是循环的，先解耦再抽 | 3 套 task 模型、2 套 automation、5 套 queue、4 套 approval |
| Control Plane 与 Conductor 是否重叠？ | ❌ **不重叠** | Conductor 是 canvas UI，与 orchestration 无关 |
| Goal Mode 属于哪层？ | **拆分**：goal-tracker → Control Plane；`update_goal` 工具 → Runtime | 同一功能现在横跨 DB / mode / workspace 三个 substrate |
| Automation Scheduler 位置？ | **Control Plane**（`electron/automation`） | 与 workflow trigger 重复，是最尖锐的重复 |
| Bot identity 与 AgentIdentity 统一？ | ✅ **方向对，但还不能建对象** | 现状分散在 4 处 registry |
| Memory 绑定哪一层？ | **User / Project / Agent 三层已有设计**，绑定 Run 是错的 | plan 479 已定义 tier |
| Connector binding 属于 Workspace 还是 Agent profile？ | **Agent profile**（能力），不是 Workspace（位置） | 现状是全局单 store，缺的是 scope 维度 |
| Permission policy 谁拥有？ | **Workspace（roots）+ Agent profile（mode），Control Plane 组合** | 4 个 source of truth，默认值已经分叉 |
| Session 是否降级为 UI/communication concept？ | ✅ **应该**，但需分阶段 | `sessions` 表一行同时承载 9 个概念 |
| Harness 是否更名 evals？ | ✅ **应该更名** | 仓库里 "harness" 已有 3 种含义，`harness/` 会冲突 |

---

## 1. Session-centric 现状（实测）

### 1.1 `sessionId` 是当前唯一的通用身份

| 标识 | 引用数 | 涉及文件 | 分布 |
|---|---|---|---|
| `sessionId` | **6175** | **367** | renderer 1776 · `electron/agents` 784 · `electron/db` 595 · `electron/ipc` 448 · `electron/wake` 335 |
| `agentId` | 1046 | 120 | renderer 303 · `electron/channels` 225 · `electron/wake` 82 |
| `runId` | 1033 | 68 | renderer 210 · `electron/db` 176 · `electron/agents` 143 |
| `projectId` | 693 | 58 | `electron/db` 228 · `electron/memory-state` 203 |
| `taskId` | 410 | 39 | `tool/` 155 · renderer 85 · `lifecycle/` 65 |
| `channelId` | 90 | 14 | `electron/cli` 28 · `packages/cli` 25 · gateway 14 |
| **`goalId`** | **0** | **0** | 不存在 |
| **`workspaceId`** | **0** | **0** | 不存在 |

> `goalId` 与 `workspaceId` **完全不存在**。Goal 靠 `session_goals.session_id` 表达，Workspace 靠裸路径字符串表达。

### 1.2 `sessions` 表的一行同时是 9 个概念

`electron/db/core/session-store.ts` DDL：

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL DEFAULT 'New Chat',      -- ① 会话标题
  working_directory TEXT NOT NULL DEFAULT '',              -- ② Workspace
  project_name      TEXT NOT NULL DEFAULT '',              -- ③ Project（还是字符串！）
  status            TEXT NOT NULL DEFAULT 'active',
  model             TEXT NOT NULL DEFAULT '',              -- ④ Agent 的模型选择
  provider_id       TEXT NOT NULL DEFAULT 'env',           -- ④ Agent 的 provider
  mode              TEXT NOT NULL DEFAULT 'code',          -- ⑤ Mode
  permission_mode   TEXT NOT NULL DEFAULT 'default',       -- ⑥ Policy
  agent_profile_id  TEXT,                                  -- ⑦ AgentIdentity
  parent_session_id TEXT,                                  -- ⑧ Spawn lineage
  agent_type        TEXT NOT NULL DEFAULT 'main',          -- ⑦ Agent 种类
  agent_name        TEXT NOT NULL DEFAULT '',
  draft             TEXT,
  extensions        TEXT NOT NULL DEFAULT '{}',
  rollout_path      TEXT,                                  -- ⑨ Durable log 指针
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

**判定**：一行同时承载 Channel(1) + Workspace(2) + Project(3) + Agent config(4) + Mode(5) +
Policy(6) + AgentIdentity(7) + Lineage(8) + Log pointer(9)。这是 session-centric 的**字面体现**。

### 1.3 五个 durable 表全部以 `session_id` 为主键维度

| 表 | 外键 | 语义上真正属于 |
|---|---|---|
| `tasks(session_id, subject, status, owner, blocks, blocked_by)` | session | **Goal 的步骤**（一个 session 只能有一个 goal） |
| `session_goals(session_id UNIQUE, goal_text, status, token_budget)` | session | Goal（`UNIQUE` 硬性限制 1:1） |
| `permission_requests(session_id NULLABLE, tool_name, status)` | session | Policy（`session_id` 可空是刻意的 —— 审批活得比会话久） |
| `mode_state_snapshots(session_id, mode, snapshot_json)` | session | Mode 状态机位置 |
| `session_spawn_edges(parent_session_id, child_session_id)` | session | 多 agent 谱系 |
| `session_runtime_locks(session_id PK, owner, expires_at, origin)` | session | **Run 互斥（但按 session 而非 run 加锁！）** |

> **`session_goals UNIQUE(session_id)` 是一条硬天花板**：一个 session 只能有一个 goal。
> 目标模型要求 `Goal → 多 Task → 多 Run → 多 Session`，当前 schema 恰恰禁止了后三者。

### 1.4 Run 概念：每次 chat 调用临时生成

`packages/agent/src/agent/DuyaAgent.ts:1759`：

```ts
// Generate a unique seq_index for this streamChat call
const runId = crypto.randomUUID();
```

**`runId` 是每次 `streamChat` 调用现场 mint 的**，不是持久实体。唯一的 durable run 记录是
`workflow_runs`（`electron/db/core/workflow-store.ts:257`），而 chat 路径完全没有 run 记录。
wake run 更是只有 `session_runtime_locks` 一条锁记录，按 session 而非 run 加锁。

### 1.5 Project：已经是不错的 durable identity，但分裂在两个库

`electron/db/core/project-store.ts:129`（`duya-core.db`）：

```sql
CREATE TABLE IF NOT EXISTS projects (
  project_id      TEXT PRIMARY KEY,
  canonical_root  TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL DEFAULT '',
  description TEXT, icon TEXT, color TEXT,
  paths           TEXT NOT NULL DEFAULT '[]',   -- JSON 多根
  created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS project_bots (project_id, bot_id, joined_at, PRIMARY KEY(project_id, bot_id));
```

**但 `electron/memory-state/migrations/0001_init.sql.ts:33` 另有一张 `projects` 表**（memory-state.db），
且 `catalogSync.ts:208-220` 自述了原因：

> "project entities now live in `duya-core.db`, but `rollout_catalog` still carries a FOREIGN KEY that
> references `projects` in the SAME (memory-state.db) database — SQLite cannot enforce a cross-database FK.
> So every project scoped by catalogSync needs a minimal bookkeeping row here."

**即：Project 已经是 durable identity（UUID + 名字 + 多根 + bot 成员），但被跨库 FK 逼出了第二张影子表。**
这是 Project 概念**唯一**的真实缺陷，且缺陷在 Storage 层，不在概念层。

### 1.6 三套 Task 模型（同名不同命）

| # | 实现 | substrate | 能力 | 跨重启 |
|---|---|---|---|---|
| 1 | `electron/db/core/stores.ts:86` TaskStore | SQLite (core.db) | `claim(id, owner)`、blocked 拒绝、`getAgentStatuses` | ✅ |
| 2 | `electron/db/schema.ts:163` | SQLite (main.db) | 列与 #1 相同，**无 INSERT 写入** —— 被冻结的壳 | — |
| 3 | `packages/agent/src/lifecycle/TaskState.ts:13` | **内存 `Map`** + `AbortController` | 后台 subagent 状态 | ❌ **丢失** |
| 4 | `packages/agent/src/session/bash-task-store.ts` | **JSON 文件** `~/.duya/bash-tasks/` | 显式说明为何不用 SQLite（避免改 IPC schema） | ✅（PID 死亡标 `lost`） |

> 同一个 "task" 词，四种生命周期。#3 内存 Map 在 agent 进程重启后全部丢失。

### 1.7 两套完整的 Automation / Trigger 栈（最尖锐的重复）

| | Stack A（Main） | Stack B（Worker） |
|---|---|---|
| 存储 | `~/.duya/cronjob.toml`（`CronFileStore`，自称"single source of truth"） | `~/.duya/workflows/` YAML registry |
| 入口 | `electron/automation/Scheduler.ts` 60s tick + retry backoff `[30s,60s,300s]` | `packages/agent/src/modes/workflow/trigger.ts` "unified trigger entry (plan 552 §7)" |
| 通道 | cron + event listener (github/slack polling) | manual / cron / bot / http **四个** |
| run 账本 | `automation_cron_runs` | `workflow_runs` |
| 消费者 | `automation/agent-run.ts` 建普通 agent session | workflow runtime |

**而 agent 的 routine 工具只通向 Stack A**（`tool/ManageRoutineTool/ManageRoutineTool.ts:17-19`：
"Persistence goes through the db-bridge `automation:cron:*` cases … the agent subprocess never writes
cronjob.toml itself"），Stack B 却在 `trigger.ts:6` 引用 "405/409 CronStore"。
**两套 schedule、两个 registry、两个 run 账本，一个 agent。**

### 1.8 Wake 与 Automation 是循环耦合，不是分层

```
electron/wake/wake-dispatcher.ts:54  →  import interruptCronSession from '../automation/agent-run'
electron/automation/listener-hub.ts:22 → import enqueueAutomationWake from '../wake/wake-dispatcher'
electron/automation/routine-wake.ts    → import enqueueAutomationWake from '../wake/wake-dispatcher'
```

> 两者互调，**谁都不在对方之上**。这是 Control Plane 无法直接抽包的根本原因之一。

### 1.9 五套 Queue

| # | 实现 | durable | 备注 |
|---|---|---|---|
| 1 | `packages/agent/src/queue/index.ts:28` 进程内 FIFO | ❌ | 自述"distinct from the DB-persisted mailbox" |
| 2 | `packages/agent/src/wake/queue.ts` 每 session 分 lane | ❌ | 内存 |
| 3 | `mailbox_items` | ✅ | durable claim 协议 |
| 4 | `workflow_runs.wait_till` | ✅ | durable deferral |
| 5 | `pending_wakes` | ✅ | 显式用来补偿内存队列的不足 |

### 1.10 五套 Event log（词汇部分统一，store 不统一）

`message_index` / `workflow_run_events` / `research_events` / `rollout_events` /
`control-plane-audit.log.jsonl`。
`workflow-store.ts:318-319` 注明 "`JournalRecord` shape is the single event vocabulary (plan 560 D4)"
—— **词汇已统一，存储未统一**。

### 1.11 一个已经存在但残缺的 Control Plane

仓库里已经有东西自称 control plane：

- `electron/services/controlPlaneAudit.ts` → `<userData>/control-plane-audit.log.jsonl`
- `packages/agent/tests/cli-control-plane/harness.ts`（真实 Electron 启动测试架）
- `electron/agents/db-bridge.ts`（**117 KB**）—— agent 进程唯一的 DB 动作分发器，
  同时 import automation（`:25-27`）与 wake（`:44`），是事实上的 control-plane API surface

### 1.12 Checkpoint：接线了，但只写日志

`electron/agents/server/index.ts:21` **确实**调用了 `setFlushHandler`：

```ts
checkpointBatcher.setFlushHandler((batch) => {
  for (const cp of batch) {
    logger.info('Batched checkpoint flushed', { sessionId: cp.sessionId, ... });  // 只打日志
  }
});
```

> handler 里没有任何持久化。`SessionManager` 的 `Map` 存 checkpoint，重启即丢。
> **所以"checkpoint 系统存在"是事实，"checkpoint 可用于恢复"不是事实。**

### 1.13 Resume：对话历史就是事实上的恢复机制

`packages/agent/src/process/agent-process-entry.ts:1290-1344` 的 restore 是**纯消息重放**：
从 DB 重建 `Message[]`、重挂附件、还原 `tokenUsage` 与 `threadMeta`。
中途工具轮次损坏时的修复（`:1455-1555`）也是**消息排序修复**，不是 run 修复。

**结论（已验证）**：对于一个跨多次会话的长目标，当前唯一表示是**对话 transcript**，
任何"我们决定先做 X 再做 Y"都只能作为散文被 LLM 重新解析。

### 1.14 ResearchStore 是仓库里最完整的 durable execution 系统

`electron/db/core/research-store.ts`（72 KB，15 张表）：

```sql
research_sessions(..., status, current_phase, iterations, coverage,
                  plan_version, active_step_id, progress_summary, completed_at, error_json)
research_plan_steps(run_id, order_num, status, started_at, completed_at)  -- 可恢复的 plan DAG
research_events(..., UNIQUE(run_id, sequence))                            -- 严格单调游标
```

**它恰好就是问题里描述的 "current plan / completed steps / remaining work" 结构。**
但 agent 侧的 9 态状态机（`modes/research-mode/research-tracker.ts`）把快照存进
`mode_state_snapshots`，**与 `research_sessions.current_phase` 构成同一 run 的两个真相源**。
且 restore 时把所有瞬态折叠成 `awaiting_input`（`:30-32`）——
"so a restart never resurrects an unsupervised half-open research run"。

> 即：**durable artifact 在 DB，orchestration 决策不跨重启。系统刻意把崩溃的 run 降级为"需要人"。**

### 1.15 三个 SQLite 文件 + 一个 JSON store

| 文件 | 拥有 |
|---|---|
| `duya-core.db` | 六个 core aggregate（task/goal/lock/mailbox/workflow/permission…） |
| `duya-main.db` | 遗留 subsystem 表（conductor / research / **冻结的** `tasks`/`permission_requests`/`agent_mailbox`） |
| memory-state DB | 记忆 schema（migrations 0001–0012） |
| `~/.duya/bash-tasks/*.json` | bash 任务 |

`agent_mailbox` 在 `schema.ts:2193` 带横幅 "LEGACY FROZEN"。冻结表**没有 drop migration**。

---

## 2. 建议的 durable object model

```
                    ┌──────────────────────────────┐
                    │  Project (durable identity) │  UUID · name · paths[] · members
                    │  已有，勿重建                 │
                    └───────────────┬──────────────┘
                                    │ 1:N
                    ┌───────────────▼──────────────┐
                    │  Workspace (execution ns)    │  roots[] · cwd · capability policy
                    │  ★ 新概念，roots 部分已有      │  connector scope · env
                    └───────────────┬──────────────┘
                                    │ 1:N
        ┌───────────────────────────┼───────────────────────────┐
        │                           │                           │
  ┌─────▼─────┐              ┌──────▼──────┐            ┌───────▼───────┐
  │  Goal     │  1:N         │   Run       │            │ Session/Channel│
  │ 跨会话目标 │─────────────▶│ 一次执行     │◀──1:N──────│ 通信投影        │
  │ (需新表)   │   N:1        │ (需新表)     │            │ (已有，降级)    │
  └─────┬─────┘              └──────┬──────┘            └───────────────┘
        │ 1:N                        │
  ┌─────▼─────┐                     │ 读
  │  Task     │  可恢复步骤           │
  │ (复用现有) │─────────────────────┘
  └───────────┘

  ┌───────────────────────────────────────────────┐
  │  AgentIdentity (persistent agent)             │
  │  agentId · profile · memory tier · bindings   │
  │  1 agent : N runs, N channels                 │
  └───────────────────────────────────────────────┘
```

**核心反转**：`Session` 从"万物的父键"降级为"Run 的一个投影"。

---

## 3. 各对象定义与裁决

### 3.1 Project — ✅ 已足够稳定，不要重建

| 项 | 判定 |
|---|---|
| 是否值得成为一等对象 | **已是**（`projects` + `project_bots`，UUID + name + paths[]） |
| 真实缺陷 | 跨库 FK 逼出 memory-state 里的影子表（`catalogSync.ts:208-220`） |
| 修复方式 | **Storage 层迁移**：解掉 `rollout_catalog` 的 FK，改用 `project_id` 软引用 |
| 不该做的 | 不要重建 Project 表；不要把 `project_name` 从 sessions 搬到新地方做二次迁移 |

**裁决：Project 概念层冻结，只修 Storage 缺陷。**

### 3.2 Workspace — ⚠️ 只有 roots/policy 部分值得建包

严格套用"至少两个真实代码位置重复承担"：

| 候选职责 | 重复数 | 裁决 |
|---|---|---|
| **路径包含 / roots policy** | **5** | ✅ 值得 |
| **Permission policy 解析** | **4** | ✅ 值得 |
| **cwd 归一化** | **3 个 normalizer / 5 个 store** | ✅ 值得 |
| Environment snapshot | **1** | ❌ 是新功能不是去重 |
| Connector / MCP scope | **1**（全局单 store） | ❌ 缺的是维度不是重复 |
| Worktree / branch | **0 实现** | ❌ 只有 prompt 文本 |
| Context sources | PromptSystem 已是唯一装配点 | ❌ 散的是内容不是身份 |

**最尖锐的证据**：两套逃逸检查语义不一致 ——

- `packages/agent/src/tool/allowedRoots.ts:37` 做 `realpathSync` symlink 检查（`:48,:58`）
- `packages/agent/src/permissions/policy.ts:717` `isPathInWorkspace` 是**词法**比较

**这不是风格问题，是安全一致性问题。** 且根策略目前被塞进
`permissionRules.additionalDirectories` 传递（`electron/agents/server/router.ts:1060-1067`）——
一个 policy 字段被当作 transport 用。

**Workspace 明确不该包含**：worktree notice 文案（`forkSubagent.ts:150`）、
tool 选择、system prompt 装配、memory projection（`memory-state/outbox.ts:127` 的 roots 是
`defaultMemoryRoot()`，混用会让 workspace root 扩大记忆写权限）、OS sandbox policy。

**裁决：建 `packages/workspace`，但只收 roots + policy 解析。**
`docs/exec-plans/backlog/2026-09-workspace-phase-0.md` 已在 Planning（P0，0/26），
本 RFC 与之对齐，不重复设计。

### 3.3 Agent Control Plane — ✅ 定义职责，⚠️ 暂不建包

**属于 Control Plane 的**（已验证分散）：

| 职责 | 现状位置 | 重复数 |
|---|---|---|
| Goal 生命周期 | `GoalStore` + `modes/goal/*`（10 文件） | 3 substrate |
| Task 协调 | 3 套 task 模型 | 4 |
| Run 调度 / 所有权 | `workflow_runs` + `session_runtime_locks` | 2 |
| Checkpoint / resume / retry | workflow-store / resume-token / resumeAgent / stream-retry / summaryRetry | **6** |
| Steering / 抢占 | `wake/preemption` / `wake-dispatcher` / `abort` / mailbox apply_mode | 4 |
| Mailbox | core + 冻结的 legacy | 2 |
| Approvals | `permission_requests` ×2 + `toolApprovalState` + `sendMessageState` | 4 |
| Event log | 5 个 store | 5 |
| Queue | 5 套 | 5 |
| Automation schedule | **两套完整栈** | 2 |
| Multi-agent | TaskStore.claim + spawn_edges + SubagentTool + DependencyGraph | 部分 |

**仍应留在 Agent Runtime 的**：模型循环、tool 执行、subagent 的**执行体**、
permission 的**交互**、compaction、取消、runtime 事件、执行内状态。

**属于 Workspace 的**：roots、cwd、env 快照。

**属于 Storage 的**：所有 durable 表、event log、checkpoint 落盘。

**暂时不应抽象的**：worktree 分配（0 实现）、cloud 多租户（0 需求）、
AgentIdentity 对象（见 §3.6）。

> **为什么暂不建包**：wake ↔ automation 是**循环耦合**（§1.8），
> 3 套 task + 5 套 queue 的地基还没统一。直接建包会把循环搬进新包。
> **先做 C1/M4 的解耦，再抽包。**

### 3.4 Agent Runtime — 收窄为短生命周期执行引擎

目标签名（**不要求现在实现**）：

```
run(AgentInput) -> AgentEventStream
```

Runtime **不需要**自己决定：当前 project 是谁、workspace 在哪、能连哪些 app、
加载哪些 context、durable goal 状态、schedule、跨 run 的 retry policy。
这些全部上移。

**裁决**：Runtime 边界在设计文档里写清（`04-agent-harness-design.md` 已有），
但**现在不重写**。理由：`packages/agent` 内部的 18 个循环 SCC 尚未解开（见 `01` §2.1 V7），
Runtime 边界连编译层面都不存在。

### 3.5 RunManifest — 建议 contract（对给定草案的修正）

草案里我认为**不该进 manifest** 的字段：

| 字段 | 裁决 | 理由 |
|---|---|---|
| `roots` / `cwd` | ✅ 进 | 但**存引用 + 内容 hash**，不是裸路径 |
| `permissionPolicy` | ✅ 进 | 需 `version`（policy 语义会变） |
| `capabilities` | ✅ 进 | |
| `connectors` | ⚠️ **改为 binding ref** | connector token 是 secret，manifest 不得含 value |
| `contextSources` | ⚠️ **不进 manifest** | 每轮动态决定，进 manifest 就变成 stale |
| `environmentSnapshot` | ⚠️ **只进 ref + hash** | 快照含 secret 风险，且体积大 |
| `agentIdentity` | ✅ 进（ref） | |
| `checkpoint` | ✅ 进（ref） | |
| `projectId` / `workspaceId` | ✅ 进 | |

**修正后的草案**：

```ts
// packages/agent-protocol/src/run-manifest.ts
/** Immutable per-run input. Constructed by the Control Plane, consumed by Runtime. */
export interface RunManifest {
  /** Schema version — bumped when any field semantics change. */
  version: 1;

  readonly runId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly goalId?: string;      // absent for ad-hoc chat
  readonly taskId?: string;

  /** Workspace root refs. Resolved content, not raw strings. */
  readonly roots: readonly WorkspaceRoot[];   // { ref, contentHash, writable }
  readonly cwd: WorkspaceUri;                 // must be within roots

  /** Policy snapshot — versioned because semantics evolve. */
  readonly permissionPolicy: PermissionPolicy;   // { mode, version, rulesHash }
  readonly capabilities: CapabilityPolicy;

  /** Connector BINDINGS, never secrets. Control Plane resolves tokens at spawn time. */
  readonly connectorBindings: readonly ConnectorBinding[];  // { id, ref, scope }

  /** Environment ref + hash. Values resolved by Runtime from a secret store. */
  readonly env: EnvironmentRef;               // { ref, contentHash }

  readonly agent?: AgentIdentityRef;
  readonly checkpoint?: CheckpointRef;
  /** Determinism control for reproducible runs. */
  readonly deterministic?: boolean;
}
```

**必须 immutable**：全部（它是 run 的事实快照）。
**需要 versioning**：`permissionPolicy`（policy 语义演进）、`version` 本身。
**属于 secret/reference 而非 value**：`connectorBindings`、`env`。

### 3.6 Session — ✅ 应该降级，但必须分阶段

**目标模型**：

```
一个 Goal → 多个 Task → 多个 Run → 多个 Session/Channel
一个 Persistent Agent → desktop chat / Telegram / Feishu / automation / scheduler
                       （操作同一个 durable state）
```

**分阶段解耦，每步独立可回滚**：

| 步 | 动作 | 破坏性 |
|---|---|---|
| **S1** | `session_goals` 加 `goal_id` 列，`UNIQUE(session_id)` 放宽为多 goal | 低（可空列 + 读回退） |
| **S2** | 新建 `runs` 表；`session_runtime_locks` 增加 `run_id`（可空，回退到 session 锁） | 中 |
| **S3** | `tasks` 表加 `goal_id` / `run_id`；内存 `TaskRecord`（`lifecycle/TaskState.ts`）迁到 SQLite | 中 |
| **S4** | `sessions` 的 `working_directory` / `model` / `permission_mode` / `agent_profile_id` 迁到各自的 owner 表，保留旧列做读回退 | 高（最后做） |
| **S5** | session 成为纯 Channel 概念 | — |

> **S4 必须最后做**：它是 9 个概念挤在一行的地方，牵一发动全身。
> S1–S3 就能支撑"一个 Goal 多个 Session"的核心需求。

### 3.7 Persistent Agent — ✅ 方向对，⚠️ 现在不建对象

**现状：AgentIdentity 已经隐式存在，但分裂在 4 处 registry**：

1. `electron/config/agents.ts`（config.toml）
2. `project_bots` 表
3. `rollout_catalog`（memory-state）
4. `agent_profiles`（`schema.ts:46`）vs `AgentProfile`（plan 224，工具集）

`sessions.agent_profile_id` + `agent_type` + `agent_name` 是第 5 处影子。

**裁决**：**不建 `PersistentAgent` 类**。判据：
「必须指出当前至少两个真实代码位置重复承担该职责」——
identity 的重复确实存在（4 处 registry），但它们**不是同一职责**：
config.toml 管 agent 定义，`project_bots` 管成员关系，`rollout_catalog` 管日志归属。
**先把它们的关系理清（开放问题），再决定是否需要一个对象。**

**现在该做的**：只定义 `AgentIdentityRef`（一个只读引用类型）放进 protocol，不建存储。

### 3.8 Checkpoint / Resume — 现有机制对比

| 机制 | 恢复单位 | 存储 | 跨重启 |
|---|---|---|---|
| Session resume | 会话（消息重放） | `message_index` + rollout JSONL | ✅ |
| Session fork | 会话快照 | 深拷贝到新 id | ✅（但 fork 后完全分叉） |
| Workflow run resume | workflow run | `workflow_run_events` + snapshots | ✅（作 replay cache） |
| **Research run** | research run | 15 张表 + plan DAG | ✅ **但刻意不自动续跑** |
| Background task | 后台 lane | 内存 Map | ❌ |
| **Agent server checkpoint** | — | 内存 `Map` | ❌ **flush handler 只打日志** |
| Mode snapshot | mode 状态机位置 | `mode_state_snapshots` | ✅ |

**Durable vs Ephemeral 的正式边界**：

| Durable（跨 run / 跨重启） | Ephemeral（单 run 内） |
|---|---|
| Goal 状态与预算 | LLM message 列表 |
| Task 列表与依赖图 | 工具调用栈 |
| Plan steps 与进度 | 流式 delta |
| Event log（rollout / run events） | Context window 原始内容 |
| Checkpoint 引用 | Prompt 快照 |
| Workspace 路径与 hash | Retry backoff 计时器 |
| 审批决策 | 当前 turn 的 tool result 缓冲 |
| 变更文件清单 | — |

> **原则**：conversation history **不是** durable state，它是 durable state 的**投影**。
> 今天的实现恰好相反 —— transcript 是唯一真相（§1.13）。这是最需要反转的一点。

**优先修复**（低成本、高价值）：把 `CheckpointBatcher` 的 flush handler 从"打日志"
改成落盘到 `run_checkpoints` 表。这一步就能让"崩溃后可恢复"从假变真。

---

## 4. Evals Architecture

### 4.1 ✅ 应该更名：`harness/` → `evals/`

**"harness" 在本仓库已有 3 种含义**：

1. `packages/agent/tests/cli-control-plane/harness.ts` —— 启动真实 Electron 的测试架
2. `docs/references/harness-comparison/`（16 篇）—— 第三方 harness（Claude Code/Codex/pi/openclaw）对比
3. `docs/exec-plans/active/429-harness-gap-closure.md` —— **把 Duya 自己称作 harness**
   （"对照 Claude Code / Codex CLI / Cursor / Amp / Grok 这一代 harness"）

而本 RFC 中 "Agent Control Plane" 才是生产概念。
**新建顶层 `harness/` 必然语义冲突。改用 `evals/`。**

### 4.2 提案结构

```
evals/
  agent/
    tasks/          # 场景定义
    runners/        # local / subprocess / http
    evaluators/     # trajectory / outcome / cost / policy
    fixtures/       # workspaces / transcripts
    mock-provider/  # wire-level LLM mock
    reports/        # 输出（gitignored）
```

### 4.3 关键阻塞：当前无法离线跑 eval

**已验证**：

- 唯一的 mock 是 `packages/agent/tests/mocks/llm/MockLLMClient.ts`（118 行）
  —— 只 yield 预排队的 `SSEEvent[]`，**无 record/replay、无 fixture 格式、无请求指纹**，
  且**无法建模多轮 tool calling**（它在一次响应里合成 `tool_use` + `tool_result`）。
  且已陈旧：活跃集成测试改用 inline `vi.fn()`，不再引用它。
- `packages/agent/tests/integration/DuyaAgent.test.ts:5` 需要真实 `ANTHROPIC_API_KEY`，无 key 则 skip。
- **全仓没有任何测试通过真实 transport 驱动完整 agent turn**。
  `e2e/ipc/agent-server.spec.ts:48-61` 只断言端口为正，**从不驱动 chat run**。

**好消息**：Agent Server 协议**已经足够**。
`electron/agents/server/index.ts:10` 用 `PORT=0` 绑定临时端口并在 stdout 广播真实端口（`:338-342`）；
路由含 `POST /sessions` → `POST /sessions/{id}/chat`（SSE）→ `GET .../status` → `DELETE .../chat`。
**所以外部 eval harness 不需要改协议，只需要一个 wire-level mock provider。**

### 4.4 依赖方向

```
Evals ──→ Agent Control Plane ──→ Agent Runtime
   └────────────────────────────→ Agent Runtime   (仅 runtime 级 benchmark)

禁止: evals → agent-core/src/*, evals → runtime private impl
```

---

## 5. Multi-host 模型

| Host | 今天 | 目标 |
|---|---|---|
| Desktop | ✅ 主 host | 不变 |
| CLI | ✅ `packages/cli` | 通过同一 Run API |
| Bot（Telegram/Feishu/…） | ⚠️ 走 wake + mailbox，**独立栈** | 作为 Channel，而非独立 runtime |
| Automation | ⚠️ 走 `electron/automation`（绑 Electron） | Control Plane，host 可换 |
| Cloud Worker | ❌ 不存在 | **不预先设计**，但架构不得锁死 |
| Web / External API | ❌ | 同上 |

> **不为不存在的 Cloud 过度设计。** 但有一条必须现在就成立：
> **Automation 不能永久绑在 Electron 进程里** —— 它是 Control Plane 职责，
> 当前的 `electron/automation/Scheduler.ts` 60s tick 把它焊死在 main 进程生命周期上。

---

## 5.1 概念 → 物理位置对照（逐条覆盖 31 个子项）

**核心认知：概念层 ≠ 物理层 ≠ 数据对象。** 你列的四组概念其实分三类落地形态：

| 形态 | 含义 | 例子 |
|---|---|---|
| **数据对象** | 有表、有生命周期、能被多个逻辑层读写的实体 | Project / Goal / Task / Run / Session |
| **逻辑层** | 一个包，或跨进程的模块集合 | Workspace / Control Plane / Runtime / Core |
| **契约引用** | 只有类型定义，没有存储 | AgentIdentity |

**把逻辑层误当数据对象建表，是最容易走偏的地方。**

### ① Project（长期逻辑身份）— 数据对象 ✅ 已存在

| 子项 | 物理位置 | 形态 | 状态 |
|---|---|---|---|
| project identity | `electron/db/core/project-store.ts:129` `projects` 表 | 表 | ✅ UUID + name + paths[] |
| Memory | `electron/memory-state/` + `packages/agent/src/memory-state/` | 表 + 包 | ✅ 已有 tier（plan 479） |
| Goals | **无独立存储** —— 挂在 `session_goals.session_id` | 表（错位） | ⚠️ 需 `goal_id`（S1） |
| Tasks | `electron/db/core/stores.ts:86` `tasks` 表 | 表 | ✅ 但有 3 套模型 |
| Sessions | `electron/db/core/session-store.ts` `sessions` 表 | 表 | ⚠️ 9 个概念挤一行 |
| Artifacts | `workflow_runs.artifacts_json` / conductor 画布 | 表 | ⚠️ 分散，无统一 artifact 概念 |

> **Project 是四个概念里唯一已经做对的。** 缺陷只有一个：跨库 FK 逼出了 memory-state 的影子表
> （`catalogSync.ts:208-220`）。修 Storage 即可，**不要重建 Project 表**。

### ② Workspace（执行环境）— 逻辑层 ⚠️ 条件采纳

| 子项 | 物理位置 | 裁决 |
|---|---|---|
| roots | `packages/workspace` | ✅ 进（现 5 处重复） |
| cwd | `packages/workspace` | ✅ 进（3 个 normalizer / 5 个 store） |
| repo / files | `packages/workspace` | ✅ 进（多根集合） |
| context sources | `agent-core` 的 `PromptSystem:495-496` | ❌ **不进** —— 已是唯一装配点，散的是内容不是身份 |
| connectors | `packages/plugin-core` | ❌ **不进** —— 缺的是 scope 维度（现在全局单 store） |
| capabilities | `agent-protocol` 的 `CapabilityPolicy` | 契约，进 manifest 不进 workspace |
| trust / permission policy | `packages/workspace` | ✅ 进（4 个 source of truth，默认值已分叉） |
| environment state | **不落地** | ❌ 现状"继承全部 env"，是**安全特性需求**不是边界去重 |

> **只有 4/8 进 workspace。** 判据是"至少两个真实代码位置重复承担"，
> 且 workspace 必须**不含任何 agent reasoning**（不含 prompt 文本、tool 选择、compaction）。

### ③ Agent Control Plane — 跨进程逻辑，**暂时不是一个包**

| 子项 | 今天在哪 | 重复数 | 裁决 |
|---|---|---|---|
| Goal lifecycle | `GoalStore` + `modes/goal/*`（10 文件） | 3 substrate | 需收敛 |
| Task decomposition | 4 套 task 模型（SQLite/冻结壳/内存 Map/JSON） | 4 | 需收敛 |
| Run scheduling | `workflow_runs` + `session_runtime_locks`（按 session 锁！） | 2 | 需新建 `runs` 表 |
| Agent identity | config.toml / `project_bots` / `rollout_catalog` / `agent_profiles` | 4 | ⚠️ **只定义 ref，不建对象** |
| checkpoints | `checkpoint-batcher.ts` **接线了但只打日志** | — | 🔥 **落盘是一行改动** |
| resume / retry | workflow-store / resume-token / resumeAgent / stream-retry / summaryRetry | **6** | 需收敛 |
| steering / mailbox | `wake/preemption` / `abort` / mailbox apply_mode | 4 | 需收敛 |
| approvals | `permission_requests`×2 + `toolApprovalState` + `sendMessageState` | 4 | 需收敛 |
| context materialization | `agent-core` | 分布不重复 | **归 Core** |
| event log | message_index / workflow_run_events / research_events / rollout / audit | **5** | 词汇已统一，存储未统一 |
| multi-agent coordination | TaskStore.claim + spawn_edges + SubagentTool + DependencyGraph | 部分 | 需收敛 |

> **为什么不抽包**：`wake-dispatcher` ↔ `automation/agent-run` 是**循环 import**。
> 现在抽包 = 把循环搬进新包。**先解耦（RFC §9 步骤 7），再抽包。**

### ④ Agent Runtime — 逻辑层 ✅ 建包（有前置）

| 子项 | 物理位置 | 裁决 |
|---|---|---|
| model loop | `agent-runtime`（`DuyaAgent`） | ⚠️ **必须先解 18 个循环 SCC** |
| tool execution | `agent-runtime` + `browser` 等独立能力包 | ✅ |
| compaction | **`agent-core`**（纯逻辑，无 IO） | 不在 runtime |
| subagent | `agent-runtime` | ✅ |
| permissions | 策略在 `workspace`，**交互**在 runtime | 拆开 |
| runtime events | `agent-protocol` 的 `RunEvent` | 契约 |

**Runtime 需要的签名**（写清约束，不要求现在实现）：

```
run(AgentInput) -> AgentEventStream
```

**Runtime 不需要自己决定**：project 是谁、workspace 在哪、能连哪些 app、
加载哪些 context、durable goal 状态、schedule、跨 run 的 retry policy —— 全部上移。

### ⑤ 剩余概念的落点

| 概念 | 物理位置 | 形态 | 状态 |
|---|---|---|---|
| **Agent Core** | `packages/agent-core` | 包 | 纯 reasoning，零 IO |
| **Session/Channel** | `electron/db/core/session-store.ts` | 数据对象 | **降级为投影，分 S1–S5** |
| **Goal / Task / Run** | Control Plane 的持久化 | 数据对象 | Goal/Run 需新表；Task 复用现有 |
| **AgentIdentity** | `agent-protocol` 的只读 ref | 契约 | **不建存储对象** |
| **Evals** | `evals/`（非 workspace 成员） | 目录 | 新建 |

> **一句话**：Project/Goal/Task/Run/Session 是**数据对象**（落在 Control Plane 与 Storage），
> Workspace/Control Plane/Runtime/Core 是**逻辑层**（落成包或跨进程模块），
> AgentIdentity 目前只是**契约引用**。把逻辑层误当数据对象建表，是最容易走偏的地方。

---

## 5.2 `@duya/browser` 已在做，改变了工具层策略

plan 583 的分支 `.claude/worktrees/browser-capability-split` 已建 `packages/browser`：

| 项 | 实测 |
|---|---|
| 规模 | 19,139 LOC / 73 src 文件 / **13 个测试文件** |
| 对 agent/electron 的 import | **0** |
| 依赖 | `axios` · `jimp` · `playwright` · `zod` |
| 自述边界 | "Owns no agent-tool contract and no product surface" |

**这条证据推翻了"建一个 `agent-tools` 聚合包"的初版建议**：
单能力 19k LOC 已经是可独立包的内聚单元，40+ 工具塞进一个袋子内聚反而更差。
详见 `docs/architecture/03-target-structure.md` §3.1。

**判定：撤回 `agent-tools`，改为一能力一包。** 后续若要抽，按同样标准评估
（Bash 三件套与权限强耦合暂不动；Read/Edit/Write 合计仅 ~3k 太薄）。

```
┌─────────────────────────────────────────────────────┐
│ agent-protocol   (零内部依赖 · 零 IO)                │  ← RunManifest / RunEvent /
│                                                     │    ToolEvent / Permission
└──────────────────────┬──────────────────────────────┘
                       │
      ┌────────────────┼────────────────┐
      ▼                ▼                ▼
 agent-core      browser  ★          ai
 (纯 reasoning)  (19k 独立能力)       (provider)
      └────────────────┬────────────────┘
                       ▼
              agent-runtime
                       │
     ┌─────────────────┼──────────────────┐
     ▼                 ▼                  ▼
 workspace       plugin-core         ★ control-plane
 (roots+policy)  (mcp/plugins)      (逻辑层，暂不建包)
                       │
     ══════════════════╪════════════  进程边界
                       ▼
   ┌──────────┬──────────┬──────────┬──────────┐
   │ desktop  │   cli    │  evals   │ gateway  │  ← 平级 consumer
   └──────────┴──────────┴──────────┴──────────┘
```

**`evals` 不在 workspace 成员内**（理由见 `04-agent-harness-design.md` §2）。

> **注意层次差异**：`control-plane` 在图里是**跨进程逻辑**（`electron/db/core/*` +
> `wake-dispatcher` + `automation`），不是一个包。它最终可能拆包，但那是解耦之后的事。

---

## 7. 过度抽象的风险（诚实清单）

| 风险 | 现实威胁 | 缓解 |
|---|---|---|
| **God Package** | 把 wake+automation+db-bridge+workflow 全塞进 `agent-control-plane` —— 它会变成 300KB+ 的 `db-bridge` | 明确排除清单：模型循环、tool 实现、prompt 组装**禁止**进入 |
| **循环搬进新包** | wake ↔ automation 已循环，抽包只会搬家 | **先 C1/M4 解耦，抽包排在解耦之后** |
| **过度 micro-package** | 8 个概念 → 13+ 个包，每个都要 build/test/typecheck 配置 | 每新增包必须过 `03-target-structure.md` 的 7 条准则 |
| **假多租户** | 为不存在的 Cloud 设计 `workspaceId`/`tenantId` 隔离 | Cloud 需求出现前不做隔离，只做可替换性 |
| **Session 迁移事故** | S4 动 `sessions` 牵 1776 处 renderer 引用 | 拆成 S1–S5，每步保留读回退列 |
| **checkpoint 语义膨胀** | 把 LLM transcript 当 checkpoint 存 → 重复且不可 replay | Durable/Ephemeral 表（§3.8）是硬边界 |
| **术语漂移** | "harness" 已有 3 义，再加 "control plane" 变 4 义 | 改用 `evals/`；每个新术语进 `AGENTS.md` 的 Architecture 章节 |

---

## 8. 明确现在不应该实现的东西

| 不做 | 理由 |
|---|---|
| `PersistentAgent` 类 / 存储表 | 4 处 registry 职责不同，先理清关系 |
| `WorktreeAllocator` | **0 行实现**（`git worktree add` 全仓不存在），只有 prompt 文本 |
| Cloud / 多租户隔离 | 0 需求。只保证可替换性 |
| `packages/ui` | UI 的问题是边界泄漏不是缺包（`03` §1.1） |
| `packages/mcp` / `memory` / `storage` | 已有 owner 或所有权未反转（`03` §1.1） |
| Environment snapshot 特性 | 现状是"继承全部 env"，无 allowlist —— 那是**安全特性需求**，不是边界去重 |
| Connector per-workspace scope | 缺的是 scope 维度，属于 plugin-capability 模型演进 |
| 重建 `projects` 表 | 概念已成立，只修跨库 FK |
| 改 `CheckpointBatcher` 为持久化 | **← 相反：这个应该做，成本最低收益最高**（§3.8） |

---

## 9. 建议的行动顺序

按"证据强度 × 成本"排序，**全部可独立回滚**：

| 序 | 动作 | 成本 | 收益 | 依据 |
|---|---|---|---|---|
| 1 | **CheckpointBatcher 落盘** | 极低 | 高 | §1.12 现在只打日志，崩溃即丢 |
| 2 | **统一两套 escape check** | 低 | 高（安全） | §3.2 realpath vs 词法不一致 |
| 3 | **M4 conductor 解耦** | 低 | 高 | 删整段 build hack |
| 4 | **C1 解循环 SCC** | 中 | 高（解锁 M5） | 18 SCC，最大 42 文件 |
| 5 | `session_goals` 加 `goal_id`（S1） | 中 | 中高 | `UNIQUE(session_id)` 是硬天花板 |
| 6 | `runs` 表 + 锁按 run（`run_checkpoints` 同批） | 中 | 中高 | §1.4 runId 是临时 UUID |
| 7 | 合并 automation 两栈 | 中高 | 中高 | §1.7 |
| 8 | 内存 `TaskRecord` → SQLite（S3） | 中 | 中 | §1.6 跨重启丢失 |
| 9 | 建 `packages/workspace`（仅 roots+policy） | 中 | 中高 | §3.2 |
| 10 | wire-level mock provider → `evals/` | 中 | 高 | §4.3 当前无法离线 eval |
| 11 | `agent-control-plane` 包 | 高 | 中 | **必须在 7、8 之后** |
| 12 | S4（sessions 瘦身） | 很高 | 中 | 最后做 |

---

## 10. 结论

**Duya 应该演进，但不是"新建一个 Agent Platform"** —— 它已经有一个事实上的 control plane
（`db-bridge.ts` 117KB + `wake-dispatcher` + `db/core/*` aggregates），
只是**从未被命名，因此从未被治理**：3 套 task、5 套 queue、4 套 approval、2 套 automation、5 套 event log，
以及一个**只打日志的 checkpoint**。

最该做的三件事，都不是建包：

1. **让 checkpoint 真的落盘** —— 崩溃可恢复从假变真，成本一行 handler。
2. **统一两套路径逃逸检查** —— 现在 realpath 与词法并存，是安全不一致。
3. **解 wake ↔ automation 的循环** —— 否则 control plane 抽出来只是把循环搬家。

反过来，**最该克制的**是不要建 `PersistentAgent`、`WorktreeAllocator`、Cloud 隔离
—— 这三个都缺"至少两个真实代码位置重复承担"的证据。
按 `AGENTS.md` 的原则：**证据不足时，只定义 contract 与术语，不建包。**
