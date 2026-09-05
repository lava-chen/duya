# 474 — Bot 系统提示词层（人格 Section + 身份信封 + 预算 + 冻结快照）

> **Status**: Planning · **Priority**: P0 · **Owner**: TBD
> **总纲**: [473-grok-bot-framework-overview](./473-grok-bot-framework-overview.md)
> **参考源码**：grok-bot `source/host/runner/system-prompt.ts`、`system-prompt-assembly.ts`、`prompt-collector-glue.ts`、`sand-agent-profile-prompt.ts`、`sand-memory.ts`
>
> **目标**：在 duya 现有 `PromptSystem`（声明式 SectionDef，**不改核心**）之上，新增 bot 场景所需的提示词模块群，使 `[agents.<id>]` 定义的 bot 拥有 grok 式的人格层、身份自改信封、per-section 预算与 epoch 冻结快照。

---

## 1. 现状 vs grok 差距

| 维度 | grok-bot | duya 现状 | 动作 |
|---|---|---|---|
| 组装骨架 | base 静态巨 prompt + 依赖注入清单（`() => string\|null`）+ 固定顺序 `"\n\n"` 拼接（system-prompt-assembly.ts:249-266） | `PromptSystem` SectionDef + PromptCache（结构更优） | **保留 duya 骨架**，只加 section 模块 |
| bot 人格 | `profileSection()` 注入 name/description + profile.json 路径 + avatar 路径 + `update_state` 自改说明（system-prompt-assembly.ts:100-117） | 424 的 `agents_md` 作 globalInstructions 静态注入 | 新增 bot identity section（读 `[agents.<id>]` 结构化字段而非整段 md） |
| 会话中身份变更 | 追加**隐藏 user 消息** `<<SAND_AGENT_PROFILE_UPDATE:v1:base64url>>`（sand-agent-profile-prompt.ts:8；prompt-collector-glue.ts:137-145,178-185 每轮检查追加） | 无（改 config 只影响下次 streamChat） | 移植 ProfileUpdateEnvelope 机制 |
| per-section 预算 | memory 字数/条数 cap（sand-memory.ts:1-18：`MEMORY_RECENT_PROMPT_CHAR_BUDGET=4000`、`MEMORY_MAX_CONTENT_LENGTH=500`；recall 30 / profile 50/recent 15 / project 25/10 cap3） | 无 | 移植 `SectionBudget` 工具（truncate + 计数日志） |
| 冻结快照 | compactionEpoch 内 profile/memory 冻结渲染防漂移；automation reminder 仅内容变化或 epoch 推进时重注入（prompt-collector-glue.ts:147-161） | PromptCache static/dynamic，无 epoch | 移植 epoch 快照语义 |
| bot 专属动态段 | automations / channels / agent roster / multitask dispatcher / MCP 多账户 / 时区 | 有 skills/memory/modes；缺 roster、automations、comms 规则段 | 新增（见 §3） |

## 2. 设计

### 2.1 bot section 模块群 `packages/agent/src/prompts/bot/`

每个模块一个文件，导出 `SectionDef`，由 bot 类 PromptSystemConfig（或 general config 的 bot 分支）注册：

| Section | 内容 | 类型 | 预算 |
|---|---|---|---|
| `botIdentity` | 名字/描述/头像路径/`update_state` 说明（读 `[agents.<id>]` name/description 字段） | dynamic（冻结快照） | 800 chars |
| `botCommsRules` | 通讯规则：回复走 SendToAgent 异步送达、禁止 ack 乒乓、禁止自发唤醒用户、quiet-work 静默语义（对齐 agent-messaging.ts:46 的 prompt 约束） | dynamic | 1200 chars |
| `botRoster` | 可见 agent 花名册（id/name/描述/可否 DM）——478 之前先渲染 `[agents.*]` 静态清单 | dynamic（冻结快照） | 每成员 120 chars |
| `botAutomations` | 该 bot 绑定的 cron/自动化清单（对齐 grok automations 段） | dynamic | 600 chars |
| `botMemory` | per-profile 记忆注入（对接 2026-08-31 plan B 的 `agent_profile_id` 分区） | dynamic | 沿用 grok cap（recent 4000 chars 等） |

### 2.2 身份信封 `ProfileUpdateEnvelope`

- 触发：会话进行中 `[agents.<id>]` 的 name/description 变更（ConfigStore watch）。
- 行为：下轮 turn 前向历史追加隐藏 user 消息 `<<BOT_AGENT_PROFILE_UPDATE:v1:<base64url JSON {name,description,changedAt}>>>`；`getLatestProfileUpdate` 保证只追加一次（幂等键 = changedAt）。
- 提示词层同时告知模型该信封格式（botIdentity section 内说明），使其理解"这是权威身份更新"。
- **不**重写 system prompt（保护 KV cache 与冻结快照）。
- **压缩后折叠步（2026-09-02 审计补，对齐 grok A7 `persistAnnouncedAgentProfile`）**：信封宣布只是临时机制，**下一次压缩 persist 时**（summaryEpoch 推进）把最新 profile 正式折进 botIdentity section 的静态基线，并标记该 update 已折叠（幂等键 changedAt 复用）——此后不再依赖历史信封消息存活。无压缩场景下，botIdentity section 渲染时合并仍未折叠的最新 update（等效折叠）；两者共用同一合并函数，保证压缩前后提示词一致。

