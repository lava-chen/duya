> Historical / superseded for execution. 原位置：`docs/architecture/08-duplicate-implementation-adjudication.md`。
> 唯一执行入口：[587 主计划](../README.md)；设计冲突以 [00 合同](../00-contracts.md) 为准。旧 Status / checkbox / 行号保留为历史证据。

# 08 — 重复实现裁决：哪一套是活的，哪些可以删

> 目的：把"这里有重复"的直觉，变成"**这一份是死代码，那两份是不同 subject**"的可执行结论。
> 方法：对 5 组重复做**可达性追踪**（从运行时入口反向：boot / IPC handler / 用户动作 / agent run），
> 而不是数 import 次数。
> 基线：`master` @ `7c5bf050`，范围 `src/` `electron/` `packages/`（排除 `node_modules`/`dist`/`bundle`）。
> **本轮为静态分析，未执行任何代码、未修改任何文件。**

> ⚠️ **路径基准**：本文全部 `electron/` `src/` 前缀写在 M7 搬迁**之前**的布局上。
> 基线 `7c5bf050` 早于搬迁 commit `ce9366c9`（PR #115），两者相距 29 个提交。
> 读本文时请按此映射换算，**结论（谁活谁死）不受影响**：
>
> | 本文写法 | 搬迁后 |
> |---|---|
> | `electron/**` | `apps/desktop/src/main/**` |
> | `electron/preload.ts` | `apps/desktop/src/preload/index.ts` |
> | `electron/main.ts` | `apps/desktop/src/main/index.ts` |
> | `src/**`（渲染层） | `apps/desktop/src/renderer/**` |
> | `packages/**` | 不变 |

---

## 0. 总裁决表

| 组 | 实现 | 裁决 | 可删？ |
|---|---|---|---|
| 1 Task | `electron/db/core/stores.ts` TaskStore（core.db） | **LIVE** | ❌ |
| 1 Task | `schema.ts:163` main.db `tasks` | **DEAD** | ✅ 需 migration |
| 1 Task | `session/task-store.ts`（IPC task store） | **LIVE** | ❌ |
| 1 Task | `lifecycle/TaskState.ts` + `BackgroundAgentLifecycle` | **LIVE**（内存） | ❌ |
| 1 Task | `session/bash-task-store.ts`（JSON） | **LIVE** | ❌ |
| 2 Automation | `cron-file.ts` + `Scheduler.ts` | **LIVE** | ❌ |
| 2 Automation | `modes/workflow/workflow-files.ts` | **LIVE** | ❌ |
| 2 Automation | `modes/workflow/trigger.ts` | **TEST-ONLY** | ✅ |
| 3 Permission | `electron/lib/permission-profile.ts`（`isValidProfile`、`settingsModeToProfile`） | **LIVE（部分）** | ⚠️ 部分 |
| 3 Permission | 同上文件（`profileToAgentMode`、`VALID_*`、`isValidAgentMode`） | **DEAD 子集** | ✅ |
| 3 Permission | `src/lib/permission-profile.ts`（第 5 份，此前未列出） | **TEST-ONLY** | ✅ + 删测试 |
| 3 Permission | `process/permission-profile-bridge.ts` | **LIVE** | ❌ |
| 3 Permission | `session/permission-resolver.ts` | **DEAD** | ✅ |
| 3 Permission | `permissions/policy.ts` `PERMISSION_MODE_CONFIG` | **LIVE**（内部） | ❌ |
| 4 Paths | `tool/allowedRoots.ts` `isPathWithinRoots` | **LIVE** | ❌ |
| 4 Paths | `policy.ts` `isPathInWorkspace` / `isToolWithinWorkspace` / `isWorkspaceEscapingCommand` | **LIVE** | ❌ |
| 4 Paths | `rules.ts` `additionalDirectories` + `DuyaAgent.ts:868` | **LIVE**（上游 root 构造器） | ❌ |
| 4 Paths | `memory-state/outbox.ts` `assertSafe` | **LIVE，不在工具路径上** | ❌ 非重复 |
| 4 Paths | `sandbox/docker-sandbox.ts`、`bubblewrap-sandbox.ts` | **LIVE，条件加载** | ❌ 非重复 |
| 5 Legacy | `db/core/legacy-import.ts` | **DEAD（但是复活舱）** | ⚠️ 见 §5 D1 |
| 5 Legacy | main.db `tasks` / `permission_requests` / `agent_mailbox` | **DEAD（仅死读者）** | ✅ 需 migration |
| 5 Legacy | `automation_cron_runs` / `_state` | **已被 migration 50 DROP** | 只剩 DDL 残留 |

