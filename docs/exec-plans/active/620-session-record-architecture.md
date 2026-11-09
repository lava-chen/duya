# 620 — 会话记录架构：单源分类学 + 落盘来源补全 + 语料自包含

状态：active · 未认领 · 更新：2026-10-21
分支：`wip/619-session-recording` · worktree：`C:\Users\lavachen\.qoder-cn\worktrees\app\e6af42\duya`
base：`325cdded`（origin/master）· owner：待认领 · 集成：未授权 / 未合并

关联：[619 提示词组装](./619-prompt-assembly-context-channel.md)（**Phase A 是 619 Phase 4 的硬前置**）·
[561 模型调用轨迹](../backlog/561-model-call-trace.md)（wire 层，边界见「目标与边界」）·
[582 会话归档加固](./582-session-archive-hardening.md)（存储与生命周期）·
[612 rollout 恢复加固](./612-rollout-recovery-hardening.md)（崩溃与索引损坏下的恢复能力）·
原始调查：`docs-local/research/session-record-taxonomy/report.md`（不入库）

## 目标与边界

619 的调研暴露的不是提示词问题，是**会话记录架构**问题：duya 的 rollout 分类学被手抄七处，
加一种记录的成本高到实际上没人加，于是 6 个 rollout event type 里 4 个成了死 schema，
而真正需要的记录（注入上下文、system prompt、usage、授权、子代理血缘）从来没有被加进去。

本计划改三件事，用户可观察到的变化：

1. **加一种记录类型只改一处**（分类学单源），并有测试在任何一处漏改时直接红。
2. **运行时上下文注入落盘**：18 种 `RuntimeContextSource` 的注入从「只活在内存里」变成
   rollout 里可查的 `system_context` 行。
3. **语料自包含**：只读 `~/.duya/sessions/**.jsonl` 就能还原子代理血缘、compaction 摘要文件、
   bash 全量输出的位置，不需要再查 SQLite 或猜时间邻近。

### In scope

| 路径 | 改什么 |
| --- | --- |
| `packages/agent-protocol/src/rollout-events.ts` | 分类学权威；派生 `ROLLOUT_EVENT_TYPES` / `isRolloutEvent` |
| `packages/data/src/message-log.ts` | `EventKind` / `deriveKind` / `extractSearchableText` 从权威派生 |
| `packages/host/src/http-server.ts` | `isDurableTimelineEntry` 从权威派生；`default: return false` 的不对称破口 |
| `packages/host/src/worker-journal/{types,Journal}.ts` | 镜像与 emit 方法从权威派生；`hook_invoked` 的定位 |
| `packages/host/src/worker-session-runtime.ts` | `_appendRuntimeContextToTimeline:1153-1175` 接上 journal |
| `packages/host/src/ipc-message-adapters.ts` | `PERSISTED_METADATA_KEYS:168-198` 放行工具输出的关联键 |
| `packages/capabilities/src/ShellCommandTool/BashTool.ts` | 截断标记结构化（当前是带内自由文本） |
| `apps/desktop/src/main/db/core/__tests__/rollout-events.test.ts` | 唯一的防漂移测试，扩成七处全覆盖 |

### Out of scope（每项写理由）

| 不做 | 理由 |
| --- | --- |
| provider wire 逐调用轨迹、`model_call` 行、`visible` 一等字段 | 561 的范围；620 只补 host 组装层与消息层的来源 |
| system prompt 全文落盘（`prompt_snapshot`） | 619 Phase 4  owns；620 只提供它依赖的单源分类学 |
| 会话树 / `parentUuid` / 分支一等结构 | `_appendMessageToTimeline:1146` 与 `_appendRuntimeContextToTimeline:1167` 都硬写 `parentId: null`；改成树要重写投影与 compaction 语义，是另一个量级。分支现状由 `rebase` + `threadMeta.branched` 表达，语义可用 |
| 单调序号 / 全局排序键 | 同上，属会话树范围。现状 `project():1124` 按行位置重推 seq，与 `message_index.seq` 并存，是已知二元性但不是本计划的痛点 |
| JSONL 侧 fsync / 文件与索引原子化 / 崩溃恢复 | `message-log.ts:16-20` 显式声明不原子，恢复靠 `scan():1308` / `reconcileAll():1873`。改原子性与恢复能力属 612，归档与生命周期属 582 |
| 抄 Claude Code 的 `attachment` 信封 | 619 的 context rail 已用 `<system-reminder>` + reminder taxonomy 覆盖同一需求；再引入一套信封就是第二份真相 |
| 抄 `atis-latch` / append-only 的 `custom-title` / `agent-name` | 纯噪声：427 条 `{"atis":""}`，以及同一事实写 N 遍只有最后一遍有效 |
| 引入轮转上限 | `NON_BOT_ROTATION_THRESHOLD_BYTES`（`message-log.ts:118`）是闸门不是上限，只在 `rotateNonBotArchive:1752` 生效。改成真上限属 582 |
| UI 审计面板 | 561 Phase 6 |
| 改 `.architecture-baseline.json` / `architecture-policy.yaml` | 根规则禁止为消音加指纹 |

