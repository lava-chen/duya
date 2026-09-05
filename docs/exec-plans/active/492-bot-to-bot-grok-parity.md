# 492 — Bot 间交互 grok 全面对齐(契约接线 + 抢占闭环 + 透明性 + Agent 自管理)

> **Status**: Phase 1 ✅(2026-09-04);Phase 4 ✅ 代码+单测(2026-09-05,e2e 挂 P6.2);Phase 2/3/5/6 待开工 · **Priority**: P0 · **Owner**: TBD
> **总纲**: [473-grok-bot-framework-overview](./473-grok-bot-framework-overview.md)
> **关联**: [476-agent-wake-bus](./476-agent-wake-bus.md)(已完成)· [477-agent-dm-messaging](./477-agent-dm-messaging.md)(P1-P3 已勾)· [478-shared-rooms-group-chat](./478-shared-rooms-group-chat.md)(未启动,群聊主 plan)· [490-bot-toolset-turn-tool-alignment](./490-bot-toolset-turn-tool-alignment.md)
> **研究基线**: 2026-09-04 对 grok-bot 0.18 重建库逐文件精读(`agent-messaging.ts`、`sand-agent-management-tools.ts`、`group-chat.ts`、`group-chat-orchestrator.ts`、`group-chat-glue.ts`、`agent-to-agent-messaging.ts`、`background-wakes.ts`),并逐项核实 duya 侧真实接线状态(以 grep 消费者为准,不采信 plan 勾选)。

---

## 0. 立项动机

用户目标:**做完本 plan 后,duya 的 bot 间交互能力与 grok-bot 相当**。

477 已落 DM 信封/工具/wake prompt/常驻绑定,478 已有群聊完整设计(未动工)。但 2026-09-04 逐行核实发现三类问题:

1. **契约层是死代码**:`buildAgentMessagingSystemPrompt`(grok `renderAgentDirectorySystemPrompt` 的移植,含异步语义/判断力/隐私转述全文)**没有任何 prompt 组装点调用**。bot 的 system prompt 实际只拿到 commsRules 的短规则 + roster 的裸列表(还有一句弱引导 "How to contact…see your available tools")。契约靠工具描述单点支撑——与 grok 的"三处强化"不符。
2. **抢占只完成了一半,且 prompt 在"说谎"**:`decidePreemption`(476 §2.2 纯逻辑)与 `DmPreemptionTracker`(477 P2.1)均**无消费者**;`agent-dm-dispatcher` 无任何 interrupt/redrive 路径。而 `buildAgentInboundWakePrompt` 的 priority 分支已写入 "It interrupted your previous non-user work" ——**运行时并没有发生打断**,提示词承诺了不存在的语义(grok 里这句话为真,因为 background-wakes 真的 interrupt)。
3. **透明性断裂**:wake prompt 告诉 bot "Your user can already see it in this chat",但 bot-direct 视图白名单只有 `source in {send_message, user}`——agent DM 条目对用户不可见。这句话目前也是假的。

另有两项 grok 能力整体缺失:CreateAgent/UpdateAgent(bot 不能自建队友,490 已列缺口)与群聊编排(478 全部未勾,本 plan 以增补修正的方式挂接,不重复其内容)。

## 1. 现状盘点(2026-09-04 逐行核实)

### 1.1 已就绪(保持,不重建)

