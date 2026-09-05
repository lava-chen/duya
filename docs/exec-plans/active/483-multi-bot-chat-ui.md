# 483 — 多 Bot 聊天 UI（侧栏 Bots 分组 + 类 Telegram 聊天 + Bot 资料/设置）

> **Status**: Implementation · **Priority**: P1 · **Owner**: TBD
> **Phase 1 基础已落地（2026-09-03）**：P1.1/P1.2/P1.3 基础版完成（18 新单测 + typecheck:all 绿）。数据源用 `[agents.*]` config（plan 424 的 `config:agents:list` IPC）替代未落地的 477 绑定映射；477 绑定线程（`bot:<agentId>:<sessionId>`）出现后自动并接（`buildBotContacts` 已写好合并逻辑）。见文末决策日志。
> **P2.1 聊天壳（bot-direct 视图）已落地（2026-09-03）**；P0（roster 增量）/ P2.2 卡族 / P2.3-P2.6 / P3 数据流与卡族部分**移交 489**（`489-bot-chat-dataflow-and-complete-cards.md`）。489 已完成 P0.1/P0.3（数据层 source 投影 + 订阅切换）+ P2.2 最小版（SendMessage 5 kind 可读卡），本 plan 后续直接从 489 承接。
> **总纲**: [473-grok-bot-framework-overview](./473-grok-bot-framework-overview.md)
> **前置**: 476（Wake Bus Phase 0 先行——UI 的 typing/busy 指示依赖锁接线）、477（per-bot 常驻会话，bot 聊天 = 该 bot 专属 session 的读视图）、478（群聊 transcript，群联系人点开 = 群房间流）
> **参考源码**：grok-bot（shipped renderer 语义：SendMessage is the only voice / reactions / plugin mention 卡片）；`roster-emit.ts`/`roster-projection.ts`/`replica-writer.ts`（P0 增量订阅）、`widget-responses.ts`/`workflow-commands.ts`（P2.5 卡闭环与 @ 展开）、`agent-lifecycle.ts`（P2.6 successor）；duya `src/components/`（下表）
>
> **2026-09-02 完整性审计并入**：C9 roster 增量订阅（新 Phase 0）、C11 卡宿主侧闭环与 @mention 展开（新 P2.5）、C10 bot 生命周期切换（新 P2.6）——总纲登记见 473 §9。
>
> **目标**：在侧栏建立与 **Projects 平级的 Bots 分组**（含单个 bot 联系人与群聊联系人，Telegram 式联系人列表），点开联系人进入**类 Telegram 聊天界面**。bot 的唯一发声通道是 `SendMessage`（映射 duya 侧 476/477 的 wake run 产物）；聊天里支持**多卡片种类**（文本/图片/任务/工具/群回合标记…）。另含 bot 资料卡片、群聊设置与唤醒/通知偏好界面。

---

## 1. 用户设计意图与 UI 全景

```
侧栏（与 Projects 平级）
└── Bots（system section，前缀 bot:）
    ├── 🤖 单 bot 联系人（frontend-expert、reviewer…）   ← bot 专属常驻会话
    └── 👥 群聊联系人（产品讨论组…）                     ← group_room_messages 房间流
          │ 点开
          ▼
    类 Telegram 聊天视图（联系人 = 一个持久 Thread）
    ├── 消息流：头像+名字+气泡 多角色渲染 + 卡片种类
    ├── 输入框：用户发言（user→bot ①）/ 群里发言（先选房间）
    └── 状态条：typing / busy（复用 StreamPhase 订阅）
    另设：Bot 资料卡片页 / Bots 设置页（bot CRUD + 群组管理 + 唤醒偏好）
```

**核心语义（对齐 grok）**：bot 在这个 UI 里**只以最终消息形式出现**（SendMessage 是其唯一声音）；工具过程、思考过程**不显示**在联系人聊天里（保留在 bot 自己的工作台会话中，从资料卡可跳转）。聊天视图与现有 ChatView 是**同一组件族、两种呈现模式**。

## 2. duya 现状盘点（可复用 / 需新建）

