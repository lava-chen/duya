# Plan 493 — Bot Session 物理隔离 + 按 Generation Rotate

> Scope: A 路径切分 + B generation rotate + D 软删+宽限期。三件套一气呵成。
> 触发:用户提议 "bot session JSONL 不要和真诚改行 session 一起存储,存在每一个 bot 的配置文件目录下",
> 因为这个 session 文件可能会越来越大并且值得维护";之后用户追加要求 C(soft delete)也合入本 plan。
> 关键约束:每次 compaction 触发 file rotate;archive 文件不压缩(用于渲染);软删宽限期 30 天,可被 `purgeOpts.olderThanMs` 覆盖。

## 0. 背景

现有 `MessageLog.resolvePath` 把所有 session 一律写到 `<duyaRoot>/sessions/<YYYY>/<MM>/<DD>/rollout-<stamp>-<sessionId>.jsonl`
(注意:不是 `<userData>/sessions`,而是 `~/.duya/sessions`)。bot session 和 main / cron / room session 共享同一棵目录树,删除 bot 时
需要跨表/跨文件系统级联清理,session JSONL 可能无限增长。

bot profile 当前落在 `<duyaRoot>/agents/<agentId>/profile.json`(plan 485 §2.2 已定),
与 `settings.json`、`avatar.png`、`state/`、`memory/` 共享 agent 目录模式。
本次 plan 把 session JSONL 也接到这个目录树下,并按 compaction 代际切分(参考 git packfile 模型)。

### 0.1 与现有 duya 体系的接入点(audit)

**已存在的 bot 路径层(plan 485 已建)**:
- `electron/config/agent-paths.ts:25` `getDuyaAgentsRoot(duyaRoot?)` — 单一 agents 根解析入口
- `electron/config/agent-paths.ts:34` `resolveDuyaAgentDir(agentId, duyaRoot?)` — agent 子目录,内置 `assertValidBotId`
- `electron/config/agent-paths.ts:41/46/54/59/64` `getBotProfilePath` / `getBotSettingsPath` / `getBotAvatarPath` / `getBotStateDir` / `getBotMemoryDir` — 各子文件/子目录 helper
- `electron/config/compass.ts:34` `resolveConfigRoot()` — `~/.duya` 根,自动遵循 `--duya-namespace` 测试隔离

**已存在的 bot profile 写层(plan 485 P2.1 已建)**:
- `electron/config/agents.ts:122` `upsertConfigAgent(id, input)` — 创建时自动 `seedBotProfileIfMissing` 写 profile.json
- `electron/config/agents.ts:150` `deleteConfigAgent(id)` — 删除时 `fs.unlinkSync(profilePath)` 清 profile.json
- `electron/config/agents.ts:191` `updateBotProfileIdentity(id, input)` — UI 改名走 profile.json

**MessageLog(plan 333/441 已建)**:
- `electron/db/core/message-log.ts:127` `MessageLog(db, rootDir)` — 单文件 JSONL
- `electron/db/core/message-log.ts:686` `resolvePath(sessionId, createdAt)` — 路径单源
- `electron/db/core/message-log.ts:748` `resolvePathOnDisk(relativePath)` — legacy fallback(Codex dev 旧路径)
- `electron/db/core/rollout-events.ts:18` `RolloutEvent` union,包含 `CompactionEntry`、`RebaseEntry`
- `electron/db/core/rollout-events.ts:140` `isRolloutEvent` inline list

**本 plan 不做的事(明确)**:
- 不新开 package —— bot session JSONL 物理隔离是 `MessageLog` 的一处增强,跨 `electron/db/core/` + `electron/config/` 的 API 改造,新开 package 反而引入 boundary overhead。computer-use-demo 这种独立域才需要独立 package
- 不迁移 `electron/channels/channel-store.ts` / `electron/config/connector-secret-store.ts` 的 `<userData>/agents/` 路径 —— plan 485 留下的债,本 plan 不背
- 不重写 `MessageLog.appendBatch` 同步语义 —— 现有 sync API 是 platform contract,改了破坏 Electron main + agent worker 同步链路

### 0.2 接入点一一对应

| Plan 493 章节 | 现有体系接入点 | 改动类型 |
|---|---|---|
| Phase A 1 (`MessageLog` 加 `agentsDir`) | `agent-paths.ts:25` `getDuyaAgentsRoot` | **复用,不重写** |
| Phase A 2 (`resolvePath` 感知 bot id) | `sessionId.startsWith('bot:<id>:<uuid>')` 解析 | **增强** |
| Phase A 3 (`resolvePathOnDisk` fallback) | 现有 `<duyaRoot>/sessions/<YYYY>/...` fallback | **沿用** |
| Phase B `rotateArchive` | `MessageLog.appendBatch` 同步语义 | **追加,不破坏** |
| Phase B `RolloutEvent` union 加 `RotationEvent` | `rollout-events.ts:18` `RolloutEvent` + `:140` `isRolloutEvent` list | **扩展** |
| Phase D schema migration | `electron/db/migrations/` 已有 migration 系统 | **沿用** |
| Phase D `softDeleteConfigAgent` | `agents.ts:150` `deleteConfigAgent` 旁 | **追加函数,不破坏现有** |
| Phase D `restoreConfigAgent` | 同上 | **追加函数** |
| Phase D `purgeDeletedConfigAgents` | 新增 | **新增函数** |
| Phase D IPC handler | `electron/ipc/db-handlers.ts:1355` 已有 `deleteConfigAgent` handler | **追加 handler** |
| Phase D UI drawer | `src/components/layout/sidebar/` 已存在的 bot section | **追加抽屉组件** |

