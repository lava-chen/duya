# Codex TUI 表面与斜杠命令体系对照（duya ↔ openai/codex）

> **状态**：参考资料（reference）· **调研日期**：2026-11-04
> **对标源码**：`E:\cloned-projects\codex` @ `fbf5f0d3a716d08c254d3e4941d5b12eaff5afe7`（2026-11-03，"Decode live transcript updates in the cloud client (#59047)"）
> **本项目基线**：duya @ `203d7d5191bc463915591af3911649a7b313394a`（Merge PR #567 "codex/tui-codex-surface"）
> **用途**：为「TUI 学 codex 表面」后续切片提供差距依据。原始摘录与代理调研原文在 ignored 的 `docs-local/research/codex-tui-alignment/`。

本文只记录**已核实的实现事实**。所有 `file:line` 均来自实际读取源码的命中行；不存在的能力写「当前版本无」，不推测。

---

## 0. 基线与复核陷阱

| 项 | 值 |
| --- | --- |
| codex 本地 HEAD | `fbf5f0d3a7`（2026-11-03，与 `origin/main` 一致，`git pull --ff-only` 返回 Already up to date） |
| codex 窗口内移动 | 自 2026-10-14 基线 `2df6705423` 起 **3307 个 commit**，其中 **922 个触及 `codex-rs/tui`** |
| duya 基线 | `203d7d51`（PR #567 已合并：composer 纯色背景 + 已发命令背景带） |

**陷阱**：`docs/references/codex-thread-and-worktree-management.md`（2026-09-30）记录的 codex 基线是 `2df6705423`（2026-08-24）。该文件本身已声明"使用前核对版本"，本报告的 codex 侧结论**不适用于**那份旧参考。

### 与既有调研的关系

| 既有材料 | 与本报告关系 |
| --- | --- |
| `docs-local/research/codex-tui-cli-deep-dive-2026-10-14.md` | 2026-10-14 纵向深挖（渲染范式、流式提交、键位、三队列、backtrack）。本报告**不重复**，只做增量。 |
| `docs/references/tui-slash-command-survey.md`（**未提交**，仅存于主检出） | 2026-10-15 四方快照，基于 codex 旧版与 duya 旧结构。**已被本报告取代**。 |
| `docs/references/codex-thread-and-worktree-management.md` | thread/worktree 机制，与本报告正交。 |

---

## 1. 结论速览

1. **duya 的斜杠命令体系已经追平甚至超过 codex 的结构质量**：单一 catalog 源（`packages/command-catalog`，53 条 spec）→ 各 surface 投影，且**定义与执行分离、lookup 与 filter 分离**——这两点 codex 也在做，但 duya 的目录约定更干净（codex 仍是 enum + 手工 match）。
2. **duya 的 TUI 渲染架构已经与 codex 同构**：codex 用 ratatui，duya 用自研 cell-grid；两者都是"单几何真源 + 区域切分 + 行级 diff"。blessed 已从 duya 完全退役（`screen/factory.ts:22`），codex 那边则从未有过 blessed。
3. **真正的差距集中在三处**：① **终端原语**（OSC 11 背景探测、OSC 8 超链接、行内图像）——duya 明确拒绝实现，codex 三项齐全；② **交互深度**（transcript 搜索、回退重编辑、auto-review、Vim modal、键位目录）——duya 多数缺失；③ **可配置状态栏**（codex 30 项 statusline 目录 vs duya 固定两行 footer）。
4. **不要抄渲染范式**。codex 是 ratatui + 全屏 viewport，duya 是自研 cell-grid + inline/fullscreen 双轨。两者都成立，抄会推翻 duya 现有资产（`screen/own/`、`terminal/viewport.ts` 的 scrollback 提交模型）。

---

## 2. 斜杠命令体系对照

### 2.1 命令清单规模

| | codex | duya |
| --- | --- | --- |
| 定义位置 | `codex-rs/tui/src/slash_command.rs` 的 `SlashCommand` enum | `packages/command-catalog/src/index.ts` 的 `COMMAND_SPECS` |
| 变体条数 | **65** | **53** |
| 别名 | enum 变体名本身即别名载体：`Approve`→`/approve`、`ElevateSandbox`→`/setup-default-sandbox`、`Pwd`→`/pwd`(别名 `cwd`)、`Pets`→`/pets`(`pet`)、`Stop`→`/stop`(`clean`)、`MultiAgents`→`/subagents`、`MemoryDrop`→`/debug-m-drop`、`MemoryUpdate`→`/debug-m-update` | `aliases` 字段独立声明 |
| 可用性表达 | **类型上的数据谓词**：`supports_inline_args()` / `available_in_side_conversation()` / `requires_dispatch_validation()` / `available_when_thread_unavailable()` / `available_during_task()` / `is_visible()` | **catalog 字段**：`surfaces` / `requiresSession` / `availableWhileBusy` |

