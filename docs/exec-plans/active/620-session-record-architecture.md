# 620 — 会话记录架构：单源分类学 + 落盘来源补全 + 语料自包含

状态：active · 实现待认领 · 更新：2026-10-21
当前集成分支：`codex/integrate-platform-handoffs` · base：`325cdded`（origin/master）
620 实现：待认领 · 集成授权：已给 · 尚未合并；本次没有读取 `~/.duya`、SQLite 或 rollout 文件。

关联：[619 提示词组装](./619-prompt-assembly-context-channel.md)（**Phase A 是 619 Phase 4 的硬前置**）·
[561 模型调用轨迹](../backlog/561-model-call-trace.md)（wire 层，边界见「目标与边界」）·
[582 会话归档加固](./582-session-archive-hardening.md)（存储与生命周期）·
[612 rollout 恢复加固](./612-rollout-recovery-hardening.md)（崩溃与索引损坏下的恢复能力）·
调查材料不随计划分发；本树仅记录源码级观察。

## 目标与边界

619 的代码调研提出了**会话记录架构**改进方向：rollout 分类定义分散在多个源码位置，增加记录类型时需要同步多个消费者。哪些类型存在于历史用户语料、记录体量和实际使用分布都尚未在本集成树验证。

本计划改三件事，用户可观察到的变化：

1. **加一种记录类型只改一处**（分类学单源），并有测试在任何一处漏改时直接红。
2. **运行时上下文注入落盘**：18 种 `RuntimeContextSource` 的注入从「只活在内存里」变成
   rollout 里可查的 `system_context` 行。
3. **语料自包含**：只用授权的匿名 fixture / 测试语料验证子代理血缘、compaction 摘要文件与 bash 全量输出位置的关联；不读取真实用户 `~/.duya` 数据。

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
| 抄 `atis-latch` / append-only 的 `custom-title` / `agent-name` | 保持范围外；历史语料影响未验证 |
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
- **V2**：在隔离的测试 session/worker fixture 中注入 AGENTS.md / memory / todo_gate，验证 `system_context` 行的 `kind` 与 `source`。
- **V3**：在隔离测试 fixture 中确认 `system_context` 写入及检索；不以真实用户 rollout 的计数作为门槛。
- **V4**：一条被截断的 bash 输出，其 rollout 行能直接读到全量文件路径；
  `metadata` 不再恰为 `{"source":"tool_use"}`。
- **V5**：只读 JSONL（不查 SQLite）能从一个子代理 rollout 找到父 sessionId。
- **V6**：`effectiveMessageTimeline`（`message-log.ts:2864`）与 `extractSearchableText`（:2651）
  对固定、匿名的测试 fixture 输出逐字不变；真实用户 rollout corpus 未读取。
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
- [ ] A7 按 schema、生产消费者与匿名 fixture 决定 `reasoning` / `tool_call` / `turn_started` / `system_context` / `compaction` 的兼容策略。历史 corpus presence 未验证；不得把“未发现写入者”当作删除依据。`turn_started` 的 `scan()` 与 `advanceRecencyOnTurnStart` 消费点需保留或替代。

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
      （容量基线待在授权的合成/匿名 fixture 上测量）。

**门禁**：V2 / V3 + `packages/host/tests` 无新失败。

### Phase C — 工具结果的结构面

- [ ] C1 `PERSISTED_METADATA_KEYS`（`ipc-message-adapters.ts:168-198`）放行 `outputFile`；用隔离 fixture 验证工具输出路径可与 rollout 行关联，不采集真实文件数量。
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
- [ ] D2 compaction 摘要文件与 rollout 的引用关系需通过 source-level 检查和匿名 fixture 验收；在 compaction 的 `rebase` 行里带上相对路径，不依赖真实用户目录普查。
- [ ] D3 对历史孤儿文件的存在、数量和清理范围另行立项；本计划不扫描、导入或删除真实用户数据。

**门禁**：V5 + V6。

## 发现与决策

### 源码观察（2026-10-21；未读取 rollout 文件、SQLite 或 `~/.duya`）

当前源码写入链路可从 `worker-session-runtime`、`Journal`、`worker-db-bridge` 到 `session-api` / `message-log` 追踪；运行时上下文当前走内存 timeline。rollout corpus 的历史行类型分布、文件数量和体积均未知，不把其他检出报告里的本机数字当作本分支证据。

