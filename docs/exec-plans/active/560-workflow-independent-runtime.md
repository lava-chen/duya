# Plan 560: Workflow Independent Runtime

> **修订版（2026-09-22）**。原稿写于 dwf 迁移之前，其数据模型与前提已与代码脱节
> （`workflow_runs` 早已存在且 schema 不同、"阶段序列是合成的"已被真实执行器取代）。
> 本版按代码实证重写：§1 列出与原稿的逐条差异，§3 是全部设计决策，§4 起是可执行清单。
>
> 事实依据已核对至 2026-09-22 的工作区状态，关键结论均带 `路径:行号`。

## 0. 一句话目标

工作流 run 变成**不依赖 chat session 的一等公民**：从 Workflow 库点 ▶ Run 即起一个
专属子进程跑完 `.dwf.ts`，事件按 `runId` 走独立 SSE 流，渲染层实时画出阶段／步骤／
产物，运行历史可整段回放。

## 1. 与原稿的差异（修订依据）

| # | 原稿写法 | 事实 | 本版处理 |
|---|---|---|---|
| 1 | Phase 1「添加 `workflow_runs` 表」 | 表已存在：migration **28** `electron/db/core/workflow-store.ts:109-139`，列是 `workflow_version_id / trigger_kind / dedup_key / wait_till / retry_of / pause_message / params_json / created_at / updated_at` | 改为 **ALTER TABLE 加列**（migration 30） |
| 2 | 新建 `workflow_run_events(type, data)` | 事件真相已存在：`workflow_run_snapshots.journal`（migration 29）= `JournalRecord[]`，`appendJournalRecord`/`loadJournal` 已就绪 `workflow-store.ts:299-350` | **不造第二套事件词汇**：新表存 `JournalRecord` 原样，并把 journal 从快照 blob 搬到表里（migration 30/31） |
| 3 | 状态只有 4 值 running/completed/failed/cancelled | `WorkflowRunStatus` 有 **15** 值 `workflow-store.ts:24-39` | 保留 15 值，UI 侧做分组映射（§7.3） |
| 4 | 类名 `WorkflowRunDb` / 新建 `WorkflowManager` | 实际是 `WorkflowRunStore`；`WorkflowManager` 这个名字已被 agent 侧 `packages/agent/src/modes/workflow/manager.ts` 占用 | 修正为 `WorkflowRunStore`；新类命名 `WorkflowRuntimeManager` |
| 5 | 「阶段序列是合成的」（问题陈述） | 已失效：`workflow-runner.ts` 现在是真实执行器（`runDwfScript` + 生产 `DwfHostPorts` 绑定 `workflow-runner.ts:183-260`） | 问题陈述改为「**耦合**仍在」：run 仍要求 sessionId（`router.ts:2901,3078`） |
| 6 | Phase 5「废弃 `workflow:run`，保留 `workflow:trigger`」 | `workflow:trigger` 不存在；`workflow:run` 是唯一在用的通道 `electron/ipc/workflow-handlers.ts:271` | 改为**双锚点共存**：`workflow:run`（session 锚）保留给会话内触发，新增 `workflow:trigger`（run 锚） |
| 7 | 「`WorkflowRunPanel` 组件（替换 WorkflowPanel 里的卡片逻辑）」 | 渲染层已有 `WorkflowRunCard.tsx` + `WorkflowRunStream`（`src/components/workflow/`）与 runId 订阅 store `src/stores/workflow-store.ts` | 改为**抽共享展示原语 + 新增 run 详情面板**，不重写已有卡片 |
| 8 | 「通过 EventSource 订阅 SSE」 | 渲染层不用 EventSource：`src/lib/agent-sse-client.ts:5-6` 明确用 `fetch()` 手工解析；端口经 `agent-server:get-port` 拿 `preload.ts:2101` | 改为 fetch 流式解析，复用同一套端口解析与重连语义 |
| 9 | 无阶段概念 | `JournalKind` 已含 `'phase'` 但 runtime 从不 append（`journal.ts:21`）；脚本也没有 `wf.phase` 原语 | 新增第 9 个原语 `wf.phase(name)`（§6.2），否则截图里的阶段列表无数据源 |
| 10 | 步骤行能显示命令原文 | `JournalRecord` 有 `action`/`exitCode`/`durationMs`/`outputSize` 但**没有输入文本**（只存 `reqHash`） | 加两个 display-only 字段 `inputSummary` / `replayed`（§6.1） |

另外修掉一处文档债：文件重命名为 `560-workflow-independent-runtime.md`（原文件名无编号，
与目录约定不符）；`559-prompt-asset-cleanup.md` 里「directory-naming restructure deferred
to plan 560」是抢号残留，那条重构**不属本计划**（§10 末尾）。

## 2. Scope

### In Scope（v1）

- run 锚定：`origin`/`parent_session_id` 落库，run 生命周期**全程不需要 session**
- 每 run 一个独立子进程（`WorkflowRuntimeManager`），含就绪握手、崩溃、取消、并发上限
- 事件流：`JournalRecord` 为唯一事件真相 → child→main IPC → main→renderer SSE（按 `runId`）
- 持久化：`workflow_runs` 扩列 + `workflow_run_events` 表 + 历史回放
- 新增 `wf.phase` 原语；`JournalRecord` 加 `inputSummary`/`replayed`
- 渲染层：run 详情面板（阶段／步骤／产物／停止／回放），与既有会话内卡片共用展示原语
- 启动弹窗（已有 `WorkflowLaunchDialog` 扩能）：触发前指定**工作目录** + **覆盖参数值**，
  两者都随 `workflow:init` 下发；工作目录即 agent 节点（`wf.agent`）的 working directory
- 产物：`publishArtifact` 落盘 `~/.duya/workflow-artifacts/<runId>/` + 表记录 + **最终卡片内渲染**

### Out of Scope（v1 明确不做）

| 项 | 理由 |
|---|---|
| agent 用 workflow 工具触发新 run | 用户明确后置。**但 schema／通道按 §3.1 预留，落地时不需要迁移** |
| 结果以「后台消息」回投会话 | 依赖上一项；`origin:'agent'` 时才有投递目标 |
| 会话内联 run 卡（截图 1 那种）的**新**能力 | 已有 `WorkflowRunCard` 继续服务 session 锚路径，本计划只抽原语不扩功能 |
| resume / 血缘（「调整自 run xxx」） | journal 缓存经济学需要同步 seed，见 §11 R4 |
| 运行队列 / 定时触发 / cron 接线 | 触发只做 manual(library) |
| MCP 工具面、`gui` 节点、YAML defs 路径 | 维持现状 |

## 3. 设计决策

### D1 — run 锚定：用 `origin` 表达，而非删除 session 路径

`workflow_runs` 加 `origin TEXT NOT NULL DEFAULT 'library'`，取值
`library | session | agent | cron`；`parent_session_id TEXT NULL` 只在后两者非空。

- v1 只有 `library` 会真正落库（run 锚，无 session）。
- `session` 走现有 `workflow:run` + `chat:workflow_run`，**不动**。
- `agent`/`cron` 是未来入口，列已就位 → 不需要二次迁移。

理由：把「去 session 化」实现为**新增一条锚定方式**而不是改写既有路径，
回归面从「整条链路」缩到「新增代码」。同时这正是 §2 里那两项后置项的落点。

