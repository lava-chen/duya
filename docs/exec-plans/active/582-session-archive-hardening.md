# 582 — Session 归档加固（归档轮转历史断裂 / 生命周期安全 / 排序语义 / 归档视图交互）

> **Status**: Draft · **Priority**: P0 · **Owner**: TBD
> **立项**: 2026-10-01（对标 `docs/references/codex-thread-and-worktree-management.md` 的 codex thread 管理调研）
> **前置**: Plan 549（归档对齐 codex）**已于 2026-09-19 经 PR #56 落地**（commit `9b1b1fe4`），Track A/B/C/D 全部实现。本 plan **不重做 549**，只补它留下的正确性缺口。
> **分界**: 存储与生命周期（G1–G4）见 §2–§5；UI 轨（G5–G9）见 §6。

---

## 0. 一句话目标

修掉 Plan 549 落地后遗留的缺陷：三个会导致**用户数据不可见或归档语义被绕过**的正确性问题（G1–G3）、一个排序语义问题（G4），以及归档视图上的**四个 UI bug 与三个空缺交互**（G5–G9）。

---

## 1. 背景：549 做完了"物理动作"，没做"状态机"

codex 的归档之所以复杂（`thread-store/src/local/archive_thread.rs`），是因为它要在**多进程、活跃 turn、派生树、轮转 rollout** 四个约束下安全地移动文件。duya 是单进程 Electron，砍掉了多进程问题，但**轮转 rollout** 这个约束 549 没有处理。

### 1.1 duya 已有的（549 成果，不再重做）

| 能力 | 位置 |
|---|---|
| 物理 `fs.renameSync` 归档 | `electron/ipc/db-handlers.ts:582` |
| `archivedAt` / `archivedPath` 字段 | migration id=26 |
| 反归档 | `db-handlers.ts:605` |
| 归档列表 IPC | `db-handlers.ts:658` |
| Windows 独占锁预检 | `db-handlers.ts:562-578` |
| 路径规则 | `electron/db/core/archive-paths.ts` |
| 侧栏归档分区 + 反归档菜单 + 归档时间副行 | `app-sidebar.tsx:968`、`ThreadListItem.tsx:177-190,315-316` |
| JSONL 权威 + SQLite 可重建投影 | `message-log.ts:16-20,1739` |

### 1.2 缺口一句话

| 缺口 | 轨道 | 一句话 |
|---|---|---|
| **G1** | 存储 | 归档只搬 `active.jsonl`，**同目录的 `archive-<g>.jsonl` 兄弟文件被遗弃** → 轮转过的 session 归档后历史静默截断 |
| **G2** | 存储 | 归档**不摘除活跃 turn**、**不递归子 session** → turn 执行中归档会导致写入分裂 |
| **G3** | 存储 | 归档的 session **可以被 fork / resume** → 静默取消归档 |
| **G4** | 存储 | 只有 `updated_at` 单排序键，归档**自身会污染排序位置** |
| **G5** | UI | 点归档行**把归档会话永久注入活跃列表**（pending 合并逻辑把它当"待同步线程"保住） |
| **G6** | UI | 归档视图**只读预览 / 批量操作 / 撤销**三个核心交互全空 |
| **G7** | UI | 归档行上的 **rename / pin / delete 是空操作**（只 map `threads[]`，不 map `archivedThreads[]`） |
| **G8** | UI | 归档区不排序、项目组内无视 `projectSortBy`、**展示了不存在的快捷键** |
| **G9** | UI | 归档/删除无确认，且级联文案需按 duya 真实语义（软删除、不级联）重写 |

---

## 2. G1【P0 数据不可见】归档轮转 session 会静默截断历史

### 2.1 复现路径

duya 的 rollout 有三种布局（`message-log.ts:2057-2093`）：

```
① 单文件（普通 session，< 4MB）
   sessions/YYYY/MM/DD/rollout-<stamp>-<sessionId>.jsonl
② 多代（bot session，或普通 session 超过 NON_BOT_ROTATION_THRESHOLD_BYTES）
   <sessionDir>/active.jsonl  +  <sessionDir>/archive-<g>.jsonl ...
③ 归档后
   archived/YYYY-MM-DD/<原 basename>
```

`NON_BOT_ROTATION_THRESHOLD_BYTES = 4 * 1024 * 1024`（`message-log.ts:114`）。**任何聊过 4MB 的 session 都会自动进入布局 ②。**