## 验收

门禁（每 Phase 结束都跑，退出码记进「验证记录」）：

```bash
npm run typecheck:all        # 含 check:encoding / check:manifest-keys / check:test-coverage
npm run architecture:check   # 棘轮，.architecture-baseline.json 无新增
npx vitest run apps/desktop/src/main/db/core/__tests__/rollout-events.test.ts
npx vitest run packages/host/tests packages/agent-protocol/test packages/data 2>&1 | tail -40
```

编号断言：

- **V1（存在理由，必须验）**：把一个新 type 只加进 `rollout-events.ts` 的权威定义，
  七处派生点全部自动跟上；`rollout-events.test.ts` 在**任何一处漏改时红**。
  真机验法：临时删掉 `isDurableTimelineEntry` 的一个 case，测试必须失败。
- **V2**：一次真实会话里注入 AGENTS.md / memory / todo_gate 各一次，
  rollout JSONL 出现对应 `system_context` 行，`kind` 与 `source` 一致。
- **V3**：`grep -c '"type":"system_context"' <rollout>` > 0（今天是 0）。
- **V4**：一条被截断的 bash 输出，其 rollout 行能直接读到全量文件路径；
  `metadata` 不再恰为 `{"source":"tool_use"}`。
- **V5**：只读 JSONL（不查 SQLite）能从一个子代理 rollout 找到父 sessionId。
- **V6**：`effectiveMessageTimeline`（`message-log.ts:2864`）与 `extractSearchableText`（:2651）
  对**既有 1121 个 rollout 文件**的输出逐字不变（回归红线，用抽样对拍）。
- **V7**：`npm test` 新失败集 ⊆ 基线失败集（基线见 619 §9.1）。

## 进度

### Phase A — 分类学单源（619 Phase 4 的硬前置）

- [ ] A1 在 `rollout-events.ts` 把 type 清单收成一处可派生的权威（判别式联合 +
      一个 `ROLLOUT_EVENT_KINDS` 常量表），保留 `:186-190` 关于 vitest/esbuild 丢
      `satisfies` 的注释约束——派生方式必须在 esbuild 运行时仍然成立。
- [ ] A2 `ROLLOUT_EVENT_TYPES:191` 与 `isRolloutEvent:201-221` 改为从 A1 派生；
      若 esbuild 约束让内联字面量无法消除，改为**测试断言内联清单与权威一致**，
      并在注释里写明为什么不能派生。
- [ ] A3 `message-log.ts:59` `EventKind` 与 `deriveKind:2644` 从权威派生。
- [ ] A4 `http-server.ts:5172` `isDurableTimelineEntry` 从权威派生；
      `default: return false`(:5215) 改成「未知 type 显式报错」或至少计数告警——
      今天它让 HTTP POST 整批 400（:3783-3784），而进程内 worker 通道完全跳过这个守卫。
- [ ] A5 `worker-journal/types.ts:27-51` 镜像从权威派生；顺带裁定 `hook_invoked`(:45)：
      它只存在于镜像，protocol 的 `isRolloutEvent` 里没有它，一旦发出 `deriveKind:2644`
      会抛 TypeError 并被吞成 `{success:false, reason:'transaction_failed'}`
      （`worker-db-bridge.ts:402-404`）。生产者 `Journal.hookInvoked`(`Journal.ts:83`)
      的调用方只有 `packages/agent/src/journal/__tests__/journal.test.ts:145,244,281,321`。