> duya 的 `requiresSession` + `availableWhileBusy` 与 codex 的 `available_when_thread_unavailable` + `available_during_task` 是**同构**的。codex 多出 `supports_inline_args`（是否吃内联参数）与 `requires_dispatch_validation`（分发期再校验，例：`Fork` / `Review`）。

**相对 2026-10-15 旧快照（codex 56 条）的变化**：新增 `/presets`、`/daybreak`、`/worktree`、`/config`、`/recap`、`/voice`、`/daemon`、`/warnings`、`/tui`；`/personality`、`/sandbox-add-read-dir` 不再作为独立命令存在（前者被 `/personality` 之外的状态行项吸收，后者并入 `ElevateSandbox`）。

### 2.2 定义与执行分离（两边都做到了）

| | codex | duya |
| --- | --- | --- |
| 定义 | `slash_command.rs`（enum + `description()`） | `packages/command-catalog/src/index.ts`（`COMMAND_SPECS`） |
| 执行 | `chatwidget/slash_dispatch.rs`（`slash_dispatch.rs:379-612` 逐 match 分发） | `packages/cli/src/tui/slash/*.ts`（33 个 handler 文件，汇总于 `registry.ts:65` 的 `TUI_SLASH_COMMANDS`） |
| 边界理由 | enum 只能带数据，行为在别处 | `registry.ts:8-20` 注释明说：executor 不能跨进程边界共享——Desktop 走 renderer bridge，CLI 走 Host HTTP |

duya 的 `registry.ts:10-20` 注释**逐字点名 codex** 作为参照（"mirrors codex: its `slash_command.rs` holds the definition … `slash_dispatch.rs` holds the behavior"），说明这是有意的对齐而非巧合。

### 2.3 lookup 与 filter 分离（关键规则）

**codex**：
- 弹窗过滤：`bottom_pane/slash_commands.rs:73-87` `builtins_for_input(flags)` 按 `BuiltinCommandFlags` 过滤。
- 精确触发：`slash_commands.rs:120-137` `find_builtin_command(name, flags)` 在查找时**强制** `token_activity_command_enabled: true`、`daybreak_command_description: Some("")`、`side_conversation_active: false`。
- 该文件顶部的注释说明了原因：*"Side-conversation and token-activity gating are intentionally enforced by dispatch rather than command lookup so a typed command can produce a specific unavailable message while the popup still hides it."*
- 兜底：手打但不在弹窗里的命令**仍会命中**，然后在分发期给出具体拒绝理由（`chat_composer.rs:3480` `reject_slash_command_if_unavailable` 检查 `is_task_running` + `available_during_task` + `requires_dispatch_validation`）。

**duya**：`registry.ts:101-104` `resolveTuiSlashCommand`（"Can the CLI RUN this token? Unfiltered by what the popup advertises."）与 `registry.ts:123` `advertisedSpecs`（走 `availableSpecsFor('cli', { hasSession: true })`）严格分开。`registry.ts:22-24` 注释把这条定为规则：*"not advertised" must never silently become "unknown command"*。

**结论**：这条规则两边完全一致，**duya 无需再改**。这是本次对照中最值得确认的"已对齐"结论。

### 2.4 未知命令兜底

| | codex | duya |
| --- | --- | --- |
| 文案 | `Unrecognized command '/{name}'. Type "/" for a list of supported commands.`（`chat_composer.rs:3121-3130`；`slash_dispatch.rs:1184` 同文） | 由 catalog 驱动；`describeSpec` 提供描述 |
| 草稿保留 | 是（测试 `slash_commands.rs:1553` 断言输入框仍为 `/does-not-exist`） | 未单独验证 |
| 参数错误 | `Unknown command setting '{name}'.`（`chatwidget/slash_command_args.rs:151`） | 未单独验证 |

### 2.5 动态命令来源

| 来源 | codex | duya |
| --- | --- | --- |
| 内置 | 65 enum 变体 | 53 catalog spec |
| Feature 门控 | `BuiltinCommandFlags`（`slash_dispatch.rs:1263-1267`：`plugins_command_enabled` 来自 `Feature::Plugins`、`token_activity_command_enabled` 来自 `has_codex_backend_auth`、`goal_command_enabled` 来自 `Feature::Goals`） | `surfaces` + `requiresSession` + `availableWhileBusy` |
| Skills | `/skills` → `open_skills_menu()`（`slash_dispatch.rs:530-532`） | `/skills` → Host `GET /v1/skills`（`packages/cli/src/tui/slash/skills.ts:16-20`）；**CLI 看不到 plugin skills**，并在面板里明说（`skills.ts:59-61` `PLUGIN_LIMITATION`） |
| Plugins | `/plugins` → `add_plugins_output()`（`slash_dispatch.rs:610-612`） | `/plugin` 有 handler |
| Apps/Connectors | `/apps` → `add_connectors_output()`（`slash_dispatch.rs:608-609`） | `/apps` 有 handler |
| Presets（可复用 prompt 与斜杠命令） | `/presets` → `open_quick_dial_menu()`（`slash_dispatch.rs:379-381`） | **无**（见 §4 差距 1） |
| 权限预设 | `builtin_approval_presets()`（`slash_dispatch.rs:436-438`） | 权限模式三档 `ask/auto/bypass`（`packages/cli/src/tui/permission-mode.ts:40`） |

