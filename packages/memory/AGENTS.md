# @duya/memory

Memory V2 领域层。拥有磁盘布局、策展账本（curation ledger）与投影、rollout 租约、投影 outbox、stage-1 抽取流水线。**存储句柄由调用方注入**。

## 1. 负责 / 不负责

**负责**

- 记忆的磁盘布局（默认 `~/.duya/memory`）与目录解析。
- 策展账本：认领 / 完成一次 curation run、输入集合哈希、候选输入查询。
- rollout 租约（acquire / heartbeat / complete / fail）、投影 outbox（入队 / 排空）、DB↔文件对账。
- stage-1 抽取流水线与产物查询。

**不负责**

- Goal / Task / Run 概念 → 本包明确不知道这些（`packages/memory/src/index.ts:17-19`）。
- `memory-state.db` 的**表与迁移** → 桌面 app（`apps/desktop/src/main/memory-state/migrations/index.ts:42`）；本包只按调用方给的 schema 用。
- 记忆如何被召回进 prompt → `@duya/agent-runtime`。
- 通用 SQLite 连接与数据根解析 → `@duya/data`（`packages/data/src/data-paths.ts:24`）。

## 2. 关键文件

| 文件 | 作用 |
| --- | --- |
| `packages/memory/src/memory_paths.ts:16` | `getDuyaRoot()`；`getDuyaMemoryRoot():27`（默认 `~/.duya/memory`，可用 `DUYA_MEMORY_ROOT` 覆盖）。 |
| `packages/memory/src/memory_layout.ts:66` | `DEFAULT_LAYOUT`；`parseLayout:88`（解析用户自定义布局 JSON）。 |
| `packages/memory/src/curation_ledger.ts:114` | `claimRun`；`completeRun:182`、`queryEligibleInputs:353`、`computeInputSetHash:74`。 |
| `packages/memory/src/lease.ts:153` | `acquireLease`；`heartbeat:272`、`complete:331`、`fail:457`；`rollout_leases` 查询 `:188`。 |
| `packages/memory/src/outbox.ts:169` | `enqueueProjectionOutbox`；`drainOutbox:199`、`projection_outbox` 查询 `:209`、退避 `outboxBackoffMs:85`、路径安全 `assertSafe:127`。 |
| `packages/memory/src/extractor.ts:550` | `Stage1Extractor`；`stage1_outputs` 查询 `:606`。 |
| `packages/memory/src/eligibility.ts:39` | `SELECT_ELIGIBLE_SQL`；`selectEligible:95`、`diagnoseEligibility:172`；默认阈值 `:24-31`（limit 16 / idle 4 h / window 30 d / 至少 3 条消息）。 |
| `packages/memory/src/reconcile.ts:82` | `reconcileProjections()`——DB 与文件投影的对账；`purgeDegradedOutputs:220`。 |

公共面：`packages/memory/src/index.ts`（barrel）+ `packages/memory/src/testing/index.ts`；`packages/memory/package.json` 另有 19 个子路径导出。

## 3. 排障入口

| 症状 | 先看这里 | 为什么 |
| --- | --- | --- |
| 记忆没落盘 | `packages/memory/src/outbox.ts:209` + `packages/memory/src/reconcile.ts:82` | **文件只是 DB 的投影**；先看 `projection_outbox` 里有没有未排空的行。 |
| 记忆没被抽取 | `packages/memory/src/eligibility.ts:39` + `packages/memory/src/lease.ts:188` | 先过资格 SQL，再抢 rollout 租约；两处都过才会抽取。 |
| 抽取跑了但产物读不到 | `packages/memory/src/extractor.ts:606` | `stage1_outputs` 的 `rollout_slug` 查询在这里。 |
| 记忆目录位置不对 | `packages/memory/src/memory_paths.ts:27` | `DUYA_MEMORY_ROOT` 优先于默认路径。 |
| 布局解析失败 | `packages/memory/src/memory_layout.ts:88` | 自定义布局 JSON 的解析入口。 |

## 4. 边界约束

- `architecture-policy.yaml:624-627`：模块 `memory`，`managed: true`，`requires: [legacy-ai]`。
- **六个模块是私有的**（无声明子路径）：`compactMessages`、`curation_validator`、`prompt`、`stage1_prompt_loader`、`types`、`writer`——`packages/memory/tests/package-boundary.test.ts:249-254` 会因外部引用它们而失败。
- 记忆的**表与迁移不在本包**：`memory-state.db` 的 schema 由桌面 app 拥有（`apps/desktop/src/main/memory-state/migrations/index.ts:42`）。找表定义时去桌面 app，别在本包里挖。
