# 473 — Grok Bot 机制移植总框架（Bot 提示词层 / 压缩增量 / 唤醒与多 Bot 通讯）

> **Status**: Planning · **Priority**: P0（总纲）/ 子 plan 各自定级 · **Owner**: TBD
> **Goal**: 把 `E:/cloned-projects/grok-bot-0.18-reconstructed`（Grok Bot 0.18 逆向重建，下称 **grok-bot**）的 bot 机制系统性移植进 duya。本 plan 是**总纲**：只描述框架、全景映射、依赖顺序与验收边界；具体实现拆到子 plan 474–478。
>
> **信息源**：`source/host/runner/`（提示词）、`source/host/extensions/transcript/`（唤醒/通讯）、`source/host/extensions/session/`（会话压缩）、`source/host/groups/`（群聊）、`source/host/agents/`（bot 档案）。

---

## 1. 为什么现在做 / 与既有 plan 的关系

| 既有资产 | 状态 | 与本系列的关系 |
|---|---|---|
| plan 422 压缩全面对齐 grok | ✅ P1–P3 基本完成（余 P3.4/G2） | **不重做**。新压缩 plan（475）只做 bot 场景增量 + 收口 422 |
| plan 413/413a-e Mode 状态机 | ✅ 已对齐 grok 多 mode | 不动 |
| plan 2026-08-31 多 Agent Profile 设计 | Planning（A 简易提示词 / B 记忆分区 / C Agent Bus） | 本系列 = 其 **A 的 grok 化落地（474）+ C 的结构化实现（476/477/478）**；B（记忆分区）保持独立推进 |
| plan 202 AgentMailbox | 已落地（agent_mailbox + claim/apply checkpoint） | 作为 wake/DM 的**传输层**复用，不另起 IPC |
| plan 212 task-notification / mailboxBackgroundNotification | ✅ 完成 | 已是「任务 completion 唤醒」的对应物，476 收编为一个 WakeSource |
| plan 409 cron 单一来源 | 代码完成 | cron fire 收编为 476 的 WakeSource（automation lane） |
| plan 424 `[agents.<id>]` 配置化 bot | 读侧 ✅ | bot 档案/常驻绑定在 477 落地 |
| gateway 入站（channel_bindings + adapters） | ✅ | connector inbound 唤醒的既有入口，476 收编 |

**结论**：duya 已具备 grok-bot 四根支柱中的「后台任务通知」「传输层」两根；缺的是**三车道唤醒调度、pending-wake 持久化/rearm、bot 人格提示词层、bot↔bot DM 与群聊编排**。

---

## 2. 全景映射：grok 概念 → duya 对应物 → 缺口 → 子 plan

### 2.1 五层通讯（用户指定的范围：先做 ①②③）

| # | 层 | grok 实现 | duya 现状 | 缺口 | 子 plan |
|---|---|---|---|---|---|
| ① | **用户 → bot** | `send-turn-dispatch.ts` `dispatchUserTurn`（lane=user，epoch+ack，抢占当前 run） | renderer/gateway HTTP chat 入口 + queue FIFO `now` | lane 化 + 抢占语义统一 | 476 |
| ② | **bot → bot（DM）** | `agent-to-agent-messaging.ts`（envelope + priority 抢占 + redrive）、`agents/agent-messaging.ts`（[agent] cue、防乒乓） | MessageSession 一次性 Q&A + interagent-router 环检测（v2 遗留） | 结构化 envelope、投递进目标 bot 唤醒队列、防回环 prompt 约束 | 477 |
| ③ | **群聊 / 共享房间** | `shared-rooms.ts` + `groups/`（memberIds≤6、轮次编排 GROUP_MAX_ROUNDS=3 / MAX_MEMBER_TURNS=10、(pass) 沉默、@mention handles） | 无 | 全部（大头，最后做） | 478 |
| ④ | broadcast（管理员广播） | `background-wakes.ts:309-353`（clamp 8000 字符，[broadcast] cue） | 无 | 随 476 顺带（低优先级） | 476 |
| ⑤ | connector/channel inbound | `wakeForInbound(agentId, envelope)` | gateway inbound + channel_bindings **已可映射** | 接到 wake 队列（agent/background lane 分类） | 476 |