### 2.6 遗留层状态

`packages/agent/src/cli/slash-commands.ts` **仍然存在**，且仍有 3 处 TODO 未实现：
- `:610` — `SlashCommandContext` 没有 send 原语，回合由调用方（`packages/agent/src/cli/index.ts` 的 `HeadlessRunHost`）持有。
- `:807` — 无法切换 session 模式（`WorkerSession` 暴露 mode registry 但无 setter）。
- `:1091` — 拿不到 provider 的 rate limit 头，只能报消耗量。

对比 2026-10-15 旧快照（"Agent CLI 27 条含 8 个 stub"，五层并存）：**已收敛为 catalog 单一来源**，CLI TUI 侧从 7 条涨到 53 条 spec（catalog）/ 实际可执行数由 `TUI_SLASH_COMMANDS` 决定，`registry.ts:65` 汇总 28 个分组模块。Desktop 侧旧快照的"注册表 14 条 / 执行器死代码"分叉需要单独复核——本轮未完成该项验证。

---

## 3. TUI 表面对照

### 3.1 渲染架构（已同构）

| | codex | duya |
| --- | --- | --- |
| 几何真源 | `bottom_pane/chat_composer/composer_layout.rs:52` `layout_with_options`（测量 `:206` / 绘制 / 光标 `:176` 共用同一套 Rect） | `packages/cli/src/tui/composer-layout.ts:79` `buildComposerLayout`（纯函数） |
| 帧装配 | ratatui `Frame` | `screen/own/frame.ts:367` `composeFrame` → `:392` `changedRows` |
| Diff 粒度 | ratatui 内部 | **行级**（`screen/own/frame.ts:392-398`，同行内局部变化整行重写） |
| 区域切分 | `transcript/composer/status/overlay` | `screen/own/geometry.ts:203` `screenRegions()`：transcript\|input\|status\|overlay\|completion |
| 滚动归属 | 全屏自管 viewport（`transcript_view.rs:91`） | **双轨**：全屏自管（`core/visible-window.ts:66` 绝对偏移 + follow 标志）；inline 交终端原生 scrollback（`terminal/surface.ts:15-31`、`terminal/viewport.ts:76` `liveWindow` 编码"已提交不可撤回"不变量） |
| 组件树 | — | `core/component.ts:54` `UIComponent` / `SceneCanvas` **存在但未被生产路径使用**（`TUIApp.ts:1423` `paint()` 仍是命令式五连调；`components/status-bar.ts:27` `StatusBar` 组件存在但 `TUIApp.ts:2293` 直接调 `buildFooterLines`） |

**判断**：duya 的 `core/component.ts` 保留树是**未接线的骨架**——`core/component.ts:20-26` 自陈"No diff. No async. No dirty propagation."。这是 duya 侧最大的架构债：渲染器（`screen/own/`）已经能，但组件层没接上，所以没有命中测试、没有脏传播、没有增量更新。

### 3.2 Composer

| 能力 | codex | duya |
| --- | --- | --- |
| 边框 | **无**，用背景色块（`chat_composer.rs:4935-4937` `Block::default().style(...)`，无 `Borders`） | **无**，用背景色块（`TUIApp.ts:1875` `composerBg`）；但额外有上下两条横线（`composer-layout.ts:196` `makeBorder`） |
| 提示符 | 左侧 `›`（bash 模式红 `!`、effort 分级着色、禁用 dim）`chat_composer.rs:4963-4989` | `› ` muted marker（`transcript-view.ts:212`） |
| effort 指示 | prompt 随 tier 变化（`chat_composer.rs:4971-4977`） | **边框/横线颜色即 effort 档位**（7 档色阶，`TUIApp.ts:1872` `effortBorderColor`，`theme.ts:184-208`） |
| 大粘贴 | `[Pasted Content N chars]` + `#2/#3`（`chat_composer.rs:471`/`:1991`/`:2630`） | `[Pasted Content #N · NNNN chars]`（`editor.ts:29` 阈值 1000、`:38` `pastePlaceholder`、`:369` `submit()` 展开），**Map 多例并存**、编辑失效、kill 展开 |
| 粘贴 burst | `bottom_pane/paste_burst.rs:173`（Windows 60ms / POSIX 8ms 延迟显示、IME retro-capture） | `paste-burst.ts:47-48`（同样 60/8ms） |
| 补全 | `mentions_v2/` + `file_search_popup.rs` + `skill_popup.rs` | `completion.ts:75-79`（files / context）+ `completion.ts:295` `slashOptionsState`（三个候选池互不串味） |
| Vim modal | **完整**（`keymap.rs:229-340` normal/operator/text-object + `textarea/vim_commands.rs:24` + `vim_register.rs:37` 寄存器） | **无**（`editor.ts` 只有词移动，无 line up/down） |
| 撤销/重做 | 撤销 + 重做（`keymap.rs:307-308`） | 撤销成熟（`editor.ts:286`），**无重做**（`undo-stack.ts` 无 redo 栈） |
| Ctrl+R | 跨会话反向搜索（`chat_composer_history.rs:12-17`、`:182`） | 模糊过滤历史（`TUIApp.ts:3172` `openHistoryWindow`） |
| 高度策略 | 布局优先级：先保输入+hint，再分配 status（`composer_layout.rs:57-113`），输入框至少 3 行 | 至多占终端 ~1/2（`composer-layout.ts:96-107` `bodyBudget`），预留 2 行状态 + 2 行边框（`:8`、`:11`） |