### D2 — 进程模型：每 run 一个子进程，不改造 `WorkerManager`

- `WorkerManager`（`electron/agents/server/worker-manager.ts`）**深度绑定 session**：
  以 sessionId 为 map key（`:71,106`）、驱动 `SessionManager` 状态机（`:113,167`）、
  带 idle reaper 与 draining 语义（`:124-130,458`）。泛化它的风险远大于收益，
  且该文件正被其他会话改动 → **不碰**。
- 新增 `electron/agents/server/workflow-runtime-manager.ts`：以 **runId 为 key** 的
  兄弟实现，`spawn(runId, job)` / `send(runId, msg)` / `kill(runId)` / `get(runId)` /
  `killAll()`，复用 `getAgentProcessPath()`（`electron/agents/process-pool/process-manager.ts:47`）
  与 `fork(..., {stdio:['pipe','pipe','pipe','ipc']})` 的既有形态（`worker-manager.ts:88`）。
- **同一个 bundle，不同角色**：子进程仍是 `agent-process-entry.js`，
  通过 `DUYA_AGENT_ROLE='workflow-runtime'` + `DUYA_WORKFLOW_RUN_ID=<runId>` 分流，
  **不设 `DUYA_SESSION_ID`**。理由：`DwfHostPorts` 的 `runTool`/`runAgent` 需要完整
  工具注册表与 LLM 运行时，另起轻量 entry 会把半个 agent 运行时重建一遍。
- 实现时若发现 `agent-process-entry.ts` 的 init 分支对 sessionId 是硬依赖
  （`:4152 case 'workflow:run'` 从 `wf.sessionId` 取），则在 entry 内加一条
  `role === 'workflow-runtime'` 的早期分支，走独立 deps 组装，**不改动原分支**。

### D3 — 子进程是纯执行器：不碰数据库

原 `workflow-runner.ts` 用 worker db 桥（`workflowRunDb` = 子进程 → main 的 IPC 桥）。新架构下：

| 动作 | 执行方 |
|---|---|
| 建 run 行（`status='active'`） | **main**（core-db 在 main） |
| 解析 saved workflow（作用域、arg 默认值、必填校验） | **child**（它才知道 workspace 路径），结果经 `ready` 帧回传 |
| 存定义快照 | main（用 `ready` 帧里的 definition） |
| 每条 journal 记录落库 | main（收到帧即 `appendJournalRecord`） |
| 产物字节 | child 写 `~/.duya/workflow-artifacts/<runId>/…`，只回报相对路径 + 元数据 |

这样 child **零 DB 依赖**（不需要 db-bridge 分支），main 是唯一持久化点，
「事件流」与「落库」天然同源同序。`agent-process-entry.ts` 里现有的 db 桥初始化在
`workflow-runtime` 角色下跳过即可。

### D4 — 事件模型：`JournalRecord` 就是事件

不引入 `{type,data}` 第二套词汇。子进程每 append 一条 `JournalRecord` 就发一帧：

```
child → main    :  { type:'workflow:run-event', runId, seq, record: JournalRecord, summary: RunSummary }
main  → renderer:  SSE frame { frame:'record', seq, record, summary }
```

`RunSummary`（每帧携带，避免渲染层自己 reduce）：
`{ runId, workflowName, status, origin, startedAt, finishedAt?, phase?, tokens?, subagents?, artifactCount?, totalRecords? }`

- `seq` 来自 `journal.ts:142` 的 `seq`（已单调），**它就是 SSE 的游标**。
- `RunStepView`（`worker-protocol.ts:463`）**继续服务 session 锚路径**，不改不删，
  避免与并行会话冲突；run 锚路径直接吃 `JournalRecord`（字段更全，见 §6.1）。

### D5 — 传输

| 段 | 通道 |
|---|---|
| renderer → main | IPC invoke：`workflow:trigger` / `workflow:cancel` / `workflow:status` / `workflow:list-runs` / `workflow:get-events` |
| main → child | `child.send()`（fork IPC，与 worker 同构） |
| child → main | stdout JSON 行（与 worker 同构，`worker-protocol.ts:789` 的写法） |
| main → renderer（**事件流**） | SSE `GET /workflow-runtime/:runId/events`（agent server 内） |
| renderer → main（审批/取消） | IPC（见 D6、§5.1） |

渲染层直连 SSE 是**已有做法**：`src/lib/agent-http-client.ts:106-141` 已经用
`agent-server:get-port` 解析 baseUrl 并做端口失效重取。**移除原稿的
`workflow:run-sse-url` 通道**——URL 由渲染层自己拼，少一条会漂移的状态。

**漏帧处理（必须实现）**：订阅晚于首帧是常态（`trigger` 返回 runId 时 run 已开跑）。
SSE 端点支持 `?afterSeq=<n>`，渲染层流程固定为：
① `trigger` 拿到 runId → ② 立刻开 SSE → ③ 同时 `workflow:get-events {afterSeq: lastSeen}` 补洞 →
④ 按 `seq` 去重合并（同一 seq 幂等覆盖）。**断言：任何时刻 UI 的记录集 = 库里 `seq <= max` 的连续前缀。**

### D6 — `DwfHostPorts` 在无 session 下怎么活

| 端口 | v1 处理 |
|---|---|
| `runTool` | 直接用，只需 `workingDirectory`（`workflow-runner.ts:189`） |
| `runGui` | 维持 loud-failure stub（556 边界，非本计划） |
| `decide` / `log` / `map` / `publish` | 直接用 |
| `publishArtifact` | **新绑定**：child 写 `~/.duya/workflow-artifacts/<runId>/`（**已裁定**；这是本仓库既有的 `~/.duya/` 家族约定，与 `~/.duya/workspace`、`~/.duya/cronjob.toml`、`~/.duya/attachments` 同级。复用 `FsArtifactStore`，`packages/agent/src/modes/workflow/gui-artifacts.ts:36`），帧里带 `{name, contentType, bytes, relPath}`，main 汇总进 `artifacts_json`；路径经 `workflow:init` 的 `artifactsDir` 下发，child 不自己拼 |
| `requestApproval` | **新通道**：原走 worker 的 `chat:permission`（渲染在锚定会话里）。run 锚下改为 run 级：child 发 `{type:'workflow:permission-request', runId, requestId, toolName, toolInput, expiresAt}` → main → SSE `frame:'permission'` → 面板内弹审批卡 → `workflow:permission-resolve` IPC 回传 child。超时语义保持「超时即 deny」 |
| `runAgent` | **本计划最硬的一块**，见下 |

**`runAgent` 的三种做法与裁定**：

| 方案 | 代价 | 结论 |
|---|---|---|
| A. 进程内 agent loop（不落 chat session） | 需在 child 里搭一个子代理循环（系统提示组装 + 工具循环 + usage 回收） | **v1 首选**，但先做 spike（Phase 5） |
| B. `SubagentTool` + 惰性载体会话 | 需引入隐藏 session，把 wake/通知/侧栏一并拖进来，直接违背「不依赖 session」 | 兜底 |
| C. v1 不支持 | `wf.agent` 记一条 failed 节点 + 明确错误 | 保底 |