### 2.2 唤醒（wake）体系

| grok 机制 | 内容 | duya 现状 | 子 plan |
|---|---|---|---|
| **三车道 run-scheduler** | 每 agent 一个 RunQueue：`pendingUser > pendingAgent > pendingBackground` 三条 FIFO，串行执行 | `packages/agent/src/queue/index.ts` 有 now/next/later 三优先级雏形，但无 lane 语义、无来源注册 | 476 |
| **wake 来源分类** | subagent completion / shell completion / automation fire（防抖 750ms 合批、≤25 条、上限 500）/ timeline event / connector inbound / channel failure / broadcast / user / agent DM | 已有 task-notification 与 cron 两类，各自为政 | 476 |
| **pending wake 持久化 + rearm** | `sand-pending-wake-store.ts`（原子写 host-pending-wakes.json）+ `pending-wake-rearm.ts`（重启后 pruneStale 48h → 重新 watch / 合成"host 重启打断"错误 completion） | 无（mailbox 行持久化近似，但无 rearm 语义） | 476 |
| **priority 抢占 + redrive** | agent DM priority=true 插队头 + 中断接收方非用户 run + `isRedriven` 回队重放 | mailbox soft-interrupt 近似；无抢占/重放 | 476 |
| **quiet-work 语义** | `QuietWakeOrigin` 标记自发工作 → 唤醒 prompt 用 QUIET_REVIVAL_INSTRUCTION（无新结果即静默结束） | 无 | 476 |
| **roster 投影** | live runner 任务 + 持久化 marker 合并成"异步任务"视图（mergeAsyncTasks 按 kind\0id 去重） | BackgroundAgentLifecycle 有 in-flight 计数，无持久化合并 | 476 |

### 2.3 bot 系统提示词层

| grok 机制 | 内容 | duya 现状 | 子 plan |
|---|---|---|---|
| section 化组装 | base 静态巨 prompt + `SystemPromptAssemblyDependencies`（`() => string \| null` 依赖清单）+ 固定顺序 `add()` 拼接 | `PromptSystem`（SectionDef static/dynamic + PromptCache + isSectionEnabled）**已声明式，结构更优** | 474 |
| bot 人格 section | name/description/avatar 路径 + `update_state` 自改 + 隐藏 user 消息身份信封 `<<SAND_AGENT_PROFILE_UPDATE:v1:base64>>` | 424 的 agents_md 注入是"静态指令"，无身份信封 | 474 |
| per-section 预算 | memory 字数预算（MEMORY_RECENT_PROMPT_CHAR_BUDGET=4000 等）、条数 cap（recall 30 / profile 50 / recent 15） | 无 per-section 预算概念 | 474 |
| 冻结快照（防漂移） | compactionEpoch 内 profile/memory 返回冻结渲染 | PromptCache 有 static/dynamic 之分但无 epoch 快照 | 474 |
| bot 专属动态段 | automations / channels / agent roster / multitask dispatcher / MCP 多账户 | 部分有（skills/memory/modes），roster/automations 段无 | 474 |

### 2.4 压缩

| grok 机制 | duya 现状 | 子 plan |
|---|---|---|
| 重建会话 / 9 段 prompt / 两遍 prefire / 健壮性网络 | plan 422 **已完成对齐** | 475 只做：① 收口 422（P3.4 segment 落盘 + G2 文档）② bot 压缩增量：wake-prompt 场景下 bot identity/roster/automation reminder 的重注入对齐（对应 grok `prompt-collector-glue.ts:147-161` 的 automation reminder 仅变化时重注入）③ per-bot compact 配置 |
| **压缩后处理链**（persist 之后的整套动作：归档/自文档刷新/纪元驱动重渲） | 只有重建顺序（422）与 automation reminder（475）两类被解析 | **§2.5** 建立术语锚点；修正散落 474/475/476/479（2026-09-02 审计） |

### 2.5 压缩纪元体系（跨 474/475/476/479 的术语锚点）⭐ 2026-09-02 审计新增

> **为什么必须单独成节**：grok 中「压缩之后还有很多事要处理」与「epoch 决定很多功能」是**同一件事的两面**——压缩发生时推进纪元，纪元推进触发一串「只在压缩后该做一次」的动作（重渲 user_info / 折叠 profile / 刷新 memory 冻结 / 重发 automation 提醒）。若把 epoch 当普通内容哈希，冻结/重渲语义全部丢失。本系列所有子 plan 引用以下定义，不得另造。