---

## 1. Task 模型：四套不是四份重复，是**三个不同的 subject**

> **这是对 `MONOREPO_RFC.md` §1.6 的实质性修正。**
> 原文写"三套 Task 模型（同名不同命）"，实测是**四个实现、三个互不重叠的领域**。

| subject | 实现 | substrate | 谁在用 |
|---|---|---|---|
| **A. TODO 清单**（per session，持久） | `stores.ts` TaskStore | SQLite core.db | `TodoWrite` 工具 |
| **B. 后台 subagent 执行注册表** | `BackgroundAgentLifecycle` | 内存 `Map` + `AbortController` | `SubagentTool` / `GetTaskOutputTool` / `KillTaskTool` |
| **C. 后台 bash 命令** | `bash-task-store.ts` | JSON `~/.duya/bash-tasks/` | `bash-task-registry.ts` |

### 1.1 Subject A 的完整调用链（已逐跳验证）

```
TodoWrite 工具   (tool/builtin.ts:150 注册，exposure:'eager')
  → TodoTool.ts:102              getDatabaseTaskStore(sessionId)
  → task-store.ts:264            工厂 → USE_IPC_MODE=true → IPCTaskStore (:101)
  → ipc/db-client.ts:417-438     sendDbRequest('task:create' | 'task:claim' | …)
  → electron/agents/db-bridge.ts:1231   case 'task:claim'
  → getCoreStores().tasks.claim()       → duya-core.db
```

第二条入口通向同一个 core store：`electron/ipc/db-handlers.ts:1404-1466`
（`db:task:*`，经 `electron/preload.ts:2290-2293`）。

### 1.2 两处需要更正既有说法

**更正 1：`getAgentStatuses` 在 electron 里根本不存在。**
全仓 grep 只在 `task-store.ts:62,178,239` 和测试里命中；
electron 侧 `TaskStore` **没有**这个方法。
agent 是从 `listTasks()` 在客户端自算的（`task-store.ts:178-193`），
**且除测试外无任何调用者**。

**更正 2：`claim()` 传输可达，但工具从不调用。**
`db-bridge.ts:1231` 处理 `task:claim`，`IPCTaskStore.claimTask`（`task-store.ts:155`）也存在，
但在 `packages/agent/src`（排除 `__tests__`）里 grep
`claimTask|blockTask|unassignTeammateTasks` **只命中定义本身**。
`TodoTool` 实际调用的只有 `listTasks` / `getTask` / `createTask` / `updateTask` / `deleteTask`
（`TodoTool.ts:103-144`）。

> **推断（中等置信度）**：block/claim 协议是为一个未启用的多 agent / teammate 功能建的。
> 它是**一条完整的、有测试、传输已接线的协议，却没有生产调用者**。

### 1.3 为什么 B 和 C 不能删

- **B（内存 Map）不是 SQLite store 的重复**，它是 **abort/notify 机制** ——
  SQLite 提供不了这个。`TaskRecord` 内嵌 `AbortController`（`TaskState.ts:21`）。
- **C（JSON 文件）同理**。`agent-process-entry.ts:79` 在 worker 启动时 rehydrate
  （`:197`），`managed-bash.ts:30` / `WorkerPool.ts:15` 每次调用都改。
- **`KillTaskTool.ts:84` 会同时对两个 registry 解析 id** ——
  删任何一个都会打断 `KillTaskTool`。

---

## 2. Automation：两套栈**都活着**，只有一个文件是死的

> **这是对 `MONOREPO_RFC.md` §1.7 的修正。** 原文称"两套完整栈"是"最尖锐的重复"，
> 实测两套都接入 boot 与用户路径，**唯一可删的是一个从未接线的文件**。