选 A 的额外理由：截图里的 `2 个子代理 · 1,821,463 tokens` 需要 **run 级 usage**，
而现有 `SubagentTool` 路径的 token 是**拿不到的**（`workflow-runner.ts:16-20` 注释自陈
「用量不提取 → token 省略」）。A 方案顺手补齐这个洞。

**Phase 5 的 Go/No-Go**：spike 限时完成「child 内跑一次带工具的子代理并回报
`usage` + actor id」；跑不通就退 C（并在 journal 与 UI 上明示 `wf.agent` 未支持），
**不阻塞 Phase 1-4 交付**。

### D7 — 取消语义（v1 诚实版）

dwf 沙箱没有定时器、`DwfHostPorts` 的调用也不接收 `AbortSignal`（`runtime.ts`），
所以**没有优雅中断**：`workflow:cancel` → manager `SIGTERM`（宽限 2s）→ `SIGKILL`
→ `updateStatus('cancelled')` → journal 补一条 `status:'failed'` + `errorClass:'cancelled'`
的收尾记录 → SSE 推 `done`。与现有 `interruptWorker` 的粗暴程度一致，**不假装优雅**。
UI 上「停止运行」的状态流转照此写实。

### D8 — 并发与崩溃

- 并发上限：默认 **3** 个同时运行的 run，超限时 `workflow:trigger` **立即失败并回明确错误**
  （不出队、不排队）。
- 崩溃：`exit` 时若该 run 仍是本进程且未收到 `finished` → `updateStatus('failed')` +
  journal 错误记录 + SSE 推 `error`。
- 重启残留：复用已有 `reconcileStaleRuns()`（`workflow-store.ts:275`）在启动时把
  仍为 `active` 的孤儿 run 收敛成 `interrupted`。

### D9 — 命名与位置

| 新东西 | 位置 |
|---|---|
| `WorkflowRuntimeManager` | `electron/agents/server/workflow-runtime-manager.ts` |
| run 锚 HTTP 路由 | `electron/agents/server/router.ts` 新增 `handleWorkflowRuntime*`，不改既有 `handlePostChatSSE` |
| run 锚 IPC | `electron/ipc/workflow-handlers.ts` 追加（同名文件已有 session 锚通道） |
| 渲染层 IPC 包装 | `src/lib/workflow-ipc.ts` 追加 + `electron/preload.ts` + `src/global.d.ts` 三处同步 |
| run 详情面板 | `src/components/layout/panels/WorkflowRunPanel.tsx`，注册进 `registry.ts` 的 `PageId` |

## 4. 数据模型（可执行 DDL）

### 4.1 migration 30 — `workflow_runs` 扩列 + 事件表

追加到 `WorkflowRunStore.migrations`（`electron/db/core/workflow-store.ts:109`）。
**id 用 30、31**：当前最大 29，收集点在 `electron/db/core-connection.ts:116,132-133`。

```sql
-- 30-a 扩列（SQLite ALTER ADD COLUMN 只能加可空列或带 DEFAULT 的列）
ALTER TABLE workflow_runs ADD COLUMN origin            TEXT    NOT NULL DEFAULT 'library';
ALTER TABLE workflow_runs ADD COLUMN scope             TEXT;
ALTER TABLE workflow_runs ADD COLUMN project_dir       TEXT;
ALTER TABLE workflow_runs ADD COLUMN parent_session_id TEXT;
ALTER TABLE workflow_runs ADD COLUMN artifacts_json    TEXT    NOT NULL DEFAULT '[]';
ALTER TABLE workflow_runs ADD COLUMN summary           TEXT;
ALTER TABLE workflow_runs ADD COLUMN finished_at       INTEGER;
ALTER TABLE workflow_runs ADD COLUMN spent_tokens      INTEGER;

-- 30-b 事件表（JournalRecord 原样存，不做字段展开）
CREATE TABLE IF NOT EXISTS workflow_run_events (
  run_id      TEXT    NOT NULL,
  seq         INTEGER NOT NULL,
  record_json TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_workflow_run_events_run ON workflow_run_events(run_id, seq);

-- 30-c 列表查询支撑（runs tab 按 origin + 状态过滤）
CREATE INDEX IF NOT EXISTS idx_workflow_runs_origin ON workflow_runs(origin, created_at);
```

> `ALTER TABLE ADD COLUMN` 没有 `IF NOT EXISTS`——迁移器按 id 记账（`database.ts` 的
> `Migration` 契约），重复执行由 id 保证不会发生。28/29 那种 `IF NOT EXISTS` 防御姿态
> 只适用于 `CREATE TABLE`。

### 4.2 migration 31 — journal 从快照搬到事件表

现有 `workflow_run_snapshots.journal`（blob）与 `workflow_run_events`（表）会**双真相**。
31 做一次性搬迁 + 改变写入面：

1. 遍历 `workflow_run_snapshots`，把 `snapshot_json.journal[]` 逐条 INSERT 进
   `workflow_run_events`（`INSERT OR IGNORE`，以 `(run_id, seq)` 幂等）。
2. 重写 `snapshot_json`，**删除 `journal` 键**（保留 `definition` / `nodeStack`）。
3. 代码侧同步：
   - `saveSnapshot`（`:299`）不再写 `journal` 字段；
   - `appendJournalRecord`（`:339`）从「load→push→save 整个 blob」改为**单条 INSERT**
     （顺带修掉 O(n²) 写放大）；
   - `loadJournal`（`:349`）改读事件表；
   - `loadSnapshot`（`:319`）**保留对 legacy `journal` 键的读取兜底**（老库未迁完时仍可回放）。

`WorkflowRunSnapshot` 类型的 `journal` 字段标 `@deprecated`，v1 结束前不删类型。

### 4.3 保留原义的既有列（不新增、不删除）

`workflow_version_id` / `trigger_kind` / `dedup_key` / `wait_till` / `retry_of` /
`pause_message` 全部保留：v1 的 library run 填 `trigger_kind='manual'`，
`dedup_key` 留空（幂等键属触发层的事，本计划不做）。

## 5. 契约

### 5.1 IPC（renderer ↔ main）

| Channel | 方向 | Payload → 返回 |
|---|---|---|
| `workflow:trigger` | r→m | `{name, params?, projectDir?, scope?}` → `{ok, runId?, error?}` |
| `workflow:cancel` | r→m | `{runId}` → `{ok, error?}` |
| `workflow:status` | r→m | `{runId}` → `WorkflowRunRecord \| null` |
| `workflow:list-runs` | r→m | `{workflowName?, origin?, status?, limit?, offset?}` → `WorkflowRunRecord[]` |
| `workflow:get-events` | r→m | `{runId, afterSeq?}` → `JournalRecord[]` |
| `workflow:permission-resolve` | r→m | `{runId, requestId, decision:'allow'\|'deny'}` → `{ok}` |

**刻意不加** `workflow:run-sse-url`（见 D5）。
`workflow:run`（session 锚）**签名不变**，两者并存；`workflow:cancel` 需按 `origin`
分派（run 锚 → runtime manager，session 锚 → 原逻辑）。

`WorkflowRunRecord`（渲染层新类型，镜像 `WorkflowRun` + 新列）：