归档 handler 只搬一个文件（`db-handlers.ts:551-582`）：

```ts
const archivedRel = resolveArchivedPath(currentRel, now);   // ← 只取 basename
const archivedAbs = path.join(rolloutRoot, archivedRel);
fs.mkdirSync(path.dirname(archivedAbs), { recursive: true });
fs.renameSync(srcAbs, archivedAbs);                         // ← 只有一个文件
```

`resolveArchivedPath` 的实现（`archive-paths.ts:48`）：

```ts
return path.posix.join('archived', bucket, path.posix.basename(currentRel));
```

**`path.posix.basename` 丢掉了 session 私有目录**，于是：

- `sessions/2026/09/18/s-abc/active.jsonl` → `archived/2026-09-18/active.jsonl`
- `sessions/2026/09/18/s-abc/archive-0.jsonl` → **留在原地，成为孤儿**

### 2.2 为什么这会"静默"丢历史

`rollout_path` 被更新为 `archived/2026-09-18/active.jsonl`。读取时（`message-log.ts:685-691`）：

```ts
if (path.basename(relativePath) === 'active.jsonl') {
  return this.listBySessionMultiFile(sessionId, path.dirname(absolutePath), options);
}
```

`path.dirname` = `archived/2026-09-18/`，而 `collectSessionGenerationFiles`（`message-log.ts:1076-1111`）在这个目录下**找不到任何 `archive-<g>.jsonl`**，只收集到 `active.jsonl`。

`message_index` 里指向旧分段的行，其 `file_offset/byte_len` 找不到宿主文件 → 按 `message-log.ts:805-806` 的设计：

> Missing files are logged at WARN and the rows are skipped — the projection layer never DELETEs so a future …

**即：只打一条 WARN，然后跳过这些行。** 用户看到的是"归档后这个会话只剩最近一段对话"，没有任何错误提示。

### 2.3 附带缺陷

- **bot session 撞名**：所有 bot session 的活跃文件都叫 `active.jsonl`（`message-log.ts:2060`）。同一天归档两个 bot session → 目标路径都是 `archived/<date>/active.jsonl`，第二次 rename 要么覆盖（POSIX）要么报错（Windows），取决于平台 —— **跨平台行为不一致**。
- **反归档路径错位**：`resolveUnarchivedPath`（`archive-paths.ts:52-60`）返回 `sessions/active.jsonl`，既不是原来的 `sessions/YYYY/MM/DD/<sanitized-id>/`，也不是活跃布局的日期树。解档后 session 指向一个语义错误的位置。
- **零测试覆盖**：`electron/ipc/__tests__/db-handlers.test.ts:962-999` 的归档测试全部 mock `mocks.stores`，不触碰真实 `fs`，且只覆盖"无 rolloutPath"和"已归档幂等"两条 happy path。`message-log-rotation.test.ts` 里**没有任何 archive 用例**。

### 2.4 修复方向

**归档单位从"单文件"改为"session 目录"**（对布局 ②）或"整组文件"（对布局 ①）：

1. 新增 `collectSessionRolloutFiles(sessionId)` —— 复用已有的 `collectSessionGenerationFiles`（`message-log.ts:1076`），对布局 ①返回单文件，对布局 ②返回全部 segment。
2. 归档目标路径携带 session 身份，消除撞名：
   `archived/<YYYY-MM-DD>/<sanitized-session-id>/<basename>`
   （保留 session 私有目录这一层，与活跃布局 `sessions/YYYY/MM/DD/<sanitized-id>/` 对称）
3. 反档案向原路径**逐文件**还原，而不是拍平成 `sessions/<basename>`。
4. `archivedPath` 存**目录**（相对 rollout root），不再是单文件路径 —— 需要评估 `db-handlers.ts:610` 的读路径。
5. 补测试：布局 ①/② 各自的归档→反档→读回全量历史往返断言。

---

## 3. G2【P0 数据分裂】归档不摘除活跃 turn、不递归子 session

### 3.1 现状

`db-handlers.ts:519-598` 只有一个 `fs.openSync` 独占锁**探针**（`:562-578`），**没有**任何"把 session 从活跃运行时摘掉、等 turn 收尾"的动作。子 agent session 完全不在归档范围内。

### 3.2 失败模式