#### 2.5.1 四类 epoch（勿混为一谈）

| # | 名称 | grok 位置 | 类型/推进时机 | 生命周期 | 决定/门控什么 | duya 落点 |
|---|---|---|---|---|---|---|
| E1 | **summary epoch**（压缩纪元，agent 侧） | `state.summaryArchives.length`（每次压缩归档 +1；`user-message-action-handler.ts:215 currentSummarizationEpoch`） | number，**每次压缩 persist +1** | 随会话 state 落盘 | **user_info 整块重渲**：`shouldRerenderUserInfoAfterSummarization` = 旧纪元 !== undefined && 新纪元更大（`prompts/shared.ts:163-168`）→ 下回合整条 `<user_info>`（rules/MCP/git/self-document）重新生成 | **474**（冻结失效源之一）+ **475**（压缩后重渲任务） |
| E2 | **compactionEpoch**（压缩纪元，host 侧） | 注入 getter `compactionEpoch: () => number`（`host-runner-composition.ts`；reconstruction 中硬编码 0，真实源应接 E1） | number，压缩后推进 | 随 snapshot 落盘 | 三件事：① **profile 宣布→折叠**（`persistAnnouncedAgentProfile`，profile update 信封在**下一次压缩后**折进 system prompt 的 Agent profile section）；② **memory 冻结刷新**（`FrozenMemorySnapshot{render, compactionEpoch}`，纪元不变复用冻结渲染，纪元推进才重渲）；③ **automation 提醒重发**（`prompt-collector-glue.ts:147-161`，纪元推进强制重发） | **474**（冻结快照失效源）+ **475**（automation reminder 已部分覆盖）+ **479**（memory 冻结） |
| E3 | **turn_epoch**（回合活性，host 内存） | `SendPipeline.turnEpochs: Map<sessionId, number>`；每次 `dispatchUserTurn` +1（`send-turn-dispatch.ts:110`） | number，每发一新用户回合 +1；**重启清零** | 进程内存，不落盘 | 判定回合被 supersede：epoch ≠ current → 该 turn 是旧回合 → 禁止 prepend-recovery / nudge（`ensureUserReply`）/ 错误上报 / deliveryOwed / group isCurrent（`turn-runtime.ts:332-573`、`run-lifecycle.ts:350-358`） | **476**（WakeItem 必须带 epoch + supersede 判定） |
| E4 | **userMessageEpoch**（审批活性） | `sand-auto-review.ts:97-160`：每条 pending approval 签发时记 epoch；新用户消息 = epoch+1 = 旧审批作废（`beginUserMessageEpoch` + expire） | number，每新回合 +1 | controller 内存 | 审批时效：resolveApproval 时 epoch 不匹配即拒绝，防止旧回合请求在用户已转向后仍被执行 | 审批链 plan（419 后续/476） |

> 与压缩**无关**、不需要移植：replica epoch（UI 快照排序）、journal_epoch（agent-store 冲突日志游标）、WriteEpoch（box 读写竞态护栏）。另注意 `dashboard_pb` 里的 `epoch` 全是 Unix 时间戳，勿混淆。

#### 2.5.2 压缩 persist 之后处理链（E1/E2 的触发后果，全量清单）

