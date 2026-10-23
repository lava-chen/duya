# 619 — 提示词组装改造：单串 system + 消息通道分流 + rollout 留痕

> **Status**: Active · **Priority**: P0 · **Owner**: /root/app_closeout (observer slice)
> **立项**: 2026-10-20（复盘：Claude Code 的原始 transcript 暴露了它的提示词注入模型——
> system prompt 是**分段数组**，易变上下文走**独立注入通道**，每次注入**留痕**。duya 的结构
> 几乎全有：分段数组、`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`、`PromptSegment` 的 id/placement、
> 多 block 的 `ModelMessageProjection.system`、reminder 的 channel/lifecycle taxonomy、
> 第二通道的 hash 去重——但**全被 join 掉或从未被消费**。）
> **前置基座**: 550/551/557（.hbs 模板与模块注册表）、567（reminder source taxonomy）、
> 408（AGENTS.md 进 system）、561（模型调用轨迹，backlog）
> **硬前置**: [620 会话记录架构](./620-session-record-architecture.md) **Phase A**
> （分类学单源）——Phase 4 要新增 `prompt_snapshot` 行类型，而今天加一种记录类型要在
> **七处**锁步手抄。先做 Phase 4 就是亲手造出第八处。619 的 Phase 0–3 不受此约束，可并行。
> **与 561 / 620 的边界**: 见 §7。**不重复它们的事**。`codex/integrate-prompt-observer` 基于 `325cdded`；observer 仅提供可选 hash 接缝，尚无生产 sink、rollout 写入或真实会话采样。

---

## 0. 一句话目标

把 duya 的提示词组装改成「**一条稳定的 system 串 + 消息通道承载易变上下文 + rollout 逐轮留痕**」
三层结构，对齐 Claude Code 的注入模型；并在同一轮里修掉调研挖出的 8 个既有缺陷。

### 0.1 当前实现边界

当前代码只提供 opt-in 的逐段 SHA-256 回调；生产路径没有安装 observer，因此不会采集摘要，也没有 `PromptSnapshot` / rollout writer。`DUYA_DUMP_PROMPT_SECTIONS=1` 是独立的显式本地调试路径，会把分段明文写入调用方指定目录，不代表 session recording。任何全文落盘前，必须先定义数据分类、脱敏、保留期限、访问与导出边界；本轮不启用该路径或扫描真实用户数据。

---

## 1. 用户已定约束（不可推翻）

- **A**：system 仍是一条**字符串**。不动 `packages/ai` 的 `ChatOptions`、不动任何 provider 的
  wire 形状、不做多 cache breakpoint。收益来自「易变内容移出 system → system 串每轮字节
  相同 → 缓存命中」。
- **B**：留痕**记全文**（system 全文 + 注入块全文），但需两条自保控制：同 hash 不重复写 +
  可选配额（否则 4MB 轮转阈值立刻触发）。
- **C**：8 个既有缺陷**全部顺手修掉**。

---

## 2. 硬不变量（验收红线）

| # | 不变量 | 证明方式 |
| --- | --- | --- |
| I1 | system 字段仍是一条字符串，wire 形状不变 | `packages/ai` 零改动 |
| I2 | 同一会话内 system 串字节逐轮相同（除 §3.3 例外清单） | Phase 0 逐段 hash 表 + Phase 2 跨轮相等断言 |
| I3 | 易变上下文每轮都带且**不堆积**（恰好 1 份，内容为最新） | 连续 3 次请求的消息断言 |
| I4 | 每轮把 system 全文 + 注入块全文写进 rollout JSONL | 3 轮 → 3 条记录 |
| I5 | rollout 体积不触发非 bot session 的 4MB 轮转 | 100 轮压测增量 < 200KB |
| I6 | `npm run typecheck:all` + `npm run architecture:check` 绿，且 `.architecture-baseline.json` **无新增** | CI（棘轮只减不增） |
| I7 | 不新增 `npm test` 失败 | 基线失败集 ⊇ 新失败集 |

---

## 3. 架构设计

### 3.1 三通道模型