- [ ] A6 扩 `rollout-events.test.ts` 成七处全覆盖（V1）。
- [ ] A7 裁定死 schema：`reasoning`:25 / `tool_call`:43 / `turn_started`:64 /
      `system_context`:78 / `compaction` 在盘上都是 0 行。
      **建议**：`system_context` 保留（Phase B 要用）；`turn_started` 保留但标注
      （`scan()` 的轮恢复与 `advanceRecencyOnTurnStart:2452` 依赖它，删了这两个函数变死码）；
      `reasoning` / `tool_call` / `compaction` 删除——`message-log.ts:514-522` 已经明说
      「nothing in the production path emits `type:'compaction'` anymore」，
      而 `effectiveMessageTimeline:2864` 对 `compaction` 的分支是不可达代码。
      删除前用 V6 的对拍证明 1121 个文件里没有这些行。

**门禁**：`typecheck:all` + `architecture:check` + `rollout-events.test.ts` 绿。

### Phase B — 运行时上下文落盘

- [ ] B1 `_appendRuntimeContextToTimeline`（`worker-session-runtime.ts:1153-1175`）今天只调
      `this.timeline.appendMessage(...)`；`timeline` 是 `MessageTimeline`（:829，来自
      `@duya/agent-core/message`，agent-core 零 IO）⇒ **纯内存，永不落盘**。
      接上 `journal`，走既有 `journal:emit` 通道（`worker-db-bridge.ts:381-405`）发
      `system_context` 行。**不新建通道、不新建文件。**
- [ ] B2 覆盖 18 种 `RuntimeContextSource`（`packages/agent-protocol/src/message-timeline.ts:22-40`）：
      `agents_md` / `attachment` / `background_notification` / `mailbox` / `memory` / `mode` /
      `system` / `todo_gate` / `working_directory_switch` / `auto_continue` / `goal_summary` /
      `research_continuation` / `dead_loop_nudge` / `premature_stop` / `send_message_reminder` /
      `goal_reply_fingerprint` / `goal_continuation` / `custom`。
- [ ] B3 `_hasAttachmentRuntimeContext`（:1176-1201）的去重语义要在落盘后仍然成立：
      被抑制的注入**不写行**，或写一条 `suppressed` 标记（裁定项 D3）。
- [ ] B4 体积自保：`system_context` 带全文，AGENTS.md 与 memory 可能很大。
      与 619 Phase 4 共用「同 hash 不重复写全文」策略，避免 4 MB 闸门被顶穿
      （盘上已有 27 个文件超阈值）。

**门禁**：V2 / V3 + `packages/host/tests` 无新失败。

### Phase C — 工具结果的结构面

- [ ] C1 `PERSISTED_METADATA_KEYS`（`ipc-message-adapters.ts:168-198`）放行 `outputFile`。
      今天 `BashTool.ts:488/497/528` 把 `outputFile` 放进 metadata，白名单把它丢掉，
      盘上真 tool_result 的 metadata 恰为 `{"source":"tool_use"}` ⇒
      3,032 个 `duya-bash-<taskId>.log` 与 rollout **无法关联**。
- [ ] C2 `truncateShellOutput`（`BashTool.ts:73`，阈值 `BASH_MAX_OUTPUT_CHARS = 30_000`:65 /
      `BASH_MAX_OUTPUT_LINES = 1_000`:66）把截断事实**以自由文本写在带内**
      （"Full output saved to: …"）。改为结构化标记（`truncated` / `appliedLimit` /
      `totalLines` / 全量路径），带内文本保留给模型看，结构面留给记录。
- [ ] C3 溢出文件 `~/.duya/bash-outputs/duya-bash-full-<uuid>.log` 的命名与 sessionId 无关，
      跨会话不可归属；至少在 rollout 行里记下绝对路径（C1 已覆盖）。

**门禁**：V4 + `packages/capabilities` 测试无新失败。

### Phase D — 语料自包含

- [ ] D1 子代理血缘今天只在 SQLite（`session_spawn_edges`，`core-stores.ts:950-954`，
      migration id=9）⇒ JSONL 不自包含。在父与子的 rollout 各写一条边记录
      （复用 `system_context` 的 `kind`，或 A7 之后新增一个 type——**优先复用**，
      因为新增 type 的成本正是本计划要消除的东西）。
- [ ] D2 131 个 `*-compaction.md` 没有任何东西引用（只能靠 sessionId + 时间邻近猜）。
      在 compaction 的 `rebase` 行里带上该文件的相对路径。
