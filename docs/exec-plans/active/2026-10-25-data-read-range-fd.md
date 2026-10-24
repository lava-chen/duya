# 消息读路径：一次打开文件读完整个会话，不再逐行 open/close

状态：active · 负责人：mavis 会话 `mvs_ae3b38275b13437883faa5ef6f4d518c` · 更新：2026-10-25
分支：`codex/read-range` · worktree：`E:\Projects\duya\.claude\worktrees\read-range` · base：`379d990b` · owner：mavis

## 目标与边界

用户能观察到的变化：打开一个长会话时，投影消息的等待时间下降。

允许修改的路径：

- `packages/data/src/message-log.ts`（`readRange` 的 fd 复用 + `listBySession` 的读循环）
- `packages/data/tests/message-log-read-range.test.ts`（新增测试）

本次不做：

- bot 世代布局的读路径（`listBySession` 里按 generation 分文件的分支，读的是多个文件）—— 单独评估
- `readAll` / `scan` 的整文件读取
- Host bridge 与 `session-api` 的分页层（另一条线）

关联：性能爬坡计划 `2026-10-23-desktop-performance-hill-climbing.md`；
同批的两条写路径线：[写路径点查](2026-10-25-data-append-index-lookup.md)（PR #456）、
[rollout 换桶](2026-10-25-data-rollout-bucket.md)（PR #462）。

## 根因

`listBySession` 投影一个会话时，对**每一条**消息都调一次 `readRange`：

```ts
entry = JSON.parse(this.readRange(absolutePath, row.file_offset, row.byte_len)) as RolloutLine;
```

而 `readRange` 自己开一次文件、读一次、关一次：

```ts
const fd = fs.openSync(absolutePath, 'r');
try { ... fs.readSync(fd, buf, 0, len, offset); ... }
finally { fs.closeSync(fd); }
```

一个 8000 条消息的会话 → 8000 次 `openSync` + 8000 次 `readSync` + 8000 次 `closeSync`。
其中 open/close 与消息内容无关，纯粹是重复的文件句柄开销。

基线（真实 `MessageLog`，WAL + 真实文件，同机同环境，3 轮取中位数）：

| 场景 | 耗时中位数 | 样本 |
| --- | --- | --- |
| `listBySession` 8000 条 | 656ms | 734 / 645 / 656 |
| `listBySession` 2000 条 | 167ms | 162 / 167 / 178 |

## 改动

把文件句柄提到读循环之外：**打开一次，读 N 次，关一次**。

- 读到的字节完全不变：每个区间仍在自己的 offset 上读，长度不变
- 文件打不开时（文件缺失等）保持原行为：每行各自失败、各自记 warn 后跳过
- 单行解析失败（坏行）仍然跳过该行并记 warn，不影响其它行

## 验收

1. `npm run typecheck:all` 退出码 0。
2. `npm run architecture:check` 退出码 0，不新增 tolerated。
3. `npm run bundle:verify` 为 `FRESH`。
4. 受影响测试全绿：断言只覆盖不变量，不设耗时阈值。
5. 新增测试锚定两件事：投影结果与改动前一致（含坏行跳过、文件缺失的行为），
   以及读路径不再为每行单独打开文件。

## 进度

- [x] 定位根因：逐行 open/close
- [x] 基线测量
- [x] 实现 fd 复用
- [x] 新增测试（4 条）+ 变异验证（回退后 1 条转红）
- [x] 受影响集 8 文件 / 116 断言全过
- [ ] 三门禁 + 重建 bundle + 开 PR

## 验证记录

基准用真实 `MessageLog` 类、WAL + 真实文件；同机同环境，每场景 3 轮取中位数。

| 场景 | 基线中位数 | 改后中位数 | 变化 |
| --- | --- | --- | --- |
| `listBySession` 8000 条 | 656ms | 68ms | −90% |
| `listBySession` 2000 条 | 167ms | 26ms | −84% |

原始样本：8000 条基线 `[734, 645, 656]` / 改后 `[67, 68, 88]`；
2000 条基线 `[162, 167, 178]` / 改后 `[27, 26, 26]`。

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| dirty（packages/data） | Windows / Node 24.16 | `vitest run packages/data/tests/message-log-read-range.test.ts` | 0 | 1 文件 / 4 断言全过 |
| dirty（packages/data） | Windows / Node 24.16 | 变异验证：reader 改回逐行 open/close | 1 | 「只开一次」断言转红（26 次 open），3 条语义断言仍绿 |
| dirty（packages/data） | Windows / Node 24.16 | `vitest run`（message-log / rotation / portability / source-filter / session-archive / session-fork / legacy-import / read-range） | 0 | 8 文件 / 116 断言全过 |

## 接续 / 结果

已实现：`openRangeReader` 一次打开 rollout 文件、在整个投影过程中复用该句柄；
`listBySession` 的读循环改用它。文件打不开时回退到原来的逐行 open/read/close，
每行各自失败的行为不变。

已验证：新增 4 条断言全过并经变异验证；受影响集 8 文件 / 116 断言全过；同机多轮
中位数基准显示投影 8000 条消息从 656ms 降到 68ms。

未提交路径：待提交。
副作用：无。
阻塞：无。

下一步：跑三门禁 + 重建 bundle + 开 PR（不合并，待用户授权）。