```
┌─ system 通道（provider system 字段，单串）───────────────────────────────┐
│  identity → prefix → [稳定段] → AGENTS.md 正文 → bot 段 → deferred     │
│  tool protocol → TOOL_GROUP_PROGRESS_INSTRUCTIONS                      │
│  目标：会话内字节恒定 ⇒ cache 断点命中                                  │
└─────────────────────────────────────────────────────────────────────────┘
┌─ context 通道（provider user turn，尾部，工作数组，不入持久历史）────────┐
│  <system-reminder> environment | mcp | skills | memory | sessionGuidance│
│                   | vision | mcp_catalog | apps | outputFormat          │
│                   </system-reminder>                                     │
│  目标：每轮重渲染 + 每轮替换；永不堆积                                   │
└─────────────────────────────────────────────────────────────────────────┘
┌─ rollout 通道（JSONL 审计行 prompt_snapshot）──────────────────────────┐
│  systemPrompt{hash,length,content} + contextBlocks[{id,source,role,…}]  │
│  目标：可审计 + 体积可控                                                │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.2 归类判据与归类表

**判据（三条同时满足才进 context 通道）**：

1. **事实性**——内容是「当前世界的状态/清单」，不是「应该怎么做」的行为规则。行为规则留在
   system（模型对 system 段的指令权重最高；Claude Code 的 `# Doing tasks` /
   `# Executing actions with care` / `# Tone and style` 全在 system）。
2. **会话内会变**——该段/块的字节在一次会话的多轮之间**可能**不同。
3. **每轮都需要**——模型每一轮都得读到它；放在 system 之外不会降低可见性（context 通道走
   user role + `<system-reminder>` 包裹）。

**留在 system**：identity / system / destructiveActions / configProtection / tools / tasks /
skillUsage / duyaDesktopContext / finalAnswer / identityCoding / systemCoding /
duyaDesktopContextCode / projectContinuity / personality / workingWithTheUser / rules /
toneAndStyle / researchProfile / taskIntent / evidencePolicy / memoryWriteProposal /
platform / scratchpad / identity block / systemPromptPrefix / bot 段 / deferred tool protocol /
TOOL_GROUP_PROGRESS_INSTRUCTIONS / **AGENTS.md 正文**（项目指令权重最高，Claude Code 的
CLAUDE.md 同款位置；改动频率极低）。

**进 context 通道**：`environment`（cwd 切换、模型切换 → knowledgeCutoff 变）、`mcp`
（MCP 连接变化）、`skills`（skill 装卸）、`memory`（后台 memory worker 更新 summary.md）、
`sessionGuidance`、`vision`、`outputFormat`(research)、MCP capability catalog
（`worker-session-runtime.ts:1556`）、Apps 段（`:1564`）。

> **这张表是待验证的初始假设，不是结论。** 最终裁定以 Phase 0 的逐段 hash 实测为准。

### 3.3 system 串的例外清单

| 例外 | 触发 | 影响 |
| --- | --- | --- |
| `options.systemPrompt` 覆盖 | 调用方传入 | 整串变（外部行为，本就如此） |
| `options.systemPromptPrefix` | 调用方传入 | 前缀变 |
| agent profile 切换（identity block） | 用户换 profile | 前缀变 |
| mode prefix | 进入/退出 mode | 前缀变 |
| AGENTS.md 正文变化 | 文件被编辑 | 串尾变化 |
| bot 段变化 | bot 配置/memory tier 变化 | 串尾变化 |
| tool 集合变化（`tools` 段若留 system） | deferred 发现新工具 / mode 注入工具 | 段内变化 |

这些例外都会导致**一次**缓存重建，属可接受的「真实状态变化」。Phase 0 的观测就是确认
**除这些之外**没有别的抖动源。

---

## 4. 分阶段实施

### Phase 0 — 观测接缝（只加观测，不改行为）

- `packages/host/src/worker-prompts/observer.ts` 提供进程级 `setPromptObserver`；已安装时按 section 计算 SHA-256 摘要，未安装时生产者跳过 hash 计算。
- `PromptSystem` 和 `worker-session-runtime` 在实际组装处报告逐段摘要；callback 异常被隔离，不得影响 prompt 结果。
- `DUYA_DUMP_PROMPT_SECTIONS=1` 可显式写分段调试文件；它包含明文，和 observer / rollout 记录分开评估。
- 具名测试覆盖摘要、字节不变、无 observer 行为和 observer 抛错时 prompt 不变。

**当前状态**：接缝和定向测试已加入本分支；没有生产 sink，因此尚无真实会话 hash 表。Phase 0 的产品采样验收仍未完成，不能据此决定 Phase 1 的上下文归类。

---
### Phase 1 — 修 8 个既有缺陷（见 §5）

落地 (b) 的「只加告警」部分与 (c)(d)(e)(f)(g)(h)；(a) 留到 Phase 2（与分区一起，否则
「缓存生效」与「字节恒定」互相打架）。