| 功能 | 现状 | 结论 |
|---|---|---|
| 侧栏分组 | `section-system.ts` 用 id 前缀识别会话种类（cron:/gw-/wakeless-），映射 system section；`app-sidebar.tsx` sidebarStructure 推导 | **复用机制**，加 `bot:` 前缀与分支 |
| 会话/聊天容器 | `ChatView.tsx`（MessageList+MessageInput+…）被 gateway/cron/subagent 全复用；stream 走 `stream-session-manager` | **bot 聊天直接复用 ChatView 一族**，无需新写聊天引擎 |
| 联系人列表项 | `ThreadListItem`（标题/时间/phase 指示） | 需**新建 BotContactListItem**（头像、在线/忙碌、未读）或把 bot 会话建成 Thread 后扩展 |
| 多角色气泡 | 无 avatar；MessageItem 按 role+msgType 分派 | **需新建**「头像+名字+气泡」渲染容器（接入 MessageItem 分支） |
| 卡片家族 | 文本/工具行/附件卡/viz widget/研究卡/`MailboxBubble`（最接近接收方气泡） | **复用 + 扩展** bot 专用卡（DM/广播 cue、群回合标记、pass 静默态） |
| 设置 | SettingsView + SettingsTab + settings/ui 套件；`AgentsSection.tsx` 已有 config agents CRUD | **加 tab**：Bots 管理、群组管理、唤醒偏好 |
| 排版件 | `ui/page/*`：PageHeader/PageNavButtons/PageFrame/PageCard/EmptyState | **复用**做 bot 资料卡子页 |
| 会话元数据 | Thread 有 agentProfileId/agentName/agentType | **需扩展** bot 标识（avatar、bot 身份、room 成员）或维护映射 |
| 运行状态 | StreamPhase + `useStreamPhase` + ThreadListItem 已有 running 指示 | **复用**做 typing/busy |

## 3. 设计

### 3.1 侧栏 Bots 分组（Phase 1）

- 前缀约定：单 bot 会话 = `bot:<agentId>:<sessionId>`；群聊 = `room:<roomId>`（不占 Thread 表，列表项直接渲染 room）。
- 改动点（对齐 section-system 既有 4 处）：① `detectThreadKind`/`bucketThreadsByKind` 加 `bot:` 分支；② `app-sidebar.tsx` sidebarStructure 追加 Bots system section（仅当存在已绑定 bot 时显示，折叠初始状态展开）；③ i18n label/icon；④ 新建 `BotContactListItem`——显示头像（复用 AGENT_ICON_MAP 或 bot 自定义头像）、在线/忙碌点（`useStreamPhase`）、未读角标（mailbox-store 计数）。
- 联系人数据源：bot 会话绑定映射（477 的 `bot_id→session_id`）读侧 + `[agents.*]` config；群聊 = groups.toml。
- **交互**：联系人可右键菜单（打开资料卡/置顶/静音/删除绑定）。

### 3.2 类 Telegram 聊天视图（Phase 2）

- **复用** `ChatView`/`MessageList`/`MessageInput`/stream-session-manager，引入 `chatMode: 'workspace' | 'bot-direct' | 'room'` 呈现模式：
  - `bot-direct`：消息按发言者渲染气泡（user 右、bot 左，bot 带头像/名字色）；bot 的工具/思考被过滤或折叠（bot 会话里的 tool rows 在聊天视图**默认隐藏**，可点"查看过程"展开——过程留在原 bot session 历史）。
  - `room`：渲染 `group_room_messages`（多发言者 + 回合标记 + (pass) 静默态 + @mention 高亮 + 收束条）。
- **消息写入与回读**：bot 侧只认 481 的 `SendToAgent`/`PostToRoom` 产物（由 476 派发进 wake run）；用户侧发言经既有 POST chat 入口，目标 = bot 常驻 session / room transcript。**room 视图不经过 agent 会话流**（直接读群表 + 订阅）。
- 新消息卡片（接入 MessageItem 分支，按 msgType/meta 分派）：
  1. `BotDirectCard`——agent DM 信封渲染（[agent] cue、priority 标、时间）；
  2. `RoomRoundMark`——群回合分隔条（Round N / 发言人轮转摘要）；
  3. `RoomPassNote`——(pass) 静默成员（灰化小字，不占气泡）；
  4. `BotBroadcastCard`——broadcast 消息（476 预留）；
  5. 复用：图片/附件卡、viz widget 卡（bot 发图/生成式卡片可直接出现）。
- 输入框扩展：直接输入 = 发给当前 bot；群聊中支持 `@member` 自动补全（member list 来源）。

### 3.3 Bot 资料卡片与子页（Phase 3）

复用 PageFrame + PageHeader + PageNavButtons 做每 bot 的子页（PageNavButtons 选中态样式遵循既有约定）：

| Tab | 内容 | 数据源 |
|---|---|---|
| 概览 | 头像/名称/描述/模型/工作区；在线状态；今日消息数 | `[agents.<id>]` + Thread + usage |
| 活动 | 该 bot 最近 wake run 列表（时间/触发来源/摘要）| 476 的 wake 生命周期日志（P4.2）→ IPC |
| 记忆 | 三层记忆浏览器（own/user/project 分 tab，只读 + 删除入口） | 479 读侧 |
| 自动化 | 绑定的 cron/automation 清单与启用开关 | cron-file + 476 automation.source |
| 绑定 | 常驻会话信息（session id/工作区/会话清理按钮）| 477 映射 |

### 3.4 设置页（Phase 3）

