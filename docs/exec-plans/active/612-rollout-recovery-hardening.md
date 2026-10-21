# 612 — Rollout 恢复能力加固

> 起点：对标 Codex / MiniMax Code 的持久化策略后，盘点 `duya-core.db` 在
> 崩溃与索引损坏场景下的实际恢复能力，补齐缺口。

**状态**：Active — Phase 1 实现中，Phase 2/3 待决策。

---

## 0. 起点结论（已核实，非推测）

对标结论：**duya 的存储内核与 Codex 同构**（rollout JSONL 权威 + SQLite 索引），
且在分代文件、精确随机读、rebase 事件、凭据 vault 分离上**强于**两者。
因此本计划不是「改成它们的架构」，而是补三个真实缺口。

已核实的既有能力（不要重复实现）：

| 能力 | 位置 | 结论 |
| --- | --- | --- |
| 单 session 索引重建 | `message-log.ts:1286` `scan()` | 已有，但要求 DB 已知 `rollout_path` |
| 全库对账 | `message-log.ts:1838` `reconcileAll()` | 已有，**已扫文件系统**，产出 `orphanFiles` |
| 路径失效后按 id 找回 | `message-log.ts:2500` `findRolloutFileBySessionId` + `:2480` `adoptRolloutPath` | 已有 |
| 投影侧可重建 | `message_search` 表（`message-log.ts:439`） | 物化表，可从文件重建 |
| 软删除 | `host/src/session-api.ts:598` | `status='deleted'`，**文件与行都保留** |

关键推论：软删除意味着**已删会话永远不是孤儿**（行还在），所以孤儿文件
只可能来自「DB 损坏/丢失」，正好是我们要救的场景 —— 孤儿收养不会复活已删会话。

---

## 1. 缺口

### G0 — `appendBatch` 静默丢弃部分 rollout 事件（实施中新发现，最严重）

**这一条是写 G1 测试时偶然撞出来的，不是事先计划的。**

`message_index.created_at` 是 `NOT NULL`。`TurnStartedEvent` 的时间戳字段叫
**`startedAt`，没有 `createdAt`**（`agent-protocol/src/rollout-events.ts:63-70`）。
`appendBatch` 直接绑定 `ev.createdAt`（原 `message-log.ts:582`），于是该值是
`undefined` → 触发 NOT NULL 约束 → 而语句用的是 **`INSERT OR IGNORE`**，
**NOT NULL 违规被 SQLite 静默忽略，不抛异常、不写日志**。

后果：事件行**照常写进了 rollout 文件**，却**永远拿不到索引行**。文件与索引
从此不一致，而 `listBySession` 走的是索引 + `readRange`，读不到该行。

实测（见 `message-log.test.ts` 新增用例）：

| 输入 | 文件行 | 索引行 |
| --- | --- | --- |
| 2 个 `turn_started` | `["e-only-1","e-only-2"]` | `[]` |
| `e,msg,e,msg` | 4 行 | 2 行（只有消息） |

排查过程中排除的假设（都实测证伪，别重复走）：

- ✗ schema 有 CHECK 约束 —— dump `sqlite_master` 确认没有
- ✗ 存在触发器 —— `type='trigger'` 查询为空
- ✗ `UNIQUE(session_id, seq)` 冲突 —— 手工执行同一条 INSERT 得 `changes:1`
- ✗ 事务内才失败 —— 事务内手工插入 `turn_started` 同样 `changes:1`
- ✓ **`insert.run()` 的 `changes` 返回 0**，`createdAt` 实测为 `undefined`

关键不一致：`scan()` 一直用的是容错助手 `rolloutLineTimestamp(entry)`
（`createdAt` → `startedAt` 回退），而 `appendBatch` 用裸字段。同一条时间戳
规则，两条路径各写一份，**安全性只存在于调用方**。

已实施修复：

1. `appendBatch` 改用 `Number.isFinite(ev.createdAt) ? ev.createdAt : rolloutLineTimestamp(ev.payload)`，
   与 `scan()` 对齐，把防线移到 store 边界
2. `insert.run()` 返回 `changes === 0` 时打 WARN（`freshEvents` 已预先排除
   已知 id，所以 0 变更只可能是约束拒绝），把静默丢失变成可见事件

**生产可达性（如实界定）**：已知的 Host 写入路径
`session-api.ts:763`（`appendTimeline`）本来就用 `rolloutLineTimestamp`，
所以**该路径当前不会触发**。但这个安全性只由调用方保证，且
`appendBatch` 还有 `forkAt`、`appendRebase`、`legacy-import` 等多个调用方。
本条定性为**store 边界防御缺失**，而非「线上正在丢数据」。

### G1 — `scan()` 丢失 `turn_id`（真缺口，非 bug 修）


`MessageEntry` **没有** `turnId` 字段（`agent-protocol/src/message-timeline.ts`），
turnId 只存在于 `reasoning`/`tool_call`/`turn_started`/`system_context` 事件上。
正常追加走 `message-log.ts:2140` 的 `ev.turnId ?? null`，而 `scan()` 在
`:1318` 硬编码 `null`。

按 `TurnStartedEvent` 的注释（"the `message_index.turn_id` column is a query
convenience, not the source of truth"）写 null 本身没错，但后果是：
**一次崩溃恢复后，该 session 全部行的 `turn_id` 变 null**，turn 级查询静默退化。