### 3.3 Footer / 状态栏

| | codex | duya |
| --- | --- | --- |
| 结构 | 1 行 hint（`footer.rs:237-249`，6 种 `FooterMode`）+ **独立持久 status 行**（`chat_composer/status_surface.rs:1`） | inline 2 行（`footer.ts:222` `buildFooterLines`）/ 全屏 1 行（`TUIApp.ts:2198` `paintStatus`） |
| 可配置项 | **30 项 statusline 目录**（`bottom_pane/status_line_setup.rs:57-168`）+ Native/Extension 双渲染器 + 实时预览（`status_line_content.rs:15`、`status_surface_preview.rs:138`） | **固定字段**（cwd / git branch / session name / token / context% / tok/s / 权限 badge / provider·model·thinking） |
| 折叠策略 | 保留 queue hint → 丢 `? for shortcuts` → 丢 `(shift+tab to cycle)` → 退化为无左侧行（`footer.rs:24-40`） | 尾部裁剪 → 丢 hint → 丢模型名 → 最后才丢权限 badge（`footer.ts:319-334`）；**权限 badge 永不丢** |
| 计时/费用 | `status_indicator_widget.rs:76` `fmt_elapsed_compact`（`1m 00s`/`2h 03m 09s`）+ `EstimatedThreadCost` | **无**耗时、无费用 |

### 3.4 History cell

| 单元 | codex | duya |
| --- | --- | --- |
| 抽象 | `trait HistoryCell`（`history_cell/mod.rs:201-356`，约 25 方法）+ 三态渲染 Rich/Raw/Transcript（`:157`） | `blocks.ts:104` `BlockKind`（user/assistant/thinking/tool/error/notice）+ `blocks.ts:409` `TranscriptModel` |
| 单元数 | **30+**（exec/patch/plan/MCP/web-search/notice/warning/separator/session/hook/computer-activity/dynamic/async-question/approval/spoken/startup-warning…） | 6 种 BlockKind（todo 与 patch 走 tool/assistant 内部路径） |
| 思考折叠 | `ReasoningSummaryCell`（`messages.rs:392`），完成后仅在展开 transcript 保留 | 折叠=1 行预览（`transcript-view.ts:1444` `thinkingBody`），流式跟尾、结束跳头（`:1456`），上限 2000 字符（`:1408`） |
| 工具折叠 | `activity_group.rs:11` `ActivityGroup<T>` + `activity_preview.rs:9` `DETAIL_PREVIEW_LINES=3`，折叠态保留元数据不物化内容（`mod.rs:270-274`） | 三档 `toolGroupMode`（`transcript-view.ts:129`），批量同族折成头（`Read 3 files`） |
| Diff | **内联**且带超链接：`patches.rs:34` `create_diff_preview_with_links` / `:47` `create_diff_summary_with_links`，紧凑态截 3 行（`:33-40`） | **仅着色文本**（`transcript-view.ts:369` `renderDiffLine`），**无 hunk 头 / 文件头 / gutter / +/- 统计** |
| Plan | **独立 cell**：`history_cell/plans.rs:126` `ProposedPlanCell` / `:235` `PlanUpdateCell` / `:42` `StreamingPlanTailCell` | **无独立 cell**，plan 由 todo 兼任（`todo.ts:26-32` 注释自陈对比） |
| Subagent | 进 transcript（`app/agent_center/`、`thread_transcript/`） | **不进 transcript**，只在 F6 独立视图 + 计数摘要（`background-tasks.ts:156`、`TUIApp.ts:1586`） |
| 逐块折叠/选中 | 成熟 | **渲染器支持但生产不传参**：`transcript-view.ts:115-119` / `:1635` / `:1717` 齐备，`TUIApp.renderOptions()`（`TUIApp.ts:1669-1692`）从不设置 `expandedBlockIds`/`collapsedBlockIds`/`selectedBlockId` |