SettingsView 加两个 tab（挂点：`SettingsTab` 分支 + `settingsNavGroups` + case）：
- **Bots 管理**：与 `AgentsSection` 互补——agents CRUD 已有，这里补 **bot 化开关**（turn 为 bot：绑定常驻会话、允许被唤醒、允许收 DM/群邀请、SendMessage 唯一通道声明）、**外观**（头像/名字色/介绍，写入 `[agents.<id>]`）、**唤醒偏好**（`wake.idleDispatch` 与静音时段、quiet 默认开）。
- **群组管理**：建群（选成员≤6、max_rounds、预算）、成员管理、删除群；落 `~/.duya/groups.toml`。

## 4. 分阶段实施

### Phase 0 — roster 增量订阅协议（2026-09-02 完整性审计并入：C9）
> 背景：完整性审计确认 grok 的 roster 不是静态列表而是**持续增量事件流**（`roster-emit.ts` runEmitAgents/runEmitAgentUpdate、ordered 序号 `replica-writer.ts`、outline 流 250ms 合并、改名即时 name-changed、`roster-search.ts`）。483 的联系人列表若只查一次，bot 名字/头像/忙闲不会实时变。本 Phase 在既有 SSE/mailbox-broadcaster 之上建立 duya 版增量订阅。

- [ ] **P0.1** roster 增量事件协议：`agents.upserted` / `agents.removed` / `agents.activity`（typing/composing/idle）/ `agents.profile_changed`（改名/头像）+ ordered 序号（进程级单调，重连窗口补洞对齐 `replica-writer` 语义）+ 单测。
- [ ] **P0.2** main 侧 roster 投影（live + 持久化 marker 合并，对齐 `async-task-union.ts`；476 P3.3 的输出侧）+ SSE 广播。
- [ ] **P0.3** 前端订阅：BotContactListItem 消费增量事件（头像/忙碌/未读实时更新）；重连后按序号补齐缺失事件。

### Phase 1 — 侧栏与导航
- [x] **P1.1** `bot:`/`room:` 前缀 + section-system 分支 + sidebarStructure 追加 + i18n（空态文案）。（2026-09-03：section-system 加 bot/room kind/前缀/分桶 + `__system__:bots` 描述符；侧栏空态即隐藏整个分组，无需空态文案）
- [x] **P1.2** `BotContactListItem`（头像/忙碌/未读）+ 联系人数据源（477 映射 + groups.toml 读侧）。（2026-09-03 基础版：数据源暂用 `[agents.*]` config（424 IPC）；头像 = agentId 确定性色相圆点；忙碌点走 `subscribeToPhase`（无绑定即 idle）；未读角标留 CSS 钩子待 plan 202 mailbox；groups.toml 群联系人待 478）
- [x] **P1.3** 导航接线：点联系人 → currentView 'chat' + bot 会话/room 专用 id（room 先占位）。（2026-09-03 基础版：有绑定走 `bot:<agentId>:<sessionId>`，无绑定降级占位 id `bot:<agentId>` → 空聊天壳；room 占位待 478）