| duya 资产 | 位置 | 状态 |
|---|---|---|
| 信封编解码(digest/dedupe/nonce/replyTo) | `packages/agent/src/agent/dm/envelope.ts` | ✅ 已接 |
| SendToAgentTool(images+priority,自消息重定向、未知 id 带可用列表的 helpful error) | `packages/agent/src/tool/SendToAgentTool/` | ✅ 已接 |
| inbound wake prompt(几乎逐字 grok,含 priority 分支文案、图片转附、FYI 沉默) | `packages/agent/src/agent/dm/wake-prompt.ts` | ⚠️ 已接但 priority 文案失真(见 §0.2) |
| 契约层全文(异步/判断力/隐私转述/接收礼仪/透明性) | 同上 `buildAgentMessagingSystemPrompt` | ❌ **死代码,未接入组装** |
| 环路检测 DmCycleDetector + 限速 DmSendLimiter(grok 没有的增量) | `agent/dm/dm-cycle-detector.ts` | ✅ 已接 |
| roster 数据源(config `[agents.*]` + `profile.json` → `ctx.agentDirectory`,cap 40) | `prompts/bot/loader.ts:121-145` | ✅ 已接 |
| wake bus(pending_wakes 持久化、agent 车道、epoch 乐观抑制) | `electron/wake/wake-dispatcher.ts` | ✅ 已接 |
| 抢占纯逻辑 `decidePreemption`(user_wake/priority_dm/redrive) | `packages/agent/src/wake/preemption.ts` | ❌ **无消费者** |
| 抢占标记 `DmPreemptionTracker` | `electron/agents/dm/DmPreemptionTracker.ts` | ❌ **无消费者** |
| epoch 机制(仅 user run 推进 `advanceUserTurn`;queue 出队时跳过 stale) | `electron/wake/wake-dispatcher.ts:136-168` | ✅ 已接(但只覆盖"排队中的旧 wake",不覆盖"运行中的回合") |

### 1.2 grok 对应物映射(移植对照表)

| grok-bot 0.18 | 机制 | duya 落点 |
|---|---|---|
| `renderAgentDirectorySystemPrompt`(system-prompt.ts 注入) | 契约+目录合一 | **P1**:roster section 渲染时调用升级版 `buildAgentMessagingSystemPrompt` |
| `buildAgentInboundWakePrompt` priority 分支 redrive 句 | "你之前的工作被搁置,回复后回去继续" | **P2**:补进 duya wake-prompt(接线打断后语义为真) |
| `background-wakes.ts` interrupt + `runner.interrupt("superseded by a priority agent message")` | 优先级 DM 打断运行中非用户回合 | **P2**:wake-dispatcher 消费 `decidePreemption` |
| `dmPreemptedWakeAgentIds` Set | 被抢占标记 → 唤醒时注入 redrive note | **P2**:接线 `DmPreemptionTracker` |
| 群消息在成员聊天可见(user-role 转录条目) | 透明性 | **P3**:bot-direct 视图白名单扩展 + [agent] 样式 |
| `sand-agent-management-tools.ts` CreateAgent/UpdateAgent | bot 自建/自改队友 | **P4** |
| 群编排全套 | 478 主计划 | **P5**(仅增补修正) |

### 1.3 明确不做(超范围)

- sand-msg 引用链、request_box_help、box 工具族(不同子系统)。
- 跨设备 remoteMembers(478 非目标已排除)。
- bot 间语音/富媒体协作。

---

## 2. 设计

### 2.1 Phase 1 — 契约层接线(prompt-only,零运行时改动)

**原则:一处出口**。grok 是 `renderAgentDirectorySystemPrompt` 单点输出契约+目录;duya 对应把契约挂到 roster section(它已持有 `agentDirectory` 数据),commsRules 不再重复 agent 间规则(避免双份漂移)。

- [x] **P1.1** 升级 `buildAgentMessagingSystemPrompt`(dm/wake-prompt.ts)补齐 grok 缺失段:
  - fan-out 政策:"给一个明确相关的队友发=正常工作;同时给多个/群发=fan-out,会唤醒每个接收者并把回复灌回用户聊天——仅在用户明确指示时;否则先 SendMessage 提议(点名对象+内容)等确认;等用户数据时绝不'顺便'fan out"。
  - 能力可见性:"用户可能不知道这功能存在——主动展示('要不要问问你的研究 agent?'),并把自然语言线索('@那个 agent')识别为调用信号"。
  - agent 管理预告段(Phase 4 落地后自然生效,文本先行)。
  - 群聊段落占位(Phase 5 接线后启用,用 feature flag 或 roster 入参分组)。
- [x] **P1.2** roster section(`prompts/bot/roster.ts`)改为:头部契约(调用 P1.1 产物)+ 目录列表;删除 "How to contact…see your available tools" 弱引导;commsRules 删除 "Talking to other agents" 小节(保留 user voice 与 wake/quiet-work 语义),catalog 描述同步。
- [x] **P1.3** 预算调整:roster budget 上调(契约 ~2.4k chars + 目录);epoch.ts 的 roster snapshot hash 无需改(自动跟随)。
- [x] **P1.4** 测试:prompt 集成断言(关键句存在:fan-out/privacy relay/capability/async);commsAndProfile/sections 预算测试更新;roster snapshot 变化不影响已有 cache 测试。