修复方向：`scan()` 按行顺序跟踪最近一次 `turn_started` 事件的 `turnId`，
用它回填后续行。rollout 文件对 turn 边界是自描述的，这条信息本来就够。

### G2 — `reconcileAll()` 报了 `orphanFiles` 但没人收养（功能缺口）

`reconcileAll()` 走完 `sessions/` 与 `agents/` 后把无主 `.jsonl` 塞进
`stats.orphanFiles` 就结束了。没有任何调用方消费它。DB 丢失 → 所有 session
变孤儿 → 数据不可发现。

**阻塞约束**：`resolvePath()`（`:2192`）用 `sanitizeFilenameSegment(sessionId)`
生成文件名，该函数（`:2604`）把 `[<>:"/\|?*\x00-\x1f]` 全部替换为 `-`，
**不可逆**。UUID 形式的 sessionId 不含这些字符，映射是恒等的，可以安全反推；
`cron:<uuid>:<ts>:<uuid>` 这类 legacy id 会变成 `cron-uuid-ts-uuid`，反推出来的
id 是错的。

→ 收养必须**只接受可证明恒等的 id 形状**（见 Phase 2），其余显式拒绝并上报，
不得猜测。

### G3 — 全链路无 fsync（三家共同的真洞）

`packages/data/src` 全包 grep 不到 `fsync`/`fdatasync`。追加走
`fs.appendFileSync`（`message-log.ts:2224`）与 `fs.writeSync`（`:1812`）。
Codex 同样只有 `flush()`，`sync_all` 只出现在 zstd 压缩产物上。

这不是「落后于谁」，是**语义未声明**：现在无法回答「最近这轮对话落盘了吗」。
Phase 3 处理。

---

## 2. 相位

### Phase 1 — G0 + G1（本次实现）✅

- [x] G0：`appendBatch` 时间戳回退，与 `scan()` 共用 `rolloutLineTimestamp`
- [x] G0：索引行被约束拒绝时打 WARN，不再静默
- [x] G1：`scan()` 跟踪最近 `turn_started` 事件的 turnId，回填索引行
- [x] G1：未出现 `turn_started` 的历史行保持 `null`（不猜）
- [x] 测试 fixture 补 `recency_at` / `last_turn_started_at`
      （`advanceRecencyOnTurnStart` 会写这两列，原 fixture 缺列导致
      任何带 turn 的用例都会炸 `no such column`）

**变异验证**（两个改动分别回退，确认测试变红）：

| 回退 | 杀掉的测试 |
| --- | --- |
| `createdAt` 回退 → `ev.createdAt` | `indexes turn_started events whose timestamp lives in startedAt` + `scan rebuilds turn_id…` |
| 删除 `turn_started` 回填 | `scan rebuilds turn_id…` |

`message-log.test.ts`：33 passed / 33。


### Phase 2 — 孤儿收养（需决策后再做）

- [ ] 从文件名反推 sessionId，**仅接受可逆形状**
- [ ] 反推不可靠 → 计入 `unrecoverableFiles` 并 WARN，不创建行
- [ ] 重建 session 行 + `adoptRolloutPath` + `scan()`
- [ ] 标题无来源 → 用首条 user 消息截断，标记为 recovered

### Phase 3 — 耐久语义显式化

- [ ] turn 边界 fsync（不做每行 fsync）
- [ ] Host 层暴露 `durability: 'buffered' | 'synced'`

---

## 3. 明确不做

- 不引入 `manifest.json` 发现层（Codex/minimax 的做法）。duya 的 `sessions`
  表同时承载 `archivedAt` / `recencyAt` / `extensions` 等**不在文件里**的用户
  状态，DB 不可能整体变可丢弃。目标收窄为「**时间线可恢复**」，
  不是「DB 可丢弃」—— 两者是不同的命题。
- 不复活 main 库里 LEGACY FROZEN 的 trigram FTS（属另一个议题，见 P2 检索）。
- 不动凭据存储。duya 的 `tokens.vault` + `safeStorage` 强于对标两者。

---

## 4. 验收

- `npm run typecheck:all` **在本机未能跑通**，阻塞项与本改动无关：
  - `@types/chokidar` 在根 `package.json` / `packages/host/package.json` /
    `package-lock.json` 中**均不存在**，而
    `packages/host/src/worker-os-context/watcher.ts` 导入了 `chokidar`。
    这是仓库自身缺陷，任何干净克隆都会 TS7016，`npm ci` 也修不了。
  - `node-pty` 无预编译产物需源码编译，本机 VS 缺 Spectre 缓解库
    （MSB8040），`electron-builder install-app-deps` 因此失败。
- 已实际通过的门禁：
  - `npx tsc --noEmit -p packages/data/tsconfig.json` → **exit 0**
    （本改动的源码所在项目）
  - `npx tsc --noEmit -p apps/desktop/tsconfig.main.json` →
    报错中**没有任何一条指向 message-log**（改动文件干净）
  - `npx vitest run apps/desktop/src/main/db/core/__tests__/message-log.test.ts`
    → **33 passed / 33**
- 新增测试已用变异注入兑现（见上），不是「跑一遍是绿的」。

