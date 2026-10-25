# 消息写路径：appendBatch 的去重检查按批点查，不再全量扫会话索引

状态：active · 负责人：mavis 会话 `mvs_ae3b38275b13437883faa5ef6f4d518c` · 更新：2026-10-25
分支：`codex/data-write-path` · worktree：`E:\Projects\duya\.claude\worktrees\data-write-path` · base：`554f24b1`（已合入 `origin/master` `3b3e6470`）· owner：mavis

## 目标与边界

用户能观察到的变化：长会话里每条新消息到达时的落盘延迟不再随会话长度增长。

允许修改的路径：

- `packages/data/src/message-log.ts`（`appendBatch` 的去重检查 + 新增 `getIndexedIdsIn`）
- `packages/data/tests/message-log-append-index.test.ts`（新增测试）

本次不做：

- `readRange` 逐行 open/read/close（另一条 PR）
- Host bridge 的 `readMessages` 分页（依赖未合并的 PR #444）
- `getOrCreateRolloutPath` 每批重算路径导致的 `moveRollout` 反复重命名（见「发现与决策」，属另一条 PR）
- `prepare()` 语句编译开销（每批 13 次，线性，非本次瓶颈）

关联：性能爬坡计划 `2026-10-23-desktop-performance-hill-climbing.md` 的剩余瓶颈之一。

## 验收

1. `npm run typecheck:all` 退出码 0。
2. `npm run architecture:check` 退出码 0，不新增 tolerated。
3. `npm run bundle:verify` 为 `FRESH`（改了 `packages/data/src/**`，必须在同变更重建 bundle）。
4. 受影响测试全绿：断言只覆盖不变量，不设耗时阈值。
5. 新增测试锚定两件事：语义等价（跨 session 的 id、批内重复 id、seq 连续），以及去重检查不再发全量扫查询。

## 进度

- [x] 定位瓶颈：CPU profile 归因，不是预设的 `MAX(seq)` 分配
- [x] `getIndexedIdsIn`：按批内 id 集合走主键点查
- [x] `appendBatch` 改用点查；import 路径同样改用点查
- [x] 删除失去调用点的 `getIndexedIds`
- [x] 新增测试（6 条）+ 变异验证（回退优化后 2 条转红）
- [x] 受影响集 7 文件 / 112 断言全过
- [x] 三门禁 + 重建 bundle + 开 PR（#456，未合并，待用户授权）

## 发现与决策

- **预设方案被实测推翻。** 原计划是「事务内单次 `MAX(seq)` 替代每行子查询」。实测
  `SELECT MAX(seq) ... WHERE session_id = ?` 走 `idx_index_session` 覆盖索引，单次 0.001ms，
  4 行一批的整段 insert 只要 0.019ms——**不是瓶颈**，改它零收益。真正的 O(N²) 是
  `getIndexedIds` 的全量扫。方案因此改为只改去重检查。
- **全量扫的代价随会话长度线性增长。** `SELECT id FROM message_index WHERE session_id = ?`
  每次 append 读一遍该会话全部 id（N 行），会话有 N 条消息时累计读 O(N²) 行。
  实测 10000 行时 1.45ms/次，50000 行时 8.33ms/次。
- **点查走的是主键索引，不是会话索引。** `WHERE id IN (...)` 命中
  `sqlite_autoindex_message_index_1`（`id` 是 `TEXT PRIMARY KEY`），实测 8 个 id 只要
  0.007ms——比全量扫快约 200×。
- **不能写成 `WHERE session_id = ? AND id IN (...)`。** 实测该写法规划器仍选
  `idx_index_session(session_id=?)`，退化成全量扫（0.797ms vs 0.007ms）。改为只按 `id` 点查，
  在 JS 侧按 `session_id` 过滤。
- **`id` 是全局主键，别的 session 的 id 也会命中**，所以 JS 侧过滤 `session_id` 是语义必需的，
  不是优化。测试覆盖了这一点：别的 session 已有的 id 不会挡住本 session 的写入。
- **批内重复 id 只写一次**这条语义在改写时差点丢失（初版用 `filter` 会保留重复项），
  已用 `emittedIds` 恢复，并用测试锚定。