**验收**:任一 bot 的 system prompt 包含完整契约 + 真实队友列表;两处(工具描述/系统提示)异步语义一致。

### 2.2 Phase 2 — 抢占闭环(诚实性修复 + 运行时对齐)

**语义对齐 grok**:user wake / priority DM → 打断运行中的**非用户**回合;background/automation → 排队等当前回合结束(现有 epoch 机制继续负责 stale 清理)。

- [ ] **P2.1** `wake-dispatcher` 消费 `decidePreemption`:drain 时若 session 有 running run 且 incoming 是 `user` 或 `priority dm` → 走 preempt 分支(而非排队)。需要 agent-server 侧 interrupt 通道:复用 476 §6.2 与 router.ts 的 STREAMING 状态机(HTTP 层 stop/abort),dispatcher 通过 activeDeps 注入的 runner 接口发 interrupt,理由串 `"superseded by a priority agent message"`(对齐 grok 文案)。
- [ ] **P2.2** redrive 接线 `DmPreemptionTracker`:interrupt 时 `markPreempted(displacedRunOwner)`;被抢占 run 的恢复策略(见 D2 决策,默认 grok 对齐:interrupt+resume,displaced run 以 redrive note 重入 agent 车道)。redrive note 文案(grok 逐句):"Your earlier work on <X> was set aside to take this message; pick it back up after you reply"。
- [ ] **P2.3** wake-prompt priority 分支补 redrive 句;并确认全链路后该分支所有句子为真(诚实性门槛:若 P2.1 未落地,此句必须保持弱化——本 phase 完成后即为真)。
- [ ] **P2.4** 测试:dispatcher 单测(priority dm → preempt 路径、background → 排队路径、user wake → preempt)+ tracker 单测 + e2e(priority DM 打断 running automation turn,redrive note 出现在恢复回合)。

**验收**:priority DM 能打断正在跑的 automation 回合;被打断的工作在 redrive 中不丢;普通 DM 不打断。

### 2.3 Phase 3 — 透明性(用户可见 bot 间消息)

- [ ] **P3.1** 数据层核实:DM in/out 在 MessageLog 的 source/kind 取值(477 P1.3 已落"双向记录",确认字段与投影路径)。
- [ ] **P3.2** `use-bot-direct-transcript` 白名单扩展 dm 类条目;`BotDirectChatView` 渲染 [agent] 风格气泡(chip:收=`from` 名,发=`to` 名),与 user/send_message 气泡视觉区分;遵循 489 的数据层过滤模式(不重蹈 483 P2.1 "UI 层假装过滤"覆辙)。
- [ ] **P3.3** i18n(zh/en)+ Playwright 验证(bot-direct 视图真实可见 agent 收发条目;gate:UI 改动必走 Playwright)。

**验收**:A↔B 的每条 DM 在 A 和 B 的聊天界面均可见——wake prompt 的 "Your user can already see it in this chat" 从此为真。

### 2.4 Phase 4 — Agent 自管理(CreateAgent/UpdateAgent)

- [x] **P4.1** 工具 schema + 描述逐句移植 grok `sand-agent-management-tools.ts`:name/id 唯一性、description 写什么(角色+专长,目录可见)、helpful errors("id 已存在:用 UpdateAgent"/"重名:换 id")。→ `packages/agent/src/tool/AgentManagementTool/`(wire names `create_agent`/`update_agent`,snake_case 对齐 send_to_agent/update_state;grok 描述逐句移植,send_to_agent 引用替换为 duya wire name)。
- [x] **P4.2** 持久化:**config.toml `[agents.<id>]`**(electron main 拥有配置写入,通过 IPC handler;loader 已有热读)。grok 是文件系统直写;duya 对应物即 config。权限模型见 D1(默认 grok 对齐:free + 审计日志;可选审批卡开关)。→ agent 子进程经 db-client `config:agents:create|update` → db-bridge case → `createConfigAgentFromName`(slugify+allocateBotId 无碰撞 id)/`patchConfigAgentIdentity`(显式字段挑选,保住 model/workspace/tools/plugins,软删除条目返回 not found);main 侧 INFO 审计日志;agent 进程零直接写 config。
- [x] **P4.3** roster 热更新:创建/更新后 config 变更广播 → 各 bot 下次 prompt 组装自动拿到新目录(epoch snapshot hash 变化即生效,无额外机制)。→ 零新增机制达成:agent 侧 `readConfigAgents()` 直接重读 config.toml(无 main 回程),main 写入同步返回后即生效;SendToAgent 的 roster 校验同源。
- [x] **P4.4** 工具注册进 `BOT_TOOLSET`;单测(校验/幂等/权限)+ e2e(创建 → 出现在对方 roster → 可 DM)。→ 注册 builtin.ts(discoverable)+ BOT_TOOLSET 追加;单测 15 例(工具校验/grok 教学 error/暴露契约:裸 '*' 不提升、applyBotToolset 精确名提升、deny 仍胜)+ bot-toolset 测试更新。**e2e 待做**(需真实 Electron 双 bot 场景,与 P6.2 ⑤ 合并验证)。