### 2.3 SectionBudget + Epoch 快照

- `SectionBudget`：`fitSection(text, budget)` 纯函数 + 溢出告警（logger WARN，带 section 名与原/截后长度）。
- **冻结快照采用双键纪元（2026-09-02 审计修正）**：给 PromptContext 增加 `botEpoch` = **内容版本哈希**（bot 档案版本 + roster 版本 + memory 版本的哈希）+ **`summaryEpoch`（压缩纪元）** 两个正交键：
  - `botEpoch`（内容哈希）→ 内容真的变了才失效（档案/roster/memory 增删改）。
  - `summaryEpoch`（= 压缩计数，对齐 grok E1 `summaryArchives.length` / E2 host `compactionEpoch`，定义见总纲 473 §2.5.1）→ **压缩 persist 才 +1**，推进后**所有 dynamic bot sections 无条件重渲一次**（对齐 grok "压缩后 agent 重新认识环境"：user_info 重渲 / profile 折叠 / memory 冻结刷新同源语义）。
  - 两者任一变化即失效；缓存键 `bot:<id>:<contentHash>:<summaryEpoch>:<section>`。与 PromptCache 关系：bot sections 使用独立 keyed cache，不污染全局 static cache。
- 语义边界（对齐 grok，勿退化为纯内容哈希）：内容没变但压缩发生了 → **必须重渲**（模型对压缩后上下文的"首次感知"）；内容变了但没压缩 → botEpoch 失效也重渲（duya 现有 prompt 每轮重拼，此路径已天然覆盖）。

### 2.4 toml 映射（合流 2026-08-31 plan A1/A2）

`[agents.<id>]` 增加：
```toml
[agents.<id>.prompt]
sections = { disable = [], enable = [] }   # 对齐 A1
identity = { name = "...", description = "...", voice = "..." }
```
`botIdentity`/`botCommsRules` 从结构化字段渲染；`agents_md` 仍整体注入（保持 424 兼容），两者分工：结构化字段 → identity/roster/预算控制；agents_md → 自由发挥的行为指令。

## 3. 分阶段实施

### Phase 1 — 基础设施
- [x] **P1.1** `SectionBudget` 纯函数 + 单测（含 CJK 长度语义：按 code point 计）——已落地为 `fitToBudget`（`packages/agent/src/prompts/bot/framework.ts`，2026-09-02，见 §7.4）。
- [x] **P1.2** `botEpoch`（内容哈希）与 `summaryEpoch`（压缩纪元，接 E1 计数）计算与 bot section 独立缓存键；冻结快照单测（同双键二次调用返回同一字符串；仅 summaryEpoch 推进 → 强制重渲；仅内容变化 → 重渲）——已落地为 `epoch.ts` + assembly 内建快照缓存 + DuyaAgent 尾部接线（2026-09-03，见 §7.7）。

### Phase 2 — bot section 模块
- [x] **P2.1** `botIdentity`（读 `[agents.<id>]` name/description → `identity.ts` 真实渲染器；avatar/title/update_state 说明待 485/481，见 §7.4）。
- [x] **P2.2** `botCommsRules`（文案对齐 grok agent-messaging prompt，但术语换 duya：SendToAgent 工具名在 477 定稿前用占位常量）——真实渲染器已落地（`commsRules.ts`，2026-09-03 见 §7.9）；工具名直接引用 `SendToAgentTool/constants.ts` 的 `SEND_TO_AGENT_TOOL_NAME`，477 改名一处跟随。
- [ ] **P2.3** `botRoster` + `botAutomations`（roster 先渲染 `[agents.*]`；automations 读 cron-file 按 agent 绑定过滤）。—— roster 静态部分已落地（`roster.ts` 真实渲染器 + `loader.ts`，见 §7.4）；botAutomations 待 405/476 cron 绑定。
- [ ] **P2.4** `botMemory`（预留 2026-08-31 plan B 的 `agent_profile_id` 接口；未落地前回退全量注入 + 预算）。

### Phase 3 — 身份信封 + 配置
- [x] **P3.1** ProfileUpdateEnvelope 生成/去重/追加（agent-core 侧 + history append）+ **压缩后折叠步**（summaryEpoch 推进时把未折叠 update 折进 botIdentity 基线，changedAt 幂等）；单测覆盖幂等 + 压缩折叠前后渲染一致性——已落地（`profileUpdate.ts` + DuyaAgent 尾部 `_syncBotProfileBaseline`，2026-09-03 见 §7.9）。
- [x] **P3.2** `[agents.<id>.prompt]` toml 字段 + ConfigStore schema + section enable/disable 映射——已落地（2026-09-03，见 §7.8）。
- [ ] **P3.3** 集成：新建一个 demo bot（toml），验证 identity/comms/roster 段渲染、预算截断、会话中改名产生信封。

### Phase 4 — 验收
- [ ] **G1** `npm run typecheck:all` + prompts 相关单测全绿。
- [x] **G2** prompt 快照 diff 工具（debug 输出各 section 实际渲染长度），供 475/477/478 复用——`BotPromptAssembly.inspectSections(ctx, opts)` 返回每段 `{name, chars, omitted, budgetChars, truncated}`（2026-09-03 见 §7.9）。

## 4. 非目标