| | Stack A（Main） | Stack B（Worker） |
|---|---|---|
| 存储 | `~/.duya/cronjob.toml`（自称 single source of truth） | `~/.duya/workflows/` YAML registry |
| **活的入口** | `electron/main.ts:567 initAutomationScheduler()`，`:568 initRoutineListenerHub(...)`；`graceful-shutdown.ts:114` 拆除 | `src/components/workflow/WorkflowRunCard.tsx:182` → `src/lib/workflow-ipc.ts:255` → `preload.ts:2453` → `workflow-handlers.ts:430` `POST /workflow/:name/trigger` → `router.ts:2991` |
| 其他消费面 | IPC `db-handlers.ts:1472-1587`、CLI `cli/handlers/crons.ts:446-546`、wake bus `wake-dispatcher.ts:374-376` | `workflow-handlers.ts:205,227,252,266,281`（library/detail/save） |
| **死文件** | — | **`modes/workflow/trigger.ts`** |

### 2.1 `trigger.ts` 是死的 —— 已复核

对它的四个导出 `launchFromTrigger` / `channelAllowed` / `buildDedupKey` / `normalizeCronInstant`
做全仓 grep，**只命中两个文件**：`trigger.ts` 自身与 `modes/workflow/__tests__/trigger-files.test.ts`。

它被 barrel `modes/workflow/index.ts` 再导出，但**每一条运行时触发路径**
（`router.ts:2991`、`router.ts:3264`）都走 `workflow-runtime-manager.ts:261 trigger()`
或 session-worker dispatch。

它自己的头注释（`trigger.ts:4-8`）描述的是一个**从未被接线**的收敛设计。

> ⚠️ 这是全文**最高价值的删除候选**，它有 1 个 barrel 行 + 1 个测试文件要一起处理。

---

## 3. Permission profile：五份拷贝，而**默认值其实不冲突**

> **这是对既有说法的修正：分歧被夸大了。**
> 两个 resolver **都**默认 `'auto'`
> —— `electron/db/permission-resolver.ts:24` 与 `packages/agent/src/session/permission-resolver.ts:20`。
> `'default'` 不是竞争默认值，它是 `settingsModeToProfile`
> 对**非法存储值**的安全降级（`electron/lib/permission-profile.ts:29-35`）。

### 3.1 实际运行的链路

```
renderer 选模式 → ChatView.tsx:63-70（**它自己的本地映射，不是 src/lib/permission-profile.ts**）
  → 建 session  → db-handlers.ts:596   resolvePermissionProfile(...)  [electron/db/permission-resolver.ts:40]
  → 持久化到 core store (core-db-adapters.ts:257,278,335)
  → worker chat:start → agent-process-entry.ts:86  resolveChatStartAgentMode()
  → permission-profile-bridge.ts:48 → agent mode → setPermissionMode
```

即：**electron resolver 负责建 session，agent bridge 负责 worker 侧强制执行，
`policy.ts:PERMISSION_MODE_CONFIG` 提供模式规则集。设置界面两份共享文件都不用。**

### 3.2 可观察的分歧：今天不可达

唯一会忽略 `settings` 行的实现就是 agent 侧 resolver，而它**是死的**（§3.3）。
所以分歧存在但**不产生行为差异**。

**潜在风险**：`permission-resolver.ts:83-93` 从 duya-main.db 读 `settings.permissionMode`，
而**未找到任何生产写入方** —— 唯一的非测试写入是 `schema.ts:488` 的种子值 `'auto'`。
（**未确定**：该行可能通过某个未定位到的通用 settings IPC 路径写入。）

### 3.3 `session/permission-resolver.ts` 是死的 —— 已复核

```
session/db.ts:20    import { resolveAgentPermissionProfile } from './permission-resolver.js';
session/db.ts:190   /** ... 若不传, 由 resolveAgentPermissionProfile 解析. */   ← 仅注释
```

**import 了，从不调用。** 全仓仅 3 个文件命中该名字。
顺带一提，`:190` 的注释还记录了那个分歧
（"agent 端无 settings 表，普通 new 不传则落 'default'"）—— 正因为是死代码，它从未发生。