### 3.5 Overlay 体系

| | codex | duya |
| --- | --- | --- |
| 机制 | `trait BottomPaneView`（`bottom_pane/bottom_pane_view.rs:29-249`）+ `ViewStack`（`view_stack.rs:17`）+ `CenteredView`（`:73`）+ `DialogOverlay`（`:109`） | 居中全屏 overlay（`overlay.ts:163`，**仅**权限批准 + 问卷，`TUIApp.ts:1508-1515`）+ composer 槽位 dock 面板（`window.ts:673` `WindowManager`）+ composer 下方补全弹窗（`TUIApp.ts:2105`） |
| 数量 | **30+ overlay**：command_popup / file_search_popup / skill_popup / mentions_v2 / list_selection_view / multi_select_picker / approval_overlay / async_questions / request_user_input / mcp_server_elicitation / config_panel / hooks_browser / memories_settings / experimental_features / feedback / custom_prompt / skills_toggle / status_line_setup / title_setup / warnings_view / user_verification / app_link / shortcut_overlay / actionable_banner… | 面板类型：F1 帮助 / Ctrl+R 历史 / Ctrl+P 用量 / 模型 / 设置 / 插件 / provider / 多标签富面板（`window.ts:442` `RichPanelController`）/ 登录输入 |
| 通用选择列表 | `list_selection_view.rs` 1900+ 行：单选/多选/次级动作/侧栏描述/搜索/Tabs，toggle 前缀四态（`:395-399`） | `window.ts:107` `ListState`：过滤 + 单选；`RichPanelController` 支持 tab strip + 每 tab 独立 filter/光标 |
| MCP elicitation | **动态表单**（`mcp_server_elicitation.rs` 1500+ 行，按 MCP schema 生成） | **无** |
| 问卷 | `request_user_input/mod.rs` 1170+ 行：选项 + 自由文本 notes 混合 + **自动解决倒计时**（60s 隐藏宽限 + 60s 可见，`:67-74`） | `question-overlay.ts:148` `QuestionAskState`：多问题逐个答 + notes 缓冲 + 多选 + 未答二次确认（`:411`）；**无倒计时** |

### 3.6 审批 / 权限

| | codex | duya |
| --- | --- | --- |
| 请求类型 | 4 变体（`approval_overlay.rs:74-79`：Exec / Permissions / ApplyPatch / McpElicitation）+ 4 套选项（`:859-945`、`:1042-1060`、`:1062-1094`、`:1096-1100`） | 1 套 picker（`overlay.ts:95-99` `PICKER`）：Allow once / Always allow this session / Deny |
| 破坏性确认 | 选项含 "No, and tell Codex what to do differently" | **有**破坏性二次确认（`overlay.ts:110-125` `DESTRUCTIVE_PATTERNS` 14 条正则 + `:126` `isDestructiveRequest`，首按 Enter staging） |
| 队列 | 内部队列（`approval_overlay.rs:186-187` `current_request` + `queue`，`:380` `advance_queue`） | 队列（`overlay.ts:239-241` 显示 `+N more requests waiting`，`:428` `advance()`） |
| 超时 | — | **有**（`overlay.ts:449` `armTimer`，到期自动拒绝） |
| 降级 | — | **有**，无 responder 时诚实显示 "no permission responder is attached to this run"（`overlay.ts:204-206`） |
| auto-review | **有**：`auto_review_denials.rs:7` `MAX_RECENT_DENIALS=10` + `app_event.rs:754` `ApproveRecentAutoReviewDenial`（**approve-one-retry**）+ `app.rs:443` `AutoReviewMode` + strict auto review（`app_server_requests.rs:358`） | **无**任何策略引擎；`overlay.ts:97` 的 "Always allow this session" 是**单次调用粒度**，不构成可复用规则 |
| 延迟弹出 | 用户停止输入 1 秒后才弹（`bottom_pane/mod.rs:246` `APPROVAL_PROMPT_TYPING_IDLE_DELAY`） | 无 |

### 3.7 流式渲染

| | codex | duya |
| --- | --- | --- |
| 分层 | `streaming/chunking.rs:157` `AdaptiveChunkingPolicy`（进入 8 行/120ms、退出 2 行/40ms、hold 250ms、严重积压 64 行/300ms）+ `commit_tick.rs:31` | `delta-buffer.ts:35`（按行提交，陈旧兜底 120ms）→ `pacer.ts:103-112`（进入 3 行/100ms、退出 1 行/40ms、hold 250ms、cooldown 250ms、严重档 32 行/300ms）→ `render-scheduler.ts:62`（尾沿 70ms + **内容首沿** `:187` + 键盘绕过节流 `:216`） |
| 同步输出 | ratatui 内部 | DECSET 2026 包裹整帧（`TUIApp.ts:131-133`、`:1430-1444`）；每帧 `?7l/?7h` + 裁剪到 width-1 |
| 中断提示 | **独立** status 行 `(1m 00s • Esc to interrupt)`（`status_indicator_widget.rs:257-265`），绑定键可改写（`:178`） | **仅**混在 footer 键位串里（`TUIApp.ts:2216`、`:2243` `'Enter steer · Tab queue · Esc stop'`） |
| 空闲动画 | 空态花朵（`empty_state_animation.rs`，50ms 帧率）+ 宠物 sprite（`pets/mod.rs`，sixel/kitty）+ composer 星光（`sparkle.rs`，motion/truecolor/starfield 三重门控）+ effort 点火 | Braille spinner 10 帧 90ms（`working-tail.ts:33`、`:55`），**仅 chrome 层** |