**验收**:bot A 可创建 bot C,C 出现在所有 bot 的 roster 且可被 DM——对齐 grok "agents spawn teammates"。

### 2.5 Phase 5 — 群聊(= 执行 478,本节仅增补修正)

478 是群聊主计划(P1-P3 未动);本 plan 不重复其内容,只把 2026-09-04 grok 精读发现的 6 处细节增补进 478 的执行要求:

- [ ] **P5.A1** 478 §2.2 增补:pass 流式前缀抑制(grok `isPotentialPassPrefix`:"(pa…" 开头不上屏预览);pass 不进群历史。
- [ ] **P5.A2** 478 §2.2 增补:成员上下文最小化精确语义 = "只注入该成员上次发言之后的新消息"(非固定尾部窗口);首轮给最近 N 条。
- [ ] **P5.A3** 478 增补:群成员被 priority DM 打断的 redrive note(grok `buildGroupRedriveNote`,最多重试 3 次):"房间没看到你的回复——已做完就把结果发回房间"。
- [ ] **P5.A4** 478 增补:shared-room 变体(历史 cap 24 + guardrail 提示词段:"工具调用与纯文本是私人草稿,只有 SendMessage 文本会送达房间")。
- [ ] **P5.A5** 478 增补:统一历史 tag(成员 1:1 转录中群回合标记 `[Group chat: "名字" - 与 A, B]`)+ 隐私声明("你和用户的这个聊天是私密的,群里看不到")。
- [ ] **P5.A6** 478 增补:群不能套群(建群校验 + mention 解析时优雅忽略嵌套群)。

**验收**:以 478 G1 为准(3 bot 受控轮转 + 收束 + 用户打断),叠加上述 6 项的用例。

### 2.6 Phase 6 — 对齐验收与收口

- [ ] **P6.1** grok 十原则逐条核验表(双通道/异步三处钉死/契约即工具描述/接收礼仪/透明性/有界编排/优先级车道/错误即教学/redrive/上下文最小化)——每条给出 duya 落点与验证证据。
- [ ] **P6.2** e2e 场景集:① A→B DM→B wake→回复;② priority DM 打断 automation + redrive;③ 透明性(A、B 界面均可见);④ 3-bot 群聊(478 G1);⑤ CreateAgent → roster → DM;⑥ 环路拦截(回归)。
- [ ] **P6.3** ARCHITECTURE.md 更新(bot 交互一节);plan 归档 completed/。

---

## 3. 关键决策点(默认值已按 grok 对齐,可改)

| # | 决策 | 默认(grok 对齐) | 备选 |
|---|---|---|---|
| D1 | CreateAgent 权限模型 | free + 审计日志(grok 即如此;单用户桌面 app 信任边界内) | 强制审批卡(复用 permission 系统) |
| D2 | 抢占恢复策略 | interrupt + redrive 重入(grok 语义,被抢占工作不丢) | 丢弃 + note 重排(实现更廉,丢尾副作用) |
| D3 | 透明性渲染形态 | 独立 [agent] 气泡(信息完整,对齐 grok) | 单行 chip(省空间) |
| D4 | 契约出口 | roster section 单点(grok 单出口模式) | 恢复 buildAgentMessagingSystemPrompt 独立 section |

## 4. 风险