## 1. 路径方案

```
~/.duya/                                          # duyaRoot = resolveConfigRoot()
  agents/
    <agentId>/
      profile.json                                # 现有(plan 485)
      settings.json                               # 现有(plan 485)
      avatar.png                                  # 现有(plan 485)
      state/                                      # 现有(plan 485 预留,477/484 落点)
        session-binding.json
        pending-wakes.json
      memory/                                     # 现有(plan 485 预留,479 落点)
      sessions/                                   # 新增(plan 493)
        active.jsonl                              # 当前 generation 活跃 JSONL
        archive-0.jsonl                           # generation 0 的数据(第一次 compaction 之前的 raw)
        archive-1.jsonl                           # generation 1 的数据(第二次 compaction 之前的 raw)
        ...
  sessions/                                        # main / cron / room(保持现状)
    <YYYY>/<MM>/<DD>/rollout-...-bot:<id>:<uuid>.jsonl  # 旧 bot session 兼容保留
  .deleted/                                        # 软删宽限目录(新,plan 493 引入)
    <ts>-<agentId>/                                # 完整 agent 目录的镜像(所有子目录 + 子文件)
```

读取时:bot session 路径由 `<agentsDir>/<agentId>/sessions/active.jsonl`(当前)或
`<agentsDir>/<agentId>/sessions/archive-<gen>.jsonl`(历史)按 generation 选。
fallback 兼容旧 `<duyaRoot>/sessions/<YYYY>/<MM>/<DD>/rollout-...jsonl`(用户选"不迁,只新写走新路径")。

> **注意**:`<userData>/agents/<id>/channels/` 和 `<userData>/agents/<id>/connector-secrets/` 是
> plan 485 留下的债(channel-store / connector-secret-store 用了不同的根)。本 plan 不碰,
> 留作后续独立清理任务。

## 2. Phase A — 路径层(纯读写切路径,不动 compaction)

### 改动

1. `electron/db/core/message-log.ts:127` constructor 签名扩展:
   `constructor(db: SqliteDatabase, rootDir: string)` 不变,**内部用 `getDuyaAgentsRoot(rootDir)` 算 agentsDir**。
   不接受外部 `agentsDir` 参数 —— 单一来源。

2. `MessageLog.resolvePath(sessionId, createdAt)` 重写:
   - 解析 sessionId 格式:
   - `bot:<agentId>:<sessionId>` 三段 → bot session
   - `cron:<id>:<ts>:<id>`、其它前缀 → 非 bot,走 `sessions/<YYYY>/<MM>/<DD>/...`
   - 主 agent UUID → 非 bot
   - bot session 返回 `<agentsDir>/<agentId>/sessions/active.jsonl`(gen=0 时)
   - 其它 session 返回 `sessions/<YYYY>/<MM>/<DD>/rollout-...`(原行为)
   - **`<agentsDir>` 通过 `getDuyaAgentsRoot(this.rootDir)` 解析,不接受外部参数**

3. `MessageLog.resolvePathOnDisk(relativePath, agentType, agentId, generation)` 扩展:
   - agentType === 'bot' + agentId 存在 → 先查 `<agentsDir>/<agentId>/sessions/active.jsonl` 或 `archive-<gen>.jsonl`
   - 否则按原路径查;fallback 旧 `<duyaRoot>/sessions/<rel>`
   - `<agentsDir>` 用 `getDuyaAgentsRoot(this.rootDir)` 单源

4. **`getOrCreateRolloutPath` 改写**:`UPDATE chat_sessions SET rollout_path = ?, agent_type = ?, agent_id = ?, generation = 0 WHERE id = ?`。
   旧 row 没 agent_id 时,允许新值覆盖(无需 migration,字段可空)。

### 不变量

- `chat_sessions.rollout_path` 字段保留 —— 新写入会按新策略设值,旧 row 路径不动。
- 旧 `<duyaRoot>/sessions/...` 的 bot JSONL 继续被 fallback 读取,不主动搬移。
- `MessageLog` constructor 签名不变(向后兼容),新行为通过 `rootDir` 派生。

### 测试

- `electron/db/core/__tests__/message-log.test.ts`: 加 bot session 路径覆盖。
- `electron/db/core/__tests__/message-log.test.ts`: 验证 fallback 到旧位置。
- `electron/db/core/__tests__/message-log.test.ts`: 验证 `<agentsDir>/<agentId>/sessions/active.jsonl` 创建。

## 3. Phase B — Generation Rotate

### 触发条件

`MessageLog.appendBatch` 检测到任何 event `payload.type === 'compaction'`(plan 441 已定义的 rebase 形态之一)→ 触发 `rotateArchive(sessionId)`。
**每次 compaction 都 rotate**(用户确认),不论 active.jsonl 当前大小。

### `rotateArchive(sessionId)` 流程