turn 执行中归档时，Agent 进程的 `message:append` 会继续向已被 rename 的路径写。`getOrCreateRolloutPath` 缓存了旧路径（`message-log.ts:435` `pathCache`），写入落到**已不存在的旧路径**，`ensureFile`（`message-log.ts:2097-2103`）会**静默重建一个空文件**。turn 的输出被劈成两个文件。

### 3.3 codex 对照

`app-server/src/request_processors/thread_processor.rs:1773-1781` 在移动文件**之前**先对整棵子树逐个 `prepare_thread_for_archive()`，实现（`:1054-1080`）是：

```
remove_thread_from_active_table() → wait_for_thread_shutdown() (Complete/SubmitFailed/TimedOut) → finalize_teardown()
```

### 3.4 修复方向

**Phase 1（最小，立即）**：归档 preflight 拒绝。
- 用已有的 `LockStore`（`electron/db/core/stores.ts:428`）的 `session_runtime_locks`（migration id=7，带 `origin` 列 `user|agent|background`）。
- 若 `isLocked(sessionId)` 为真 → 整体拒绝归档，UI 弹 toast"会话正在运行，无法归档"。**不碰磁盘、不碰 SQL**，与现有 rename 失败路径（`:583-590`）一致。
- 同时失效 `message-log.ts:435` 的 `pathCache`。

**Phase 2**：递归子树。
- 用已有的 `SpawnEdgeStore.getTree(sessionId)`（`stores.ts:972`，递归 CTE 已就绪）。
- 语义：先算 `[sessionId, ...descendants]`，对**每个** id 走 Phase 1 的 preflight，**任一**在跑则整体失败（与 codex `archive_threads` 的"首个必须成功"批次语义一致）。
- **unarchive 不递归**（与 codex 一致，见参考文档 §1.3）。

**Phase 3**：两阶段提交 + 补偿回滚。
```
PHASE 1（不碰文件）：全部 id 的 preflight
PHASE 2: for (i, move of plan) { try { move } catch { restoreRolloutMoves(plan.slice(0,i)); return false } }
         try { sessions.update(...) } catch { restoreRolloutMoves(plan); return false }
```

`restoreRolloutMoves` 参照 codex `archive_thread.rs:114-140` 的 `restore_rollout_moves`。这是唯一一处"文件已动、SQL 未动"的状态分裂，且分裂后**无自愈路径**（`reconcileAll` 只报 `missingFiles`，不改指向）。

---

## 4. G3【P0 归档语义被绕过】归档的 session 可以被 fork / resume

### 4.1 现状（已自验）

`electron/db/core/session-fork.ts:208-211`：

```ts
const source = deps.sessions.get(input.sourceSessionId);
if (!source) {
  return { ok: false, reason: 'source_not_found', seedCount: 0 };
}
// ← 没有 status 检查
```

resume 路径同样无判断：`electron/agents/` 全目录 grep `archived` **零命中**。

### 4.2 为什么严重（不只是"应该拦"）

`message-log.ts:658-679` 的漂移恢复 `findRolloutFileBySessionId` 会把归档文件当"漂移文件"找回并 `adoptRolloutPath`（改写 `sessions.rollout_path` 指向归档路径）。fork 一次归档 session → 归档文件被**重新实体化**，等于静默取消归档。

### 4.3 codex 对照

commit `d944ce83a2`（2026-08-20）后，CLI 拦截并弹三选项提示（Unarchive / Cancel / Quit），挂在 `tui/src/app/startup.rs:573` 与 `:672` 两处 resume/fork 入口。

### 4.4 修复方向

1. `session-fork.ts:208` 之后加：`if (source.status === 'archived') return { ok: false, reason: 'archived', seedCount: 0 }`（需在 `ForkSessionResult` 的 reason 联合加变体，见 `session-fork.ts:188-190`）。
2. renderer 在 `src/stores/conversation-store.ts` 的 fork action 把该 reason 翻成"请先解档"提示。
3. resume 侧：在 `electron/agents/session-manager.ts` 加载 session 时检查 `status === 'archived'` 则拒绝启动。

---

## 5. G4【P1 排序语义】归档自身污染排序位置

### 5.1 现状（已自验）

`electron/db/core/session-store.ts:250-251`：

```ts
sets.push('updated_at = @updated_at');
params.updated_at = Date.now();
```

**每次 `update()` 无条件刷 `updated_at`**，而 `db:session:archive` 正是通过 `sessions.update()` 改 status（`db-handlers.ts:592-596`）。而 `list()`（`session-store.ts:288`）只有 `ORDER BY updated_at DESC` 一个排序键。

