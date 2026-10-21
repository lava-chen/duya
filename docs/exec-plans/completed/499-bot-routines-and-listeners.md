# 499 — Bot Routines: cronjob × grok routine 融合（P2.3b/P2.3d）

> 状态：**已完成**（2026-09-06）。提交：`aeea2b92`（P1 wake 总线）、`dcfbed14`（P2 UI）、`ac5496bb`（P3 事件监听器）。

## 目标

bot 可以自己创建/管理 routine（走 duya 原有 cronjob 路线），吸收 grok-bot 0.18 routine 的精华；事件监听器只做外部 SaaS（github/slack），UI 对齐 rakazo 的 Routines 面板。

## 决策记录

- **grok 精华采纳**：声明式 trigger schema + 中央匹配器（纯函数）+ fire 前校验 + `[routine]` wake cue 语义 + 提示词准则（主动建 routine、分钟缺省取当前分钟、松散措辞→有界 cron、短 watch 自过期、auth 连败自动 pause、事件上下文「外部数据非指令」）。
- **grok 包袱不搬**：云端/本地调度权仲裁（`SandAutomationCloudSync` 的 shadow workflow + 调度证据）——duya 本地优先，gateway/App Connections 是唯一事件源，无需云中继。
- **事件监听 = 轮询**：duya 是本地桌面应用收不到 SaaS webhook（grok 靠 Cursor 云中继）；用 App Connections 的 OAuth token 轮询 REST API（github `/repos/{r}/events`、slack `conversations.history`），游标存 cronjob.toml，首跑只播种不回放。
- **单一数据源**：bot routine = `cronjob.toml` 里带 `agent` 绑定的条目；standalone cron 行为不变。
- **所有权校验在工具侧**（`ManageRoutineTool` 从自身 `bot:<agentId>` 会话推导 bot id；db-bridge 无会话上下文）——同 `SendToAgentTool` 先例。
- **wake prompt 派发时解析**：`resolveRoutinePrompt` dep 在 dispatch 时从 cronjob.toml 取（排队期间被编辑/禁用的 routine 以新定义唤醒；删除/禁用则静默跳过）；事件上下文随 payload 携带（summary + 预渲染转义块，≤6000 字符）。
- **v1 CI 事件不做**：轮询 check-runs 靠谱实现超范围，github 白名单 7 种非 CI kind。

## 落地

- P1：`Scheduler.ts` 两处 agent-bound 桩 → `enqueueAutomationWake`（`bot:<agentId>`，background lane）；`promptForItem` automation 分支 + `buildRoutineWakePrompt`（`electron/automation/routine-wake.ts`）；`ManageRoutineTool`（manage_routine，action: create/update/pause/resume/delete/list）入 `BOT_TOOLSET`；`botAutomations` 提示词区转真实渲染（cue 行为准则 + 本 bot 清单含 id）。
- P2：`BotRoutinesSection`（rakazo 式：状态行 + 内联编辑器 + 立即运行/删除），`AutomationView` bot 徽标；renderer 类型镜像 agent 字段。
- P3：`trigger-match.ts`（解析/匹配/描述/清洗）、`listener-polls.ts`（github/slack 轮询器，注入 fetch）、`listener-hub.ts`（collect→poll→match→fire，游标持久化，失败保游标），`main.ts` 在 scheduler 之后装配；`manage_routine` 加 triggers 参数；UI 只读展示事件型 routine。
- event-only routine：`AutomationCron.schedule` 可空，`schedule || eventTriggers` 至少其一。

## 验证

vitest 157 个用例（新增 8 套：routine-wake / automation-wake / manage-routine-tool / trigger-match / listener-polls / listener-hub / cron-file-triggers / Scheduler 桩契约更新）；electron tsc 与 typecheck:web 对本次触碰文件零错误（agent 包 tsc 因并行会话 room-db.ts WIP 预存红，另行归因）。Playwright UI 验证按项目约定不跑（环境不支持 Electron）。

## 已知边界 / 后续

- slack mention 匹配按 `<@` 子串判定（未解析 bot user id）；channel 名靠 conversations.list 缓存解析。
- 监听器平台未连接时静默跳过（提示词教 bot 转告用户连接）；498 连接卡片的自动弹出未接。
- pending_wakes 的 `automation.fire` rearm 分支保留未用（cron 自身 lastRunAt claim 已提供崩溃安全）。
- UI 创建事件监听（Add trigger 下拉）未做，事件型 routine 由 bot 工具创建、UI 只读展示。