### 3.8 滚动 / 搜索 / 回退

| | codex | duya |
| --- | --- | --- |
| 视窗 | `transcript_view.rs:91` + `scroll_state.rs:33` `ScrollState`（滚轮 3 行 `:9`）+ `jump_to_latest`（`:517`） | `core/visible-window.ts:66` 绝对偏移 + follow 标志；滚到底自动恢复 follow（`TUIApp.ts:4225`、`:4242`） |
| Transcript 搜索 | **有**：`vim_search.rs:24` `SearchQuery` + `pager_overlay.rs:395` `TranscriptHistoryState` + `keymap.rs:110` `find_transcript` + `keymap.rs:342` `PagerKeymap` | **无**（现存"搜索"仅列表窗口的模糊过滤 `window.ts:342`） |
| 回退 / 重编辑 | **有**：`app_backtrack.rs:64` `BacktrackState` + `:568` `backtrack_revert_before_turn_id` + 3 子模块 | **无**（最接近的 `TUIApp.ts:3191` 只是回填**输入历史**，无重发/分支语义） |

### 3.9 终端能力与其他

| 能力 | codex | duya |
| --- | --- | --- |
| 终端探测 | **主动**：`terminal_probe.rs` 970+ 行，探 OSC10/11 默认色（`:257`）、光标位置（`:268`）、kitty keyboard（`:499`）、primary DA（`:548`） | **仅环境变量推断**（`terminal-env.ts:185` `detectTerminalEnvironment`），无主动探测 |
| OSC 11 背景色 | 有（驱动亮色适配 `terminal_palette.rs`） | **明确拒绝**（`theme.ts:32-36`，"the OSC 11 probe was rejected in plan 611 W1.1"）；只能靠 `COLORFGBG` 猜（`theme.ts:138`） |
| OSC 8 超链接 | **有**（`terminal_hyperlinks.rs` 820+ 行，含工作区文件白名单 `:58-60`、8KB 目的地上限 `:41`、折行重映射 `:396`） | **明确不做**（`terminal/ansi.ts:258-262` "OSC 8 is deliberately absent"；`core/span.ts:70-71` `linkId` 字段预留但无消费者）→ Markdown 链接**只渲染 label，URL 永久丢失**（`transcript-view.ts:1554`） |
| 行内图像 | 有（`inline_visualization.rs` + kitty/sixel） | **探测但无消费者**（`terminal-env.ts:207` `kittyGraphics`，全仓无使用者，仅 `__tests__/terminal-env.test.ts:109` 断言） |
| 键位 | **单一 catalog 宏**：`keymap/bindings.rs:158-301` `define_runtime_action_bindings!` 同时生成 5–6 个 API；13 个 `KeymapContext`（`:15`）；Chord/Leader（`keymap/chords.rs`、`keymap/leader.rs`）；录制式编辑器（`keymap_setup/`） | **仅 7 个全局 action 可重绑**（`keymap.ts:40` `REBINDABLE_ACTIONS`），来源 `~/.duya/config.toml` `[tui.keys]` + `DUYA_TUI_KEY_<ID>`；`keymap.ts:48` `RESERVED_KEYS`；编辑器/补全键**不可重绑** |
| Markdown | 成熟 + 10 个扩展子模块（`markdown_render/{math,mermaid,local_links,web_links,task_lists,…}`）+ 表格边框字符（`markdown_render.rs:108-111`） | 8 种行内构造（`markdown/inline.ts:54-61`）；**缺** autolink / 引用式链接 / 脚注 / HTML 实体（`markdown/inline.ts:34-37`）；**无代码语法高亮**（`transcript-view.ts:344`） |
| 通知 / 窗口标题 | 有（`notifications/` OSC9 + BEL；`action_required_title.rs`） | **无** OSC 0/2 标题、无 BEL；`TUIApp.ts:293` `title` 选项未被消费 |
| 语音 | 有（`voice_strip.rs`、`chatwidget/realtime*`，**实验性**） | **无** |
| 命令面板 | 有（`app/agent_center/`、`app/agents_overview*` 20+ 文件、`analytics/` 约 60 文件） | **无**（`actions.ts:5-8` 注释明说"command palette"是尚未采纳的第三方收益点） |