### Phase 2 — 聊天视图与卡片
- [x] **P2.1** chatMode 模式分支（workspace/bot-direct/room）与角色气泡渲染容器（头像+名字色，左 bot 右 user）。（2026-09-03：`resolveChatMode`（bot/chat-mode.ts）+ ChatView 末尾早期 return → 独立 `BotDirectChatView`（Telegram 式：header 28px 头像+名字+运行中、690px 居中 transcript、user 右对齐 color-mix 气泡 / bot 左对齐 bg 气泡、group-start 行带 22px 头像+名字、三点 typing 胶囊、圆角 composer；room 同舞台占位待 478）。约束兑现：bot 逻辑零侵入 MessageList。未绑占位会话 composer 禁用（防垃圾 session），绑定期后启用。grok 几何（max-width min(88%,640px)、18px 圆角、22px 行距）+ duya token。测试 chat-mode 7 + 视图 8，tsc --noEmit 干净。**2026-09-04 修正**：核对发现 09-03 提交（d413696b）实际**未含挂载**——ChatView 从未引用过该组件（git log -S 全历史为空）；按用户架构决策改为 **App.tsx renderView 平级分支**（`resolveChatMode(activeThreadId)` 派生，ChatView/BotDirectChatView 同级互斥渲染，见决策日志 09-04 条））
- [x] **P2.1b 截图标准样式对齐（2026-09-04，用户指定截图为视觉标准 + grok-bot 0.18 recovered CSS 佐证）**：① 气泡：去尾角、去边框，对称 18px 圆角；user 气泡改高对比色对 `--bot-contrast-bg/fg`（暗色象牙 #ecece8/墨 #242424，亮色反转，同 grok light `#070707` 策略），assistant 气泡 `--surface-solid`；尺寸上限 min(88%, 640px)。② 行内**去头像/去名字**（用户明确：消息泡前不放 bot 头像，整体干净 = grok transcript 实态），身份只保留居中 header。③ composer 重排为 grok prompt-shell 结构：textarea 上、actions 行下（attach 左圆钮 / send 右高对比圆钮 32px），外壳 16px 圆角 + 细边 + 微阴影。④ header 居中身份、去分隔线；back 左侧、working 右侧绝对定位。⑤ 日期分隔符（grok sand-transcript-time-separator）：跨自然日插入居中 11px muted 标签，Intl 本地化。⑥ hover 操作锚定修复：`.bot-message-action` 从 `display:contents` 改为真实盒（fit-content + min(88%,640px) 封顶），工具栏随气泡而非行定位；user 行同样接 copy。⑦ 全部硬编码 lime 色（#bfe86b/#20231f/#1a1d19 等 15 处）替换为 bot 域 token（--bot-popover/--bot-code/--bot-shell），亮色主题不再破相。验证：视图测试 10/10（含分隔符/无头像/双角色 copy 断言）+ computed-style 断言清单（气泡/发送键/对齐/header 全绿）；`typecheck:all` 全仓被并行会话在途改动阻塞（message-framework.ts TS2741 / use-bot-direct-transcript 未完成 IPC），本 plan 触碰文件 tsc 零错误。文件：bot.css（token 化重样式）、BotDirectChatView/BotBubbleRow/BotComposer、测试。
- [ ] **P2.2** 卡片族：BotDirectCard / RoomRoundMark / RoomPassNote / BotBroadcastCard（接入 MessageItem 分派）。
- [ ] **P2.3** bot-direct 的工具/思考折叠（"查看过程"展开）+ room 视图直读群表并订阅更新。
- [ ] **P2.4** typing/busy 状态条（useStreamPhase；room 场景显示"成员 X 发言中"）。
- [ ] **P2.5** **卡宿主侧处理闭环（2026-09-02 完整性审计并入：C11）**——对齐 grok `widget-responses.ts`，为 duya 现有/未来卡片（审批卡、secret 卡、提问卡、权限卡）建立"落卡→用户响应→回写 agent"闭环：
  - **host 侧**：卡片在 transcript 落卡（复用 437 hook rows 的渲染通道）；用户操作（允许/拒绝/提交 secret/回答）→ IPC → 回写对应 run/agent（对齐 grok `respondToWidget`/`submitSecret` 路由到 connector credential store）；未答提问卡在下次 wake 时**补问**（`collectUnansweredQuestionPrompts` 语义）。
  - **reactToMessage**：对 bot 消息点 emoji → resume 一次隐藏 run 让 agent 感知（对齐 `reactToMessage`，483 §6 原列 P2 后置项提前为本项）。
  - **权限卡过期**：pending approval 超时清场 + 状态回写（对齐 grok local-tool-permission 卡 sweep；与 419/476 E4 userMessageEpoch 衔接——新回合即旧审批作废）。
  - **@mention 展开（478 依赖）**：host 侧消息解析把 `@agentHandle` 展开成提及上下文并定向唤醒目标 agent（对齐 grok `workflow-commands.ts` `expandWorkflowReferences`/`withMentionedAgentsContext`；478 P1.3 的 mention 优先在此获得 host 侧实现）。
  - 依赖：476 投递通道 + 481 工具 schema + 419 权限总线。**前端卡渲染与 host 侧闭环分离**——本 Phase 先做 host 闭环 + 复用现有卡 UI；新型卡（secret/permission）视觉后置。
- [ ] **P2.6** **bot 生命周期切换（2026-09-02 并入：C10）**——对齐 grok `agent-lifecycle.ts`：删除当前 bot → successor 会话选择（对齐 deleteAgents 的 successor 语义：删除后 UI 落到剩余 bot 或 Projects）；kickstart onboarding（新建 bot 的首条引导消息，对齐 `kickstartAgent`）；avatar 变更即时反映（P0.1 profile_changed 消费）。clone bot（连同 automations/avatar）列为 P3 后置。