| # | 处理 | grok 证据 | 状态 |
|---|---|---|---|
| A1 | 被压消息 blob 化 + SummaryArchive 归档（blobId 列表 + 摘要 + windowTail） | `summarization-orchestrator.ts:726-749` | duya rollout 全量保留 → 422 P3.4 判 won't-fix（记录即可） |
| A2 | 重注入 `fullReplacementMessages`（system/userInfo/新摘要/保留尾） | `:754-765` rootPrompt.clear+append | 422 已做重建顺序；**`refreshNamedAgentSelfDocumentInMessages`（named-agent 自文档刷新）无人认领 → 475 补** |
| A3 | durable blocks 七类随摘要写入（mode-prompt/project-root/plan/transcript/automation-trigger/todos/skills） | `agent-summarization/durable-blocks.ts:20-41` | 422 只做 system_reminder 一类 → 475 补其余 |
| A4 | tokenDetails 置 stale 剔出 checkpoint（防旧计数落盘） | `turn-settle.ts:197-229` | **缺失 → 475 补** |
| A5 | ask-question 回执保留（replay-horizon） | `:766-768` | **缺失 → 475 补**（duya 若无 ask-question 可 skip） |
| A6 | **user_info 整块重渲**（E1 推进驱动，feature flag 门控） | `user-message-action-handler.ts:227-296`；`execute-plan-action-handler.ts:152-227` | **缺失 → 475 补** |
| A7 | profile 宣布→压缩后折叠进 Agent profile section（E2 驱动） | `system-prompt-assembly.ts:129-146` | 474 只有信封无折叠步 → **474 补** |
| A8 | memory 冻结快照刷新（E2 驱动，FrozenMemorySnapshot 持久化） | `sand-memory.ts:24-38`；`system-prompt-assembly.ts:155-194` | 479 有冻结无 epoch 失效 → **479 补** |
| A9 | automation 状态提醒重发（E2 驱动，epoch 推进强制） | `prompt-collector-glue.ts:147-161,438` | ✅ 475 已覆盖 |

---

## 3. 子 plan 索引与依赖图

```
485 存储布局 ──► 474 bot 提示词层 ──┐
                                        ├──► 477 bot→bot DM ──► 478 群聊 Shared Rooms
476 唤醒总线 ────────────────────────────┘            │
                                                         └── 475 压缩增量（依赖 474 的 bot 段 + 476 的 wake prompt）
484 可靠性兜底 ─────────────────────────────────────► 依赖 476 投递通道（与 476 P3 rearm 边界正交）
488 Channel 接入 ────────────────────────────────────► 依赖 485 channels/ + 476 connector.inbound + 474 botChannels + 481 工具
483 多 Bot UI ──────────────────────────────────────► 依赖 476/477/485 + 488（channel 配置 UI）
前置收口：422 P3.4/G2（独立，可先行）
```

| 子 plan | 主题 | Priority | 依赖 |
|---|---|---|---|
| [474-bot-system-prompt-sections](./474-bot-system-prompt-sections.md) | bot 系统提示词层（人格 section + 身份信封 + 预算 + **双键冻结快照**：内容哈希 + summaryEpoch） | P0 | 485（profile.json 身份源） |
| [475-bot-compaction-increment](./475-bot-compaction-increment.md) | 压缩增量：422 收口 + bot 场景重注入 + per-bot compact 配置 + **压缩后处理链（A2–A6）** | P1 | 474、476 |
| [476-agent-wake-bus](./476-agent-wake-bus.md) | 唤醒总线：三车道 + wake 来源注册表 + pending 持久化/rearm + 抢占/redrive + **turn_epoch 回合活性（§2.6）** + quiet-work | P0 | 无（系列地基） |
| [477-agent-dm-messaging](./477-agent-dm-messaging.md) | bot→bot DM：envelope + SendToAgent 工具 + 防回环 + per-bot 常驻绑定 | P0 | 476、485（state/session-binding 落点） |
| [478-shared-rooms-group-chat](./478-shared-rooms-group-chat.md) | 群聊：group 模型 + 轮次编排 + @mention + 群 transcript | P1 | 477 |
| [479-bot-memory-isolation-tiers](./479-bot-memory-isolation-tiers.md) | 记忆隔离层：Grok 式三层（Own/User/Project）+ 单写者 shard + via 溯源 + 三层注入（独立 section/预算/优先级 own>project>user）+ **双键冻结快照** | P0 | 474、485（memory/ 落点） |
| [480-appended-tool-schema-catalog](./480-appended-tool-schema-catalog.md) | 追加式 Tool Schema 目录：tools 数组恒定 + 稳定排序 catalog 侧信道 + 恒定 meta 工具（tool_schema/tool_invoke）+ 收编 241 注入路径 | P1 | 418（能力声明）、474（section 通道） |
| [481-bot-toolset-unified-foundation](./481-bot-toolset-unified-foundation.md) | 系列新增工具统一建档：update_state（**含 profile.set/avatar.set**）/ SendToAgent / PostToRoom / tool_schema / tool_invoke / background_tasks 一次性建立 + 测试基建 + 权限矩阵 | P0 | 各归属 plan、485（executor 底层） |
| [483-multi-bot-chat-ui](./483-multi-bot-chat-ui.md) | 多 Bot 聊天 UI：侧栏 Bots 分组（与 Projects 平级）+ 类 Telegram 联系人聊天 + Bot 资料卡 + Bots/群组设置（前端收口层） | P1 | 476、477、485（roster/avatar 数据源）、488（channel 配置 UI） |
| [484-bot-reliability-ack-and-resume](./484-bot-reliability-ack-and-resume.md) | **可靠性兜底**：ack 义务投递确认（C4）+ run 级中断续跑/升级恢复（C6） | P0 | 476、485（state/ 落点） |
| [485-bot-storage-layout](./485-bot-storage-layout.md) | **存储布局**：config.toml 声明层 + agents/<id>/ 身份目录（profile.json 含 title/settings/avatar）+ agentId 约束 + ~/.duya 规划 | P0 | 424（[agents.<id>] 读侧） |
| [486-message-threads](./486-message-threads.md) | **消息 thread/fork 分支层**：同一 timeline 内分支（replyToId+branched）→ 主投影过滤 + thread 聚合读 + quote 注入 + 压缩不占主窗口 + UI "Start a thread"（483 承接） | P1 | 315（parentId 基座）、483（UI） |
| [487-host-persistent-tool-permission](./487-host-persistent-tool-permission.md) | Host 持久化工具权限 | P1 | 481 |
| [488-bot-channel-integration](./488-bot-channel-integration.md) | **Bot Channel 接入**：外部消息平台绑定（Discord/Slack）+ `[inbound]` 唤醒 + 出站发送 + reaction + secret-request | P1 | 485（agents/<id>/channels/ + connector-secrets/）、476（connector.inbound wake source）、474（botChannels section）、481（SendMessage channel 字段 + update_state channel.disconnect） |