---

## 4. 差距清单（按优先级）

> P0 = 架构债或明确被拒绝但代价高；P1 = 高价值交互缺失；P2 = 打磨项。每条给出 codex 侧锚点与 duya 侧锚点/缺失声明。

| # | 优先级 | 差距 | codex 锚点 | duya 现状 |
| --- | --- | --- | --- | --- |
| 1 | **P0** | **`/presets`：用户可保存「可复用 prompt 与斜杠命令」**。codex 把 prompt/命令做成可命名预设，存入配置并可快速唤起 | `slash_dispatch.rs:379-381` `open_quick_dial_menu`；`bottom_pane/picker_presets.rs` | **无对应实现**。duya catalog 是硬编码 53 条，无用户可扩展的预设层 |
| 2 | **P0** | **组件树未接线**。codex 有 `renderTree` + 增量渲染；duya 的 `core/component.ts` 保留树不接生产路径，导致无命中测试、无脏传播、无增量更新 | `chatwidget/rendering.rs:140` `as_renderable`（渲染入口） | `core/component.ts:20-26`（自陈 Phase 3 范围）；`TUIApp.ts:1423` `paint()` 仍命令式；`TUIApp.ts:2293` 直接调 `buildFooterLines` 而非 `components/status-bar.ts:27` |
| 3 | **P0** | **逐块折叠/展开/选中未接线**。渲染器已支持，生产路径不传参 | `history_cell/mod.rs:251-274` 披露协议 | `transcript-view.ts:115-119`/`:1635`/`:1717` 支持；`TUIApp.ts:1669-1692` 从不设置 `expandedBlockIds`/`collapsedBlockIds`/`selectedBlockId` |
| 4 | **P1** | **可配置 statusline（30 项）**。codex 把状态栏做成用户可选项目目录 + 实时预览 | `bottom_pane/status_line_setup.rs:57-168`；`status_line_content.rs:15` | 固定字段（`footer.ts:222`）；需先决定多行还是分页 |
| 5 | **P1** | **Transcript 搜索** | `vim_search.rs:24` + `pager_overlay.rs:395` + `keymap.rs:110`、`:342` | 无 |
| 6 | **P1** | **回退 / 重编辑上一条消息** | `app_backtrack.rs:64`、`:568` + 3 子模块 | 无 |
| 7 | **P1** | **auto-review + approve-one-retry** | `auto_review_denials.rs:7-37` + `app_event.rs:754-755` + `app.rs:443` | 无策略引擎；`overlay.ts:97` 仅单次调用粒度 |
| 8 | **P1** | **Vim modal 编辑** | `keymap.rs:229-340` + `textarea/vim_commands.rs:24` + `vim_register.rs:37` | 无 |
| 9 | **P1** | **单一键位 catalog 生成多 API** + chord/leader + 录制式编辑器 | `keymap/bindings.rs:158-301`、`:15`；`keymap/chords.rs`；`keymap_setup/` | 仅 7 个可重绑 action（`keymap.ts:40`），编辑器/补全键不可 |
| 10 | **P1** | **OSC 8 超链接**（含工作区文件白名单与安全上限） | `terminal_hyperlinks.rs:41`、`:44`、`:58-60`、`:396`、`:706` | 明确不做（`terminal/ansi.ts:258-262`）；链接 URL 丢失（`transcript-view.ts:1554`） |
| 11 | **P1** | **MCP elicitation 动态表单** | `bottom_pane/mcp_server_elicitation.rs:693` | 无 |
| 12 | **P1** | **request_user_input 自动解决倒计时** | `bottom_pane/request_user_input/mod.rs:67-74` | 无（`question-overlay.ts:148` 有完整状态机但无倒计时） |
| 13 | **P2** | **OSC 11 背景色主动探测** | `terminal_probe.rs:257`、`terminal_palette.rs` | 明确拒绝（`theme.ts:32-36`）；底色写死 256 色灰（`theme.ts:91-92` `236-bg`/`238-bg`） |
| 14 | **P2** | **行内图像 / kitty graphics 消费** | `inline_visualization.rs:29`；`pets/mod.rs:128` | 已探测无消费者（`terminal-env.ts:207`） |
| 15 | **P2** | **独立 Plan cell** | `history_cell/plans.rs:126`、`:235`、`:42` | 无，plan 由 todo 兼任（`todo.ts:26-32`） |
| 16 | **P2** | **subagent / 后台任务进 transcript** | `thread_transcript.rs:67-227`；`app/agent_center/` | 只在 F6 独立视图（`background-tasks.ts:156`） |
| 17 | **P2** | **Diff 加 hunk 头 / 文件头 / gutter / +/- 统计** | `patches.rs:33-64`（带超链接的完整 diff 摘要） | 仅逐行着色（`transcript-view.ts:369`） |
| 18 | **P2** | **中断提示独立视觉** | `status_indicator_widget.rs:257-265` | 混在长键位串（`TUIApp.ts:2243`） |
| 19 | **P2** | **Composer 按行移动 + 重做** | `keymap.rs:200-213`、`:307-308` | `editor.ts:176-208` 无 line up/down；`undo-stack.ts` 无 redo |
| 20 | **P2** | **代码语法高亮** | `markdown_render/` 10 子模块 | `transcript-view.ts:344` 仅转义 + 行号槽 |
| 21 | **P2** | **终端通知 / 窗口标题 / 语音** | `notifications/`；`action_required_title.rs`；`voice_strip.rs` | 全无 |
| 22 | **P2** | **全屏 diff 降到 cell 级** | ratatui 内部 | 行级（`screen/own/frame.ts:392-398`） |