> **P2.6 蓝本：kickstart 引导机制精读（2026-09-02 源码核实，`agent-lifecycle.ts` + `shared/agents/onboarding.ts`）**
>
> **结论先行**：grok 的"新 bot 引导"**不是知识库/RAG 驱动**，而是**静态 prompt 模板 + 会话状态门禁**驱动的一次 **hidden run**。模型唯一的外部知识 = 自身 profile（名字/描述已在 system prompt）+ 绑定 AGENTS.md。移植照抄机制即可，无需知识管线。
>
> **触发链**：
> ```
> 创建请求 isKickstartRequested=true（host-gateway-api.ts:97-98 透传，可选参数）
>   → createAgent → kickstartCreatedAgent(next.id)          （agent-lifecycle.ts:62-63）
>   → kickstartAgent(agentId, isRunReady)                    （:116，三重门禁见下）
>   → enqueueExclusiveRun(lane:"user", source:"kickstart")   （:180，hidden run）
>   → 模型输出经 SendMessage 送达（sentMessageCount>0）→ delivered → setIntroductionPending(false)
> ```
> **门禁**（全过才跑，:126-137）：① 非群聊/remote room 会话；② 会话 `introduction_pending` KV 为真（**新建默认置真**，agent-session.ts:106）；③ transcript 尚无任何 user 消息；④ 执行就绪 `canExecute`/`isRunReady`。
> **取消/作废条件**：① 用户在任何时刻发第一条真实消息 → `send-pipeline.ts:228 setIntroductionPending(false)` 直接作废引导（用户自己开口就不必自我介绍）；② 升级 quiesce → `markAgentResumePending` 后置续跑。
> **prompt 分支**（`SAND_ONBOARDING_KICKSTART_PROMPT`，onboarding.ts:1-8，`[first run]` cue）：
> - profile 有 concrete assignment → **跳过寒暄直接开工**，首条消息即交付结果或要审批；
> - 无任务 → 真实对话式探询（非表单/清单）：想要什么助手/怎么工作/素材在哪，**一次一问**，拿到真活即停；
> - 需要未接 connector → 就地发 connector 卡（检查已连接防重复）；
> - 一切经 SendMessage；选择用 question widget；**禁止透露被 cue 驱动**。
> - **disk-saver 特例**：`purpose==="disk-saver"`（磁盘低自动创建的角色）换 `SAND_DISK_SAVER_KICKSTART_PROMPT`（disk-saver.ts:7-11），跳过问候直接给审计+审批。
> **duya 移植要点**：① `introduction_pending` 状态位（用户首条消息即作废）——放 bot 常驻 session（477 映射）meta；② hidden run 复用 476 投递通道（source:"kickstart"，lane 语义同 user 但不可见）；③ "首条消息必须可见送达才算完成"判定复用 484 ack 语义（sentMessageCount>0）；④ prompt 静态模板放 474 或 bot 配置旁，含上述三分支；⑤ `custom-agent-creation`（创建层已落地）挂 `isKickstartRequested=true` 即接通，UI 无需新增流程。

### Phase 3 — 资料卡与设置
- [ ] **P3.1** Bot 资料卡五 tab 子页（复用 page/ui；活动/记忆 tab 依赖 476 P4.2 与 479 读侧 IPC，未就绪先占位）。
- [ ] **P3.2** 设置 tab：Bots 管理（bot 化开关/外观/唤醒偏好）+ 群组管理（groups.toml 写侧）。
- [ ] **G1** `npm run typecheck:all` + 前端单测；Playwright 手动验收（按 AGENTS.md UI 门禁）。

## 5. 验收标准

- [ ] 侧栏出现与 Projects 平级的 Bots 分组；单 bot 与群聊联系人可展开对话。
- [ ] **roster 实时性**：bot 改名/头像变更/忙闲切换在 ≤1s 内反映到联系人列表（P0.1/P0.3 验收；含重连补洞）。
- [ ] bot-direct：user 发消息 → bot 常驻会话 wake → bot 回复以气泡出现在聊天里；bot 的工具/思考默认不可见。
- [ ] room：3 人讨论按回合渲染（RoundMark/PassNote/@mention），实时更新。
- [ ] bot 只能经 SendMessage 通道发声——任何非最终消息形态不出现在联系人聊天（自动化断言）。
- [ ] 卡闭环（P2.5）：提问卡未答在下次 wake 补问；secret 提交到达 connector credential store；reactToMessage 触发 agent 感知 run；@mention 定向唤醒目标 agent。
- [ ] 删除当前 bot 后 UI 落到 successor（P2.6）；新建 bot 出现 onboarding 引导。
- [ ] Bot 资料卡、Bots/群组设置可用；唤醒偏好开关生效（双路互斥开关 476 P0-C 联动）。
- [ ] typecheck + Playwright 全绿。

## 6. 非目标

- 不做 bot 的头像生成器/富 Profile 编辑器（占位即可，后置）。
- 不做消息搜索/归档 UI（bot 历史搜索可复用全局 search plan 243 后续）。
- 新型卡视觉（secret/permission 的专用 UI）后置——本 plan 只做 host 侧闭环 + 复用现有卡渲染。
- 不动现有 ChatView 在 workspace 模式下的任何行为（模式分支隔离）。

## 7. 风险