> **旁支（同参考源，非本系列子 plan）**：[482-external-agent-invocation](./482-external-agent-invocation.md) —— 移植 grok-bot 的另一半能力：调用**外部 agent**（Claude Code / Codex）。本系列管「duya 自己的 bot 如何互相唤醒与编排」，482 管「duya 如何把活派给本机已安装的外部 agent」；两者共用 476 的 WakeQueue 与 481 的工具建档入口。

---

## 4. 全局设计约束（所有子 plan 必须遵守）

1. **不动 `PromptSystem` 核心与 plan 224 三层正交**（Profile/Mode/Permission）。474 只加 section 模块与 bot 配置映射。
2. **不引入新 IPC 协议**。wake 投递与 DM 传输复用 `agent_mailbox` + MailboxClaimer checkpoint + renderer 唤醒广播；群聊编排跑在 agent-server HTTP 链路（对齐 cron `runCronInSession` 的模式）。
3. **保持 session 单 run 串行**（queue FIFO + session_runtime_locks 不变）。grok 的"并发感"由 lane 抢占 + wake 排队实现，不是并行 run。
4. **每根支柱先落纯函数 + 单测**（对齐 413a 的做法）：lane 排序、wake 合并去重、envelope 编解码、轮次编排均为可独立测试的纯模块。
5. grok 术语到 duya 术语的映射在 476 定稿（WakeSource / WakeLane / PendingWake / QuietOrigin），后续子 plan 沿用，不再各自发明。
6. **epoch 术语统一以 §2.5.1 为准**（E1 summary epoch / E2 compactionEpoch / E3 turn_epoch / E4 userMessageEpoch）。任何子 plan 不得把 epoch 当"内容哈希"使用；内容版本哈希是另一个正交键（474 的 botEpoch），两者必须并存标注。
7. 安排 474/476 为第一里程碑；477 跟进；478 最后（工作量最大、依赖最多）。

---

## 5. 验收标准（总纲级）