```ts
interface WorkflowRunRecord {
  id: string; workflowName: string; status: WorkflowRunStatus; origin: WorkflowOrigin;
  scope: 'global' | 'project' | null; projectDir: string | null;
  parentSessionId: string | null; params: Record<string, unknown>;
  artifacts: WorkflowArtifactRef[]; summary: string | null;
  spentTokens: number | null; createdAt: number; updatedAt: number; finishedAt: number | null;
}
interface WorkflowArtifactRef {
  id: string; name: string; contentType: string; bytes: number; relPath: string;
}
```

### 5.2 HTTP（renderer / main ↔ agent server）

| Method | Path | 谁调 | 说明 |
|---|---|---|---|
| POST | `/workflow-runtime/trigger` | main | body `{name, params, projectDir, scope}` → `201 {runId}`；建行、spawn、等 `ready`；失败即收敛成 failed |
| GET | `/workflow-runtime/:runId/events` | **renderer 直连** | SSE；`?afterSeq=` 起播；帧 `{frame:'record'\|'permission'\|'done', seq, record?, summary?, request?}`；15s 心跳沿用现有写法 |
| POST | `/workflow-runtime/:runId/cancel` | main | 等价 `kill(runId)` |
| GET | `/workflow-runtime/runs` | main | 只为 e2e/调试，不影响 UI 路径 |

**沿用** `/workflow/:name/trigger`（session 锚）不动。

### 5.3 子进程帧（child ⇄ main）

```ts
// child → main
{ type:'workflow:ready', runId, definition, args, missingArgs?: string[] }
{ type:'workflow:launch-failed', runId, error }
{ type:'workflow:run-event', runId, seq, record: JournalRecord, summary: RunSummary }
{ type:'workflow:permission-request', runId, requestId, toolName, toolInput, expiresAt }
{ type:'workflow:publish-artifact', runId, name, contentType, bytes, relPath }
{ type:'workflow:finished', runId, status, summary, artifacts, spentTokens }
// main → child
{ type:'workflow:init', runId, workflowName, params, projectDir, scope, llm, workingDirectory, artifactsDir }
{ type:'workflow:permission-resolve', requestId, decision }
{ type:'workflow:cancel', runId }
```

`workflow:ready` 既是就绪握手也是**唯一解析点**（D3）：main 用它存快照。
`missingArgs` 非空 → main 直接把行收敛成 `failed`，不执行脚本。

## 6. 事件与渲染契约

### 6.1 补齐两处唯一缺口

`JournalRecord`（`packages/agent/src/modes/workflow/journal.ts:28-62`）已含
`nodeKind/action/exitCode/durationMs/outputSize/childSessionId/usage/verification` ——
截图上除了**命令原文**和**重放标记**，全都有。因此只加两个 display-only 字段：

```ts
/** 显示用输入摘要（如 `git tag --list v*`）；截断到 200 字符。绝不进 reqHash。 */
inputSummary?: string;
/** journal 缓存命中（本次没真跑）。 */
replayed?: boolean;
```

写入点：`runtime.ts` 的 `cachedCall`（命中分支 `:261` 设 `replayed:true`；
未命中分支 `:266` 填入 `inputSummary`，由各原语传入）。字段注释必须沿用
`journal.ts:48-51` 的措辞：**display/audit only — NEVER part of the reqHash payload**。

### 6.2 新增第 9 个原语 `wf.phase(name)`

- `runtime.ts` 的 `DwfApi` 加 `phase(name: string)` → `journal.append({ kind:'phase',
  nodeId: callNodeId(callSeq++, name), attempt:1, status:'running', action:name,
  nodeKind:'noop', atMs })`。`JournalKind` 已有 `'phase'`（`journal.ts:21`），无需扩枚举。
- 分组规则（渲染层）：按 `seq` 升序扫，遇到 `kind==='phase'` 起新阶段；
  其后所有记录归该阶段；首个 phase 之前的记录归隐式阶段「准备」。
- **必须同步的三处文档/提示词**（否则 planner 仍产 8 原语脚本）：
  `packages/agent/skills/.system/workflow/SKILL.md`（原语表 + 签名节）、
  同目录 `examples.md` / `patterns.md`、`packages/agent/src/modes/workflow/dwf/planner-dwf.ts`
  的 `PLANNER_DWF_SYSTEM_PROMPT`。
  ⚠️ SKILL.md 现文写「原语面只有八个」，改完逐处复核；该文件是打包分发的自包含文档，
  直接陈述事实即可，不写自我指涉的权威宣言。

### 6.3 SSE 帧与游标

```
id: <seq>              ← 渲染层记 lastSeq，重连带 Last-Event-ID 或 ?afterSeq
event: record          ← 每帧一条 JournalRecord 增量；summary 冗余携带全量头部
data: {"seq":42,"record":{…},"summary":{…}}
```

回放（历史 run）= 同一端点的 drain 模式：`workflow:get-events` 拉全量 + 可选接 SSE。
**live 与回放共用同一记录形状与渲染代码**（ZCode 这点是对的，别再分叉）。

## 7. UI 规格（对齐 ZCode 截图）

### 7.1 展示原语抽取（复用优先）

从 `src/components/workflow/WorkflowRunCard.tsx` 抽出到
`src/components/workflow/run-display/`（会话内卡片与新面板共用，**行为不变**）：
`useCountUp`(`:43`)、`formatCompact`(`:75`)、`formatDuration`(`:90`)、
`GridCell`(`:99`)、`RunSteps`(`:119`)。新面板再补：`RunStatusPill`、
`PhaseList`、`StepRow`、`ArtifactTile`。

### 7.2 面板结构（对齐截图 2 = ZCode `WorkflowRunSidePane`）

```
┌ 头部：● + `wfrun-<runId>`（mono，截断，点击复制）· 状态徽章 · [停止运行]（仅 running）
├ 元信息：N 个子代理 · M/K 步 · tokens · N 个产物      ← 血缘「调整自 run xxx」v1 不渲染
├ 结果：一句话结论（成功/失败/取消 + summary）
├ 阶段列表：每行 = 状态点 + 阶段名 + [泳道图标 + done/total]×泳道 + chevron
│   running 阶段自动展开
├ 阶段展开 → 步骤行（对齐截图 1）：
│    行1：kind 图标 + `已执行 <inputSummary>` / `读取 <file>` + 右侧 `+相对时间`
│    行2：`退出码 0 · 0ms · 371 B · [重放]`
│    行3：输出块，默认折叠为**末 3 行**，点击展开全文
└ 产物区：`产物 N` + 瓦片（图标/缩略 + 名称 + contentType 徽章 + 大小）
      点击 → 走既有文件预览事件开侧栏（不改产物查看器）
```

- **泳道**取 `nodeKind`（`tool`→终端图标、`agent`→actor 头像、`decision`→决策图标…），
  `fraction = 该阶段该泳道内 succeeded / 总数`。
- 「重放」＝ `record.replayed === true` 徽章，**不是**重跑按钮（ZCode 亦然）；
  重跑是头部独立按钮，v1 不做（属 resume）。
- 展开态记忆：模块级 Map（对齐 ZCode `workflowLogbook` 的做法），别放组件 state。

### 7.3 状态映射（15 值 → UI 6 态）

| UI | WorkflowRunStatus |
|---|---|
| 运行中 | `inactive`(启动瞬间) `planning` `awaiting_confirm` `active` `verifying` |
| 已暂停 | `user_paused` `backoff_paused` `no_progress_paused` `infra_paused` `blocked` `budget_limited` |
| 已完成 | `complete` |
| 已失败 | `failed` |
| 已取消 | `cancelled` |
| 已中断 | `interrupted` |

