# 消息写路径：rollout 文件按日期桶落地，不再每批改名

状态：active · 负责人：mavis 会话 `mvs_ae3b38275b13437883faa5ef6f4d518c` · 更新：2026-10-25
分支：`codex/rollout-bucket` · worktree：`E:\Projects\duya\.claude\worktrees\rollout-bucket` · base：`686f3c81` · owner：mavis

## 目标与边界

用户能观察到的变化：长会话里每条新消息到达时的落盘延迟不再随会话长度增长；rollout 文件名不再每批跳动。

允许修改的路径：

- `packages/data/src/message-log.ts`（`getOrCreateRolloutPath` 的换桶判定 + 新增桶比较helper）
- `packages/data/tests/message-log-rollout-bucket.test.ts`（新增测试）

本次不做：

- `readRange` 逐行 open/read/close
- Host bridge 的 `readMessages` 分页（依赖已合并的 #444）

关联：性能爬坡计划 `2026-10-23-desktop-performance-hill-climbing.md` 的剩余瓶颈之一；
上一条线 [2026-10-25 写路径点查](2026-10-25-data-append-index-lookup.md)（PR #456）。

## 根因

`resolvePath` 生成的路径是
`sessions/<yyyy>/<mm>/<dd>/rollout-<ISO 毫秒戳>-<sessionId>.jsonl`——**文件名带毫秒级时间戳**。

`getOrCreateRolloutPath` 用 `existing !== desired` 判断「路径变了」：

```
const desired = this.resolvePath(sessionId, createdAt);   // 每批 lastActivity 变 → stamp 变
const existing = this.getRolloutPath(sessionId);
if (existing && existing !== desired) { ... this.moveRollout(...) }
```

`createdAt` 取本批消息的最大 `createdAt`，每批都不同 → `desired` 每批都不同 → 判定恒成立。
于是**每批 append 都**：

- `moveRollout`：`existsSync` → `mkdirSync` → `renameSync` → `UPDATE sessions SET rollout_path`
- 把同一个文件重命名成一个新名字（旧名消失，目录里文件数不变）

代码注释与意图写的是「Date bucket changed (cross-midnight session) — move the file」，
即**只在跨午夜换桶时移动**；但实现比的是整条路径，把「桶变了」误判成「任何变化都变」。

CPU profile 归因：`renameSync` 11.8% + `moveRollout` 3.6% + `existsSync` ~12% + `mkdirSync` ~7%
≈ **38% 是文件系统开销**；`appendBatch` 自身 28.9%、`sqliteTransaction` ~11%。

## 改动

把「是否移动」的判定从**整条路径不同**收紧为**日期桶不同**：

- 桶相同 → 保留现有路径，不改名、不 UPDATE
- 桶不同（跨午夜）→ 仍然 `moveRollout`，行为与今天一致
- `active.jsonl`（generation 布局）→ 保持不动，与今天一致
- 无法识别的布局（legacy 扁平路径、bot 绝对路径）→ 保守按「桶不同」处理，行为与今天一致

语义不变的部分：首写路径仍含精确时间戳（`message-log.test.ts:136`/`:150`/`:602`）、
漂移恢复仍取最新 stamp（`:472-526`）、跨午夜仍换桶（`:607`）。

可观察的行为变化：同一天内，一个会话的 rollout **文件名不再随每批消息跳动**，固定为首写
时刻的 stamp。这正是「桶决定归属、文件名只是标签」的意图。`findRolloutFileBySessionId`
按 stamp 取最新候选的语义不受影响：跨午夜会在新桶留下一个新文件，新文件的 stamp 更大。

顺带修掉同一条写路径上的另一处重复探测：`ensureFile` 原来每批先 `mkdirSync` 再检查
文件是否存在，而文件几乎总是已经存在。改成先探测文件——文件在就说明目录也在，直接
返回；文件不在才建目录并写空文件。语义等价（文件被外部删掉时仍然会被重建）。

## 验收

1. `npm run typecheck:all` 退出码 0。
2. `npm run architecture:check` 退出码 0，不新增 tolerated。
3. `npm run bundle:verify` 为 `FRESH`。
4. 受影响测试全绿：断言只覆盖不变量，不设耗时阈值。
5. 新增测试锚定三件事：同桶不再改名（路径与文件都不动）、跨午夜仍然换桶、无法识别的
   布局仍然移动。

## 进度

- [x] 定位根因：路径比较的粒度错了，不是 `MAX(seq)` 也不是 seq 分配
- [x] 实现桶粒度判定
- [x] `ensureFile` 先探文件再决定建目录，省掉每批的目录创建
- [x] 新增测试（4 条）+ 变异验证（回退后 2 条转红）
- [x] 受影响集 8 文件 / 116 断言全过
- [x] 三门禁 + 重建 bundle + 开 PR（#462，未合并，待用户授权）

## 验证记录

基准用真实 `MessageLog` 类、WAL + 真实文件；同机同环境，每场景 3 轮取中位数
（机器有其它任务在跑，单轮数字噪声很大）。

| 场景 | 基线中位数 | 改后中位数 | 变化 | `rollout_path` 变化次数 |
| --- | --- | --- | --- | --- |
| 1 会话 × 4000 条 / 每批 4 条 | 2804ms | 1155ms | −59% | 1000 → 1 |
| 20 会话 × 1000 条 / 每批 4 条 | 25868ms | 8223ms | −68% | 5000 → 20 |

原始样本：1×4000 基线 `[1840, 2804, 3495]` / 改后 `[1147, 1155, 2148]`；
20×1000 基线 `[14753, 25868, 26941]` / 改后 `[8223, 7973, 8387]`。

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| dirty（packages/data） | Windows / Node 24.16 | `vitest run packages/data/tests/message-log-rollout-bucket.test.ts` | 0 | 1 文件 / 4 断言全过 |
| dirty（packages/data） | Windows / Node 24.16 | 变异验证：桶判定改成「总是视为不同桶」 | 1 | 2 条稳定性断言转红（路径被改名、40 次变化），2 条语义断言仍绿 |
| dirty（packages/data） | Windows / Node 24.16 | `vitest run`（message-log / rotation / portability / source-filter / session-archive / session-fork / legacy-import / rollout-bucket） | 0 | 8 文件 / 116 断言全过 |
| head `51cdbc1a`（clean） | Windows / Node 24.16 | `npm run typecheck:all` | 0 | 无新增类型错误（206 known / 102 key(s)） |
| head `51cdbc1a`（clean） | Windows / Node 24.16 | `npm run architecture:check` | 0 | total 2721 = tolerated 2721，baseline 2530 未变 |
| head `51cdbc1a`（clean） | Windows / Node 24.16 | `npm run bundle:verify` | 0 | FRESH，0/948 bundle inputs 在 bundle commit 后变更 |

## 接续 / 结果

已实现：`getOrCreateRolloutPath` 的移动判定从「整条路径不同」改为「日期桶不同」
（新增 `isDifferentDateBucket`），同桶的批次直接复用现有路径；`ensureFile` 先探测
文件再决定是否建目录。

已验证：新增 4 条断言全过并经变异验证；受影响集 8 文件 / 116 断言全过；同机多轮
中位数基准显示写路径耗时降 59%–68%，`rollout_path` 变化次数从「每批一次」降到
「每会话一次」。

未提交路径：无。
副作用：无。
阻塞：无。

下一步：等 PR #462 的 CI 绿，然后申请合并授权（不自行合并）。