- 不改 `PromptSystem` 类与 plan 224 的 Profile/Mode/Permission 三层。
- 不做 profile 作者 UI（那是 2026-08-31 plan A4）。
- 不动记忆分区存储本身（plan B 独立推进）。

## 5. 风险与回滚

- **风险**：bot sections 每轮重算增加延迟 → 冻结快照 + 预算上限兜底。
- **风险**：信封消息污染历史投影/持久化 → 追加走既有 hidden/system-reminder 通道（对齐 plan 408 的 system-reminder 包裹），不落 `<user_query>`。
- **回滚**：bot sections 为纯增量模块，ConfigStore 不启用 `prompt` 字段即完全回退。

---

## 6. 可行性审计修正（2026-09-02 逐行核实代码后）

1. **bot section 挂点改为 `_buildSystemPrompt` 尾部，不进 PromptSystem 缓存**。证据：PromptCache 只是通用 LRU 字符串缓存（`prompts/cache.ts:37-166`），失效仅 3 条路径（preBuildHook invalidate / setProfile / clearCache），无 epoch 概念；而 `_buildSystemPrompt`（`DuyaAgent.ts:2885-2991`）在 PromptSystem 输出之后已有"每次重拼的尾部动态段"先例——MCP catalog（:2934-2944）与 Apps section（:2951-2956）。bot sections 采用同一模式：**双键纪元**（内容哈希 `bot:<id>:<contentHash>` + 压缩纪元 `:summaryEpoch` 拼成 `bot:<id>:<contentHash>:<summaryEpoch>:<section>`）做**自我缓存键**，与 PromptCache 并存不互扰。原 P1.2 的"botEpoch/summaryEpoch 进 PromptContext"保留，但缓存实现在 DuyaAgent 尾部拼装层。
2. **身份信封有现成持久化路径，P3.1 大幅简化**：`_appendRuntimeContextToTimeline`（`DuyaAgent.ts:2513-2540`，专为 runtime_context 设计、含去重）+ `AgentMessageFactory.createRuntimeContextMessage(visibility='hidden')`；runtime_context **包含在持久化投影中**（`message-projectors.ts:356-369` → `agent-process-entry.ts:3766` 落库）。信封即一条 hidden runtime_context 消息，无需新机制。注意与 checkpoint 认领的 transient 路径区分：信封走 **timeline append（durable）**，认领走非 durable。
3. **冻结快照的边界**：`buildSystemPrompt` 每次 streamChat 恰好调 1 次（`DuyaAgent.ts:822`→`:2926`）；mid-stream skill 增删不刷新。bot sections 的"每轮变化"只发生在 wake run 边界，与该节奏天然吻合——epoch 内冻结即可，无需 per-turn 冻结。
4. **cache 风险提示转交 480**：system 是单拼接字符串 + cache_control 打第一块（`prompt-caching.ts:356-389`）；bot sections 相对稳定（epoch 缓），但**高频变化的尾部段会令 system 断点前缀失效**（Anthropic 前缀缓存特性，全部 4 断点连带 miss）。botIdentity/comms 等低频段可安全追加；凡高频段（如 480 catalog）必须等 system 改多 block 后再进尾部。

---

## 7. 提示层分段全景映射与"现在可组装"判定（2026-09-02 晚）

> 用户把 grok 提示层按**数据源**拆成 12 段，问哪些段 duya 现在就能开始组装。本节目的是把每段的 grok 出处、duya 现状、真实数据源、阻塞项钉死在代码行号上，避免"感觉能组装"与"实际能组装"脱节。grok 行号来自 `E:/cloned-projects/grok-bot-0.18-reconstructed`，duya 行号为本仓库相对路径。

### 7.1 全景映射表