- [ ] 五层通讯中 ①②③ 全链路可演示：用户发消息唤醒 bot；bot A SendToAgent 唤醒 bot B 并得到异步回复；3-bot 群聊完成一轮受控轮转讨论。
- [ ] 所有唤醒来源（任务 completion / cron / connector inbound / broadcast / DM / event）走同一 WakeQueue，lane 优先级可观测（日志/trace）。
- [ ] 宿主重启后 pending wake 不丢（rearm 语义），UI 的异步任务视图合并 live + 持久化 marker。
- [ ] bot 人格在提示词层可见（identity section），会话中改名产生身份信封而非重写 system prompt。
- [ ] **压缩纪元语义验收**：① 压缩 persist 后 summaryEpoch（E1）+1，下回合 user_info 被重渲一次且仅一次（无压缩则零重渲）；② profile 更新信封在**下一次压缩后**折叠进 botIdentity 基线（A7）；③ 旧回合被新消息 supersede 后不产生 nudge/错误上报/deliveryOwed（E3，476 P2.5 验收）；④ 审批在用户已转向后被拒（E4，419/476）。
- [ ] 每个子 plan 的单测 + `npm run typecheck:all` 全绿；ARCHITECTURE.md 增补"Bot Layer"章节与压缩纪元体系。

## 6. 风险

- **范围失控**：五层通讯一次做完不现实 → 总纲已裁剪（④顺带、⑤收编现有 gateway、③ 最后）。
- **mailbox 泛化过载**：agent_mailbox 最初为 in-run instruction 设计，当 wake 总线复用它时 claim 语义需扩 kind，风险记录在 476。
- **群聊成本**：轮次编排一晚可能烧大量 token → 478 必须带预算上限（MAX_ROUNDS/MAX_TURNS 即上限机制，另加 per-group token budget）。

---

## 7. 可行性审计（2026-09-02）与跨 plan 前置

系列 9 份 plan 已逐行对照代码审计，各子 plan 末尾新增「§6 可行性审计修正」，其中**两处原假设被推翻**，且影响面跨多个子 plan，故提升为全局前置：

| # | 原假设 | 审计结论 | 影响 |
|---|---|---|---|
| **X1** | WakeQueue 可建在 agent-core，复用子进程 `queue/index.ts` 的 lane 优先级 | agent 子进程**无发起 run 的通道**（对 main 只有 chat/db/journal 事件）；所有 run 都收敛到 HTTP `/sessions/:id/chat` | 476/477/478 的派发全部改到 **electron main**，复用 cron 的 `runPromptInSession` 投递模式 |
| **X2** | system prompt 尾部追加高频变化段只影响自身 | Anthropic 缓存前缀式：尾部变化 → system 断点 + 全部 messages 断点（≤4）连带 miss | 474/480 的尾部段必须先完成 **system 改多 block 数组**（480 P0.0） |

**两个必须先行解决的基础设施缺口**（无现成可用，非设计选择）：

1. **main 侧 session 忙闲判定**：现"空闲唤醒"判定在 renderer（`src/lib/stream-session-manager.ts:1078-1100`），无窗口/CLI 模式断链；`session_runtime_locks` 表**无任何生产 acquire 调用**，真实互斥是 agent-server 的 STREAMING 409（main 无法直读其内存）。476/478 共用此项，须先定方案（HTTP 状态查询 或 接线锁）。
2. **memory 存储源已变更**：`memory_entries` 表已被 migration 0009 删除，现源真理是文件 manifest + `curation_publications`（memory-state.db）。479 的"加列"方案作废，改为 0010 migration / manifest 扩展决策。

**审计结论汇总**：未发现任何"不可行"项——九份 plan 的目标机制均可在现有架构上落地；修正集中在**实现位置**（main vs 子进程）、**缓存语义**（前缀失效）与**已删除/未接线的既有表**三类。系列仍按原顺序推进（474+476 并行 → 477 → 475/479/480 → 478），其中 476 需先完成 X1/X2 相关前置决策。

---

## 8. 二轮审计修正（2026-09-02 晚 · epoch/压缩后处理专项）

> 首轮审计（§7）核实的是"机制能否落地"；本轮专项核实的是"grok 的**压缩纪元体系**是否被解析进计划"，源自用户质询："grok 里压缩后有很多事处理、epoch 决定很多功能，有没有吃透"。逐行对照 grok-bot-0.18-reconstructed（1722 TS 文件）后确认存在**语义误读 + 覆盖缺口**，已就地修正：