本次 prompt observer 只产生 SHA-256 / 长度 / section 名称；无生产代码安装 callback、无 prompt snapshot writer，因此它不会产生会话记录。现有显式 prompt dump 是单独的本地调试行为，会写明文；不作为 rollout 或审计链路。
### D1 — 单源用「派生」还是「一致性测试」

**决策**：优先派生；派生不了的地方（`isRolloutEvent` 的内联字面量，受
`rollout-events.ts:186-190` 记录的 esbuild 约束）改用一致性测试，并在注释写明原因。
**理由**：A2 若强行派生，会撞上「vitest 的 esbuild 运行时丢跨模块 const 引用」这个已记录的坑，
把一个结构问题换成一个更难查的运行时问题。
**备选**：代码生成（build 步骤产出七处）。**裁定：不做**——引入构建期产物与源文件的第二份真相，
正是本计划要消除的东西。

### D2 — schema 是否可退役

**待验决策**：按 A7 分别检查 schema、生产消费者和匿名 fixture。源码中 `turn_started` 仍有 `scan()` / `advanceRecencyOnTurnStart` 消费点；没有已知生产写入者不足以证明它不存在于历史 corpus。未经单独授权，不读取真实用户 corpus。
### D3 — 被抑制的注入要不要留痕

裁定留一条不含全文的 `suppressed` 标记，使“本轮未注入”与“没有尝试注入”可区分。该语义须由隔离 fixture 验证；此前工作树报告的外部数据计数不作为本计划证据。
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
| R2 | 删除 schema 破坏兼容性 | V6 固定 fixture + source-level consumer 检查 | 恢复该 type（D2 的 Go/No-Go） |
| R3 | `system_context` 全文把 rollout 顶过 4 MB 闸门 | 隔离 fixture 的写入体积与轮转测试 | B4 的 hash 去重 + 配额；极端情况回退 B1 |
| R4 | `isDurableTimelineEntry` 改成报错后，HTTP POST 通道开始拒收既有客户端 | timeline POST 400 率 | A4 先只做计数告警，不改返回值 |
| R5 | 放行 `outputFile` 让 metadata 白名单变成「什么都放」 | code review | 只放这一个键，注释写明理由 |
| R6 | `architecture:check` 新增违规 | 门禁红 | 派生代码放已有文件，不新建跨包依赖 |
| R7 | 自己的改动被既有失败掩盖 | `npm test` 红但分不清 | 基线失败集见 619 §9.1，判定规则：新失败 ⊄ 基线 |

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `325cdded` source snapshot | Windows worktree | 源码级阅读 | 已核对计划范围与可见生产链路；未读取用户数据 | 本计划源代码引用 |
| `4f83de28` integration checkpoint | Windows | `npm run typecheck:all`; `npm run electron:build`; `npm run bundle:verify` | typecheck/build exit 0; bundle FRESH 0/1083 | 只证明集成分支门禁；不表示 620 Phase A–C 已实现 |
| `d8a0d306` worktree test | Windows + Git Bash | `npx vitest run scripts/remove-worktree.test.ts` | 14/14 passed | 非 Windows skip 缺 PowerShell 的平台专属 fixture，其余测试照常执行 |
| — | — | 本地 rollout / DB 扫描 | 未执行 | 本任务明确不读真实用户数据 |

旧工作树的 typecheck、architecture 或用户语料统计不作为当前分支证据。当前集成门禁仅记录可复现的构建结果；不读取真实 rollout / DB，也不声明 620 Phase A–C 已实现。
## 接续 / 结果

已实现：无（本文件为计划）；prompt observer 仅提供可选摘要接缝，不属于 620 交付。
已验证：源码级审查；无真实 DB / rollout 扫描，不声明历史语料分布。
本计划与目录登记行随集成分支提交；它们是计划，不是 620 实现。
副作用：无。

下一步：由 owner 认领 **A1**，先在固定测试中建立分类表单一权威，再按计划逐步覆盖消费者；任何需真实数据的验收先定义匿名化、访问和留存边界并单独授权。

集成状态：计划与 observer 接缝已进入集成分支；620 Phase A 实现仍待认领，PR / merge 状态以仓库为准。