| # | 段 | grok 出处 | duya 现状（已核实） | 现在可组装？ |
|---|---|---|---|---|
| 1 | **basePrompt**（平台功能主体，硬编码） | `buildSandBaseSystemPrompt` system-prompt.ts:77-266（~8KB 文案）+ assembly 顺序 :249-266 | duya 无单块 base；等价物 = `generalConfig`/`gatewayConfig` 的 static sections 群（identity/communication/system/tasks/tools/skillUsage/project/duyaDesktopContext，PromptSystem.ts:51-94）——声明式、结构更优 | ✅ **骨架已有，无需新写**；bot 只在该 config 之上加"机器人格段" |
| 2 | **Spotlight**（功能开关状态提示，运行时） | `spotlightPromptSection` shared/sand-spotlight.ts:16 | 无对应概念；最近似 = 当前启用的 modes/profile 段（mode 状态机 413 已落地）+ `communicationPlatform`（types.ts:151-159） | ⏳ 等 476 lane/唤醒语义定稿后再做；现在做是空壳 |
| 3 | **Agent profile 段**（名字/描述/头像/自改方式，profile.json） | `profileSection` system-prompt-assembly.ts:100-117 + 信封 `sand-agent-profile-prompt.ts:8` | 身份块已有：`buildAgentIdentityBlock`（agent/utils/agent-helpers.ts:205-219，DuyaAgent.ts:2966-2969）；config 读侧 424 已接线：`config-agents.ts:57 readConfigAgents` 直读 config.toml `[agents.<id>]`，name/description 经 `toAgentProfile` 进 profile | ✅ **identity 基础可组装**（name/description）；title/avatar/profile.json 属 485 P2.2；update_state 属 481 |
| 4 | **用户身份 + 时区段**（用户全名、时区，requestContext） | `renderUserIdentitySystemPrompt` sand-user-identity.ts:4 + `renderTimeZoneSystemPrompt` timezone.ts:26 | 时区**已在提示里**：`location` 经 init payload → `PromptContext.location`（types.ts:192-197）→ environment 段渲染（sections/dynamic/environment.ts:160-166，含当前日期）。用户**全名未下发 agent**（main 侧仅 gateway 配对有 userName，pairing.ts:19-28） | 🔶 **时区半段现在就有**；用户全名需加 init payload 字段（仿 systemLocation 先例 process-pool.ts:709-712）+ PromptContext 字段，小改可做 |
| 5 | **记忆段**（agent/user/project 三层，compaction 冻结） | `renderMemorySystemPrompt` sand-memory.ts:76-102（recent 4000 字符预算）等 + FrozenMemorySnapshot :24-38 | `memorySection`（sections/dynamic/memorySection.ts:20-96）已注入 summary.md（12K 截断）；三层分区与冻结快照 = **479 范围**（依赖 485 memory 落点） | 🔶 单层全量已存在；三层 + 双键冻结等 479 |
| 6 | **Automations/Workflows 段**（≤100 条清单） | `renderAutomationsSystemPrompt` automation.ts:19（前 100）+ `renderWorkflowsSystemPrompt` | 主进程 cron 单一来源 `~/.duya/cronjob.toml`（cron-file.ts:4-17）；**agent-core 可读**：`db-client.ts:850 listCrons` → `automation:cron:list` → db-handlers.ts:711。`AutomationCron` **无 agent 绑定字段**（types.ts:33-50，仅 workingDirectory/model） | 🔶 渲染器可按 workingDirectory 过滤先写；per-agent 绑定字段需 405/476 扩展 cron schema |
| 7 | **Channels 段**（已连接通道 + connector manifests） | `renderChannelsSystemPrompt` channel-messaging.ts:89-136（依赖 channelStore.listConnections + connectorManifests 按平台过滤） | **gap 最大**：channel_directory + bindings 全在 main（electron/gateway/channel-directory.ts:4-16），agent-core 只拿到单值 `communicationPlatform`（DuyaAgent.ts:2923），**无 IPC/init 通道可查通道清单**。Connector 半段已有：AppConnectionTool descriptors（tool/AppConnectionTool/index.ts:276-286）→ `buildAppsSystemSection`（mentions/index.ts:110-139）已在尾链（DuyaAgent.ts:2951-2956） | 🔶 **Connector manifests 半段现在就能组**（复用 Apps 段模式）；**消息通道清单必须新建 main→agent 数据通道**（init payload 快照 或 IPC 查询，仿 systemLocation 先例）——这正是 476 ⑤ 的入站前提，建议本 plan 一并定义 payload 形状 |
| 8 | **Agent directory 段**（其他 bot 介绍 + 群组 + 互发规则） | `renderAgentDirectorySystemPrompt` agent-messaging.ts:35-81（≤40 成员 + 群组 + 互发规则文案） | 静态 roster **数据已在 agent-core 可读**：`readConfigAgents()`（config-agents.ts:57）直读 `[agents.<id>]` map（424 产物）。互发消息规则文案依赖 477 的 SendToAgent 工具名 | ✅ **roster 静态清单现在可组**（对齐本 plan P2.3 的"478 之前先渲染 [agents.*] 静态清单"）；互发规则文案等 477 工具名定稿（先放占位常量） |
| 9 | **MCP 自定义指令 / 探测状态段**（server 声明用法偏好） | `buildMcpCustomInstructionsSystemPromptSection` mcp-custom-instructions.ts:15-18 + discovery status（prompt-collector-glue.ts:163-168） | 目录已存在：`buildMCPCapabilityCatalog`（mcp/capability-catalog.ts:152-202，按 server 分组 + 预算截断）尾链追加（DuyaAgent.ts:2934-2944）——**即"探测状态"已渲染**。自定义指令：`mcpInstructions` 动态段已存在（sections/dynamic/mcpInstructions.ts:7-35）但 **`server.instructions` 无任何路径填充**（CLI 传 `[]`，cli/index.ts:122）——类型留口、数据源缺失 | ✅ 目录/探测段现在就有；🔶 instructions 需 MCP client 层把 server 声明（serverInfo/工具注解）喂给 `ctx.mcpServers` |
| 10 | **Remote box / Computer 段**（运行环境说明，运行时） | remote-box/computer section（prompt-collector-glue.ts:187-216） | environment 段已覆盖大半（platform/OS/timezone/cwd/date，environment.ts:160-169）；computer-use 独立能力（454 / built-in computerUseAgent） | 🔶 大部分已有；如要 bot 场景"运行在 duya box"说明，复用 environment + 一句静态即可 |

### 7.2 结论（回答"哪些现在能动手"）

用户判断"大部分可以开始组装"**基本成立，但有一个被低估的硬缺口**：

