# Plan 552: Goal Mode v2 — 跨会话续跑 + 时间线 UI + minimax 对比缺陷补全

> **Status**: ✅ Implemented (2026-09-19)；Electron 真机冒烟待办（Playwright 不可用，验证=typecheck + 475 vitest 绿）
> **Priority**: P1
> **Origin**: 对 `E:\cloned-projects\minimax-code` Thread Goal 与 duya goal mode (plan 411) 的深度对比审查。
> 用户要求:补全所有已识别缺陷;新增 minimax TUI 风格的时间线 UI(active 状态 / 第几轮 / 中途 pause 操作);长期跨 session。

## 已识别缺陷(对比结论 → 本 plan 逐项落地)

| # | 缺陷 | 修复方式 |
|---|------|----------|
| D1 | 消息边界后 goal 停摆;重启折叠 `user_paused` 需手动 resume | PreFinalize `goal-continuation` veto hook(turn 内自动续跑,有界)+ `auto_resume` 配置(重启后恢复 active)+ persisted-snapshot self-add 到 activeTrackerIds(下一条消息即续跑)|
| D2 | 4 个 paused 状态使 transition 表膨胀;UI 无法显示精确暂停原因 | 封闭 `GOAL_PAUSE_REASONS` 目录 + `pauseReason` 字段贯穿 snapshot/事件/UI(保留 10 状态,完整正交化列为后续) |
| D3 | blocking ack 验证面板可无限挂起工具循环 | `verifyTimeoutSeconds` 面板超时 → `blocked(verifier_timeout)`;验证期间发 `executionWait: 'verification'` 事件(UI 显示 Verifying)|
| D4 | 无 BYOK/成本维度 | `verification = "panel" \| "none" \| "auto"` 配置;`none` 信任 worker 提案直接结算;`auto` 对 ollama 本地模型跳过面板 |
| D5 | 模型无法主动查询 goal 状态 | `get_goal` 工具(codex 同名;未绑会话返回 goal:null)|
| D6 | stall 检测依赖 verifier 跑过 | 回复指纹 breaker(归一化指纹 streak:≥2 nudge veto,≥3 自动 `no_progress_paused`),零验证依赖 |
| D7 | goal tracker 进程单例跨会话污染风险 | `boundSession` 绑定 + 所有工具/hook/coordinator 调用点会话守卫(misbound → 视为 idle/NO_GOAL)|
| D8 | `/goal status/pause/resume/clear` 靠模型自觉解释 | streamChat 入口确定性拦截 + CLI slash 注册(不耗 LLM 调用)|
| D9 | UI 无 turn 计数/无实时 elapsed/无 pause 操作 | 时间线式 GoalStatusPanel(状态+原因+Turn N+Verify M+tokens+实时计时+history 时间线+Pause/Resume/Clear)|

## 设计决策

- **保留 10 状态机**,不做 paused/reason 完全正交化——transition 表的重写风险大于收益;`pauseReason` 承载全部审计语义。resume-from-budget 需抬预算的语义差异保留。
- **自动续跑默认开**(`auto_continue = true`,默认上限 `max_auto_continues = 200` 次/run,防失控;engine 不变量 max-turns/dead-loop 硬停仍然优先于 hook)。
- **重启安全模型调整**:grok 折叠 `active/verifying → user_paused` 保留为 `auto_resume = false` 时的行为;默认 `auto_resume = true` 时 coordinator.restore 将 `pauseReason === 'restart'` 的折叠态自动 resume 回 active(下一条消息即续跑)。
- **验证超时 fail-closed**:面板超时 → `blocked`(等待用户),与"验证器不可用"一致;不计入 side effects(stall/strategist 跳过)。
- **确定性命令拦截**在 streamChat 入口(turnContext 组装后、ConfigHooksRunner 前),合成 `{type:'text'}+{type:'done'}` 结束 turn;mailbox 中途注入的 `/goal` 消息仍走 LLM 路径(fallback)。

## Phases

### Phase A — tracker 基建 (`goal-tracker.ts`)
- [x] `GOAL_PAUSE_REASONS` 封闭目录 + `pauseReason` 字段(snapshot/restore/accessor;pause/stall/infra/budget 事件携带 reason;resume/start/clear 清除)
- [x] `boundSession` 会话绑定(start 记录;`stateOf(sessionId)` 等会话感知访问器;misbound 一律视为 idle)
- [x] 回复指纹字段(`replyFingerprint`/`noProgressStreak` 入 snapshot)+ `recordReply(text): 'none'|'nudge'|'pause'` + `resetBreakers()`