- [ ] D3 `~/.duya/sessions` 里 4 个 `*-api.jsonl`（2.7 MB，全 2026-07-26）是已移除的
      调试构建的孤儿，当前树与历史里都没有写入者；6 个名为 `bot` 的 0 字节文件同源。
      记进本计划的「发现」，清理动作归 582。

**门禁**：V5 + V6。

## 发现与决策

### 现状实证（2026-10-20/21 核对，全部带 file:line）

写入链路：

```
_pushDurable (worker-session-runtime.ts:1211)
  → _commitDurable (:1278)         role switch 只有 user / assistant / tool (:1287-1297)
  → _appendMessageToTimeline (:1136-1152)   parentId 硬写 null (:1146)
  → Journal.{userMsgAdded,assistantMsgFinalized,toolResultAdded} (Journal.ts:61-76)
  → JOURNAL_MESSAGE_FIELDS 白名单 (Journal.ts:280-310)
  → messageDb.append → 'message:append' → worker-db-bridge.ts:315-343
  → appendTimeline (session-api.ts) → appendBatch (message-log.ts:476-635)
rollout event 另走 'journal:emit' (worker-db-bridge.ts:381-405)，逐字转发
运行时上下文走 _appendRuntimeContextToTimeline (:1153-1175) —— 只进内存 timeline
```

盘上普查（`~/.duya/sessions`，1121 个 rollout / 599 MB）：

| type | 行数 | 判定 |
| --- | --- | --- |
| `message` | 104,591 | 唯一活口 |
| `rebase` | 51 | 活（compaction / edit-resend） |
| `rotation` | 11 | 活 |
| `compaction` | 0 | 死 schema，`message-log.ts:514-522` 已自述 |
| `reasoning` | 0 | 死 schema |
| `tool_call` | 0 | 死 schema |
| `turn_started` | 0 | 死 schema，但 `scan()` 与 `advanceRecencyOnTurnStart:2452` 依赖它 |
| `system_context` | 0 | 死 schema，**Phase B 要复活它** |
| `hook_invoked` | 0 | 只在镜像里，protocol 缺位，发出即 TypeError |
| codex 遗留五类 | 7,028 | 仅 2026-07 的历史导入数据，当前树零引用 |

分类学七处手抄（一个防漂移测试守着）：
`rollout-events.ts`（union :25/:43/:64/:78/:103/:159 + `ROLLOUT_EVENT_TYPES`:191 +
`isRolloutEvent`:201-221 内联字面量）→ `message-log.ts`（`EventKind`:59 + `deriveKind`:2644 +
`extractSearchableText`:2651 + `effectiveMessageTimeline`:2864）→ `http-server.ts`
（`isDurableTimelineEntry`:5172，`default: return false`:5215）→ `worker-journal/types.ts`:27-51
→ `packages/host/bundle/worker-entry.js`（重新打包）→ 生产者 → 三个测试文件。

从不记录的东西：system prompt（只有 `DUYA_DUMP_PROMPT*` 的本地 txt，无 session/run/turn 关联）·
provider wire · 每次调用的 token usage（在 `JOURNAL_MESSAGE_FIELDS` 白名单处丢掉）·
cache 统计与成本 · 运行时上下文注入（18 种 source）· 授权决策 · 模式变更（只走 SSE）。

### D1 — 单源用「派生」还是「一致性测试」

**决策**：优先派生；派生不了的地方（`isRolloutEvent` 的内联字面量，受
`rollout-events.ts:186-190` 记录的 esbuild 约束）改用一致性测试，并在注释写明原因。
**理由**：A2 若强行派生，会撞上「vitest 的 esbuild 运行时丢跨模块 const 引用」这个已记录的坑，
把一个结构问题换成一个更难查的运行时问题。
**备选**：代码生成（build 步骤产出七处）。**裁定：不做**——引入构建期产物与源文件的第二份真相，
正是本计划要消除的东西。

### D2 — 死 schema 删还是留

**决策**：分三种处置，见 A7。**理由**：`turn_started` 虽然 0 行，但删了会让
`scan()` 的轮恢复与 `advanceRecencyOnTurnStart` 变死码，那是**扩大**死码面而不是收缩。
`compaction` 相反：`effectiveMessageTimeline:2864` 对它的分支已被 `rebase` 取代，属真死码。
**Go/No-Go**：删除前必须用 V6 对拍证明 1121 个文件里 0 行；出现任何一行就改为保留 + 标注。