**实施记录（2026-10-22 · 分支 `codex/619-phase1-prompt-defects` · base `8ebda627`）**

本次落地 7 项，(g) 拆出单独排期（见下），(a) 仍留 Phase 2：

| 缺陷 | 落地形态 | 行为变化 |
| --- | --- | --- |
| (c) | `isSectionEnabled` 改成 **disable 优先**（`modes/index.ts`） | 仅「两个列表都给」的 profile 变；顺带与 `resolveEnabledSections`（本来就是 enable 减 disable）对齐 |
| (d) | `SUBAGENT_TYPE_PROFILE_MAP` / `DEFAULT_SUBAGENT_PROFILE` 的段名改成真实存在的 `memory` / `vision`，删掉 `memoryContent` / `widgetGuidelines` / `visionGuidelines`；加防漂移测试（遍历 4 个 config 的段名集合断言） | 是——子代理**真的**少了 memory 与 vision 段（此前是空操作） |
| (e) | 删掉 code / research config 里的 `projectInstructions` 段与 4 处失效的 `invalidateCacheKeys`（`'project'` / `'projectInstructions'` 都不是活的缓存键；AGENTS.md 正文根本不经 PromptCache）；每份指令文件的 glob 适用性改挂到正文标题上 | 是——code / research profile 的 system 少了一段索引 |
| (f) | 新增 `shouldInjectMcpCatalog(exposure)`，host 与 legacy agent 两个调用点都改调它 | 是——默认 `hint` 下 legacy 路径不再注入 MCP 目录（此前与 host 路径不一致） |
| (h) | 抽出 `composeModePrompt(base, prefixes, suffixes, ctx)`，`applyModes` 与 `refreshTurnSystemPrompt` 都改调它；字符串前缀统一用空行连接，函数前缀仍自己控制 | 是——多两个换行，一次性缓存重建；**修好了 turn 0 与 turn N 的 system 字节必然不同**这条 |
| (b) | 结构化 system 块被丢弃时计数并 `logger.warn`（不改行为） | 无（仅可观测） |

**(g) 单独排期**：`BOT_BASIC_SYSTEM_PROMPT` 在 host 路径被丢弃（`bot/framework.ts` 显式
`includeBasic:false`）。恢复它会直接改 bot 的模型人格（system prompt 变长数 KB），需要
独立的对比与灰度，不混在这次 bug 修复里。

### Phase 2 — PromptSystem 分区 + 缓存修复

- `PromptSystem.ts:119-191` `SectionDef` 新增 `placement?: 'system' | 'context'`（默认
  `'system'`）——与 `cachePolicy` 正交，不能复用。
- `PromptSystem.ts:462-486`：`placement:'context'` 强制 `cachePolicy:'every-call'`，否则抛错。
- `PromptSystem.ts:493-538`：新增
  `buildSystemPromptPartition(context): Promise<{stable: string[]; context: string[]; digest}>`；
  `buildSystemPrompt` 保留原签名供 legacy 调用方。
- `types.ts:394` + `PromptSystem.ts:533`：**删除 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 的写入**
  （只写不读、还被 join 进送模型的文本）。
- `configs/{general,code,research,bot}.ts`：逐段标 `placement`（取值以 Phase 0 实测为准）。
- `worker-session-runtime.ts:1520-1625`：`_buildSystemPrompt` 拆成 system 路 / context 路。
- **system 路相对顺序必须与今天逐字一致**（identity → prefix → stable → AGENTS.md → bot →
  deferred → tool-group-progress），用单测锁死。

### Phase 3 — Context Rail 注入（消息通道）

- **新** `packages/host/src/worker-context/context-rail.ts`（该目录已存在，不新增架构违规）：
  `ContextBlock{id,source,role,content}` + `applyContextRail(messages, blocks, opts)`。与
  `packages/host/src/worker-hooks/injection.ts:245-282` 同构，但**用独立 metadata key
  命名空间**（`contextRailKey`/`contextRailHash`）——现有 hook rail 的去重是「全数组扫同
  hash」，共用 hash 空间会互相误命中。
- `packages/agent-core/src/context/reminder-sources.ts`：注册新 source `volatile_context`
  （`{channel:'mid_turn', lifecycle:'per_request', persisted:false}`）。taxonomy 是穷尽
  `Record`，不注册会抛错。