- ✅ **真正现在就能动手**（数据已在 agent-core 或主进程 IPC 可达）：
  1. `botIdentity` 基础版（name/description，读 `[agents.<id>]`，替换/增强 identity 块）；
  2. `botRoster` 静态清单（`readConfigAgents` 直读，P2.3 原样落地）；
  3. MCP 探测/目录段（已在尾链，只需确认 bot 场景不重复注入）；
  4. Connector（Apps）半段（复用 `buildAppsSystemSection` 模式，Channels 段拆两半：connector 半段 vs 通道清单半段）；
  5. Automations 渲染器（`listCrons` IPC 已通，先按 workingDirectory 过滤，绑定字段后补）；
  6. 时区半段（environment 已有）——如要 bot 化展示只需包一层。
- 🔶 **现在可做但需小基建**：
  - Channels 通道清单半段 → 新建 **main→agent channel snapshot** 通道（init payload 或 IPC）。这是 476 的入站前提，强烈建议本 plan 在 P3 先定义 `PromptContext.channels` 形状 + payload 字段，476/477 直接消费。
  - 用户全名 → init payload 加 `userDisplayName`（仿 systemLocation 三行改动）。
  - MCP 自定义指令 → MCP client 声明收集（独立小任务）。
- ⏳ **明确等依赖**：Spotlight（等 476）、记忆三层/冻结（479）、avatar/title/update_state（485/481）、互发规则文案（477）。

### 7.3 调整后的 Phase 2 实施顺序（供执行引用）

1. **P2.0（新增）** PromptContext 扩展字段类型先行：`channels?: ChannelSnapshot[]`、`userDisplayName?: string`、`botAgentId?: string`（types.ts），字段空则各段渲染器自然返回 null——**无任何主进程改动前即可让渲染器全绿**（单测 mock 数据）。
2. **P2.1** `botIdentity`（读 profile name/description；avatar/title 待 485）。
3. **P2.3** `botRoster`（`readConfigAgents` 静态清单）+ `botAutomations`（`listCrons` IPC，workingDirectory 过滤）。
4. **P2.5（新增）** `botChannels`：Connector 半段复用 Apps 段（现在）；通道清单半段读 `ctx.channels`（P2.0 字段），main 侧 payload 接线随 476 Phase 1 收编入站时一并做。
5. **P2.2** `botCommsRules`（占位常量，477 定稿替换工具名）。
6. **G2** prompt 快照 debug 工具（各段实际渲染长度），供 475/477/478 复用。

> 其余 P1.1/P1.2/P2.4/P3.x 维持原计划不动。改动集中在 §3 的 checkbox 顺序与新增 P2.0/P2.5 两项。

### 7.4 落地登记（2026-09-02 晚 · basic 单文件 + 框架先行）

用户指令："提炼 duya 现有 prompt 为一个精华 basic 文件（不管理多个文件）；其余只搭框架，等系统完善后注入。" 已落地：

**新增模块群 `packages/agent/src/prompts/bot/`**（agent-core 内，纯增量，未接线进 `_buildSystemPrompt`，零外部依赖）：

| 文件 | 内容 |
|---|---|
| `basicPrompt.ts` | `BOT_BASIC_SYSTEM_PROMPT` —— 单文件 distilled 基线。把 general profile 的 identity/communication/finalAnswer/system/tasks/destructiveActions/configProtection/tools/skillUsage/project/memory 浓缩成一份**运行时数据无关**的稳定文本（KV-cache 友好）；含显式作者规则：turn 变化数据一律不在此、留待注入段。无新增规则，只提炼 |
| `framework.ts` | `BotPromptAssembly` + `BotSectionDef` + `BotPromptContext` + `fitToBudget`（= P1.1 SectionBudget：code-point 计、CJK/emoji surrogate-safe）。注册/替换/注销按序组装，null 即省略，per-section budgetChars 截断，单段异常不拖垮整体 |
| `catalog.ts` | 12 段占位目录（botIdentity/spotlight/userIdentity/botMemory/botAutomations/botChannels/botRoster/botMCP/botRemoteBox）——每段 `compute` 恒 null + 数据源状态注释（对齐 §7.1 判定），未来由归属 plan 换真实渲染器 |
| `factory.ts` / `index.ts` | `createBotPromptAssembly()`（预载占位目录）+ barrel export |
| `__tests__/framework.test.ts` | 10 单测：预算截断（CJK/emoji）、默认只出 basic、注册段按序追加、null 省略、budget 截断、异常隔离、unregister/replace —— **全绿**（vitest，10/10） |

**验证**：`npx vitest run packages/agent/src/prompts/bot/__tests__/framework.test.ts` PASS；定点 `tsc --noEmit`（strict/NodeNext）通过。P1.1 勾选；Phase 2 各 P2.x 待各自数据源落地后逐个把 catalog 占位换成真实渲染器（这正是本 plan 的注入路径）。

**注**：暂不注册进 `prompts/index.ts`/registry —— 等 DuyaAgent 尾部挂点（§6.1）与 P2.0 上下文接线时再暴露，避免无消费方的空导出。

### 7.5 落地登记 2（2026-09-02 晚 · P2.1 botIdentity + P2.3 roster 静态部分）

用户选定系列第一件事 = 474 P2.1/P2.3（数据已就绪的提示词段）。新增真实渲染器，替换 catalog 中两个占位：