- **双界面语义混乱**：bot 既有"工作台会话"又有"联系人聊天"→ 语义收敛为：工作台 = 过程，联系人聊天 = 最终消息视图（SendMessage 产物）；资料卡提供两者互跳。
- **chatMode 分支污染现有 ChatView**：分支必须收敛为少量 prop/hook，绝不在 MessageList 散落 bot 逻辑；验收含 workspace 模式回归。
- **room 实时性**：直读群表轮询有延迟 → 用 room 专属订阅（复用 stream-session-manager 的模式）；心跳/SSE 视 478 落地情况接入。
- **侧栏膨胀**：bot 数量多时联系人列表失控 → 搜索框（复用项目搜索）与"仅显示在线"过滤，P2 后置。

---

## 8. 决策日志

### 2026-09-04（第三轮）— 视觉复核修正（vision 工具恢复后）

vision provider 恢复可用后对实现截图与标准截图正面对审，两处修正：① header 身份改为**左对齐**（第二轮把 header 下方的日期分隔符误读为居中标题——像素分析中 x738-838 的文本实为分隔符）；② 助手气泡补回**浅色边框**（1px var(--border)，typing 药丸同步，标准截图 vision 复核确认助手气泡带浅色描边）。已知保留偏差：标准截图空输入态右侧是麦克风圆钮（grok 语音听写），duya 无语音功能，send 常驻但空态禁用；标准截图气泡内疑似带时间戳（vision 提及、像素证据不足），暂不加，待后续确认。

### 2026-09-04（第二轮）— P2.1b 视觉标准：用户截图 + grok-bot 0.18 recovered CSS 双源对齐

**背景**：用户提供截图（2026-09-03 21:03）作为视觉标准，要求对齐 duya bot 聊天窗口的 header/composer/气泡样式，并明确「消息泡前不放 bot 头像，整体干净」。视觉 provider 当日不可用（认证报错），改用浏览器 canvas 像素分析提取截图规格：主区 #242424、助手气泡 #313131（无边框）、用户气泡 #ecece8 全圆角（半径 ≈20px、右缘对齐、暗字）、发送键 ≈35px 高对比圆钮、侧栏 #151515 + 1px #313131 边、header 居中文本。佐证以 `grok-bot-0.18-reconstructed/frontend` 的 recovered `view.css`（sand-* 类，几何/结构权威：690px 列、18px 圆角、22px 行距、prompt-shell 结构）+ `runtime-theme-token-installer.ts`（user 气泡暗亮反转策略）。

1. **头像策略再修正（取代 09-03 第三轮第 2 条的 group-start 方案）**：transcript 行完全不渲染头像/名字，身份只在居中 header。理由：用户明确指令 + grok transcript 实态（`sand-transcript-row` 无头像元素）+ 截图助手气泡左缘即列左缘（无头像槽）。
2. **user 气泡弃 accent 改高对比色对**：截图用户气泡是中性象牙而非主题强调色；新增 `.bot-chat-view` 域 `--bot-contrast-bg/fg`（暗 #ecece8/#242424，亮反转），send 按钮共用同对（对应 grok `--sand-fill-primary` 同源用法）。主题适配走 `:root[data-theme='dark']` 覆盖，不硬编码进组件。
3. **硬编码 lime 清零**：P2.1 CSS 沿用了 grok 青柠主题色 15 处，与截图中性灰調冲突且破坏亮色主题；全部收敛为 bot 域 token（--bot-popover/--bot-code/--bot-shell），语法高亮 token 色除外。
4. **验证方式**：vision 工具不可用 → 截图像素分析提取规格 + 预览页 computed-style 断言（比截图更精确）；vitest 覆盖结构（分隔符/无头像/双角色 copy）。备注：P2.1 的测试文件从未跑通过（composer 未跟踪文件 + placeholderUnbound 断言错位），本次一并修复至 10/10。

---

### 2026-09-04 — 挂载修正：ChatView 嵌套改为 App 级平级分支

**背景**：用户审查 P2.1 时指出 ChatView 本身就是消息界面，与 BotDirectChatView 应为平级视图而非嵌套关系；随后核对代码发现原方案（"ChatView 末尾早期 return"）**从未真正落地**——d413696b 只提交了组件/测试/chat-mode/CSS，ChatView 无任何引用（`git log -S BotDirectChatView -- ChatView.tsx` 全历史为空），P2.1 勾选与事实不符。