> ✅ **最安全的删除候选**：删 `permission-resolver.ts` 及其测试，
> 再删 `session/db.ts:20` 那行没用到的 import。

---

## 4. Path containment：一次 `Read` 跑三道检查，**五处没有一处是死代码**

一次普通 `Read` 实际执行：

| # | 位置 | 强度 | 作用 |
|---|---|---|---|
| 1 | `permissions.ts:601` `isToolWithinWorkspace` | 词法 | 权限闸门：要不要问用户 |
| 2 | `policy.ts:600` `isPathInWorkspace` | 词法 | 规则求值 |
| 3 | `ReadTool.ts:285` `isPathWithinRoots` | **realpath + symlink 解析** | **安全边界** |

**前两个比第三个弱是刻意的** —— 第三个才是安全边界，
前两个只决定"要不要弹窗"。**把三者合并会改变权限提示 UX，不只是减少代码量。**

不在 Read 路径上的：

- `isWorkspaceEscapingCommand`（`permissions.ts:790`）—— **仅 Bash**
- `DuyaAgent.ts:868-872` —— **上游 root 集合构造器**，喂给 `toolPermissionContext`，不是检查
- `outbox.ts:127 assertSafe` —— 只从 `outbox.ts:255`（memory-outbox replay）到达
- sandbox 模块 —— `agent-process-entry.ts:1879-1883` **条件加载**
  （`if (sandboxEnabled !== false)`），管 Bash/网络，不管文件包含性

> **结论：五处全部 LIVE，没有一处是另一处的真重复。**
> 它们是分层的，威胁模型不同（词法提示注入防护 vs realpath 逃逸防护）。
> **"5 处 path containment 重复"这个诊断是错的。**

---

## 5. 遗留表：读者本身是死的，但它们是复活舱

### 5.1 `legacy-import.ts` 未在 boot 时被调用

**证据（缺失即证明）**：grep `legacy-import|runLegacyImport|importLegacy`
只命中 `electron/db/core/index.ts:14`（barrel 再导出）、文件自身注释、以及测试。
grep 四个导出（`openLegacyReadonly` / `readLegacyRows` / `legacyRowToNewEvent` / `sortSessionMessages`）
只命中定义 + 测试。
grep **`LegacyImporter`**（构造函数在 `:409`、`run()` 在 `:428` 的那个类）——
**全仓零命中，连测试都没有**（测试直接构造零件）。

因此 main.db `tasks`（`legacy-import.ts:232`）、`permission_requests`（`:233`）、
`agent_mailbox`（`:231`）的**唯一读者是不可达的**。

### 5.2 cron 表是特例

migration 50 `drop_automation_cron_tables` **已经 DROP 了这两张表**（`schema.ts:2476-2479`）。
所以 `schema.ts:1225` 的 CREATE 和 migration 48（`:2406-2419`）
**是残留 —— 在每一个全新 DB 上被创建然后被删掉。**

---

## 6. 删除清单（按安全度排序）

| # | 删除对象 | 前置 | 验证方式 |
|---|---|---|---|
| **1** | `packages/agent/src/session/permission-resolver.ts` + 其测试 | 同时删 `session/db.ts:20` 的无用 import | `npm run typecheck:all` |
| **2** | `modes/workflow/trigger.ts` + `modes/workflow/index.ts` 的 barrel 行 + `__tests__/trigger-files.test.ts` | — | `npm run bundle:agent` + `npm run typecheck:all`；**在真实 Electron renderer 里手动跑一次 workflow 启动**（依 AGENTS.md，纯 Vite 浏览器无法验证 preload 路径） |
| **3** | `src/lib/permission-profile.ts` + `src/lib/__tests__/permission-profile.contract.test.ts` | 先确认 `ChatView.tsx:60-70` 是唯一在用的映射 | `npm run typecheck:web` |
| **4** | `electron/lib/permission-profile.ts` 的死子集：`profileToAgentMode`、`isValidAgentMode`、`VALID_PROFILES`、`VALID_AGENT_MODES` | **必须与 #3 同做**（否则 #3 的 contract test 会 import 到已删模块而 CI 失败）。保留 `PermissionProfile`（`db-bridge.ts:33` 在用）、`isValidProfile`、`settingsModeToProfile` | `npm run typecheck:all` |
| **5** | main.db 的 `tasks`（+ `permission_requests`、`agent_mailbox`）DDL | **不是纯删除**：需要一条新的 additive migration 做 `DROP TABLE`，并移除 `schema.ts:163-178` 的 CREATE | 用真实用户 DB 的迁移副本启动，确认无 `SqliteError`、`app.log` 无 WARN。**必须在 #6 之后** |
| **6** | `electron/db/core/legacy-import.ts` + `index.ts:14` 的导出 + 其测试 | 需产品确认（见 §7 D1） | 确认导入功能已对装机用户成功运行过 |