- `packages/agent-core/src/context/reminders.ts:33-42`：新增
  `renderUserChannelReminder(body, source)`——user 通道加「这不是用户说的话」免责说明
  （Claude Code 做法）。**只给新 rail 用**，不改现有 hook rail 字节。
- `worker-session-runtime.ts`（`:865-866` 旁）：`private contextRailBlocks: ContextBlock[] = []`，
  session 级、**每轮整体覆盖**（不是 append）。
- `worker-session-runtime.ts:2199-2236`：在 hook 注入之后调用 `applyContextRail`（provider
  请求的真实消息路径：`worker-run-composition.ts:229-246` → `projectTurnMessages()` →
  `_projectModelMessages`）。rail **无条件**注入，不挂在 `injectHookContexts` 开关下。
- 注入位置：**尾部**（在 hook rail 之后）——与生产已验证的 hook rail 位置一致，不改历史前缀。
- 机制：工作数组每次从 `timeline.snapshot()` 重新投影，rail 块不在 timeline 里 ⇒ 每请求恰好
  1 份、不可能堆积、compaction 后自动重建、持久记录干净。块消失时旧块被移除。

### Phase 4 — Rollout 留痕（记全文 + 体积控制）

> **前置**：[620 Phase A](./620-session-record-architecture.md) 必须先落地。A 完成后本 Phase 的
> 「同步七处」缩成「在权威处加一个 type」；A 未落地就动手，`prompt_snapshot` 自己会变成第八处手抄。

- **新行类型 `prompt_snapshot`**（加在权威处 `packages/agent-protocol/src/rollout-events.ts`，
  不是 worker 侧镜像）：`{type,id,turnId,createdAt,systemPrompt:{hash,length,content?,
  contentOmitted?},contextBlocks:[{id,source,role,hash,length,content?,contentOmitted?}],
  overridden?}`。
- 同步点（**620 A 之后应全部自动派生，此处保留清单只为在 A 未落地时兜底**）：
  `ROLLOUT_EVENT_TYPES`（`rollout-events.ts:191`）、`isRolloutEvent` 的**内联字面量**
  （`:201-221`，`:186-190` 注释说明 vitest/esbuild 会丢跨模块 const 引用）、
  `packages/data/src/message-log.ts:59` `EventKind` + `deriveKind:2644`
  （`message_index.kind` 是裸 TEXT 无 CHECK，**无需迁移**）、
  `packages/host/src/http-server.ts:5172` `isDurableTimelineEntry`
  （`default: return false` 在 `:5215`；不加则 HTTP 端点整批 400 `invalid_timeline_entries`，
  见 `:3783-3784`）、`packages/host/src/worker-journal/types.ts:27-51` 镜像、
  重新打包 `packages/host/bundle/worker-entry.js`。
- **不越界**：`hook_invoked` 只在镜像里存在（`worker-journal/types.ts:45`），protocol 缺位，
  真发出来 `deriveKind` 会抛 TypeError——归 620 A5 裁定，本计划不碰。
- **新** `packages/host/src/worker-context/prompt-ledger.ts`：per-session 状态
  `{lastSystemHash, blockHashes, fullWrites}`；`record(turnId, systemPrompt, blocks)`。
  **变化才写全文**（约束 B 的自保控制之一）+ 可选配额 `DUYA_PROMPT_LEDGER_MAX_FULL`
  （默认 0=不限）+ 单行截断上限。
- 写入通道复用 `Journal` → `messageDb.emit` → `journal:emit` → `appendTimeline` →
  `appendBatch`（**不新建通道、不新建文件**）。
- 体积测算：稳态 100 轮 = 1 次 system 全文（~30KB）+ 变化时的块全文 + 100×~400B 元数据
  ≈ 30–80KB，离 4MB 阈值两个数量级余量。

### Phase 5 — 度量与收口

- 生产采样：同 session 内 `prompt_snapshot.systemPrompt.hash` 的 distinct 值 = 1（例外清单除外）。
- provider 侧 cache 命中率对比 Phase 2 前后。
- 更新 `docs/exec-plans/README.md` Active 表 + `ARCHITECTURE.md` 增补「提示词三通道」小节。

### Phase 2–4 实施记录（2026-10-23 · 同一分支 `codex/619-phase1-prompt-defects`）

Phase 2 与 Phase 3 必须同一个 commit：把 volatile 段标成 `placement:'context'` 而
host 侧还没接分区时，那些段会**从 system 串里消失**——中间态是坏的。