1. `getOrCreateRolloutPath` 取当前 `rollout_path`,记为 `currentPath`
2. 读 `chat_sessions.generation` 当前值 `g`(默认 0)
3. 计算新路径:
   - 旧 active: `<agentsDir>/<agentId>/sessions/active.jsonl` → rename 为 `<agentsDir>/<agentId>/sessions/archive-<g>.jsonl`
   - 非 bot session **不 rotate**(保持原路径,compaction 走 `appendRebase` 现有逻辑)
4. touch 新 `<agentsDir>/<agentId>/sessions/active.jsonl`(空文件)
5. 写一条 **rotation event** 到新 active.jsonl(不是 rebase —— 见下方"为什么不是 rebase"):
   ```ts
   {
     type: 'rotation',
     id: `rotation:${sessionId}:${g}:${Date.now()}`,
     fromGeneration: g,
     toGeneration: g + 1,
     archivePath: `archive-${g}.jsonl`,
     createdAt: Date.now(),
   }
   ```
6. `UPDATE chat_sessions SET generation = g+1, rollout_path = '<agentsDir>/<agentId>/sessions/active.jsonl' WHERE id = sessionId`
7. 后续 `appendBatch` 用新 active.jsonl

### 为什么不是 rebase

最初设计考虑复用 `RebaseEvent`(plan 441)携带 rotation 标记,但 `RebaseEvent.supersededUpToSeq = null` 会被 `applyRebases` 解读为 "supersede ALL prior rows",**会把 archive-N 里的 raw messages 全部从投影里抹掉** —— 这违反了 "rotate 是文件迁移,不是数据删除" 的语义。

新增独立 event type `'rotation'` 更安全:
- `RolloutEvent` union 加 `RotationEvent`
- `EventKind` 加 `'rotation'`(自动,`deriveKind` 走 `isRolloutEvent` 分支)
- `isRolloutEvent` inline list 加 `'rotation'`
- `applyRebases` 不碰(不是 rebase)
- `extractSearchableText` 返回 `''`(内部事件,不出现在 search)
- `listBySession` 分桶时通过 `event.type === 'rotation'` 识别 generation boundary

### crash safety

- 顺序是 **touch new → write rotation event → rename old → UPDATE SQLite**。每步独立可恢复。
- 如果 rename 失败(active.jsonl 残留旧数据),下次 `listBySession` 检测到 `active.jsonl` 头部第一条是 `rotation` event,**回退到对应 archive 文件**(`rotation.fromGeneration` 指向 archive 路径)。
- crash 中间态:`active.jsonl` 是空的(只有 rotation event),`<archive-g.jsonl>` 已 rename 完成 → 完全 OK。
- crash 中间态:已 rename 但 `generation` 没 update → 下次读 `chat_sessions.generation` 仍是旧值,read path 检测 `active.jsonl` 是空或仅含 rotation event → 走 `<archive-g.jsonl>` 读数据。
- crash 中间态:已 UPDATE `generation = g+1` 但 rotation event 缺失 → 下次 appendBatch 会再次写入 rotation event(idempotent via `INSERT OR IGNORE` on `message_index.id`)。

### `message_index` 改造

`ALTER TABLE message_index ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;`
migrations 加一条新 id。

`appendBatch` 在 INSERT message_index row 时填 `generation`(读 `chat_sessions.generation` 的当前值)。
`listBySession` 在 SELECT rows 后按 `generation` 分桶,**每个 bucket 用对应 generation 的 absolutePath 读 file_offset + byte_len**,最后按 seq 排序合并。

迁移策略:已有 rows 的 generation 默认 0,落在 `archive-0.jsonl` 或 fallback 旧位置,无破坏。

### read path

`listBySession(sessionId, opts)`:
1. SELECT rows from `message_index` GROUP BY generation
2. 对每个 generation bucket,计算 absolutePath(优先 archive-<gen>.jsonl,fallback 旧位置)
3. 从对应文件读 rows,合并按 seq 全局排序
4. 应用 `applyRebases` + `repairInterruptedToolCalls`,与现有逻辑一致

### 不变量

- `message_index` 保留 append-only —— rotate 不删 rows,只加 `generation` 列
- `chat_sessions.generation` 字段保留 + 复用 —— 旧值 0/1 不变,新 session 从 0 起
- 同一 session 多次 rotate,产生 `archive-0.jsonl` `archive-1.jsonl` `archive-2.jsonl` `active.jsonl`

### 测试

- `electron/db/core/__tests__/message-log-rotation.test.ts`(新文件):
  - 单 session 触发 2 次 rotate,验证文件切分 + rotation event + generation 递增
  - rotate 后 `listBySession` 返回合并后的 timeline(seq 顺序正确,**rotation event pass-through 不参与 rebase 折叠**)
  - rotate 中 crash 模拟:rename 后 generation 未 update,read path fallback 到 archive
  - 验证 `applyRebases([rotation event + 旧 messages])` 不删任何 message(rotation 不是 rebase)

## 4. 阶段 D — 软删 + 宽限期(Soft Delete)

### 4.1 Schema 改动

`agent_profiles` 表加列:
```sql
ALTER TABLE agent_profiles ADD COLUMN deleted_at INTEGER;
ALTER TABLE agent_profiles ADD COLUMN deleted_reason TEXT;
ALTER TABLE agent_profiles ADD COLUMN deleted_purge_at INTEGER;  -- 预定的 purge 时间(软删时计算)
```