**后果**：解档后该 session 会因为"归档时刻"而不是"最后使用时刻"排在列表顶部。

### 5.2 codex 对照

`state/migrations/0039_threads_recency_at.sql` 引入 `recency_at` 双列。归档时 `state/src/runtime/threads.rs:929` 显式 `recency_at = threads.recency_at` —— **归档不改 recency**。`recency_at` 只在 turn 开始时推进。

### 5.3 修复方向

migration **id=34**（27 已被 workflow 占用，见 `workflow-store.ts:240-243`）：

1. 加 `recency_at INTEGER`（nullable，回填 = `updated_at`）
2. 加 `last_turn_started_at INTEGER`（nullable）。**数据源已经存在**：`rollout-events.ts:63-67` 的 `TurnStartedEvent { type:'turn_started', turnId, startedAt }`，只需在处理该行时落库
3. `update()` 的 recency 与 `updated_at` 解耦；归档路径显式不动 `recency_at`
4. 排序改 `ORDER BY recency_at DESC, id DESC`，`idx_sessions_updated` 换成 `(recency_at DESC, id DESC)` 复合索引
5. 回填一行 `UPDATE sessions SET recency_at = updated_at WHERE recency_at IS NULL`

**不需要** codex 那套递归 CTE 迁移（duya 建表即毫秒，无秒级历史数据，见参考文档 §2.3 说明）。

### 5.4 顺带修的排序 tiebreak

`list()`（`session-store.ts:288`）同毫秒并列时顺序不确定。`listSummaries()`（`:402`）已有 `, s.id DESC`。补齐即可。

---

## 6. UI 轨

> **达成度**：归档这条线约 codex TUI 的 60–70%。入口、状态视觉、批量原语、Toast 基础设施都齐了，但**归档视图的三个核心交互（预览 / 批量 / 撤销）全空**，且**归档行上的 rename / pin / delete / 点击 全是 bug**。
> 与 codex 的形态差异：duya 归档区是**并排常驻 section**（`app-sidebar.tsx:972-979`，`id: '__system__:archived'`，恒为数组最后一项，默认折叠），codex picker 是**互斥视图**（toolbar 切 Active/Archived）。**这是有意的产品形态差异，不改。**

### G5【P0 bug】点归档行会把归档会话永久注入活跃列表

**已自验。** 两处代码构成这个 bug：

1. `src/stores/conversation-store.ts:844-852` —— `setActiveThread` 发现 thread 不在 `threads[]` 里，走 `getThreadIPC(id)` 兜底并**把它塞进 `threads[]`**：
   ```ts
   set((state) => ({
     threads: [result.thread, ...state.threads.filter(t => t.id !== id)]
   }));
   ```
   `ThreadListItem.tsx:100-104` 的 `handleClick` 直接调 `setActiveThread`，**无任何 archived 分支判断**。

2. `src/stores/conversation-store.ts:1344-1347` —— `loadFromDatabase` 的 pending 合并把它**永久保住**：
   ```ts
   const dbThreadIds = new Set(filteredThreads.map(t => t.id));   // DB 列表排除 archived
   const pendingThreads = existingThreads.filter(t => !dbThreadIds.has(t.id));
   ```
   归档会话在 `existingThreads` 里但不在 `dbThreadIds` 里 → 被当作"尚未同步的本地线程"保留。

**后果**：点一次归档行，它就出现在活跃侧栏，并且**每次 `loadFromDatabase` 都被重新保留**，直到应用重启才消失。

**修复方向**（二选一，建议后者）：
- 给 `ThreadListItem` 加 `readOnly?: boolean`，归档行传 true，点击不调 `setActiveThread`（配合 G6 的只读预览）。
- 或在 `loadFromDatabase` 的 pending 合并里排除 `status === 'archived'`：
  ```ts
  const pendingThreads = existingThreads.filter(t => !dbThreadIds.has(t.id) && t.archivedAt == null);
  ```
  后者一行改动，但**只治标** —— 归档会话仍会被切进主视图。

### G6【P1】归档视图三个核心交互全空