- **成本**:群聊/抢占放大 token 消耗 → 478 三重熔断(rounds/turns/预算)+ DmSendLimiter 已有;P2 抢占仅限 priority,user 永远最高优先。
- **诚实性回归**:任何 prompt 断言(打断/可见)必须先有运行时事实——P2.3/P3.3 是门槛检查点。
- **抢占误伤**:interrupt 打断流式写库可能留半条消息 → 复用 489 的 phase 机(消息仅 phase=complete 时对用户可见)+ stream-retry 的 resume 语义。
- **配置写入并发**:P4 多 bot 同时 CreateAgent → config.toml 写入走 main 进程单点 IPC 串行化。

## 5. Amendment 记录

- 2026-09-05: **Phase 4 代码+单测完成**(P4.1-P4.4)。落点:新工具 `packages/agent/src/tool/AgentManagementTool/`(create_agent/update_agent,grok sand-agent-management-tools 描述逐句移植);注册 `builtin.ts`(discoverable × 3,含补上 SendToAgentTool 缺失的注册点——477 P1.2 工具实现早已完成但从未进 registry);`BOT_TOOLSET` 扩至 `['send_to_agent','update_state','SendMessage','create_agent','update_agent']`;持久化链 `configDb.agentCreate/agentUpdate` → db-bridge `config:agents:create|update` case → `electron/config/agents.ts` 新增 `slugifyBotIdFromName`/`createConfigAgentFromName`/`patchConfigAgentIdentity`(显式字段挑选避免 upsert 整行替换丢 model/workspace/tools;软删除条目自然 not found);main 侧 INFO 审计日志(D1 默认)。测试:AgentManagementTool 15 例(含暴露契约:裸 '*' 不提升/精确名提升/deny 仍胜)+ bot-toolset 8 例;agent 包 tsc 绿;agent-profile+bot prompts 126 例全绿;electron tsc 编辑区域零新增(预存 963 行噪音与本改动无关)。**暴露对齐说明**(490 对照盲区补记):send_to_agent 此前仅在 BOT_TOOLSET 预收名字、工具本体未注册——本轮补齐后 bot 第一轮静态可见工具集与 grok 静态集的差额收敛为 ReactToMessage(490 P1)/CopyToBox 族(490 P2)/image_generate+MessageSession 的暴露模式决策。注:Phase 4 落在共享 checkout 未提交 WIP(489/496/491)之上,提交需先与在途会话协调。

- 2026-09-04: 立项。基于 grok-bot 0.18 重建库精读 + duya 侧逐消费者 grep 核实。修正 477 P2.1 的勾选认知(抢占/红驱部件已建但未接线)、发现契约层死代码与透明性断裂;CreateAgent/UpdateAgent 执行责任自 490 移入本 plan P4。
- 2026-09-04: **Phase 1 完成**(P1.1-P1.4)。落点:`buildAgentMessagingSystemPrompt` 升级(新增 fan-out 政策 / 能力可见性 / agent 管理预告(条件式措辞,满足诚实门槛)/ 群聊占位(options.groups),目录行携带 description)+ roster section 改为契约单点出口(D4)并删除弱引导 + commsRules 删「Talking to other agents」小节(wake/quiet-work 语义保留为「Wakes and quiet work」)+ 预算 roster 2000→8000(实测契约 ~3.2k + 40 长条目 ~6.6k)/ commsRules 2400→2000。测试:新建 dm/wake-prompt.test.ts(9 用例)+ sections/commsAndProfile 更新;@duya/agent typecheck 绿,bot 相关 69 用例全绿,全包 threads-pool 基线对比零新增失败(预存失败为 better-sqlite3 ABI 与池偶发,与本次无关)。注:全仓 `typecheck:all` 当前被工作区其他会话进行中的 WIP(483/486/491 相关 renderer 文件)阻塞,与 Phase 1 无关。
- 2026-09-05: **image_generate 暴露归属决策落地**(grok 静态面对照遗留项)。BOT_TOOLSET 扩至含 'image_generate'(精确名提升,bot 第一轮静态可见),不注册 always——grok 对所有非 subagent 回合静态暴露 GenerateImage,duya 的对应物是 bot profile 提升而非全局暴露。bot-toolset 注释 + 测试(含 ReactToMessage 不入 BOT_TOOLSET 断言)。ReactToMessage 本体见 490 amendment 同日记录。