新 `electron/db/migrations/migration-NN.ts` 一条。

`chat_sessions` 表**不动** —— bot 软删时 session rows 保留,等 purge 时级联删。

### 4.2 路径方案补充

```
~/.duya/
  agents/
    <agentId>/                              # 正常 bot 目录(存在 sessions/)
      profile.json
      sessions/active.jsonl
      sessions/archive-0.jsonl
    .deleted/                                # 软删宽限目录(隐藏)
      <ts>-<agentId>/                        # 完整 agent 目录的镜像
        profile.json
        sessions/active.jsonl
        sessions/archive-0.jsonl
        ...
```

`.deleted/` 命名:
- 用 `<ts>-<agentId>` 而不是 `<agentId>`,避免同一 agent 多次软删冲突。
- 文件名用 ms timestamp(`Date.now()`),保证字典序 = 时间序。
- `.deleted/` 目录用 dot-prefix,默认不在 OS 文件管理器显眼位置,但**不强制隐藏**。

### 4.3 API 改动(`electron/config/agents.ts`)

- **保留 `deleteConfigAgent(agentId)`** —— 现在的 hard delete(只删 profile.json),不变。**这是给"从来没创建过 session 的占位 bot"快速删除用的**。
- **新增 `softDeleteConfigAgent(agentId, opts: { reason?: string })`**:
  1. 验证 profile 存在 + `deleted_at IS NULL`(已软删不能重复)
  2. 读 `profile.json`(稍后跟着目录 move)
  3. **rename** `<agentsDir>/<agentId>/` → `<agentsDir>/.deleted/<ts>-<agentId>/`(同步 fs.renameSync;Windows 上目标不存在时成功)
  4. SQLite transaction:
   - `UPDATE agent_profiles SET deleted_at = ?, deleted_reason = ?, deleted_purge_at = ? WHERE id = ?`
   - `deleted_purge_at = Date.now() + 30 * 24 * 3600 * 1000`(30 天)
  5. 内存缓存 `listConfigAgents` 失效
  6. 返回 `{ ok, softDeletedAt, restorePath: '<agentsDir>/.deleted/<ts>-<agentId>/' }`
- **新增 `restoreConfigAgent(agentId)`**:
  1. 读 `agent_profiles WHERE id = ? AND deleted_at IS NOT NULL`
  2. 在 `<agentsDir>/.deleted/` 找最新 `<ts>-<agentId>/`(同 agent 可能多次软删,取 max ts)
  3. 验证目标 `<agentsDir>/<agentId>/` 不存在(避免覆盖正常 bot)
  4. rename `<agentsDir>/.deleted/<ts>-<agentId>/` → `<agentsDir>/<agentId>/`
  5. SQLite: `UPDATE agent_profiles SET deleted_at = NULL, deleted_reason = NULL, deleted_purge_at = NULL WHERE id = ?`
  6. 内存缓存失效
- **新增 `listDeletedConfigAgents()`**:
  - SELECT `* FROM agent_profiles WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`
  - 返回 `{ id, deletedAt, deletedReason, purgeAt, path }[]`
  - 给 UI 的 "Deleted bots" 抽屉用
- **修改 `listConfigAgents()`**: `WHERE deleted_at IS NULL`
- **修改 `getConfigAgent(id)`**: `WHERE id = ? AND deleted_at IS NULL` —— 已软删的 agent 对 IPC 调用一律"not found"

### 4.4 IPC 暴露(`electron/ipc/db-handlers.ts`)

| IPC | 行为 |
|---|---|
| `configAgents.softDelete(id, opts)` | 调 `softDeleteConfigAgent`,broadcast `configAgents:changed` |
| `configAgents.restore(id)` | 调 `restoreConfigAgent`,broadcast |
| `configAgents.listDeleted()` | 调 `listDeletedConfigAgents`,返回 `DeletedAgent[]` |
| `configAgents.purge(opts)` | 调 `purgeDeletedConfigAgents`,返回 `{ purgedIds, dryRun }` |

### 4.5 UI 改动(`src/components/layout/sidebar/`)

- **替换当前的 `confirmDeleteBot` dialog**(如果存在):改为 "Delete bot" 按钮 → "确认" → 走 `softDelete`
- **新 `DeletedBotsDrawer` 组件**:在 sidebar 底部 "Manage deleted bots" 入口,展开后列 `deleted_at` 不为 null 的 bots,每行有 "Restore" 按钮
- **Restore 时如果目标 agentId 已被新 bot 占用**:UI 报错 "Agent ID already exists, please rename or remove the new bot first",不允许覆盖

### 4.6 Purge 调度(`electron/db/agents/agent-purge-scheduler.ts`)

- **不在 boot 时跑**:boot 时间宝贵,避免 startup 慢
- **方案 A** —— 定时:`app.setInterval(purgeTick, 60 * 60 * 1000)`(每小时一次)+ `app.on('before-quit')` 最后一次兜底
- **方案 B** —— 懒触发:`configAgents.listConfigAgents()`、`listDeletedConfigAgents()`、UI 抽屉每次打开时 check
- **方案 C** —— IPC 触发:UI 的 "Manage deleted bots" 抽屉打开时调 `purgePending(opts={ dryRun: true })` 预览;有 "Purge now" 按钮触发实删
- **本轮采用 B + C**:抽屉打开触发 `dryRun`,显式 "Purge now" 触发实删。**A 留作 plan 494 增强**(避免一小时一次 IO 对用户的影响评估)。