1. **新分支位置（取代 09-03 第三轮第 1 条）**：`App.tsx renderView()` 内 `currentView === 'chat'` 处按 `resolveChatMode(activeThreadId)` 派生互斥渲染 `BotDirectChatView` / `ChatView`。理由：① 单一事实来源是线程 id 前缀，不会出现 currentView 与 activeThreadId 脱同步；② bot 会话不再白跑 ChatView 的 1600 行 hooks（SSE 订阅/线程加载/权限等副作用）；③ 489 P0.3 `useBotDirectTranscript` 已把数据层做成自包含，"复用 ChatView streaming 语境"的原理由基本失效。不新增 ViewType 枚举值——bot-direct 视图强依赖 activeThreadId，独立枚举反而引入脱同步面。
2. **数据源**：现阶段仍传 store `messages[activeThreadId]`（组件内 isBubbleMessage 过滤 + StatusRow 压缩已兜底）；489 P0.3 IPC 后端（`db:message:botDirectGetTranscript` + `source` 列迁移）落地后切换订阅源——注意该 hook 当前引用的 `getBotDirectTranscriptIPC` / `Message.source` 尚不存在（未完成的工作区文件，勿在本 plan 内半途接线）。
3. **发送路径**：暂复用 `handleSendMessage`/`handleInterrupt`（P2.5 重接为 bot 专属管线）；composer 门控不变（仅 `boundThreadId != null` 启用）。
4. **补齐 send_to_ui 预埋桥接**：HEAD 已提交的 App.tsx `message:new` 监听（483 P2 send_to_ui）对应的 preload 桥接从未落地（`onMessageNew` 不在 ElectronAPI 类型/实现中，HEAD 本身 typecheck 不过）。本次补上 preload 桥接 + 类型声明（主进程侧 `db-bridge.ts` 的 `broadcastSessionEvent('message:new')` 已存在），bot SendMessage 产生的消息现在能实时到达 bot-direct 视图。顺带修复 487 遗留的 `settings.getHostToolPermission/setHostToolPermission` 类型声明缺失与 `SettingsRow` 不存在的 `icon` prop 用法。
### 2026-09-04 — 占位 id 边界由 491 P2.5 收敛：partialize + cleanup + sidebar fast-path

**背景**：用户反馈新建 bot 后侧栏出现该 bot，但点击不跳转到 BotDirectChatView（视图瞬间闪回 WelcomeView，看上去"无反应"）。

**根因**：
- 09-03 第三轮第 3 条设计的 `bot:<agentId>` 占位 id 在 store 里有两条意外收窄路径：
  1. `setActiveThread("bot:<agentId>")` 同步 `set(updates)` 后 `await loadFromDatabase()` 命中 plan 224 / ddfccf12 引入的 orphan cleanup，把刚设的 placeholder 立即清回 null。
  2. `partialize` 把 placeholder 原样写进 localStorage，下次启动 hydrate 后被同一清理再次清掉——重启体验丢失。
- 这两条路径是 09-03 决策时未考虑到的：当时只假设了占位 id 是 "in-memory 状态"，没意识到它会经 store 持久化层 + DB 同步层各被击一次。