| 文件 | 内容 |
|---|---|
| `identity.ts` | `renderBotIdentity(ctx)` —— 纯渲染器：稳定 agentId + name/description + "常驻 bot 节点"人格锚定。**与 DuyaAgent 前置身份块分工**：前置块 `buildAgentIdentityBlock` 只给 name/role 一句；本段补 bot 身份语义（agentId、background wake、一致性人格）。无 botAgentId/name 返回 null（安全保持注册） |
| `roster.ts` | `renderBotRoster(ctx)` —— 纯渲染器：`ctx.agentDirectory` 静态清单，`BOT_ROSTER_MAX_ENTRIES=40` 截断 + 溢出计数。无目录返回 null。DM 规则文案留待 477（段尾一句话占位，不提前发明工具名） |
| `loader.ts` | `loadBotPromptContext(agentId)` —— 数据接入：`readConfigAgents()` 直读 config.toml → 自身条目填 botName/botDescription + 他者条目填 agentDirectory（排除自身）。agentId 未知/无 agents → 返回 `{}`，渲染器自然省略 |
| `framework.ts` | `BotPromptContext.agentDirectory` 由 `unknown` 收窄为 `BotRosterEntry[]`（id/name/description） |
| `__tests__/sections.test.ts` | 9 单测：identity null/完整/仅 id；roster null/列表/40 截断；loader 空 id/排除自身/端到端渲染 |

**验证**：19 单测全绿（framework 10 + sections 9）；定点 `tsc --noEmit`（strict/NodeNext）通过。P2.1 勾选；P2.3 roster 静态部分完成、botAutomations 标注待 405/476。**注入路径演示**：`createBotPromptAssembly()` 预载 catalog（identity/roster 已真实渲染）→ `await loadBotPromptContext('alpha')` 填 ctx → `assembly.render(ctx)` 输出 basic + identity + roster。

### 7.6 落地登记 3（2026-09-02 晚 · DuyaAgent 尾部接线，bot 会话启用）

将 bot 提示层挂进运行时的**最小接线**（对齐 §6.1 审计"bot sections 挂 `_buildSystemPrompt` 尾部"）：

| 改动 | 内容 |
|---|---|
| `framework.ts` | 新增 `renderSections(ctx)` —— 只输出注册段、**不含 basic**（避免与 general PromptSystem 输出的平台指引重复）。`render()` 语义不变（单文件基线仍可独立出全量 prompt） |
| `loader.ts` | 新增 `isBotAgentProfile(profile)` 判定：**bot 会话 = 非 preset 的 kind:'main'**（config 驱动 `[agents.<id>]`，424 产物 `isPreset:false`；内置 general/code/research/gateway/cron 均 `isPreset:true` → 不会被误判） |
| `prompts/index.ts` | barrel 追加 bot 模块导出（`createBotPromptAssembly`/`loadBotPromptContext`/`isBotAgentProfile`/渲染器等）——**有消费方后开放**，此前按 §7.4 有意不暴露 |
| `DuyaAgent.ts` | `_buildSystemPrompt` 尾部（AGENTS.md 之后）：`isBotAgentProfile(appliedProfile)` 为真 → `loadBotPromptContext(profile.id)` → `getBotAssembly().renderSections(ctx)` 追加。装配实例惰性缓存为类字段（catalog 稳定跨 turn）；段渲染异常只 WARN 不炸 prompt；非 bot 会话 / ctx 空 → 天然 no-op |
| 测试 | framework.test 增至 16：`renderSections` 不含 basic、空 ctx 尾段为空串、`isBotAgentProfile` 6 判定用例（preset/subagent/special/undefined 均 false）——**25 单测全绿** |

**验证**：`npx tsc --noEmit -p packages/agent/tsconfig.json`（全包）通过；prompts/agent-profile 回归中 7 个失败均为**改动前既有失败**（subagentProfilePrompt 6 个 = 424 已记录的 prompts/modes 未提交工作；gatewayConfig 1 个 = 测试期望 staticSections 不含 `configProtection`，而 gateway.ts 早已包含、测试滞后），与本次 bot 改动无关（未触碰任何 config 定义）。

**边界声明**：本接线仅注入身份/roster 段，**不替换** general base——bot 会话的平台指引仍来自 PromptSystem；`basicPrompt.ts` 单文件基线供未来独立 bot PromptSystem 分支使用（P3.2 toml `prompt` 字段可切换时）。cache 风险（§6.4）由"段稳定 + renderSections 追加"缓解，多 block system 改造待 480。

### 7.7 落地登记 4（2026-09-03 · P1.2 双键纪元 + 冻结快照 + 尾部接线）

按 §6.1 审计结论实现：缓存不进 PromptCache，由 bot assembly 自持（`BotPromptAssembly.snapshotCache`，实例 = DuyaAgent 会话生命周期，FIFO 上限 256 条）。