映射放纯函数 + 单测（`src/components/workflow/run-display/run-status.ts`）。
**颜色**：运行中用 warning（不是 accent）、成功用 success、失败/取消用 danger ——
与 ZCode 的选择一致，duya 的语义 token 已具备。

### 7.4 打开与去重（遵循仓库面板约定）

- 新 page id `workflow-run`，注册进 `src/components/layout/panels/registry.ts` 的
  `PageId`（现为 `:38`）。
- 打开走 `usePanel.openOrActivatePage`，`dedupKey = workflow-run::<runId>`；
  程序化打开用 window 事件 `duya:open-workflow-run-panel {runId}`（与
  `duya:open-review-panel` 同构）。
- 从 runs tab 行点击 → 派发事件；**复用 tab 不更新 params 时靠事件二次定位**
  （仓库已知约定）。

### 7.5 启动弹窗（目录 + 参数值）

**已有实物，不用新建**：`WorkflowLaunchDialog`（`src/components/layout/panels/WorkflowPanel.tsx:593-751`）
已经实现了「选目录 + 覆盖参数」两件事，只是它现在**只挂在 `DefinitionCard` 上**，而且走的是
session 锚（`api().run()`）。library 卡片（`WorkflowLibraryView.tsx:292`）与详情页
（`WorkflowDetailView.tsx:622` `handleRun`）都是**直接触发、没有弹窗**。所以这里的工作是
「抽出来 + 多挂两个入口 + 换锚」，不是造 UI。

| 项 | 落法 |
|---|---|
| 位置 | 抽到 `src/components/workflow/WorkflowLaunchDialog.tsx`；`WorkflowPanel` 改为引用它。**保留现有 testid（`workflow-launch-*`）与 i18n key（`panel.workflow.launch*`）**，使现有测试不红 |
| 入口 | 三个：library 卡片 ▶、详情页 ▶、`DefinitionCard` ▶。后两者现在都没有弹窗，改为先开弹窗 |
| 目录 | 复用现有 `projectDir` 字段，**语义明确为「本次 run 的工作目录」**：它既是 `wf.tool` 的 cwd，也是 `wf.agent` 子代理的 `workingDirectory`（`workflow-runner.ts:189` 的既有用法）。v1 保持文本框（`defaultProjectDir` 预填），不接 folder picker |
| 目录必填 | 保持现有硬校验（空目录报 `panel.workflow.launchProject`）。run 锚下这不是可选项——agent 节点没有 workingDirectory 就没有意义 |
| 参数 | 保持现有能力与语义：**留空 = 用 frontmatter 声明的默认值**（缺省值在 child 侧 `applyArgDefaults` 生效，`workflow-runner.ts:317`）。类型转换/JSON 校验/required 校验全部不动 |
| 提交 | `api().run(...)` → `api().trigger({name, params, projectDir, scope})`；成功后**派发 `duya:open-workflow-run-panel {runId}`** 并关闭弹窗（现在只是 `onLaunched()` + `onClose()`） |
| 产物提示 | 弹窗底部一行小字写明产物落盘位置 `~/.duya/workflow-artifacts/<runId>/`（runId 触发后才存在，写成模板即可） |
| 不做的 | 不选 scope（由 definition 解析）、不选 LLM、不做排队/并发覆盖（并发上限是全局的，见 D8） |

## 8. Phases（可执行清单）

### Phase 1 — 数据层（无 UI，可独立验收）✅ 2026-09-22 完成

- [x] `workflow-store.ts`：`WorkflowRun` 类型加 8 个新列 + `rowToRun` 映射
- [x] migration **30**：扩列 + `workflow_run_events` 表 + 索引（§4.1）
- [x] migration **31**：journal 搬迁 + 快照去 `journal` 键（§4.2）
- [x] `createRun` 接受 `origin/scope/projectDir/parentSessionId`；`listRuns` 支持 `origin` 过滤
- [x] `appendJournalRecord` 改单条 INSERT；`loadJournal` 读事件表；
      `loadSnapshot` 保留 legacy `journal` 兜底
- [x] 新增 `listEvents(runId, afterSeq?)` / `getEventCount(runId)`
- [x] 单测：扩列往返、搬迁幂等（连跑两次）、`(run_id,seq)` 幂等、
      legacy 快照仍可读 journal、`listRuns` origin 过滤
- [x] 门禁：`electron/db/core/__tests__/workflow-store.test.ts` 20 例全绿；
      既有 `workflow-handlers.test.ts` / `workflow-runner.test.ts` 未回归（10 例全绿）；
      `tsc -p electron/tsconfig.json` 对本文件 0 错误

**落地时对计划的 4 处补强**（都属 Phase 1 语义，非范围扩张）：

1. **migration 30 加列前用 `PRAGMA table_info` 探列**。SQLite 没有
   `ADD COLUMN IF NOT EXISTS`，而 28/29 的注释显示本仓库踩过「重复 id / 部分执行」的坑
   → 探列后只补缺失列，避免开发库中止 `initCoreDatabase`。
2. **migration 30 追加 `UPDATE workflow_runs SET origin='session'`**。加列那一刻库里所有行
   都来自 session 锚（`workflow:run`），默认值 `'library'` 会把它们标错；加列后立刻改写一次，
   历史 run 的 origin 筛选才是真的。
3. **`saveSnapshot` 不丢 journal，改为「顺带 ingest」**。新契约下 blob 不存 journal，
   但直接丢弃会让未同步改造的调用方（`db-bridge.ts:2719` 转发 worker 的 `journal` 字段）
   静默丢数据。改为把传入的 records `INSERT OR REPLACE` 进事件表 → 语义等价、无静默丢失，
   blob 仍然干净。同时给了 `WorkflowRunSnapshotSaveInput`（`journal` 可选），新调用方不必再传。
4. **补 3 个方法**，都是新增列/新表的必要写读口：`finishRun()`（终态 + summary/artifacts/
   spent_tokens/finished_at 一次写，**未提供的字段不覆盖**）、`listActiveRunIds()`（reconcile 的
   活跃集）、`latestEventSeq()`（SSE `afterSeq` 的种子）。另 `deleteRun` 现在一并清事件表。

### Phase 2 — 独立进程与事件流 ✅ 2026-09-22 完成

- [x] `journal.ts`：加 `inputSummary` / `replayed`（display-only 注释照抄现有措辞）
- [x] `runtime.ts`：`cachedCall` 填两字段；`DwfApi` 加 `phase()`
- [x] `workflow-runner.ts`：把 `emit`/落库职责从 `workflowRunDb` 改为**注入的 transport**
      （`WorkflowRunnerTransport`：`createRun`/`saveSnapshot`/`appendJournal`/`finishRun`/`emit`；
      `deps.transport` 缺席时回落到 `legacyTransport(deps)` = 原 worker db 桥 + `chat:workflow_run`，
      session 锚行为逐字不变）