### D3 — 被抑制的注入要不要留痕

**决策**：留一条不带全文的 `suppressed` 标记。**理由**：Claude Code 的 `attachment` 有
20 条「算了但被抑制」（`rendered`/`renderedRole` 皆无），这个状态本身是有用信号——
`_hasAttachmentRuntimeContext`(:1176-1201) 的去重命中意味着「模型这轮没看到它」，
排障时正是最需要知道的事。
**备选**：完全不写。**裁定：不采纳**，因为「没写」与「没发生」在 rollout 里不可区分。

### D4 — 与 619 / 561 的顺序

**决策**：**620 Phase A 先于 619 Phase 4**；619 Phase 0–3 不受影响，可并行。
**理由**：619 Phase 4 要新增 `prompt_snapshot`，如果先做，它自己就变成第八处手抄，
把本计划要修的结构问题加重一层。
561 在 620 之后：561 记 wire 层逐调用轨迹，需要 `visible` 一等字段与 payload 全文，
那是 620 单源化之后才好加的东西。

### D5 — 不引入会话树

**决策**：本计划不做 `parentUuid` / 树头指针 / 分支一等结构。
**理由**：`parentId` 在两个写入点都硬写 null（:1146、:1167），改成树要重写投影
（`project():1124` 按行位置重推 seq）与 compaction 语义。收益（分支可视化）与本计划的
收益（可审计、可关联）正交，混在一起会让两者都验不干净。

## 风险

| # | 怎么坏 | 怎么发现 | 怎么回滚 |
| --- | --- | --- | --- |
| R1 | 派生改动让 esbuild 运行时丢常量引用，`isRolloutEvent` 静默恒假 | A2 的单测 + `rollout-events.test.ts` | 退回内联字面量 + 一致性测试（D1 备选） |
| R2 | 删死 schema 删掉了某个历史文件里真有的行 | V6 对拍 1121 个文件 | 恢复该 type（D2 的 Go/No-Go） |
| R3 | `system_context` 全文把 rollout 顶过 4 MB 闸门 | 文件增速监控；盘上已有 27 个超阈值 | B4 的 hash 去重 + 配额；极端情况回退 B1 |
| R4 | `isDurableTimelineEntry` 改成报错后，HTTP POST 通道开始拒收既有客户端 | timeline POST 400 率 | A4 先只做计数告警，不改返回值 |
| R5 | 放行 `outputFile` 让 metadata 白名单变成「什么都放」 | code review | 只放这一个键，注释写明理由 |
| R6 | `architecture:check` 新增违规 | 门禁红 | 派生代码放已有文件，不新建跨包依赖 |
| R7 | 自己的改动被既有失败掩盖 | `npm test` 红但分不清 | 基线失败集见 619 §9.1，判定规则：新失败 ⊄ 基线 |

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `a3ab102f`（本计划提交前） | Windows 10.0.26200 / Node v24.18.0 | `npm run architecture:check` | 0 | 2921 违规全部已基线化，baseline size 2801，无新增 |
| `a3ab102f` | 同上 | `node scripts/check-test-coverage.mjs` | 0 | 修好 master 遗漏的 baseline 条目后（见「接续」） |
| — | 同上 | 盘上普查 `~/.duya/sessions`（1280 文件） | — | 行数与体积见「现状实证」 |
| — | 同上 | 七处手抄与死 schema 的 file:line 核对 | — | 全部逐条 grep 复核，非二手转述 |

## 接续 / 结果

已实现：无（本文件是计划，不含代码改动）。
已验证：现状实证部分的每条 file:line 都在 `a3ab102f` 的工作树上逐条 grep 复核过。
未提交路径：本文件 + `catalog.md` 的登记行 + 619 的边界补写。
副作用：无。

下一步（一条可开始执行的动作）：**A1**——在 `packages/agent-protocol/src/rollout-events.ts`
把六个 type 的判别式收成一处可派生的权威，先不动任何派生点。
完成判据：`rollout-events.test.ts` 绿，且 `npm run typecheck:all` 退出码 0。

回收：owner 未退出，成果未合并，worktree 保持原位。