### Phase B — 配置 (`goal-config.ts`)
- [x] `autoResume`(默认 true)、`autoContinue`(默认 true)、`maxAutoContinues`(默认 200)、`verification`('panel'|'none'|'auto',默认 'panel')、`verifyTimeoutSeconds`(默认 300)+ env/toml 覆盖

### Phase C — evaluator (`goal-evaluator.ts`, `goal-tools.ts`)
- [x] 面板超时(Promise.race 内置于 verifyGoalCompletion,超时跳过全部 tracker side effects → blocked + verifier_timeout)
- [x] verification mode:`none` 直接结算 worker 提案;`auto` 对 `provider==='ollama'` 跳过面板
- [x] 验证前发 `executionWait:'verification'` 事件;`get_goal` 工具;goal_start/update_goal 会话守卫

### Phase D — hooks (`hooks/builtin.ts`)
- [x] `replyFingerprintHook`(PreFinalize priority 11):nudge veto / pause+stall(reason no_progress)+ goal_updated 发射
- [x] `goalContinuationHook`(PreFinalize priority 12):goal active 且 autoContinue → block_finalize 注入短续跑指令;`maxAutoContinues` 计数封顶
- [x] `goalTrackerActive` → 会话感知 `goalTrackerActiveFor(sessionId)`

### Phase E — coordinator + DuyaAgent 接线
- [x] coordinator goal 分支传 sessionId(recordWorkerRound/updateTokenUsage/shouldInjectReminder/renderGoalContinuation)
- [x] `coordinator.restore()`:autoResume 时将 `pauseReason==='restart'` 的折叠态自动 resume + persist
- [x] DuyaAgent:goal persisted-snapshot self-add 进 activeTrackerIds(DB peek,非 idle 即纳入)+ streamChat 入口 `/goal` 确定性拦截(`goal-commands.ts` 共享实现)

### Phase F — 协议 (`worker-protocol.ts`, `src/types/stream.ts`)
- [x] buildGoalUpdatedEvent 扩展:totalWorkerRounds/totalVerifyRounds/elapsedMs/createdAt/pauseReason/executionWait/planFile(可选字段,向后兼容)

### Phase G — CLI slash 注册 (`cli/slash-commands.ts`)
- [x] `/goal <objective>|status|pause|resume|clear` 注册,复用 `goal-commands.ts`

### Phase H — 前端时间线 UI
- [x] `GoalStatusChip`:Turn N + tokens;verifying/executionWait 标签;snapshot 种子带新字段
- [x] `GoalStatusPanel` 时间线重构:实时 elapsed 计时(active 时 1s tick)、状态+pauseReason 人话标签、Turn N · Verify M · tokens 元信息行、history 竖向时间线(圆点+连接线+相对时间)、Pause(active)/Resume/Clear 操作
- [x] `composer-panels.css` 时间线样式(竖线+圆点,data-theme 双主题)

### Phase I — 测试
- [x] tracker:pauseReason 传播、会话绑定守卫、recordReply 决策表、snapshot round-trip
- [x] tools:get_goal、会话守卫拒绝、verification none 直接结算、executionWait 事件
- [x] evaluator:超时 → blocked 且无 side effects;auto 模式 ollama 跳过
- [x] hooks:continuation veto(含封顶)、fingerprint nudge/pause、会话感知
- [x] frontend:Panel 状态→操作映射、时间线渲染

### Phase J — 收尾
- [x] `npm run typecheck:all` + 相关 vitest 全绿
- [x] ARCHITECTURE.md goal 小节更新;exec-plans README 注册

## 非目标(记录为后续 plan 候选)
- 队列驱动的跨 turn 流水线(无用户消息时自动开新 turn;需 message-queue + admission 闸,参照 minimax `thread-goal/admission*.ts`)
- paused 状态完全正交化(状态收敛为 6)
- no-tool streak(与 reply fingerprint 共享阈值的独立计数)
- 预算三维化(token/turn/active_time)+ 每工具调用实时闸