- [x] `agent-process-entry.ts`：新增 `role === 'workflow-runtime'` 分支——
      收 `workflow:init` → 解析 saved workflow → 发 `ready` → 执行 → 逐条发 `run-event`
      → 发 `finished` → 退出。**不初始化 db 桥**。实现落在新文件
      `packages/agent/src/process/workflow-runtime-child.ts`，entry 只加 9 行分派：
      该分支在 `parseStdin` 之前 `return`，避免与 chat 主循环抢 stdin。
- [x] `electron/agents/server/workflow-runtime-manager.ts`：spawn / ready 握手（超时分级
      `READY_TIMEOUT_MS=30s`）/ stdout 行解析 / kill / exit 处理 / 并发上限 3 / killAll。
      **按 runId 索引**（不是 sessionId）；复用 `createWorkerEnvironment` + 同一份
      `agent-process-entry.js`，只换 `DUYA_AGENT_ROLE=workflow-runtime` + `SESSION_ID=''`。
- [x] `router.ts`：4 个 `/workflow-runtime/*` 端点（`GET /runs`、`POST /trigger`、
      `POST /:runId/cancel`、`GET /:runId/events`）；SSE 支持 `?afterSeq` + 心跳；
      run 无 session 行可读模型，故 provider 由 `config:provider:getActive` 现解析（§5.2）
- [x] 单测：manager 握手成功/超时/崩溃；SSE 起播与补洞（`afterSeq` 语义）；
      cancel 的两段 kill；并发上限拒绝
- [x] 门禁：`tsc -p packages/agent` **0 错误**；`tsc -p electron/tsconfig.json` 对改动文件 0 错误
      （db-bridge 的 15 条报错全在 304-1816 行，属改动前基线；新代码在 2665+ 行零报错）。
      workflow 全量测试 **16 文件 / 256 例全绿**

**Phase 2 后半落地时对计划的补强**（新增，共 4 条）：

1. **SSE 必须先 `flushHeaders()`**。`res.writeHead()` 只写缓冲、不落线，而 run 在两步之间
   可能静默数分钟 —— 不刷新头部，附着上来的客户端在下一帧到达前**根本收不到响应**
   （`EventSource` 的 `open` 永不触发）。这是实测暴露的真 bug（路由单测以「等响应头死锁」
   的形式复现），静默流与补洞流两条路径都受影响。
2. **测试注入缝走 `forkChild`，不用 `vi.mock('child_process')`**。仓库 `test-setup.ts` 的
   `beforeEach clearAllMocks` / `afterEach restoreAllMocks` 会清掉模块 mock，导致
   `await import()` 拿到的还是真 `fork`。改为 `WorkflowRuntimeManagerDeps.forkChild` 可注入，
   环境构造与接线仍走真实路径 —— 比模块 mock 更稳，也比纯桩更接近生产。
3. **子进程侧只做「执行器 + 帧发射」**：transport 的 `createRun`/`saveSnapshot`/`emit`
   在 run 锚是 no-op，`appendJournal`/`finishRun` 转成 `workflow:run-event` / `workflow:finished`
   帧。落库、事件表、`done` 汇总是 main 的唯一职责（D3 得到代码级保证：child 单测断言
   「全程零数据库调用」）。
4. **`attach()` 返回 `null` = 该 run 不在本进程**，路由据此回落事件表补洞；`?afterSeq`
   是 journal 游标，两条路径共用同一帧契约（`record` / `artifact` / `permission` / `done`）。

**Phase 2 前半落地时对计划的补强**：

1. **`inputSummary` 由 payload 推导，不由各原语手传**。`summarizeCall(action, nodeKind, payload)`
   按 nodeKind 分派（tool 取 `input` 的最像命令的那个键、gui 出 `app: click som:3 +N`、
   agent/human 取 prompt、decision 出问题 id），保证「同一 payload → 同一摘要」，新增原语
   不必记得补字段。
2. **launch 目录真正成为 tools/sub-agents 的 workingDirectory**。`buildToolUseContext` 与
   `buildHostPorts` 新增 `cwd` 参数（= `req.projectDir ?? deps.workingDirectory`），
   `runTool`/`runAgent` 都改用它。此前 `wf.agent` 拿到的是 worker 默认目录，与 §7.5 的要求不符。
3. **`failFrame` 变成 async 且必须落终态**。原实现只在 `catch` 分支写 `updateStatus`，
   而 `not_found` / `missing args` / 建行失败三个早退分支只发帧不落库 —— run 锚下 main
   已先建好 `active` 行，这会让它永远挂在 `active`。现在 `failFrame` 内 `await finishRun`，
   与 `emit` 解耦（`emit` 在 run 锚是 no-op）。
4. **`legacyTransport.createRun` 强制 `origin='session'`**，不信任调用方传入值：
   该 transport 本身就是 session 锚；否则会落成 `library` 把两个锚混在一起。
5. **顺带补齐 db 桥面**：`workflowRun:create` 转发 `origin/scope/projectDir/parentSessionId`、
   `workflowRun:list` 支持 `origin` 过滤、新增 `workflowRun:finish` / `latestEventSeq` /
   `listEvents`。db-bridge 与 db-client 两侧同步。

### Phase 3 — IPC 与编排接线 ✅ 2026-09-22 完成

- [x] `workflow-handlers.ts`：`workflow:trigger` / `status` / `list-runs` / `get-events` /
      `permission-resolve`；`workflow:cancel` 按 `origin` 分派
- [x] `preload.ts` + `src/global.d.ts` + `src/lib/workflow-ipc.ts` 三处同步
      （**实测只需两处**：`global.d.ts` 只是 `import type { ElectronAPI } from '../electron/preload'`
      的转发，没有自己的 workflow 区块，新增通道改 preload 即覆盖渲染层声明）
- [x] 启动弹窗按 §7.5 落地：抽到 `src/components/workflow/WorkflowLaunchDialog.tsx`（testid 与
      i18n key 不变）、library ▶ 与详情页 ▶ 补上弹窗入口、submit 从 `api().run()` 切到
      `api().trigger()`、成功后派发 `duya:open-workflow-run-panel {runId}`；
      工作目录字段语义写死为「run 工作目录 = agent 节点 workingDirectory」并在弹窗内提示产物路径
- [x] 启动时调 `reconcileStaleRuns()`（`main.ts` core 库初始化后，活跃集传空 `Set`——此刻
      本进程确无任何 run 在跑，RUNNING 类行一律陈旧）；app 退出时 `killAll()`（Phase 2 已接）
- [x] 单测：通道存在性 + payload 形状；cancel 两条路径分派
- [x] 门禁：`tsc --noEmit`（渲染层）与 `tsc -p electron/tsconfig.json` 对改动文件 **0 新增错误**

**Phase 3 落地时对计划的补强**（新增，共 4 条）：

1. **§5.2 的 HTTP 表漏了一条**。IPC 面有 `workflow:permission-resolve`、帧契约有
   `permission`，但 HTTP 只列了 4 个端点 —— 审批的**回程**没有通道。补 `POST
   /workflow-runtime/:runId/permission {requestId, decision}`，manager 侧同时补
   `resolvePermission()`（原本只把请求 publish 成 SSE 帧，没有任何回写路径，等于审批**只能超时**）。
   非显式 `allow` 一律按 `deny` 处理。
2. **`workflow:cancel` 保持同步返回形状的兼容**。session 锚路径仍返回 `{ok, reason}`
   （现有测试逐字断言），library 锚才返回 `{ok, error?}`；handler 变 async，
   `workflow-handlers.test.ts` 的 cancel 断言随之改 `.resolves`。