### 4.7 `purgeDeletedConfigAgents(opts: { olderThanMs: number; dryRun?: boolean })`

1. SELECT `* FROM agent_profiles WHERE deleted_at IS NOT NULL AND deleted_purge_at < ?`(用 `Date.now() - olderThanMs`)
2. 对每个待删 agent:
   - 验证 `<agentsDir>/.deleted/<ts>-<agentId>/` 路径与 profile 记录的 ts 一致(防止 rename 后又被人手动改名)
   - 列目录里的 `sessions/` 子目录,**对每个 JSONL 文件**:
   - `SELECT id FROM chat_sessions WHERE id LIKE 'bot:<agentId>:%'` 获取该 agent 的 session id 列表
   - `DELETE FROM message_index WHERE session_id IN (...)` ← 级联删索引
   - `DELETE FROM chat_sessions WHERE id IN (...)` ← 级联删 session rows
   - `fs.rmSync(<agentsDir>/.deleted/<ts>-<agentId>/, { recursive: true, force: true })`
   - `DELETE FROM agent_profiles WHERE id = ?`
3. dryRun 模式只算清单 + 总大小,返回 `{ candidates, totalBytes, wouldDelete: [...] }`,不实际删
4. 单事务包整批(避免半删状态)

### 4.8 与 Phase A + B 的相互依赖

- **Phase A 路径层**:`resolvePath` 需要感知 `deleted_at`?—— **不需要**。已软删的 agent 其 session 仍在 `<agentsDir>/<agentId>/sessions/`(目录已 move 到 `.deleted/`,但路径形态相同)。`MessageLog` 不感知 agent 是否被软删 —— 这是 IPC 层(`getConfigAgent`)的责任。如果 IPC 层调用 `getOrCreateRolloutPath` for已软删 agent 的 session,**会出现 data leak**(删了但能写新数据)。
  - **对策**:`configAgents.createSession` 这个 IPC handler 增加 `WHERE deleted_at IS NULL` 检查
  - **对策**:`appendBatch` 入口不查 agent 状态(性能),但上层 IPC handler 负责
- **Phase B rotate**:已软删 agent 的 `sessions/active.jsonl` 在 `.deleted/<ts>-<agentId>/sessions/active.jsonl`。理论上不会有新 compaction(用户看不到),但如果某个 session 在软删前已开始 append batch 中包含 compaction event,需要在 appendBatch 完成后**最后再检测**"agent 是否已软删"。
  - **对策**:`appendBatch` 检测到 compaction event 时,**先**查 agent 的 `deleted_at`。如果已软删,跳过 rotate 但仍写入 events(保留现有数据完整性)。如果未软删,执行正常 rotate。

### 4.9 Crash safety

- rename 软删目录时 crash: 可能半 rename(目录部分内容已 move),需要 fsync 父目录。`fs.renameSync` 在 Windows + NTFS 下基本原子,但 Linux ext4 rename 也是原子的
- rename 后 SQLite UPDATE 失败:directory 已在 `.deleted/` 但 DB 没标 deleted_at → 下次 listDeleted 找不到该 agent,**成 zombie**。恢复:`purgeDeletedConfigAgents` 应该也扫磁盘 `<agentsDir>/.deleted/`,凡是不在 DB 里的 `<ts>-<agentId>/` 也列出来作为 "未记录的删除项",提供 UI 手动处理
- SQLite UPDATE 后 rename 失败:DB 标 deleted_at 但目录还在 `<agentsDir>/<agentId>/` → **软删状态不一致**。恢复:再次重试 rename,如果目标路径冲突(目录已存在),**报错回滚 DB**。
- **对策**:soft delete 必须包在一个"先 SQLite 试算 → 再 rename → 再 SQLite 提交"的伪事务里,任一步失败回滚前一步

### 4.10 测试

`electron/config/__tests__/agents-soft-delete.test.ts`(新):
- softDelete 移动目录 + 标 deleted_at + 计算 purge_at
- 重复 softDelete 同一 agent → 第二次失败("already soft-deleted")
- restore 把目录移回 + 清 deleted_at
- restore 时目标 agentId 已被占用 → 报错"path conflict"
- listConfigAgents 不返回已软删
- getConfigAgent 对已软删返回 null
- purge dryRun 不实际删 + 返回正确清单
- purge 实际删:删 chat_sessions + message_index rows + JSONL 文件 + profile row
- purge 跳过未到期的 agent(deleted_purge_at > now)
- **bot session 在 agent 软删后 appendBatch 仍能写**(目录还在,只是换了位置)
- **rename 失败模拟**:mock fs.renameSync throw,验证 DB 未提交(目录未 move)

### 4.11 不变量

- 软删时 sessions/ 完整 move 到 .deleted/,JSONL 物理内容不变
- restore 后 sessions/ 物理位置还原,`chat_sessions.rollout_path` 字符串不变(还是 `<agentsDir>/<agentId>/sessions/active.jsonl`)
- purge 必须先删 message_index + chat_sessions 再删 JSONL 文件,避免 dangling pointer
- 已软删 agent 的 channel 配置(`channels/`)、connector secrets(`connector-secrets/`)跟着 move,不能漏