### 4.1 duya 侧另外两处需要修的事实错误（非缺口，是 bug）

| 项 | 证据 | 影响 |
| --- | --- | --- |
| `chat.ts:617` `inlineTuiRequested()` 的注释仍写"`DUYA_TUI_INLINE=1` opts in，默认是全屏"，但该函数在 TUI 构造路径**已不被调用**（`chat.ts:1239` 走 `effectivePreferences.displayMode`）。真实默认是 **inline**（`preferences.ts:116`） | `chat.ts:605-621` | 误导后续维护者，可能导致错误的默认值改动 |
| `packages/agent/src/cli/slash-commands.ts` 遗留层仍有 3 处 TODO stub（`:610` send 原语、`:807` mode setter、`:1091` rate limit） | 同左 | 遗留层正在退役，这些 stub 应确认调用方后清理 |

---

## 5. 建议的切片（供选型）

| 切片 | 内容 | 依赖 | 规模 |
| --- | --- | --- | --- |
| **S1 命令预设** | `/presets`：用户保存可复用 prompt/斜杠命令，catalog 增一条 `presets` spec + 新增预设存储与 picker | 与 S2 分离；需要新增持久化位置（`~/.duya/`） | 中 |
| **S2 组件树接线** | 把 `TUIApp.paint()` 迁到 `core/component.ts` 的 `renderTree`，先接 `StatusBar` + `TranscriptPane` | 无前置；需命中测试先行 | 大 |
| **S3 逐块折叠接线** | `TUIApp.renderOptions()` 真正传 `expandedBlockIds`/`collapsedBlockIds`/`selectedBlockId`，加交互键 | 渲染器已就绪 | 小—中 |
| **S4 状态行可配置** | 引入 statusline 项目目录（codex 30 项的子集），支持多行/分页决策 | 需先定 footer 结构 | 中—大 |
| **S5 搜索与回退** | Transcript 搜索 + backtrack 重编辑 | 可分两刀；回退需 turn 结构支持 | 中 |
| **S6 键位目录化** | 把 `keymap.ts` 的 action 表抽成单一 catalog 并生成多 API（对齐 codex `keymap/bindings.rs`） | 为 S4/S5/S7 提供基础 | 中 |
| **S7 OSC 8 超链接** | 实现 OSC 8 + 工作区文件白名单 + 长度上限 | 与 S2 不冲突；可独立 | 中 |

**优先级建议**：S3（小、价值直接、渲染器已就绪）→ S6（键位目录是 S4/S7 的地基）→ S1（用户可感知的命令面扩展）→ S5 → S2（最大但最重）→ S4 / S7。

---

## 6. 核验说明

- 全部 `file:line` 均来自本次实际 Read/Grep 的命中行；codex 侧基线 `fbf5f0d3a7`，duya 侧基线 `203d7d51`。
- 本轮 **未完成** 的核验项（需后续补）：
  - Desktop 侧命令执行器与旧快照"14 条注册表 / 死代码"的差异复核。
  - `packages/command-catalog` 53 条 spec 中，**每一条**在 CLI 与 Desktop 两侧是否都有真实执行器的逐条映射（本次核到 CLI 侧 `TUI_SLASH_COMMANDS` 汇总 28 个分组模块，未逐条比对 53 条）。
  - codex `/presets` 的预设存储格式与复用范围（只确认了入口 `open_quick_dial_menu`）。
- codex 侧 `codex-rs/tui/src` 共 228 个顶层 `.rs` 文件、42 个子目录、递归 1173 个 `.rs`；`chatwidget/`、`app/`、`analytics/` 三大目录为功能级抽样而非逐文件穷举。
- 关键数字已用命令独立复核：`SlashCommand` enum 变体数 **65**（`sed -n '/^pub enum SlashCommand {/,/^}/p' slash_command.rs | grep -cE '^    [A-Z][A-Za-z0-9]*(,|\s*\{)'`）；duya `COMMAND_SPECS` 条数 **53**（`grep -c "^    name: '" packages/command-catalog/src/index.ts`）。