3. **`createRun` 的 `origin` 默认是 `library`**，所以「store 级 cancel」只对**显式盖了
   `origin:'session'`** 的行生效（`legacyTransport` 会盖）。测试里必须显式传 `origin:'session'`
   才能走到 store 分支 —— 这同时暴露了一个真问题：library 行**只有**进程能改终态，
   main 不得替它写 `cancelled`（已写成断言）。
4. **弹窗入口类型做成结构类型**。`DwfArgDeclaration`/`DwfWorkflowEntry` 在 `WorkflowPanel.tsx`
   与 `src/lib/workflow-ipc.ts` **各有一份**，且 `type` 一个必填一个可选，两个调用方互相
   不可赋值。弹窗声明自己的 `WorkflowLaunchDialogEntry`（字段全可选），顺便把
   `listDwfWorkflowsIPC` 的 `args?: unknown` 收紧成真实声明形状 —— 否则每个消费者都要先 cast。

### Phase 4 — 渲染层面板

- [ ] 抽 `src/components/workflow/run-display/`（§7.1），`WorkflowRunCard` 改为引用它，
      **其现有测试必须全绿不动**
- [ ] `run-status.ts` 映射 + 单测（15 值全覆盖，含未知值兜底）
- [ ] `WorkflowRunPanel.tsx`：头部/元信息/结果/阶段/步骤/产物（§7.2）
- [ ] runId 订阅：`src/stores/workflow-store.ts` 扩展为 runId-keyed（`useWorkflowRunById`），
      内部用 fetch 流式解析 SSE（复用 `agent-sse-client.ts` 的端口解析与重连语义）
- [ ] 漏帧合并：SSE + `get-events` 按 seq 去重（D5 的断言写成测试）
- [ ] 注册 page + `duya:open-workflow-run-panel` 事件 + dedupKey
- [ ] i18n（中/英）：面板标题、停止运行、结果、产物、退出码、重放、泳道名、空态
- [ ] 门禁：`check:design-tokens`(+compile)；Playwright 浅/深各一张截图 + 0 console error

#### 追记（2026-09-27）：运行历史与详情的主页面交互

按用户反馈，运行历史归属到 workflow 详情页：只列当前 workflow 的运行，使用精简列表；
点某一行进入主内容区的 run 详情页，展示节点流程，点节点后在下方显示该节点详情。
旧侧栏 `WorkflowPanel` 不再承载运行历史或详情，只保留迁移提示入口。

- [x] 当前 workflow 历史列表按名称、scope 和可用的 projectDir 过滤
- [x] 列表行打开独立 run 详情，支持节点选择及下方详情
- [x] 旧侧栏入口改为跳转主 workflow 页面

这次是 UI 原型；原 Phase 4 的 runId SSE 订阅、SSE 与事件补洞合并、设计 token 门禁及
截图验证仍未完成，不能据此把整个 Phase 4 标为完成。

#### 追记（2026-09-27）：节点卡片链接 UI 升级（已落地，未提交）

用户请求：run 卡片/证据行里的节点链接升级——agent 节点点击进入子会话 ChatView，
其余节点类型各有专属查看组件；样式沿用 duya 既有 UI。

- agent chip（带 `childSessionId`）与证据行子会话链接改为 `setActiveThread` 直达
  主列 ChatView（原 `duya:open-session-panel` 只读侧栏保留给 subagent 工具行/任务抽屉）
- 新增 `duya:open-workflow-node-panel` 事件（usePanel 开页 + WorkflowPanel 聚焦双层接线）
- 新增 `run-display/node-detail.tsx`：tool/agent/decision/human/gui/browser/noop
  每类一个查看组件；截图 ref 经 `workflow.artifactPath` → `duya-file://` 画廊 +
  `ImagePreview` lightbox（gui 走 `${nodeId}#step${i}` artifact 记录，browser 走
  `output.screenshots`）
- `WorkflowPanel` run 详情顶部渲染聚焦节点的专属查看器；证据行点击改为打开查看器
- 测试：`node-detail.test.tsx` 13 例新增；`workflow-run-card.test.tsx` 对齐新行为；
  workflow 簇 77/77 绿；`typecheck:web` 按文件过滤无本改动错误

### Phase 5 — `wf.agent`（Go/No-Go，可独立失败）

- [ ] **Spike（先做，跑不通即退 C）**：child 内搭最小子代理循环，跑一次带工具的
      子任务，回报 `usage{inputTokens,outputTokens}` + actor id
- [ ] 走 A：把 `runAgent` 绑到该循环，journal 记 `nodeKind:'agent'` + `usage`
      （于是「N 个子代理 · M tokens」有真数据）
- [ ] 退 C：`runAgent` 抛明确错误，journal 记 failed + `errorClass:'unsupported'`，
      面板在该步骤行显示「子代理暂不支持」——**不允许静默失败**

### Phase 6 — 文档与收尾

- [ ] `wf.phase` 原语同步三处：`SKILL.md` / `examples.md` / `patterns.md` + planner prompt
- [ ] `ARCHITECTURE.md`：新增 run 锚进程模型与事件流小节
- [ ] 修 `559-prompt-asset-cleanup.md` 的「deferred to plan 560」→ 指向新编号（§10）
- [ ] README 表格行更新（状态、描述）
- [ ] `LogComponent` 增 `Workflow` 项，替换现在借用 `LogComponent.Main` 的位置

## 9. Verification

1. **无 session 可跑**：删掉所有会话（或冷启动、零 worker）后从 Workflow 库点 ▶ Run，
   能跑完并出产物 —— 这是本计划的存在理由，必须真机验。
2. **进程独立**：任务管理器可见独立子进程；运行中杀掉它 → run 变 `failed` +
   面板显示错误 + 主进程不崩。
3. **实时性**：面板阶段/步骤随执行逐条出现（不是完成后一次性出现）；首帧延迟 < 1s（本地）。
4. **漏帧**：面板打开晚于 run 启动 → 记录集仍是连续前缀，无空洞无重复。
5. **回放**：任选历史 run，事件流与 live 时一致（同记录形状、同渲染）。
6. **停止**：运行中点「停止运行」→ 2s 内进程消失、状态 `cancelled`、UI 立即更新。
7. **产物**：`wf.publish` 产物出现在面板，点击可在预览面板打开；文件确实落在
   `~/.duya/workflow-artifacts/<runId>/`。
8. **审批**：带 `wf.approve` 的脚本在 run 锚下弹审批卡并能 allow/deny；
   超时按 deny 结算。
9. **并发**：第 4 个 run 触发时收到明确拒绝而不是静默排队。
10. **重启残留**：运行中强杀 app，重启后该 run 是 `interrupted` 而非永远 `active`。
11. **门禁**：`npm run typecheck:all` 通过；`npm run electron:build` 通过
    （bundle 边界变了：入口多一条 role 分支）。
12. **e2e**：`e2e/` 新增 workflow trigger smoke（当前 `e2e/` 无 workflow 覆盖）。

## 10. 依赖与序号

- 依赖已完成的：Plan 552（dwf 格式与引擎）、dwf Phase 0-4（runtime / store / planner / IPC）、
  已落地的 `workflow-runner.ts` 真实执行器。