## 5. 不做(推到 plan 494 / 后续)

- 迁移 `electron/channels/channel-store.ts` / `electron/config/connector-secret-store.ts` 的 `<userData>/agents/` 路径 → plan 494(plan 485 留下的债,本 plan 不背)
- Room session 物理隔离(`rooms/<roomId>/sessions/`) → plan 483 房间模式落地时再做
- 备份/导入导出工具 → 后续 plan
- agent profile 自动 export/import 协议(plan 477 binding 之后再说)
- purge 的定期调度(plan 494 用 `app.setInterval` + UI 提示)

## 6. 验收

- `npm run typecheck:all` 全绿
- `npm test` 全绿(尤其 `message-log.test.ts` `message-log-rotation.test.ts` `electron/db/core/__tests__/fsync-policy.test.ts`)
- 新建 bot → 走 IPC 创建第一条 message → 验证 `<agentsDir>/<agentId>/sessions/active.jsonl` 出现
- 手动触发 /compact(plan 491 P2.x 未完成,先用 `client.call('compact:trigger', ...)` 直接调)→ 验证 `active.jsonl` 切分到 `archive-0.jsonl`,新 `active.jsonl` 空 + rotation event
- 重启后 `useBotContacts` 仍能列出 bot,sidebar 显示正常(bot profile 没被破坏)
- 旧 `<duyaRoot>/sessions/<YYYY>/<MM>/<DD>/rollout-bot:<id>:<uuid>.jsonl` 的 bot session 在 resolvePathOnDisk fallback 下仍可读
- soft delete 一个 bot → 目录在 `<agentsDir>/.deleted/<ts>-<id>/`,UI 抽屉列出,Restore 按钮工作
- 软删 30 天后 Purge now → message_index + chat_sessions + JSONL 文件全部清掉,文件系统回收空间

## 7. 接入规划

- 单 PR,标题 `feat(db): bot session JSONL 物理隔离 + compaction rotation + soft delete (plan 493)`
- 不拆 worktree —— 改动集中于 `electron/db/core/message-log.ts` + `electron/config/agents.ts` + `electron/db/migrations/` + 2 个新测试文件 + 1 个 UI 抽屉,blast radius 中等(改动 IPC 路径),master 直接 commit + push
- 测试时确认 `message-log.test.ts` 现有覆盖不被破坏(无 schema 兼容性问题)

## 8. 检查报告(2026-09-04,plan 自检)

### 8.1 完整性

| 检查项 | 状态 |
|---|---|
| Phase A 路径切分 + Phase B generation rotate | ✓ 覆盖 |
| Phase D 软删 + 宽限期 | ✓ 覆盖(本轮追加) |
| Room session 路径 | △ 推到 plan 483 房间模式落地 |
| 备份/导入导出 | ✗ 推到后续 |
| 现有 schema(`chat_sessions.rollout_path`、`agent_profiles.profile_kind`、`message_index` schema)的兼容性 | ✓ 显式分析 |
| 测试覆盖(单元 + 集成) | ✓ 每个 phase 列了测试文件 |
| Crash safety 分析 | ✓ Phase B + Phase D 都列了 |
| 跨平台行为(Windows + macOS + Linux) | △ Windows rename 风险提了,需要实际测试 |
| `docs/exec-plans/` 是 gitignored(plan 不进 origin) | ✓ |
| **与 plan 485 路径 helper 复用** | ✓(`getDuyaAgentsRoot` / `resolveDuyaAgentDir`) |
| **与 plan 485 profile 写层耦合** | ✓(`upsertConfigAgent` / `deleteConfigAgent` 同文件追加 soft delete) |
| **不新开 package** | ✓(详见 §0.1) |

### 8.2 一致性

| 项 | 状态 |
|---|---|
| `chat_sessions` schema 不动 | ✓ D1 |
| `message_index` 加 `generation` 列(migration) | ✓ Phase B |
| `agent_profiles` 加 `deleted_at` / `deleted_reason` / `deleted_purge_at` 三列(migration) | ✓ Phase D |
| 现有 `rebase` event 不被误用 | ✓ 改用新 `rotation` event type |
| `RolloutEvent` union / `EventKind` union / `isRolloutEvent` inline list / `applyRebases` 都要更新 | ✓ Phase B "为什么不是 rebase" 列了 |
| 与 plan 491 P1.1(lazy create thread)的依赖 | ✓ Phase A 写入路径不依赖 P1.1(可以从 fixtures 测试),Phase A 验收可以独立 |
| 与 plan 477(bot-session binding)的依赖 | △ `agent_id` 在 `chat_sessions` 已存在;`getOrCreateRolloutPath` 用 plan 477 binding 拿 agentId,**不依赖 plan 477 完成** |
| 与 plan 441(rebase event)的冲突 | ✓ 用独立 `rotation` event 区分 |
| **`<duyaRoot>` vs `<userData>` 区分** | ✓ 已显式:本 plan 用 `<duyaRoot>/agents/`,**不**碰 `<userData>/agents/` |
| **与 plan 485 已建能力对齐** | ✓ 复用 `getDuyaAgentsRoot`,**不**重写 |
| **`<userData>/agents/<id>/channels/` 债** | △ 显式标记 plan 494,本 plan 不碰 |