**修复归位**：挂在本 plan 之外、由 [491 P2.5](./491-bot-chat-messaging-feel.md#phase-25--bot-新建后跳转回归修复bugfix独立于-p2-打磨) 落地。
- **D1 partialize**：新增 `isPlaceholderBotThreadId(id)` 与 `partializeConversationState(state)` 纯函数；persist middleware 的 partialize 委托前者。占位 id 持久化为 null。
- **D2 cleanup 白名单**：`loadFromDatabase` 的 orphan-cleanup 分支遇到 placeholder 跳过清除。
- **C fast-path**：`app-sidebar.tsx` 新增 `handleOpenBotById(agentId)`，`CreateBotDialog.onCreated` 改为先跳转再 `await reloadBots()`。

**对 P1.3 设计意图的兑现**：占位 id 是合法的 "in-memory active state"，partialize 与 cleanup 都在它的边界处过滤（一致源头 `isPlaceholderBotThreadId`），不再依赖两者各自特例化处理占位形状。后续 477 binding 接入后真 session 走 `bot:<agentId>:<sessionId>` 三段形式，仍能正确区分。

**与本 plan 后续 phase 关系**：
- 与 P2.5 发送路径解耦不冲突：占位只是"未发消息的 bot"，第一条真消息时 477 binding + `createThread + 替换 id 再发` 路径会让 placeholder 自然消失。

---

### 2026-09-03（第三轮）— P2.1 聊天舞台：独立组件 + 早期 return，零侵入 MessageList

1. **分支位置**：ChatView 所有 hooks 之后的 render 末尾早期 return → `BotDirectChatView`。不另设 App 级路由（保持 ChatView 的 streaming/handleSend 语境可复用），也不穿透 props 进 MessageList（plan §6 约束兑现）。
2. **头像策略合并**：plan 原文要「头像+名字色」、grok 实测 transcript 内无每条头像（仅 header 28px）。合并为 Telegram 式：**group-start 行**带 22px 头像+名字，续行无；header 常驻 28px 头像。空态（无消息）居中 72px 头像。
3. **composer 门控**：绑定期（`boundThreadId != null`）才启用；占位 id `bot:<agentId>` 禁用 + 提示文案。防上屏垃圾 session（发送走现有 handleSend 管道，只在真实会话上发生）。
4. **状态行**：tool_use/thinking/hook 消息（role 亦为 assistant）压为单行胶囊 chip，不打断 bubble 分组（assistant 文本续接同组）；展开交互留 P2.3。
5. **grok 几何 → duya token**：690px 居中列、max-width min(88%, 640px)、18px 圆角、22px 行距、user 气泡 color-mix(accent 22%) 右对齐；颜色全部走 var(--surface/--border/--text/--muted/--accent) 双主题。
6. **文件落点**：`chat/bot/chat-mode.ts`（resolveChatMode/resolveBotAgentId，7 测试）、`chat/BotDirectChatView.tsx` + 测试（8）、`ChatView.tsx`（分支 + 2 import）、globals.css（bot-chat-* 区块）、i18n `bot.chat.*`（zh/en 各 6）。

---

### 2026-09-03（第二轮）— 创建流程对齐 grok-bot + Bots 分组常显

**背景**：用户反馈两点：① 手动在设置里加了 `[agents.test1]` 后侧栏仍看不到 Bots（空组隐藏 + 渲染层未重载叠加）；② 加 bot 的流程/表单与 grok-bot（`E:/cloned-projects/grok-bot-0.18-reconstructed`）差距大 —— grok 是模板建议 + name/description + 形状×颜色形象，duya 是开发者向的配置表单。

**决策**：
1. **Bots 分组常显**：推翻首轮「无联系人时整组隐藏」——实际使用中让人困惑（用户两次问「没看到 bot」）。空态改为显示「创建 Bot」引导行。
2. **创建流程对齐 grok**：新增 `CreateBotDialog`（模板建议 ×8 + name 必填 + description + 形状×颜色形象选择，id 由 name 自动 slug 化不暴露给用户）。模板取 grok catalog 的通用子集汉化。
3. **形象体系照搬 grok**：8 形状（blob/pebble/squircle/tablet/wedge/hex/cloud/teardrop）× 11 色 token，`BotCharacterAvatar` SVG 渲染；无 token 的旧数据回退确定性色相首字母圆。
4. **存储分层遵循 485**：avatarShape/avatarColor 只进 `profile.json`（身份层），config.toml 不动；485 P2.1 的 seed 流程扩展为透传 avatar token（主侧校验，未知 token 丢弃）。新 IPC `config:bots:list` = config + profile 合并读侧（profile 字段优先，485 §2.4 runtime identity wins）。
5. **已知偏离**：图片裁剪上传头像（grok avatar-editor 的另一分支）本轮未做，485 身份层已预留 `avatar.<ext>` 落点，归 Phase 3 资料卡。

**验证**：34 相关单测过（bot-contacts 15 + section-system 8 + agents 11）；`tsc --noEmit`（src）绿；`build-electron.mjs` 绿。注：`npm run typecheck:all` 当前被另一并行会话在 packages/agent 的在途改动（TS1308，plan 475 相关）卡住，与本 plan 无关；CodeReviewPanel 的 4 个测试失败同样来自并行会话的在途改动。

### 2026-09-03 — Phase 1 基础落地：数据源用 config agents 替代 477 绑定映射

**背景**：Phase 1 前置（476/477/478）全部还在 Planning，bot 常驻会话绑定与 groups.toml 都不存在。用户要求先落 UI 基础。

**决策**：
1. **联系人数据源** = `[agents.<id>]` config（复用 plan 424 已落地的 `config:agents:list` IPC），无绑定会话的联系人照常渲染。
2. **绑定并接预留**：`buildBotContacts` 已实现 477 约定（`bot:<agentId>:<sessionId>` 前缀扫描 + 最近 updatedAt 优先）的合并逻辑，绑定线程出现后无需改代码自动生效。
3. **无绑定导航降级**：点联系人 → 占位 id `bot:<agentId>`（与 477 前缀约定兼容，`detectThreadKind` 会把它路由进 bot 桶），`setActiveThread` 对不存在线程降级为空聊天壳，不写库不建会话。
4. **未读角标**：仅留 CSS 钩子（`.bot-contact-unread`），计数源待 plan 202 mailbox。
5. **room 联系人**：完全未建（`room:` 前缀路由已备），待 478 groups.toml。
6. **文件落点**：`section-system.ts`（kind/前缀/分桶/描述符）、`bot-contacts.ts`（纯函数 + 单测）、`use-bot-contacts.ts`（hook）、`BotContactListItem.tsx`、`app-sidebar.tsx`（sidebarStructure + 渲染分支 + 导航）、`SidebarSectionItem.tsx`（SectionKind 扩 'bot'/'room'）、globals.css（bot-contact 样式）、i18n（`sidebar.section.bots` / `bot.contactBusy`）。

**验证**：18 新单测（section-system 8 + bot-contacts 10）全过；`npm run typecheck:all` 绿；layout + i18n 既有测试无回归（37 过）。Playwright UI 验证待 Electron 手动冒烟（与 P3 G1 合并）。