- 迁移 id：**30**（扩列 + 事件表）、**31**（journal 搬迁）。后续如需更多取 32+。
- **编号归位**：`559` 把「prompt 目录改名（`basicPrompt.ts`→`basicPromptLoader.ts`、
  flatten `bot/memory/`、rename `modules/mappers/`）」deferred 给了 "plan 560"，
  但 560 已被本计划占用。该重构与本计划无关，需在下次触碰 prompts 目录时
  重新指派编号（建议 563+）或明确放弃。

## 11. 风险与已知边界

| # | 风险 | 缓解 |
|---|---|---|
| R1 | `agent-process-entry.ts` 对 sessionId 的硬依赖比预期深（init / 日志 / db 桥） | Phase 2 先做「最小可用分支」spike；牵扯过深则让 child 持一个 `ephemeral` 标识而非真实 session |
| R2 | 运行中崩溃/断电导致 journal 丢失 | 逐条落库（D3），最坏丢最后一条；`reconcileStaleRuns` 收敛状态 |
| R3 | SSE 与 `get-events` 双写竞态产生重复行 | 以 seq 幂等覆盖（D5），并写成测试而不是靠约定 |
| R4 | resume / 血缘做不了 | journal 缓存命中需要**同步** seed，而加载是异步的（`workflow-runner.ts:28-31` 已自陈）。v1 不做；`dedup_key` / `workflow_version_id` 列已在位 |
| R5 | 与并行会话冲突 | `router.ts` / `worker-manager.ts` / `WorkflowRunCard.tsx` 均是他人在制品 → 新增文件优先，改动集中在文件尾部追加；只 `git add <具体路径>` |
| R6 | `wf.phase` 是新原语，存量脚本没有阶段 | 存量脚本渲染成单个隐式阶段「准备」，不报错 |
| R7 | docs/exec-plans 整目录在 .gitignore | 提交计划文档要 `git add -f` |

## 12. 裁定结果（2026-09-22 已定，开工依据）

| # | 议题 | 裁定 |
|---|---|---|
| 1 | `wf.agent`（Phase 5）范围 | **按计划默认推进**：先 spike；跑不通退 C（显式报错 + journal 记 `errorClass:'unsupported'` + 步骤行显示「子代理暂不支持」），**不阻塞 Phase 1-4 交付**。Phase 5 真正开工时如 spike 结论有变再回头确认 |
| 2 | 产物落盘位置 | **`~/.duya/workflow-artifacts/<runId>/`**（按 run 分目录，便于整包删除）。这是仓库既有的 `~/.duya/` 家族约定，不是新发明。**并且：产物必须在最终 run 卡片里渲染**（§7.2 产物区，不是只落盘） |
| 3 | 并发上限 | **3**（`WorkflowRuntimeManager` 常量，不暴露 UI；超限 `workflow:trigger` 立即失败并回明确错误，见 D8） |
| 4 | 启动弹窗 | **新增需求**：触发前弹窗指定**工作目录 + 参数覆盖**。已实物存在（`WorkflowLaunchDialog`），按 §7.5 抽出来 + 补入口 + 换锚；工作目录即 agent 节点 workingDirectory |

## 13. 相邻缺口（核实过，但**不属本计划**）

三条都在同一批核查里落地成事实，为避免再查一遍记在这里。**都不在 560 的 In Scope**，
`gui` 节点更是 §2 Out of Scope 明确排除的。

### N1 — `wf.gui` 是硬失败桩，但执行器已经写好，缺的只是接线

- `runGui()`（`packages/agent/src/process/workflow-runner.ts:240-247`）无条件返回
  `{status:'failed', error:'gui runtime is not wired into the worker yet'}`；`runtime.ts` 见 failed
  即 throw → 含 `wf.gui` 的脚本在**第一次调用**就整轮失败。
- **执行器已实现**：`runGuiNode`（`packages/agent/src/modes/workflow/gui-runner.ts:153`）。
  缺的是 `GuiRunPorts`（`gui-runner.ts:107-111`：`backend: {step, capture}` + `artifacts` + 可选 `decide`）
  没被接到 `computer_use:execute` IPC 上。
- **接线前置条件只有一处**：`buildToolUseContext`（`workflow-runner.ts:152-181`）没有注入
  `ipcRequest`。而 entry 里已有现成的 `toolIpcRequest`（`agent-process-entry.ts:690`）并已注入
  `conductorIpc`（`:2830-2832`）→ 把 `ipcRequest` 顺着 deps 传进 `buildToolUseContext` 即可。
  **同一处修复顺手解决 `wf.tool('computer_use')` 的 `NO_IPC`**（`ComputerUseTool.ts:227-242`）。
- 环境限制（非代码问题）：`computer_use` 走 desktopCapturer + nut.js 坐标点击，需真实桌面会话与权限。
- **建议**：独立计划 `561`，两步走 —— **561a** 注入 `ipcRequest`（小、独立、可单独验收，顺带修
  `computer_use`）；**561b** `GuiBackendPort` 适配器 + `runGui` 接线。

### N2 — annotation 契约被教错，且没有任何校验兜底（静默丢弃）

- 真实契约 `RecorderNodeAnnotationSchema`（`packages/agent/src/modes/workflow/converter.ts:76-82`）要求
  `{ source:'recorder', app, windowTitle, som: { 'som:<n>': { ts, element, point?, clickCount?, paramHint? } } }`
  —— **`app` / `windowTitle` / 每个 ref 的 `ts` 与 `element` 都是必填**。
- 而 `PLANNER_DWF_SYSTEM_PROMPT`（`packages/agent/src/modes/workflow/dwf/planner-dwf.ts:81`）只教了
  `{source:'recorder', som:{'som:<n>': <element descriptor>}}` → 模型产出的 annotation 必然被
  `RecorderNodeAnnotationSchema.safeParse` fail-closed 成 `{}`（`gui-runner.ts:336-339`），
  som ref 静默退回「我自己上次 capture 的序号」语义。
- `validateSource`（`planner-dwf.ts:134-157`）只做 frontmatter 解析 + 编译两道门，**从不校验 annotation**
  → 模型得不到任何反馈。
- **修法三处**：① prompt 补全契约；② `validateSource` 增一道 annotation 校验并把错误回喂
  （**这才是关键**，只改 prompt 仍会漏）；③ `converter.ts` 自己产出 `app`/`windowTitle`
  （记录器本来就知道，不该让模型猜）。
- 附带：`on_stuck` 属 **gui spec**（`schema.ts:95-102`），写进 annotation 会被剥掉 → 该节点失去 skip 语义。
- **建议**：独立计划 `562`（小、收益直接：它卡着用户手上那个 `.dwf.ts` 能不能跑）。

### N3 — `wf.approve(timeoutHours)` 与审批通道的 5 分钟上限可能不一致（**待核**）

- `requestApproval` 的注释自陈「v1 cap: the pipeline's own 5-minute deny timeout applies」
  （`workflow-runner.ts:250-255`），而同处 `expiresAt` 用的是 `spec.timeoutMs ?? 300_000`。
  若脚本声明 `timeoutHours > 5min`，实际可能在 5 分钟就被判 deny。
- 未核实这一条，仅记为疑点；接线 Phase 2 的 run 级审批通道（D6 `requestApproval`）时必须一并裁定。