### 8.3 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| Windows rename 失败(目标存在 / 文件 locked) | rotate 失败 | `fs.renameSync` 抛错被 appendBatch catch,console.error,不下毒(rebase event 仍按 batch 写入 active.jsonl);下次 batch 重试 |
| 多进程并发 rotate(主进程 + agent 子进程同时 append) | 数据竞争 | `appendBatch` 是同步的(只在主进程调),agent 子进程通过 IPC 调 `journal:appendBatch` 单线程处理。rotate 在主进程同步链路内,无并发 |
| Linux ext4 rename 跨设备失败(sessions 在不同 fs) | rotate 失败 | `<agentsDir>` 与 `<rootDir>` 都是 `<duyaRoot>` 子目录,同一 fs。验证过 |
| purge 时 crash 中途 | 半删状态 | purge 整个包在 SQLite transaction,JSONL 文件最后删。如果 JSONL 已删但 SQLite 没 commit,下次开机 SQLite 仍是 stale,purge 再次尝试 |
| 旧 session 在 `<duyaRoot>/sessions/...` 没被 move | 读路径兼容 | `resolvePathOnDisk` 加 fallback(Phase A 步骤 3) |
| `applyRebases` 折叠了不该折叠的 message | UI 错误显示 | 用独立 `rotation` type 不用 rebase(已修正) |
| 软删后 zombie `.deleted/<ts>-<id>/` 目录(SQLite 失败) | 磁盘泄漏 | purge 扫磁盘作为 reconciliation |
| soft delete 中 rename 失败但 SQLite 已标 deleted_at | 状态不一致 | 伪事务:SQLite 试算 → rename → SQLite 提交,rename 失败回滚 |
| Room session 现在没定义路径策略 | plan 483 房间落地时冲突 | 本 plan 明确"room 推到 plan 483 房间模式落地" |
| Phase B 改 schema migration id 撞现有 | migration 顺序破坏 | review 时人工指定新 id(比如 47) |
| `<userData>/agents/` vs `<duyaRoot>/agents/` 两套并存的债 | 用户迷惑 | plan 493 §0.1 显式标注;plan 494 收敛 |
| **plan 485 已建的 `agent-paths.ts` 是否足够?** | 路径 helper 复用度 | ✓ `getDuyaAgentsRoot` 已暴露,直接 import |
| **新 API 与 plan 485 P2.1 已建 upsert 流程冲突?** | 并发竞争 | softDelete 是单 agent 操作,upsert 也是单 agent 操作;两者都通过 `store.set('agents', ...)` 同步,无并发 |

### 8.4 可行性 / 工作量

| Phase | 工作量 | 备注 |
|---|---|---|
| Phase A 路径层 | ~150 行 + ~80 行测试 | 1 天 |
| Phase B generation rotate | ~250 行 + ~150 行 测试 | 1.5 天 |
| Phase D soft delete | ~350 行 + ~200 行测试 | 2 天 |
| 文档同步 | ~100 行 | 0.5 天 |
| **总计** | **~1280 行** | **~5 天** |

### 8.5 依赖关系

```
plan 493 Phase A   (独立,无前置)
plan 493 Phase B   (前置: Phase A 的 MessageLog agentsDir 参数)
plan 493 Phase D   (前置: Phase A 路径层就位,但 schema 改动独立)
plan 491 P1.1      (无依赖,可并行)
plan 477 binding   (无强依赖:bot session id 已含 agentId,plan 493 自己解析)
plan 441 rebase    (无冲突:用新 event type 隔离)
plan 485 路径 helper (强复用:agent-paths.ts:25 getDuyaAgentsRoot)
plan 485 P2.1 upsert (强复用:deleteConfigAgent 在同文件追加 softDeleteConfigAgent)
```

### 8.6 验收覆盖度

| 验收项 | 是否覆盖 |
|---|---|
| 单元测试 | ✓ 每个 phase 1-2 个测试文件 |
| 集成测试(IPC 端到端) | △ 没明确写;建议加 `electron/ipc/__tests__/config-agents-soft-delete.test.ts` |
| typecheck | ✓ |
| vitest 全绿 | ✓ |
| 手动 smoke(创建 bot → 发消息 → /compact → rotate) | ✓ Phase B 验收 |
| 手动 smoke(soft delete → restore → purge) | ✓ Phase D 验收 |
| 跨平台(Windows + macOS + Linux) | △ 重点测 Windows rename |

### 8.7 决策日志锚点

- plan 491 决策日志加引用:**bot JSONL 物理隔离 + 按 generation rotate + 软删**落地
- plan 483 决策日志加引用:同上
- plan 477 binding 决策日志加引用:`boundThreadId` 现在通过 `<agentsDir>/<agentId>/sessions/active.jsonl` 的 `bot:<agentId>:` 前缀自动建立,**不需要额外 binding 写表逻辑**

### 8.8 自检结论