| 缺口 | 现状 | codex 对照 |
|---|---|---|
| **只读预览**（不解档、不切 activeThread） | 无。`ThreadListItem.tsx:100-104` 点击即 `setActiveThread` | `Ctrl+E` 内联展开最近 6 行（`resume_picker.rs:1263-1269` → `1931-1951`），`Ctrl+T` 全文。**注**：codex 的 *resume* 路径确实强制解档（`resume_picker.rs:1300-1307`），但它有独立的 preview 通道 |
| **批量操作** | 侧栏无多选。批量原语已存在（`src/lib/project-actions.ts:109-129` 的 `archiveSelectedSessions` / `deleteSelectedSessions`）但 `getSessionIdsUnderProject`（`:147`）只扫 `threads[]`，**归档 session 不在批量范围内** | picker 也是单选 —— **这是 duya 独有的真缺口** |
| **撤销** | 无。`ThreadListItem.tsx:148` unarchive 失败只 `console.error`，成功也无反馈 | codex 也没有 undo —— 这是 duya 可以**超越**而非追赶的一项 |

**修复方向**：
- 预览：在 `ThreadListItem` 内做行内展开（复刻 codex `Ctrl+E`），从 `getThreadIPC(id).messages` 取尾部 N 条，不调 `setActiveThread`。
- 批量：在归档 section header 的 trailing 位（`app-sidebar.tsx:1638` 现在只给 project section 传 trailing）加 `⋯` 菜单，"批量解档全部 / 清空归档"，配 `RemoveProjectConfirm` 风格确认弹窗（列出会解档的 N 条）。
- 撤销：`src/components/ui/toast.tsx:33-36,50` 的 `ToastAction {label, onClick}` 就是为此准备的（`dedupeKey` 替换、hover 暂停、MAX_VISIBLE 回收都已实现）。`ThreadListItem` 目前**一次 toast 都没用**。

### G7【P1 bug】归档行上的 rename / pin / delete 是空操作

三个 store action 只 map `threads[]`，不 map `archivedThreads[]`：

| 操作 | store 实现 | 症状 |
|---|---|---|
| rename | `updateThreadTitle` `conversation-store.ts:1124-1134` | 菜单项在（`ThreadListItem.tsx:200-207`），归档行标题**不变** |
| pin | `setThreadPinned` `conversation-store.ts:1225-1247` | hover 按钮在（`ThreadListItem.tsx:333-344`），DB 写了但**归档行无反馈** |
| delete | `deleteThread` `conversation-store.ts:741-763` | **行不消失**，要等某次 archive/unarchive 触发 `loadArchivedThreads` |

**修复方向**：抽一个 `patchThreadLocal(id, patch)` 同时作用于 `threads[]` 与 `archivedThreads[]`；`deleteThread` 里额外 filter `archivedThreads` 并 `void get().loadArchivedThreads()`。纯 store 层改动，风险低。

### G8【P2】两处排序失效 + 一个假快捷键

1. **归档 section 完全不排序**：`app-sidebar.tsx:977` 直接 `threadItems(archivedThreads.slice(...))`，绕过 `sortThreads`（`:766-771`）。实际顺序 = `sessions.list()` 的 `ORDER BY updated_at DESC`。语义上应按 `archivedAt` 排（与 G4 呼应）。
2. **项目组内 thread 恒按 `updatedAt`**：`ProjectGroupItem.tsx:108-111` 硬编码 `b.updatedAt - a.updatedAt`，**完全无视 `projectSortBy`**。三行改动：把 `projectSortBy` 传进 `ProjectGroupItem`。
3. **展示了不存在的快捷键**：`ChatHeader.tsx:102,110` 显示 `Ctrl+Alt+R` 重命名，但**全仓无对应 keydown 处理**；`src/hooks/useShortcutBinding.ts:32` 的 `useShortcutBinding` **零调用方**。要么接上真快捷键 + 冲突检测（抄 codex `archive.rs:29-42` 的 `archive_shortcut_available()` 软让位模式），**要么先摘掉假 label**。后者成本近乎为零，建议先做。

### G9【P2】归档/删除前无确认，且文案需按 duya 真实语义重写

- session 级归档/删除**全无确认**（`ThreadListItem.tsx:131-138` 直接调 store），项目删除有（`RemoveProjectConfirm.tsx:90-175`）。
- codex 的文案 "Subagent threads will also be deleted" **在 duya 不成立** —— `db:session:delete` 是软删除且**不级联**（`db-handlers.ts:390-395` 只 `status='deleted'`）。
- 但 duya 的问题是**不提子 agent 存在**：删掉父 session 后，子 agent session（`parentId` 指向它）留在 DB 里成为孤儿。文案应写"**子 agent 会话不会被删除**"以免误导。
- 建议新增 `ArchiveConfirm`（复用 `RemoveProjectConfirm` 视觉语言），确认文案预告 G2 修复后的真实级联范围。