- **点查在大批量下反而更慢。** 实测 N=10000、B=10000 时点查 8.37ms vs 全量扫 1.38ms
  （点查每 id 一次 B-tree 查找）。compaction 会重发整个消息列表（B≈N），这是点查的最坏情况。
  仍选点查：B=N 是罕见路径且只慢几毫秒，而 B≪N 是常态且快两个数量级。
- **`moveRollout` 每批重命名 rollout 文件**（CPU profile 15.4%）是**另一条独立的瓶颈**，
  由 `getOrCreateRolloutPath` 每批重算含毫秒时间戳的路径导致。它改变可观察的文件名与
  `sessions.rollout_path`，且跨午夜语义有测试锁定，不在本 PR 混进来。
- **`MAX(seq)` 分配确实无需改**：原实现每行一个相关子查询，但覆盖索引让它足够快。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| base `554f24b1`，dirty（packages/data） | Windows / Node 24.16 | `npx vitest run packages/data/tests/message-log-append-index.test.ts` | 0 | 1 文件 / 6 断言全过 |
| dirty（packages/data） | Windows / Node 24.16 | 变异验证：把点查换回全量扫后重跑同一文件 | 1 | 2 条性能断言转红，4 条语义断言仍绿 |
| dirty（packages/data） | Windows / Node 24.16 | `npx vitest run`（message-log / rotation / portability / source-filter / session-archive / session-fork / legacy-import） | 0 | 7 文件 / 112 断言全过 |
| dirty（packages/data） | Windows / Node 24.16 | 基准：真实 `MessageLog`，单会话 8000 条 / 每批 4 条 | 0 | 5957ms → 3029ms（−49%）；2000 条 951ms → 710ms（−25%） |
| head `cafcb4d8`（clean） | Windows / Node 24.16 | `npm run typecheck:all` | 0 | 206 known / 102 key(s)，无新增类型错误 |
| head `cafcb4d8`（clean） | Windows / Node 24.16 | `npm run architecture:check` | 0 | total 2721 = tolerated 2721，baseline 2530 未变 |
| head `cafcb4d8`（clean） | Windows / Node 24.16 | `npm run bundle:verify` | 0 | FRESH，0/948 bundle inputs 在 bundle commit 后变更 |
| head `cafcb4d8`（clean） | Windows / Node 24.16 | `vitest run`（message-log / rotation / portability / source-filter / session-archive / session-fork / legacy-import / append-index） | 0 | 8 文件 / 118 断言全过 |
| head `e1389a8b`（合入 master 后，clean） | Windows / Node 24.16 | `npm run typecheck:all` / `npm run architecture:check` / `npm run bundle:verify` | 0 / 0 / 0 | 无新增类型错误；total 2730 = tolerated 2730，baseline 2530 未变；FRESH 0/950 bundle inputs 变更 |
| head `ca192654`（合入含 #466 的 master 后，clean） | Windows / Node 24.16 | `npm run typecheck:all` / `npm run architecture:check` / `npm run bundle:verify` | 0 / 0 / 0 | 无新增类型错误；architecture total 2730 = tolerated 2730；FRESH 0/950 bundle inputs 变更 |
| head `ca192654`（clean） | Windows / Node 24.16 | `vitest run`（message-log 等 7 个 + append-index / rollout-bucket / read-range） | 0 | 10 文件 / 126 断言全过 |

## 接续 / 结果

已实现：`getIndexedIdsIn`（按批内 id 集合走主键点查，JS 侧按 `session_id` 过滤，分块 400），
`appendBatch` 与 `importContinueFromFile` 两处去重检查改用它，删除失去调用点的 `getIndexedIds`。

已验证：新增 6 条断言全过并经变异验证；受影响集 8 文件 / 118 断言全过；基准单会话 8000 条
耗时减半；三门禁（typecheck / architecture / bundle:verify）在 head `cafcb4d8` 上全绿。

未提交路径：无。
副作用：无。
阻塞：无。

下一步：等 PR #456 的 CI 绿，然后申请合并授权（不自行合并）。