plan **总体完备**,可进入实施阶段。需要在实施前进一步确认的点:
1. `RolloutEvent` union 加 `RotationEvent` 是否影响 plan 441 已 ship 的版本(检查 `electron/agents/db-bridge.ts:509` 的 typed payload 是否需要更新)
2. `app.setInterval` 调度 vs UI 触发 vs boot 触发,**选 B + C 确认 OK**(详见 Phase D 4.6)
3. 软删宽限期 **30 天**是默认值还是暴露给用户设置?本轮默认 30 天、代码留 `purgeOpts.olderThanMs` override
4. `<agentsDir>/.deleted/` 是否在 OS 层隐藏(macOS chflags hidden,Windows SetFileAttributes)?本轮**不隐藏**(dot-prefix 是约定,不是强制),方便用户 finder 找到

## 9. 为什么不新开 package

### 9.1 packages/ 现有划分逻辑

duya 的 `packages/` 划分是按 **runtime domain / 进程边界**:

- `agent` —— Agent Server 的核心进程逻辑(所有 AI 对话),可独立打包成 CommonJS bundle
- `ai` —— 多协议 LLM 适配器(anthropic/openai/…)
- `cli` —— 独立 CLI 工具(`node packages/agent/dist/cli/index.js`)
- `computer-use` —— 屏幕上下文采集(独立 worker)
- `computer-use-demo` —— 用户测试 demo,完全独立
- `conductor` —— 多 agent 编排(plan 224 mode)
- `gateway` —— HTTP+SSE 通信
- `plugin-core` —— 插件系统
- `voice` —— 语音 I/O

每个 package 都有**独立的 build 目标**(tsc 输出到 `dist/`),独立 runtime,独立测试。

### 9.2 plan 493 的改动**不**符合"独立 runtime domain"标准

| 改动 | runtime domain | 适合独立 package 吗? |
|---|---|---|
| `MessageLog.resolvePath` 感知 bot id | 与 main/cron/room session 共享同一个 MessageLog | ✗ 拆 package 反而破坏共享 |
| `MessageLog.rotateArchive` | 同上 | ✗ 同上 |
| `agents.ts` 加 `softDeleteConfigAgent` | 与现有 `deleteConfigAgent` / `upsertConfigAgent` 同文件 | ✗ 同文件追加即可 |
| `agent-paths.ts` 加 helper | 已有 plan 485 helper,直接 import | ✗ 复用 |
| IPC handler 暴露 | `electron/ipc/db-handlers.ts` 已有 deleteConfigAgent handler | ✗ 同一文件追加 |
| UI drawer | `src/components/layout/sidebar/` 已有 bot section | ✗ 同侧栏 |
| `electron/db/migrations/` 加迁移 | SQLite migration 系统已存在 | ✗ 沿用 |
| Schema 加列( `agent_profiles` / `message_index` ) | SQLite migration 即可 | ✗ 沿用 |

**关键观察**:plan 493 的所有点都是**对现有设施的扩展 / 沿用**,没有引入新的 runtime domain、新进程、新 IPC surface、新 build target。**独立 package 只在需要独立 runtime / 独立 build / 独立部署 时才有价值**,否则徒增 boundary overhead(import cycle 风险、tsc 重启、typecheck 重复)。

### 9.3 plan 493 复用 vs 新建的最终清单

| 复用现有 | 新增 |
|---|---|
| `electron/config/agent-paths.ts` `getDuyaAgentsRoot` / `resolveDuyaAgentDir` | `MessageLog.rotateArchive()` 方法 |
| `electron/config/agents.ts` `upsertConfigAgent` / `deleteConfigAgent` 旁 | `softDeleteConfigAgent` / `restoreConfigAgent` / `listDeletedConfigAgents` / `purgeDeletedConfigAgents` 函数 |
| `electron/db/core/message-log.ts` `resolvePath` / `resolvePathOnDisk` / `appendBatch` | `RotationEvent` 类型(`rollout-events.ts` 扩展 union) |
| `electron/db/core/rollout-events.ts` `RolloutEvent` union | 4 个 IPC handler(`db-handlers.ts` 追加) |
| `electron/db/migrations/` 已有 migration 系统 | 1 条 migration(`migration-NN.ts`) |
| `electron/ipc/db-handlers.ts` 已有 `configAgents.delete` handler 旁 | `DeletedBotsDrawer` UI 组件 |
| `src/components/layout/sidebar/` 已有 bot section 旁 | `electron/config/agents-soft-delete.test.ts`(新测试) |
| `electron/db/core/__tests__/message-log.test.ts` 已有用例 | `electron/db/core/__tests__/message-log-rotation.test.ts`(新测试) |
| `electron/config/__tests__/agents.test.ts` 已有用例 | `electron/config/agents-soft-delete.test.ts`(新测试) |

**9 个复用,8 个新增,全部就地落地**,没有任何"新体系"。

### 9.4 何时**应该**考虑新开 package

如果未来出现以下场景,**才**需要新开 package:

- plan 491 P1.x 落地后,bot-direct 发送管线需要独立 worker 进程(plan 224 mode-orchestrator 模式)→ 新 `@duya/bot-runtime` package
- room session JSONL + multi-agent transcript 格式特殊,需要独立 schema → 新 `@duya/bot-transcript` package(注:`packages/agent/dist/bot-transcript/` 已经被某种程度预留)
- bot 工具集(plan 491 P1.x)需要独立 LLM tool registry → 新 `@duya/bot-tools` package

这三种情况都属于**新 runtime domain**,适合独立 package。plan 493 不在这个范围。