| Phase | 落地形态 | 备注 |
| --- | --- | --- |
| 2 | `SectionDef.placement`（`'system'` 默认 / `'context'`）；`buildSystemPromptPartition()` 拆两路；`buildSystemPrompt()` 保留原签名给 legacy 调用方；4 个 config 逐段标注；**删除 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`**（只写不读、还把哨兵文本送进模型） | 标注与 §3.2 的归类表一致 |
| 2 | 缓存三件套：`PromptsRegistry` 按 (config, profile) 共享实例；缓存键带**上下文指纹**（`contextFingerprint.ts`，覆盖会影响渲染的全部 ctx 字段，排除 `sessionStartTime`）；`promptProfileKey()` 分桶 | 只做「共享实例」会造成陈旧缓存——工具集变了缓存仍给旧字节 |
| 3 | **新** `packages/host/src/worker-context/context-rail.ts`；agent-core 注册 `volatile_context` source + `renderUserChannelReminder`（user 通道加「不是用户说的话」免责句）；rail 每轮整体覆盖、块消失即移除、独立 metadata key 命名空间 | 位置在尾部（hook rail 之后）；不进 timeline |
| 4 | **新** `packages/host/src/worker-context/prompt-ledger.ts`；`Journal.promptSnapshot()` 走 `journal:emit`；`_recordPromptSnapshot()` 在最终 system 串算完后调用 | 全文记录，未变化的按 hash 记，配额 `DUYA_PROMPT_LEDGER_MAX_FULL` |
| 620 A | rollout 分类学收成一张权威表（`packages/agent-protocol/src/rollout-events.ts`），并标注每个 type 的产生方（`worker` / `storage` / `reserved`）；`EventKind`、HTTP 校验器、worker 镜像全部派生 | 见下方裁定 |

**620 A7 的兼容裁定**：`reasoning` / `tool_call` / `turn_started` / `system_context` 保留
（schema 与读侧消费点齐备，「今天没有写入者」不是删除依据）；`rotation` 有生产者；
`hook_invoked` **纳入**权威（它本来只有 worker 镜像一份，protocol 不认 → 真发出来
`deriveKind` 抛 TypeError、rollout 文件留下孤儿行）；`prompt_snapshot` 新增。

---

## 5. 8 个既有缺陷的修法

| # | 缺陷 | 最小修法 | 行为变化 | Phase |
| --- | --- | --- | --- | --- |
| a | `PromptCache` 实例级 → `cachePolicy:'once'` 跨调用失效 | 三件套：① `PromptsRegistry` 按 `(configName, profileKey)` 复用实例 ② 缓存键升级为 `${sectionName}@${contextFingerprint}` ③ profile 切换换桶。**只做①会造成真回归**（工具集变了缓存给陈旧字节） | 否 | 2 |
| b | host 静默丢弃 `projection.system` 的 blocks 分支（`worker-session-runtime.ts:2228-2230`） | Phase 1 先加告警计数；Phase 2 加 `renderSystemBlocksToText()` 真修 | Phase 2 是 | 1→2 |
| c | `enableSections`/`disableSections` 互斥（`modes/index.ts:30-36`） | 改 **disable 优先**；同步注释与 `logSectionLedger` | 仅「两个都给」的 profile | 1 |
| d | `SUBAGENT_TYPE_PROFILE_MAP` 段名漂移（`memoryContent`/`widgetGuidelines`/`visionGuidelines` 都不存在） | 改为真实名（`memory` / `vision`；`widgetGuidelines` 删）；加防漂移单测 | 是（子代理真的少两段） | 1 |
| e | AGENTS.md 索引 + 正文重复注入 | 删 `configs/code.ts:31` / `research.ts:27` 的 `projectInstructions` 段；删 4 处失效的 `invalidateCacheKeys`；修正 `mappers/project.ts:9-10` 失实注释 | 是 | 1 |
| f | MCP exposure 两处判定不一致（`=== 'search'` vs `!== 'full'`，默认 `hint`） | 在 `worker-config/tool-exposure.ts` 新增 `shouldInjectMcpCatalog()`，两个调用点都调它 | 是 | 1 |
| g | `BOT_BASIC_SYSTEM_PROMPT` 在 host 路径被丢弃（`bot/framework.ts:294-299` 显式 `includeBasic:false`） | 在 bot 分支前置注入，**开关 `DUYA_BOT_BASIC_PROMPT=1` 默认关** | 默认否 | 1 |
| h | `apply-modes.ts:57-60`（无分隔）与 `worker-session-runtime.ts:277`（`\n\n`）不一致；`refreshTurnSystemPrompt` 丢弃传入 prompt → turn 0 与 turn N 字节必然不同 | 抽唯一 `composeModePrompt(base, prefixes, ctx)`，两处都调；分隔符统一 `'\n\n'` | 是 | 1 |

**黄金断言**（直接对应 I2）：同一 run 内 turn 0 与 turn N 的 `assembly.systemPrompt` 逐字相同
（**有 mode 时也相同**）。

---

## 6. 风险清单

| # | 怎么坏 | 怎么发现 | 怎么回滚 |
| --- | --- | --- | --- |
| R1 | context 通道削弱 system 指令权重 | 指令遵循率/任务完成率下降 | 该段 `placement` 改回 `'system'`（一行配置） |
| R2 | 某 provider 拒绝连续 user turn | 首轮请求 400 | 同 R1 |
| R3 | 缓存没提升（还有别的抖动源） | hash 表仍多变 | 回 Phase 0 定位新抖动源 |
| R4 | 缓存命中但内容陈旧（指纹漏字段） | 模型拿到的 cwd/工具清单与实际不符 | 补指纹字段或全改 `every-call` |
| R5 | rail 块堆积（实现走偏成 append） | 单测：请求里 >1 份 | 改成先删后插 |
| R6 | rollout 体积失控 | 文件增速异常、轮转频次上升 | `DUYA_PROMPT_LEDGER_MAX_FULL=0` |
| R7/R8 | 新事件被 HTTP 拒收 / `deriveKind` 抛 TypeError | timeline POST 报 invalid entry | 回滚 protocol 改动 |
| R9 | (b) 真修让 system 突然变长 | Phase 1 告警计数 | (b) 真修做成开关，默认关 |
| R10 | (g) 恢复 basicPrompt 改 bot 人格 | bot 任务完成率对比 | 开关默认关（设计如此） |
| R11 | (d) 子代理真的失去 memory/vision 段 | 子代理质量下降 | 段名改回 |
| R12 | 架构门禁新增违规 | `architecture:check` 红 | 新文件放已存在目录（`packages/host/src/worker-context/` 已有先例） |
| R13 | 自己的改动被既有失败掩盖 | `npm test` 红但分不清 | Phase 0 先存基线失败集 |
| R14 | 561 落地后行类型再次分叉 | 561 的 union 覆盖测试红 | 本计划自带 union 覆盖测试，只覆盖自己拥有的 type |

---

## 7. 与 561 / 620 的边界

三个计划各拥有一片，重叠处只在「system 文本」这一个字段上，用 `overridden` 标记区分：

| | **619**（本计划） | **620** 会话记录架构 | **561** 模型调用轨迹 |
| --- | --- | --- | --- |
| 观测点 | host 组装层，每轮一次 | 分类学与落盘来源，跨所有记录 | api/wire 层，每次 LLM 调用一次 |
| 行类型 | `prompt_snapshot` | 复活 `system_context`；单源化全部 type | `model_call`（+ `visible` 一等字段） |
| system 文本 | host 组装终态（含 mode prefix / AGENTS.md / identity） | 不拥有 | wire 终态（会被 `options.systemPrompt` 覆盖、带 cache_control 包装） |
| payload 全文 | system + 注入块 | 运行时上下文注入全文 | 561 Phase 4 做 |
| UI | 不做 | 不做 | 561 Phase 6 做 |

**落地顺序：620 Phase A → 619 Phase 0–4 → 561。**

- 620 A 先于 619 Phase 4：否则 `prompt_snapshot` 是第八处手抄（见 Phase 4 的前置注）。
  619 的 Phase 0–3 不碰行类型，可与 620 A 并行。
- 619 先于 561：把易变上下文挪走后，561 记的 system 才是稳定、值得缓存的。
- 正常路径 619 与 561 的 system 逐字相同；`options.systemPrompt` 覆盖 / `disableSystemPrompt`
  时不同 → 619 的行加 `overridden?: boolean` 标记。
- 619 的新类型加在 **protocol 侧**（权威），worker 侧只同步；自带 union 覆盖测试。
- **不越界**修 `hook_invoked`（它在 protocol 的 `isRolloutEvent` 里缺位 → `deriveKind` 会抛）
  ——归 620 A5，只在注释里标注。
- **不越界**复活 `system_context`（18 种 `RuntimeContextSource` 的注入落盘）——归 620 Phase B。
  619 的 context rail **不进 timeline**（§8.2），两者不会打架：rail 是「这轮请求带了什么」，
  `system_context` 是「harness 往会话里注入了什么」。
- **不引入 `visible` 字段**（561 的事）；`effectiveMessageTimeline`（`message-log.ts:2864`）
  本来就滤掉所有非 message/compaction 行，语义已正确。
- **不新建落盘通道**。
- **隐私门槛**：`systemPrompt` 与 context blocks 可能含用户内容、工作区材料和工具目录。定义并验证脱敏、保留/删除、访问/导出控制前，不实现全文 rollout 写入；hash-only observer 不构成录制授权。

---

## 8. 明确不做

1. ❌ system 改多 block 数组 / 动 `packages/ai` / 动 provider wire 形状 / 多 cache breakpoint。
2. ❌ 把 context 块持久化进 timeline（会无限堆积，compaction 还会把它们当历史摘要）。
3. ❌ 实现 `PromptSegment.placement` 的 `'before-current-user'`（要重写段合并与投影语义）。
4. ❌ 重写 `.hbs` 模板体系 / 改 prompt 文案。
5. ❌ 统一历史上手写 `<system-reminder>` 的地方（`loader.ts:690`、`turn-time-reminder.ts:86-91`）
   ——新代码不许再手写即可。
6. ❌ 顺手修 `injectTurnTimestampReminders` 的 host 路径接线——记入基线文档。
7. ❌ UI 审计面板（561 Phase 6）。
8. ❌ 改 `architecture-policy.yaml` / `publicEntrypoints` / `.architecture-baseline.json`。
9. ❌ 跨 session 的 prompt 检索 / 版本管理 / A-B 框架。

---

## 9. 基线（2026-10-20 · 分支 `feat/619-prompt-context-channel`）

### 9.1 已知既有失败（`packages/agent/tests/unit/prompts/` + `packages/host/tests/`）

修复了 prompt 套件的资产路径与 mock 漂移后，剩 **8 个文件 / 12 个用例**为既有红：

| 文件 | 用例数 |
| --- | --- |
| `packages/agent/tests/unit/prompts/modules/project-modules.test.ts` | 2（AGENTS.md 索引渲染空——缺陷 (e) 会处理） |
| `packages/host/tests/skills/sync-protection.test.ts` | 1 |
| `packages/host/tests/sse-frame-codec-silent-drops.test.ts` | 1 |
| `packages/host/tests/worker-db-client.test.ts` | 1 |
| `packages/host/tests/worker-interagent-calls.test.ts` | 1 |
| `packages/host/tests/worker-product-runtime/live-ring-refresh-frame.test.ts` | 1 |
| `packages/host/tests/worker-product-runtime/native-event-authority-loss.test.ts` | 1 |
| `packages/host/tests/worker-product-runtime/run-lifecycle-seam.test.ts` | 4 |

判定规则：**新失败 ⊄ 上表**。stash 对比确认：修 vitest alias 前是 10 文件 / 16 用例，
修后 8 文件 / 12 用例——**净修复 2 文件 / 4 用例，未引入新失败**。

### 9.2 计划外发现并已修（commit `33e03d11`）

| # | 现象 | 根因 | 修法 |
| --- | --- | --- | --- |
| 9 | prompt 套件 12 个文件全红（ENOENT） | 资产已搬到 host，测试仍指向 `packages/agent/src/prompts/assets` | 导出 `resolvePromptAssetsRoot()`，测试改用生产同一解析器 |
| 10 | `omitAgentsMdPreBuildHook` 的 `vi.mock` 不生效 | mock 的是 agent 侧 shim，config 按相对路径引 host 模块 | 改为 mock host 模块 |
| 11 | 子路径 import 带 `.js` 时 "Cannot find module" | vitest alias 把子路径的 `.js` 与模板的 `.ts` 叠成 `foo.js.ts` | alias 单独捕获扩展名，两种拼写都落到同一文件 |

11 号是**共享测试基础设施**的缺陷：任何新写的测试只要用 `.js` 拼包子路径就会踩到。

### 9.3 集成分支验证（2026-10-21）

当前实现边界：可选逐段 SHA-256 observer 接缝，没有生产 sink、真实会话 hash 表、rollout writer 或 619 Phase 1–4 的产品闭环。以下门禁只证明列出的代码与构建结果；不代表 session recording 或 rollout 完成。

- 分支 `codex/integrate-platform-handoffs`，base `origin/master@325cdded`；应用边界、SSE与 worktree 安全切片后，源码组合为 `43c9c7c2`。
- `npm run typecheck:all`：`43c9c7c2`，exit 0；`build:packages` 只执行一次，所有原 TypeScript/Electron 检查保留；recorder 的 node:test 4/4。
- Prompt observer：`npx vitest run packages/host/tests/worker-prompts/prompt-digest.test.ts`，7/7；Plugin App Host API 测试7/7、Desktop Host 测试1/1。SSE decoder 与 Web stream consumer 各13/13。
- `project-modules.test.ts` 的两条 instruction-index 断言在 observer 之前的基线 `a5a01c99967f8f447881e31d101389a0e3b9d4be` 已同样失败（3 passed / 2 failed）；当前失败集相同，不归因于 observer。
- Windows worktree 安全测试在 Git Bash `PATH` 前置下14/14（`d8a0d306`；仅缺 PowerShell 的 Windows-specific fixture 在非 Windows 平台 skip）；`architecture:check` 在 `68e60f96` 无新增违规。
- `npm run electron:build` 在 `68e60f96` exit 0；bundle commit `4f83de28` 后 `npm run bundle:verify` 为 FRESH，0/1083 inputs changed。

### 9.4 与 620 的分工（2026-10-21 补）

会话记录格式的完整对照见 [620](./620-session-record-architecture.md)。本计划只拥有
system prompt 与注入块这一片；620 拥有分类学单源、运行时上下文落盘、工具结果结构面与
语料自包含。**Phase 4 必须等 620 Phase A**。

### 9.5 Phase 1 验证（2026-10-22 · 分支 `codex/619-phase1-prompt-defects`）

- **基线**：master 演进后，host 测试套件是 162 文件 / 1563 用例**全绿**；`packages/agent`
  只剩 1 个测试文件（agent 包退役中，`packages/agent/tests/unit/prompts/` 已随实现迁移
  删除）。Phase 1 的判定规则是「host 套件保持全绿 + 新增测试全绿」。
- **新增测试**：`packages/host/tests/worker-prompts/` 下 4 个文件（段门控、AGENTS.md 索引、
  MCP 目录门控、mode 前缀拼接），与 master 上已有的 `prompt-digest.test.ts` 合计 21/21。
- **门禁**：`npm run -w @duya/host typecheck` 与 `npm run -w @duya/agent typecheck` 均 exit 0；
  `npm run architecture:check` 无新增违规（棘轮基线 2806 条不变，且有 1 条指纹已不再触发）。
- **行为变化的两处字节级断言**已同步更新：`worker-modes/modifiers/registry.test.ts`
  （mode 前缀分隔符）与 `worker-product-runtime/turn-assembly-seam.test.ts`（该测试断言
  「mode 拼接只有一处实现」——现在实现搬到了 `composeModePrompt`，文件里只留调用）。
- **bundle**：`npm run bundle:worker` 重建后按仓库惯例单独成 `build(worker):` commit。

### 9.6 Phase 2–4 验证（2026-10-23）

- **回归**：`npx vitest run packages/host/tests/ packages/agent/tests/ packages/agent-protocol/test/
  packages/agent-core/test/ packages/data/ apps/desktop/src/main/` — **516 文件 / 5902 用例
  全绿**（1 文件 / 11 用例 skip）。新增测试：分段与缓存（`prompt-partition.test.ts` 7）、
  context rail（`context-rail.test.ts` 6）、prompt ledger（`prompt-ledger.test.ts` 7）、
  分类学单源（`rollout-events.test.ts` 6）、prompt_snapshot 落盘
  （`message-log.test.ts` +1）。
- **架构门禁**：`npm run architecture:check` — 无新增违规（total 2813，全部在基线内）。
- **类型检查的 worktree 限制**：`npm run -w @duya/host typecheck` 在本 worktree 里报 4 条
  `TS2742`（`app-connector-manage-tool.ts`），根因是 junction 让 `@duya/capabilities`
  的声明无法生成可移植的相对引用——**不是代码问题**：清掉 `tsconfig.tsbuildinfo` 做全量
  重建后错误数为 0。增量构建的产物会触发它，所以 worktree 里的类型结论要按「全量重建」
  读，不能按增量读。
- **磁盘**：worktree 的 `packages/*/dist` 全部是可重建产物，删掉后按依赖顺序重建即可；
  验证期间 E 盘一度写满（`ENOSPC`），构建产物是主要占用。