| # | 原缺陷 | 修正 | 落点 |
|---|---|---|---|
| Y1 | 474/479 把 epoch 当**内容哈希**（botEpoch） | 拆为**双键**：内容哈希（botEpoch）+ 压缩计数纪元（summaryEpoch，对齐 grok E1/E2）；压缩 persist 必须触发无条件重渲 | 474 §2.3/P1.2/§6.1、479 §3.2/P2.2、总纲 §2.5.1 |
| Y2 | 压缩后处理链 9 项只解析 1 项（automation reminder） | 新增 A2–A6 全量清单与归属：A6 user_info 整块重渲（最大缺口）、A2 自文档刷新、A3 durable blocks 补齐、A4 tokenDetails stale、A5 回执 skip | 475 §2.5 + Phase 4 |
| Y3 | profile 信封无"压缩后折叠"步 | 补折叠语义：下一次压缩（summaryEpoch 推进）把未折叠 update 折进 botIdentity 基线 | 474 §2.2/P3.1 |
| Y4 | 476 无回合活性纪元（WakeItem 无 epoch 字段） | 新增 §2.6 turn_epoch：user/priority 派发 +1、supersede 抑制 nudge/error/recovery；与压缩纪元正交声明 | 476 §2.6 + P1.3/P2.5 + §6.4 |
| Y5 | 审批无时效防护 | E4 userMessageEpoch 登记为 419/476 后续工作项 | 总纲 §2.5.1 E4 |

**推进顺序不变**，但 475 增加 Phase 4（压缩后处理链，依赖 474 的 summaryEpoch 接线），476 Phase 1/2 各加 turn_epoch 项。所有新概念定义以 §2.5 为准。

---

## 9. 完整性审计：bot 宿主系统全量对照（2026-09-02 晚）

> 对 grok-bot host 侧**13 个功能簇**（transcript 54 文件 + runner/agents/groups/automations 支撑）逐文件盘点后，与本系列 473–483 对照。结论：**5 簇主体对齐、5 簇局部缺口、3 簇完全空白 + 1 方向性决策缺失**。空白集中在可靠性底线与宿主收尾，处置如下：

| 簇 | grok 模块 | 判定 | 处置 |
|---|---|---|---|
| C4 ack 义务 | `ack-obligations.ts` + `sand-ack-obligation-store.ts`（用户消息必须被可见确认；5s idle redrive ≤3 次 + ackRunTokens 归属） | **空白** | **新立 [484](./484-bot-reliability-ack-and-resume.md)**（Phase 1） |
| C6 断点交接/升级恢复 | `upgrade-recreate-resume.ts` + `sand-upgrade-resume-store.ts`（quiesce→marker→重启 hidden 续跑，automation 带 runId） | **空白**（476 P3 rearm ≠ run 续跑） | **484**（Phase 2） |
| C11 widget 卡闭环 + @展开 | `widget-responses.ts`（提问补问/secret 提交/权限卡过期/reactToMessage）+ `workflow-commands.ts`（@agent/@workflow 展开） | **空白**（481 只建档工具无卡宿主侧） | **并入 483**（新增 Phase 2.5 前置；@mention 展开为 478 依赖） |
| C12 client-side-tool-v2 | IDE 原生工具执行流投影（call/result/epoch/sequence/replay） | 无 IDE 宿主 → 大概率不需要 | **方向性结论见下**（不移植，480 不覆盖它） |
| C2 发送管线 | 多消息类型模型、reply-to/fork、clientNonce+digest 幂等、acceptance ledger、图物化 | 部分 | 并入 477 §2.5（消息类型表 + 幂等）与 483 卡族依赖 |
| C3 回合细节 | reply-nudge（≤3）、activity 状态机、windowed 激活、错误卡 | 部分 | 476 §2.6 已含 supersede 抑制；nudge 正面移植留决策点（484 的 ack redrive 覆盖同类需求，倾向不重复） |
| C9 roster 订阅 | 增量 emit/ordered 序号/outline/改名刷新/搜索 | 部分 | 并入 483（roster 增量订阅协议，复用 SSE） |
| C10 生命周期 | clone/delete-successor/kickstart/notifyOnUpdates/hiddenFromSidebar | 部分 | 并入 483（bot 删除/失活会话切换） |
| C13 turn-settle | checkpoint↔transcript 事务边界、runTurnMemory、silent-tool-call | 部分 | 475 Phase 4 追加"事务边界核对"（与 441 journal 关系记录决策） |