### 6.4 duya 已经比 codex 做得好的地方（不要改）

1. **归档行视觉区分** —— `ThreadListItem.tsx:310-317` + `sidebar.css:1003-1029`（斜体 + `opacity:.62` + "归档于 X" 三重信号）。codex 是互斥视图，不需要也不做逐行灰度；duya 混排就必须有，做对了
2. **一等分区 + 持久化顺序** —— codex 的 `ThreadSection` 协议齐全但 TUI 零接入，duya 的用户 section 真能用（`sidebar_sections` 表 + 拖拽）
3. **项目实体 + 独立管理页** —— `project-actions.ts` 单点收敛 6 个菜单面
4. **项目维度批量原语已存在** —— 接上归档视图的成本远低于 codex 从零做
5. **增量揭示三粒度分化**（项目组 5 / 扁平 20 / 归档 10，折叠时重置计数）比 codex 单一 pagination 更贴合多列表
6. **Toast 基础设施完备**（`toast.tsx`）—— codex TUI 只有 inline error 行
7. **搜索能覆盖归档内容**（`session-store.ts:360-375` 不过滤 archived），codex picker 只搜当前 status 视图

### 6.5 实施前必须先做的一次运行验证

G5 是读码推断，**未运行验证**。动工前先在 dev 环境手动复现一次：

1. 归档一个 session
2. 点开它
3. 看侧栏活跃区是否多出一行
4. 触发一次 `loadFromDatabase`（切项目 / 刷新）
5. 确认该行是否仍在

同时验证 G7 的 delete 空操作：归档一个 session → 在归档区删它 → 看行是否不消失。

> 若 G5 复现不成立（例如某处已有过滤），需先定位真实成因再改，不要按本节盲改。

---

## 7. 风险

| 风险 | 缓解 |
|---|---|
| G1 改归档目录结构会**破坏已归档的存量数据** | 需要一次性迁移：扫描 `archived/**` 找出缺 `archive-<g>.jsonl` 的 session，标记为"历史已截断"并在 UI 提示，或从孤儿分段重建目录结构 |
| G2 Phase 1 的锁预检可能**误拒**正常归档 | `LockStore` 需确认 `origin` 语义：`background` 来源的锁是否应放行 |
| G3 拦截 resume 可能影响**外部 agent 集成** | 需确认 `session-manager` 的所有调用方是否有非交互式恢复场景（如 cron / bot） |
| G4 加列后旧行 `recency_at` 为 NULL | 回填必须与加列同 migration 完成，否则排序行为不定 |

---

## 8. 完成定义

**存储轨（G1–G4）**

- [ ] **G1** 归档单位改为 session 目录/文件组；目标路径携带 session 身份消除撞名；反档逐文件还原到原路径
- [ ] **G1** 补测试：布局 ①/② 各自的"归档→反档→读回全量历史"往返断言（真实 fs，非 mock）
- [ ] **G1** 存量数据迁移脚本 + UI 提示
- [ ] **G2** Phase 1：`LockStore` preflight 拒绝 + 失效 `message-log.ts` `pathCache`
- [ ] **G2** Phase 2：递归子树归档（unarchive 不递归）
- [ ] **G2** Phase 3：两阶段提交 + `restoreRolloutMoves` 补偿回滚
- [ ] **G3** `session-fork.ts` 拒绝 archived 源 + `ForkSessionResult` 新增 reason
- [ ] **G3** `session-manager.ts` 拒绝加载 archived session
- [ ] **G3** renderer fork 失败提示"请先解档"
- [ ] **G4** migration 34：`recency_at` + `last_turn_started_at` + 回填 + 复合索引
- [ ] **G4** 排序改 `recency_at DESC, id DESC`；`list()` 补 tiebreak

**UI 轨（G5–G9）**