| 文件 | 内容 |
|---|---|
| `epoch.ts`（新增） | **`computeBotContentHash(ctx)`**——botEpoch 内容哈希：对 ctx 全部 bot 相关字段（identity/roster/userDisplayName/timezone + 四个 reserved slots）做规范序列化（对象键排序、roster 按 id 排序、reserved slots 防御式序列化）→ sha256 取 16 hex。reserved slots 虽未渲染但已入哈希，476/479/405 落地时无需再改哈希函数；**`botSectionCacheKey(botId, hash, epoch, section)`**——`bot:<id>:<contentHash>:<summaryEpoch>:<section>`；**`countTimelineCompactions(entries)`**——summaryEpoch = timeline 中 `type === 'compaction'` 条目计数（E1 `summaryArchives.length` 的 duya 类似物；会话恢复时 compaction 条目会重新 append，计数跨重启稳定） |
| `framework.ts` | `BotSnapshotKey`（botId/contentHash/summaryEpoch）+ `BotRenderOptions.snapshot`；`render`/`renderSections` 接受可选快照键 → `renderSection` 命中即原样返回冻结文本（跳过 compute），miss 则 compute + budget 截断后入缓存。**null（合法省略）也缓存**（段不会在 epoch 中途弹出）；**异常不缓存**（下次渲染重试）。新增 `clearSnapshotCache()` |
| `DuyaAgent.ts` | 尾部接线升级：`renderSections(botContext, { snapshot: { botId, contentHash, summaryEpoch } })`——hash 来自 `computeBotContentHash(botContext)`，summaryEpoch 来自 `countTimelineCompactions(this.timeline.snapshot())`。未传 snapshot 的调用路径（单测/未来独立分支）行为不变 |
| `bot/index.ts` / `prompts/index.ts` | barrel 追加 epoch 三函数 + `BotSnapshotKey`/`BotRenderOptions` 类型 |
| `__tests__/epoch.test.ts`（新增） | 18 单测：哈希稳定性/身份敏感性/roster 顺序不敏感/reserved slot 敏感/undefined 等价；key 形状；compaction 计数；**冻结快照三语义**（同双键 → compute 1 次且字符串一致；仅 summaryEpoch 推进 → 重渲；仅内容变化 → 重渲）+ null 缓存 + 异常不缓存 + post-budget 冻结 + 无 snapshot 每次重算 + clearSnapshotCache + 跨 bot 隔离 |

**验证**：bot 单测 46/46 绿（epoch 18 + framework 16 + sections 12）；`tsc --noEmit -p packages/agent` 通过；`typecheck:web` 通过。**语义边界**（§2.3）：内容没变但压缩发生 → summaryEpoch 失效强制重渲（模型对压缩后上下文的首次感知）；内容变了没压缩 → contentHash 失效重渲。下一步：P3.2 toml `prompt` 字段 / P3.1 ProfileUpdateEnvelope / P2.2 comms 占位。

### 7.8 落地登记 5（2026-09-03 · P3.2 `[agents.<id>.prompt]` 配置 + section 门控）

| 文件 | 内容 |
|---|---|
| `agent-profile/config-agents.ts` + `electron/config/schema.ts` | `CustomAgentPromptConfig`（`sections = { enable?: string[], disable?: string[] }` + `identity = { name?, description?, voice? }`）双侧镜像类型；ConfigStore 用 `@iarna/toml` 原样读写不 strip 字段 |
| `prompts/bot/framework.ts` | **section 门控**在 `assemble` 内：disable 胜过 enable；非空 enable 为白名单；未知段名忽略（对 476/479/481 前向兼容）。过滤器挂在 ctx 上 → 参与 contentHash，toml 切换段即失效冻结快照。新增 `BotPromptConfig`/`BotPromptSectionsFilter`/`BotPromptIdentityConfig` 类型 + `ctx.voice` |
| `prompts/bot/epoch.ts` | contentHash 覆盖 `voice` + `promptConfig` |
| `prompts/bot/loader.ts` | `sanitizePromptConfig` 防御式净化原始 toml 形状（错型丢弃、空数组保留 = 无白名单语义）；**身份优先级**：profile.json（485 运行时身份）> `prompt.identity`（声明式 prompt 人设）> `[agents.<id>]` 顶层注册名；voice 提升为 `ctx.voice` |
| `prompts/bot/identity.ts` | 渲染 `Your voice: …` 行 |
| `electron/config/agents.ts` | **upsert 保留 prompt 表**（1 行）：upsert 输入无 prompt 面，UI 改名等 re-upsert 原本会整对象重建丢掉手编 toml——现 `prompt: agents[id]?.prompt` 原样保留 |
| 测试 | agent 侧新增 15 用例（门控语义 7、哈希覆盖 2、voice 渲染 2、loader 净化/优先级 4）；electron 新增 `agents-prompt.test.ts` 2 用例（re-upsert 保留 prompt / 新建无 prompt）|

**验证**：bot 层 61/61 绿（新增 promptConfig 15）；electron config 相关 13/13 绿（含既有 agents 测试无回归）；agent 包 tsc 0 错。electron 全量 tsc 当前有大量**并行会话在途改动**的既有错误（db-bridge/core-db-adapters/steering 等，基线 stash 验证与本改动无关）。**语义注意**：`enable: []` = 无白名单（全渲染）；roster 显示注册名，identity 段显示 prompt 人设名，二者可有意不同。下一步：P3.1 ProfileUpdateEnvelope / P3.3 demo bot 集成 / G2 快照工具。

### 7.9 落地登记 6（2026-09-03 · P2.2 botCommsRules + P3.1 ProfileUpdateEnvelope + G2 inspectSections）