**C12 方向性结论**：client-side-tool-v2（grok 的 `client-side-tool-v2-*.ts` + relay，Cursor 类 IDE 的"宿主接管工具执行"通道）与 480 的目录侧信道（让模型读 schema 再调用）**不是同一件事**，480 不构成对它的覆盖。duya 是独立 Agent 无 IDE 宿主，**本轮不移植**；若未来嵌入 IDE 场景再单独立项。此结论记录于此，防止后人误读 480 范围。

**执行登记**：484 已入 §3 依赖图与索引表；483/477/475 的并入见各自 plan 更新（2026-09-02）。

---

## 10. 第三轮审计：存储地基（bot 配置模型 + ~/.duya 规划）2026-09-02 晚

> 用户质询："bot 除了 name 还有 title；bot 配置建在哪、是 JSON 吗、路径怎么定；~/.duya 怎么规划；bot 配置包含什么"。逐文件核实 grok（agent-paths/agent-profile/settings-file/agent-avatar/host-paths）与 duya（config schema/agents.ts/424）后确认：**存储布局是 473–484 集体空白的地基项**——每份 plan 都引用"bot 存储锚点"却无人定义。

| 维度 | grok（已核实） | duya 现状 | 决策 |
|---|---|---|---|
| 身份文件 | agents/&lt;uuid&gt;/profile.json（name/**title**/description/avatarShape/avatarColor 5 字段）单一身份源 | config.toml `[agents.<id>]` 7 字段（无 title/avatar） | **485**：config.toml 声明层 + `agents/<id>/profile.json` 身份层双层模型 |
| 目录名/id | 目录名=uuid，改名不更目录 | map key slug，无约束 | **485**：保留人类可读 slug + isSafeBotId 约束，目录名=id |
| title | name=身份，title=展示副标题（UI/roster 用，模型不改） | 无 | **485**：profile.json 增 title，模型 update_state 只改 name/description |
| avatar | avatar.png/avatar.&lt;ext&gt; 独立文件（MIME 嗅探 ≤5MB） | 无 | **485**：avatar 文件落 agent 目录 |
| 观察者 | fs.watch profile/settings/avatar → roster 广播 | ConfigStore hot-reload | **485 Phase 3**：选型（fs.watch 或 ConfigStore watch） |
| ~/.duya 布局 | 每 agent 自持 + agents 同级全局共享（user-memory/projects/…） | 20+ 顶层项无归类 | **485 Phase 4**：新增 agents/ + 归类文档 |

**执行登记**：新立 [485](./485-bot-storage-layout.md)（P0），已入 §3 依赖图与索引表，作为 474/477/479/483/484 的存储前置（485 Phase 1-2 先行）。

---

## 11. 第四轮审计：消息 thread/fork 分支层（2026-09-02 晚）

> 用户发现 grok 可在 bot 超长 session 内对单条消息开独立 thread（三点菜单 "Start a thread"），判断可融入 duya session 管理。全链路核实（UI `message-actions.tsx:277` → fork 提交 `conversation-workspace-controller.ts:184` = `{replyToId: rootId, isFork: true}` → host 落盘 `send-pipeline.ts:267,301` 带 `replyTo`+`branched:true` → 主时间线 SQL 过滤 branched `agent-db-schema.ts:2-28` → `threadDescendants` 沿 replyTo 链聚合 `transcript-threads.ts` → quote 注入 `system-prompt.ts:48` `[In reply to <id>: "..."]`）后确认：

**核心结论**：grok 的 thread **不是新会话，是同一 transcript 的分支层**——bot 超长 session 不分裂；branched 不进主投影 → 不进主模型上下文（压缩免疫）；thread 视图 = root + threadDescendants 的独立读。**duya 的 315 `parentId` 字段已定义但全为 null 未消费——是低成本的直接移植**，且天然契合 duya session 串行架构。

**执行登记**：新立 [486](./486-message-threads.md)（P1），已入 §3 依赖图与索引表。依赖关系：315（基座）→ 486（模型/投影/压缩）→ 483（UI）；477 envelope replyTo 与 486 字段同源，实施互引；478 群 transcript 暂不接 branched。