---

## 7. 删除阻塞：看着像死代码但其实不是

**D1. `legacy-import.ts` 是复活舱，不是死代码。**
它是**唯一**能读取 plan-328 之前用户数据的组件。
在导入功能**已被证明对装机用户跑通**之前删掉它，
等于**断掉那些跨越该升级边界的用户的恢复路径**。
类虽未接线，但**意图有文档**：`docs/exec-plans/active/329-core-db-legacy-import.md`
（依 `legacy-import.ts:21` 的头部注释）。**先确认该 plan 是否已关闭。**

**D2. `TaskStore.claim()` / `block()` / `unassignTeammate()` 有完整、已测试、已接线的路径，却没有生产调用者。**
有人是**刻意**实现了 blocked-rejection 语义的。
删掉它们等于删掉一个"离启用只差一个开关"的功能 —— 而保留它们很便宜。

**D3. `BackgroundAgentLifecycle` 与 `bash-task-store` 看起来是 SQLite store 的内存/JSON 双胞胎，但不是。**
删任何一个都会打断 `KillTaskTool`（`KillTaskTool.ts:84` 对两个 registry 解析 id）。

**D4. `src/lib/permission-profile.ts` 被一个 contract test 守着**，
而那个 test 存在的唯一目的就是让它与 electron 那份保持同步。
**副本删了，test 必须一起删**，否则 CI 会因为 import 一个已删模块而失败。

**D5. `policy.ts` 的 path 函数看起来相对 `allowedRoots.ts` 是词法冗余**，
但它们实现的是**不同的结果**（问用户 vs 拒绝），且基于**更弱的比较**。
合并它们改的是权限提示 UX，不只是代码量。

**D6. migration 48 创建了一张 migration 50 会 DROP 的表。**
删 migration 48 而不检查 migration 顺序与 `schema_version` 高水位，
会让已有数据库重跑或跳过 migration。

---

## 8. 未确定事项

- **`settings.permissionMode` 这一行在生产里到底有没有被写入？**
  找到了种子（`schema.ts:488`）与测试写入方，**没找到 UI 或 IPC 路径**。
  如果存在一个我 grep 模式之外的通用 `settings:set` handler，
  那 electron resolver 的 settings 分支是活的，
  而 agent resolver **缺少**该分支就是一次真实的（虽然目前不可达的）分歧。
- **`TaskStore.claim` 没有调用者是刻意的吗？** ——
  追踪路径上没有任何 plan 文件或注释说明。
- **`packages/agent/src/hooks/task-registry.ts` 是不是活的第四份？**
  它的头部（`task-registry.ts:4`）说自己 "Mirrors BashTaskRegistry … but is scoped to" 某物；
  **我没有追踪它的消费者**。它没有出现在我建的任何 import 图里，
  **可能是一份真正的重复，值得后续单独查。**
- **运行时确认。** 以上全部是静态分析，**没有 boot、没有跑 agent、没有执行测试**。
  最值得做一次活体检查的是 #1（那个没用到的 `resolveAgentPermissionProfile` import）——
  它是价值最高的删除，而依据只是一次 grep。
  （**已交叉复核**：我独立跑了同样的 grep，`packages/agent/src` 内确实只有 3 个文件命中。✅）