| 文件 | 内容 |
|---|---|
| `commsRules.ts`（新增） | `renderBotCommsRules(ctx)`——异步 `send_to_agent` 送达、禁 ack 乒乓、禁自发唤醒用户、quiet-work 静默；无 botAgentId 返回 null；文案 ~1100 chars < 1200 预算。**占位常量即真实常量**：直接引用 SendToAgentTool 的工具名，477 定稿改名自动跟随 |
| `profileUpdate.ts`（新增） | **P3.1 纯模块**：`buildProfileUpdateEnvelope`/`parseProfileUpdateEnvelope`（`<<BOT_AGENT_PROFILE_UPDATE:v1:<base64url JSON>>>`，错型/缺字段拒绝）、`detectProfileUpdate`（对比基线，幂等）、`mergeProfileUpdate`（update 胜出、foldedUntil 单调推进防旧信封回卷）、`getLatestProfileUpdate`（changedAt 取最新）、`isProfileUpdateFolded`（折叠抑制重宣布） |
| `identity.ts` | botIdentity 增信封格式说明段（§2.2"提示词层告知模型信封格式"：权威身份更新、立即采纳） |
| `DuyaAgent.ts` | `_syncBotProfileBaseline(botId, ctx, summaryEpoch)`：①首轮静默播种基线（冷启动不误报变更）；②基线与当前身份不一致 → 构建信封 `AgentMessageFactory.createRuntimeContextMessage(source='custom', visibility='hidden', metadata.botProfileUpdate)` → `_appendRuntimeContextToTimeline` 追加（durable，进持久化投影，自带 id 去重）；③summaryEpoch 推进（压缩 persist）→ 折叠：botIdentity 本轮重渲已含合并视图（profile.json 每轮重读），折叠标记抑制后续重宣布。异常只 WARN 不破坏 system prompt |
| `framework.ts` | **G2** `inspectSections(ctx, opts)`：按门控/预算/省略后的真实渲染返回 `BotSectionSnapshot[]`（name/chars/omitted/budgetChars/truncated），与 renderSections 共享冻结快照缓存（inspect 后 render 不重复 compute） |
| `catalog.ts` / barrels | `BOT_COMMS_RULES_SECTION` 注册（排在 botIdentity 后）；commsRules/profileUpdate/inspectSections 相关导出进 bot/index.ts 与 prompts/index.ts |
| `__tests__/commsAndProfile.test.ts`（新增） | 14 用例：comms 渲染与守卫（4）、信封 round-trip 与畸形拒绝（3）、detect/merge/fold 幂等与单调（3）、**折叠前后渲染一致性**（merge-then-render == fresh render，§2.2 共用合并函数语义）、inspectSections 度量/过滤/缓存共享（3） |

**验证**：bot 层 75/75 绿（新增 14）；agent 包 tsc 0 错。**设计边界**：折叠后不重宣布（信封历史消息可被压缩安全淘汰）；折叠与渲染共用 `mergeProfileUpdate`，压缩前后 botIdentity 输出逐字节一致；信封走 timeline durable append（区别于 checkpoint 认领的 transient 路径，§6.2）。**剩余**：P3.3 demo bot 集成验证 + G1 全量门禁（属验证步骤，按指示暂缓）；P2.3 automations / P2.4 botMemory 仍等 405/476/479 数据源。

### 7.10 落地登记 7（2026-09-03 · 独立 bot base 组装上线，Path A）

用户选定架构路径 A：bot 会话使用 **独立的自包含系统提示词**（`BOT_BASIC_SYSTEM_PROMPT` + 动态骨干 + bot section 目录），彻底替换 general 的 static/identity/memory 组合，避免能力回退与重复注入。

| 文件 | 内容 |
|---|---|
| `prompts/configs/bot.ts`（新增） | bot 专属 `PromptSystemConfig`：`staticSections: []`（base 来自 basicPrompt.ts）；`dynamicSections` 仅保留面向 bot 的骨干子集（language/outputStyle/platform/environment/mcp/skills/scratchpad/sessionGuidance），**排除 general 的 `memory`**（由 bot memory tiers 取代）；`preBuildHook` 复用 AGENTS.md 初始化 |
| `prompts/registry.ts` | 注册 `'bot'` config → `PromptsRegistry.getOrCreate('bot')` 可按名解析 |
| `DuyaAgent._buildSystemPrompt` | ①`isBotAgentProfile(appliedProfile)` 判定会话 → `sysName='bot'`；②系统提示 = `${BOT_BASIC_SYSTEM_PROMPT}\n\n${dynamic 输出}`（dynamic 为空则纯 base）；③**跳过 `buildAgentIdentityBlock`**——bot 身份来自自包含 base 的 botIdentity 语义 |
| `prompts/configs/__tests__/botConfig.test.ts`（新增） | 6 用例：static 空 / dynamic 骨干子集顺序 / 排除 memory / registry 注册可解析 / basic 导出存在 / 门控留白 |

**验证**：botConfig 6/6 绿；`typecheck:agent`（全包 tsc）0 错。`typecheck:all` 中 web 侧报错均为**并行会话在途改动**（`HostToolPermissionCard`/`MarketplacePage`/`preload.ts` 的 `getHostToolPermission`），并经基线比对与本改动无关——本改动仅触 `packages/agent/src/prompts/`、`agent/DuyaAgent.ts` 的 bot 分支与 `src/` 无涉。**边界**：bot 会话的 identity 仍由自包含 base（botIdentity 语义）承载，general 的 identity 块不再重复注入；general memory 段从 bot 组合中排除；`promptConfig` 的 enable/disable 门控（§7.8）在此组合上天然生效。至此 §6.1 挂点的"独立 base"形态闭环，后续 476/477/478/479/481 的各 bot section 渲染器在其上增量注入。