- [ ] **G5** `loadFromDatabase` 的 pending 合并排除 `archivedAt != null`；归档行点击走只读路径
- [ ] **G6** 归档行内只读预览（不解档、不切 `activeThread`）
- [ ] **G6** 归档 section trailing 插槽加"批量解档 / 清空归档" + 确认弹窗
- [ ] **G6** archive / unarchive 接入 `ToastAction`，失败路径不再 `console.error`
- [ ] **G7** 抽 `patchThreadLocal(id, patch)` 同时作用于 `threads[]` 与 `archivedThreads[]`
- [ ] **G7** `deleteThread` 同步 filter `archivedThreads` + 触发 `loadArchivedThreads`
- [ ] **G8** 归档 section 接上 `sortThreads`（按 `archivedAt`）
- [ ] **G8** `projectSortBy` 传进 `ProjectGroupItem`
- [ ] **G8** 摘掉 `ChatHeader.tsx:102,110` 的假快捷键 label
- [ ] **G9** 新增 `ArchiveConfirm`；删除确认文案改为"子 agent 会话不会被删除"

**门禁**

- [ ] **`npm run typecheck:all`** clean
- [ ] **单测** ≥ 25（真实 fs 的归档往返、preflight 拒绝、回滚补偿、fork 拦截、`patchThreadLocal` 双数组一致性）
- [ ] **E2E** `e2e/ipc/session-archive.spec.ts`（补 549 未交付的 E2E 位）
- [ ] **Playwright MCP** 烟测：归档 → 归档分区出现 → 点归档行不污染活跃区 → 反档 → 历史完整 → 排序位置正确 → 归档行 rename/delete 立即生效

---

## 9. 不在本 plan 范围

- **持久化用户输入队列**（codex 的 `queued_items`）—— 触及渲染层，工作量最大，单独立 plan
- **spawn edge 改森林模型**（codex `child_thread_id` PRIMARY KEY）—— duya 当前 `child_session_id` 无 UNIQUE，存在 DAG 风险但无实际症状；低优先
- **subagent residency LRU 驱逐** —— duya 单机 Electron，无常驻 subagent 池，**不建议做**
- **跨进程 writer 文件锁** —— duya 唯一写者是主进程（Agent 子进程经 `db-bridge.ts` 转发，不直接开 better-sqlite3），**架构上不需要**
- **秒→毫秒递归 CTE 迁移** —— duya 建表即毫秒，**不适用**
- **稀疏秩排序 / thread section** —— duya 无分区功能，**不适用**
- **worktree 框架** —— Plan 496 独立跟踪
- **`ForkPersistence::Referenced`** —— duya fork 是低频用户操作，复制语义更简单安全，且 duya 的 id 重映射比 codex 更严谨

---

## 10. 推进顺序

| 批次 | 内容 | 理由 |
|---|---|---|
| **P0** | **G5 + G7**（两个纯 bug，改动小）→ **G1**（目录级归档）→ **G2 Phase 1**（preflight）→ **G3**（fork 拦截） | G5/G7 是用户立刻能看到的"点了没反应"；G1 是唯一"无感知丢历史"的缺陷 |
| **P1** | G2 Phase 3 两阶段提交 + G4 `recency_at` + G6（预览/批量/撤销） | G6 三项共用 `app-sidebar.tsx:1638` 的 trailing 插槽与 `project-actions.ts` 的批量原语，改动面收敛 |
| **P2** | G8 排序三处 + G9 确认弹窗 + G2 Phase 2 递归子树 | G8 的假 label 摘除成本近乎为零，可随手做 |
| **独立** | 持久化输入队列、spawn edge 森林模型 | 各自单独立 plan |

> **G5 动工前先做 §6.5 的运行验证** —— 那是读码推断，未跑过。

---

## 11. 决策日志

- **2026-10-01** — 立项：对标 codex thread 管理调研时发现 549 遗留多个正确性缺口。G1（轮转归档断史）、G5（点归档行污染活跃列表）均为本次新发现，549 的调研与测试均未覆盖。
- **决定不重做 549** — 549 的 Track A/B/C/D 全部已落地且有测试，本 plan 只补缺口。
- **决定 G1 优先于 G2/G3** — G1 是唯一"用户无感知地丢失可见历史"的缺陷，另两个至少会报错或状态可见。
- **决定不抄 codex 的跨进程锁** — duya 单写者架构天然免疫，抄过来是纯负债。
- **决定不把归档区改成互斥视图** — codex picker 是模态单列表，duya 侧栏是多列表常驻形态。互斥视图会破坏"归档区作为常驻收纳位"的产品定位。归档行视觉区分（斜体 + 降透明 + "归档于 X"）是 duya 混排形态下的必需项，做得比 codex 好，保留。
- **决定 G6 的撤销是"超越"而非"追赶"** — codex 也没有 undo，但 duya 的 `toast.tsx` 基础设施已完备，接入成本极低。
