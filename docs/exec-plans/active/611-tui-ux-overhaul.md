# 611 — CLI TUI 体验改造（主题 token 化 / 动作注册表与多窗口 / busy 排队 / 粘贴修复 / token 展示 / 工具组渲染 / undo+kill ring）

> 2026-10-15 foundation slice: see [Host-backed TUI foundation](611-tui-foundation-slice.md).
> This slice targets the actual `@duya/cli` Host entry; earlier legacy-adapter
> queue and approval evidence below does not establish behavior in that path.

> **Status**: Wave 1–4 landed（2026-10-11/12）· **Priority**: P1 · **Owner**: agent
> **立项**: 2026-10-11（对标 `E:\cloned-projects\grok-build` 的 `xai-grok-pager` TUI，调研见
> `docs-local/research/grok-build-tui-comparison.md`）
> **分界**: 本 plan 只覆盖 `packages/cli/src/tui` + `packages/agent/src/cli` 接线；权限审批链路
> （需要 headless host 增加 permissionResponder）单独立项，见 §6 非目标。
> **Wave 1 验收实测**: `packages/cli/src/tui` 13 文件 178 用例全绿；`packages/agent/src/cli`
> 6 文件 98 用例全绿；`tsc -p packages/cli` 与 `tsc -p packages/agent`（重建 cli dist 后）零错误；
> `check-text-encoding` OK。剩余真机项：§4 手感清单。

---

## 0. 一句话目标

让 CLI TUI 的交互手感对齐成熟参考实现：颜色可主题化（自动明暗）、键位有单一事实源和帮助窗口、
busy 时排队而非并发开 run、大粘贴可多个共存、token 用量进状态栏而非 transcript 噪音行、
连续同名工具调用渲染为组。

## 1. 背景：调研结论（证据见对比报告）

duya TUI 工程底子好（三级流式流水线、DECSET 2026、码点编辑器、13 个测试文件），差距在功能面：

| 问题 | 位置 | 现状 |
|---|---|---|
| busy 无排队 | `packages/agent/src/cli/tui-session.ts:267-311` | 运行中提交输入并发再开 run |
| 第二个大粘贴覆盖第一个 | `packages/cli/src/tui/editor.ts:42` | 单 `paste` 字段 |
| token_usage 只打一行 notice | `packages/cli/src/tui/blocks.ts:473-477` | 无状态栏、无累计 |
| 颜色硬编码 | `packages/cli/src/tui/transcript-view.ts:48-58` | 无主题、浅色终端不可读 |
| 键位分散 | `packages/cli/src/tui/TUIApp.ts:1089-1227` | 无帮助窗口、无单一事实源 |
| 连续同名工具每行一个全 marker | `packages/cli/src/tui/transcript-view.ts:248-289` | 无组感 |

## 2. Wave 1（本 plan 交付）

### W1.1 主题 token 化 + 自动明暗（`theme.ts` 新文件）
- 语义 token 集：muted/accent/success/error/warning/user/thinking/diffAdd/diffDel/heading/link。
- tag 值域为 blessed 名（`gray-fg` 等）或 256 色数字（`241-fg`，已实测输出 `\x1b[38;5;241m`）。
- 暗色主题 = 现有取值（测试基线不变）；亮色主题 = 256 色数字重映射。
- `RenderOptions.theme?: ThemeTags` 注入，纯函数性保持；默认暗色。
- 选主题：`DUYA_TUI_THEME=dark|light|auto`；`auto` 读 `COLORFGBG`，无则默认 dark。
- **取舍（被否）**：OSC11 背景探测——blessed 的 `Program` 构造即接管 stdin raw mode，
  在其之前自管 raw mode 探测会让启动路径多一条失败面；COLORFGBG + 显式 env 已覆盖
  Windows Terminal / Git Bash 主场景。OSC11 留给 Wave 2 再评估。

### W1.2 动作注册表 + F1/Ctrl+R/Ctrl+P 三窗口（`actions.ts`、`window.ts` 新文件）
- `ACTION_DEFS`：id / keys / label / context 单表，**是帮助窗口的渲染源**——键位与提示同源
  （grok 的 actions/mod.rs 红利，本 wave 先吃"提示同源"，键位分发仍是命令式 bindKeys，
  表驱动分发留 Wave 2）。
- `WindowManager`：通用模态窗口（复用 `overlayBox`，与权限 overlay 互斥），支持
  视口滚动、行选择、type-to-filter、Enter/Esc。
- 三个窗口：
  - **F1 Help**：从 `ACTION_DEFS` 渲染键位表；
  - **Ctrl+R History**：输入历史 type-to-filter + Enter 回填编辑器（历史数据源
    `editor.exportHistory()` 已存在）；
  - **Ctrl+P Usage**：上一 turn usage（input/output/total）+ 会话累计 + 上下文占比条（有预算时）。

### W1.3 token_usage 上状态栏，transcript 除噪
- `TUIApp.push()` 拦截 `token_usage` 帧 → 更新 `lastUsage` + 会话累计；`blocks.ts` 的
  token_usage arm 改为 `{ kind: 'none' }`（对应集成测试同步更新）。
- 状态栏追加固定宽度段：`Σ 12.3k tok`；有预算（`contextBudgetTokens` 注入，来自
  `findModelById(...).contextWindow`）时显示 8 格等宽 bar `▰▰▱▱▱▱▱▱ 23%`（grok
  context_bar 的零布局偏移手法：总宽恒定）。
- **取舍（被否）**：token_usage 帧投影自 `assistant.usage`（`legacy-sse-projector.ts:147-155`），
  是**单次调用快照**不是 turn 累计块（plan 445/546 的形状只存在于持久化层）——状态栏标注
  "last call" 口径，会话累计由 TUI 自己对帧求和，语义为"会话至今见过的用量总和"，
  不冒充上下文窗口占用。

### W1.4 busy 排队（`tui-session.ts`）
- busy 且非 slash 命令 → 入队，transcript 打一行 `queued (N)`；`runTurn` finally 后
  依序自动开跑。
- slash 命令保持即时执行（与 grok 一致，/status /effort 等在运行中有效）。
- `/exit` 等退出命令不入队。

### W1.5 粘贴占位 Map（`editor.ts`）
- 单 `paste` 字段 → `Map<placeholder, content>` + 计数后缀 `[Pasted Content #N · X chars]`。
- 提交时展开**全部**仍完好的占位符；编辑破坏某个占位符文本则只作废那一个。
- 历史记录存展开后文本（现状语义保持）。

### W1.6 工具组渲染（`transcript-view.ts`）
- 连续同名、已完成的 tool 块，后续块头部用 `└ name(preview)` 续行样式（dim）。
- **约束**：只改头部 marker，不增删行数——`revealSelectedBlock`（TUIApp.ts:1476-1500）按
  `renderOneBlock` 逐块累加行数定位，行数不变是它保持精确的前提。

## 3. 非目标（本 plan 明确不做）

- **权限审批链路**：`canAnswerPermissions: () => false`（tui-session.ts:212）是因为 headless
  host 无 permissionResponder（`headless-run-host.ts:737-743` 只能 classify 'generic'）。
  修复要动 host + run 生命周期，单独立项。overlay 的"诚实告知不可答"设计保留。
- vim 模式、鼠标支持、Mermaid/行内媒体、语法高亮 worker、多会话 tab（对比报告 §2 P3 记录了取舍）。
- 全量重渲 → paint-window 裁剪：结构投资大，Wave 2 单独立项（本 plan 的窗口系统不受影响）。

## 4. 验收

- [ ] `node node_modules/vitest/vitest.mjs run packages/cli/src/tui` 全绿（含新增测试：
      编辑器双粘贴、窗口管理器、工具组渲染、token_usage 不再产生 notice）。
- [ ] `npm run typecheck:all` 相对基线无新增错误。
- [ ] 手感清单（真机）：F1 出键位表；Ctrl+R 过滤历史回填；Ctrl+P 显示用量；运行中提交
      显示 queued 并在回合结束后自动执行；两个大粘贴各自展开；浅色终端 `DUYA_TUI_THEME=light`
      下文字可读。

## 5. 参考语义取舍记录

| grok 语义 | 采纳/被否 | 理由 |
|---|---|---|
| 单一动作注册表（键位+提示+面板同源） | 部分采纳（提示同源先行） | 键位分发命令式改造风险 > 本 wave 收益 |
| 等宽进度条零布局偏移（context_bar） | 采纳 | 纯渲染技巧，无依赖 |
| 审批队列仅队首可交互 | 暂缓 | 审批链路断在 host 层，TUI 侧改了也空转 |
| OSC11 背景探测 | 被否（本 wave） | raw mode 竞争面；COLORFGBG 够用 |
| 历史 nucleo 后台 daemon | 被否 | duya 历史 ≤1000 条，同步 substring 过滤足够 |
| token 用量条含预算 | 采纳（预算可解析时） | 数据源 `findModelById().contextWindow` 已存在 |

## 6. Wave 2（minimax-code 二轮移植，2026-10-12）

调研对象：`E:/cloned-projects/minimax-code/packages/tui/src/tui`（pi-tui fork，自研字符串行渲染器，
~104k 行）。二轮只移植**引擎无关**机制；`keys.ts` 三编码解析、行 diff 渲染、CURSOR_MARKER 等
引擎强绑定项被否（blessed 自带等价或代价不成比例）。

### W2.1 UndoStack（`undo-stack.ts` 新文件，移植自 `engine/undo-stack.ts`）
- 整 buffer 快照 `{cells, cursor, pastes}`，`structuredClone` 深拷贝，push 上限 100。
- 每个变更操作（insert/backspace/deleteForward/kill×3/clear/setText/applyHistoryEntry）先拍快照；
  undo 粒度 = 一次操作而非一次按键。
- yank 经普通 insert 路径，大粘贴自动折叠为新占位符——undo 顺带恢复 pastes Map。

### W2.2 KillRing（`kill-ring.ts` 新文件，移植自 `engine/kill-ring.ts`）
- Emacs 语义：连续 kill 累积（`lastAction === 'kill'` 时 accumulate），后向 kill prepend
  保证文档序。上限 60 条。
- `killRange` 助手统一三个 kill：杀出的文本**展开占位符后**进 ring——kill 一个折叠粘贴
  必须把真实内容放上 ring，只杀标签等于制造死文本。
- yank（Ctrl+Y）/ yankPop（Alt+Y，仅 yank 后有效，typing 打断）。
- 键位：Ctrl+Z / Ctrl+Y / Alt+Y（C-z 在 blessed raw mode 下不会触发 SIGTSTP）。

### W2.3 窗口过滤 fuzzy 化（`window.ts`）
- Ctrl+R 历史窗口 substring → `@duya/input-completion` 的 `fuzzyFilter`（该实现本身即
  minimax-code + codex 二源的吸收改良版，含多起点对齐、稳定排序），空查询保持原序短路。

### W2.4 actions.ts 同步
- 新增 undo / yank / yank-pop 三条目，kill-line/kill-word 标注 "into kill ring"——F1 帮助
  窗口从注册表渲染，自动同源。

### Wave 2 验收实测
- `packages/cli/src/tui` 14 文件 **193/193** 全绿（新增 undo/kill 14 用例 + fuzzy 排序 1 用例）。
- `tsc -p packages/cli`（连带重建 dist）与 `tsc --noEmit -p packages/agent` 零错误；
  `packages/agent/src/cli` 98/98；`check-text-encoding` OK。

### Wave 2 舍弃项（minimax-code 调研结论）
| 候选 | 决定 | 原因 |
|---|---|---|
| fuzzy.ts 独立移植 | 被否 | `@duya/input-completion` 已有更强的同源实现，直接复用 |
| 输入旁路立即渲染 | 已存在 | `RenderScheduler.requestImmediate` 本就是此语义 |
| 权限决策回执 cell | 暂缓 | 依赖审批链路修复（§3 非目标） |
| 队列管理面板（重排/删除） | 暂缓 | Wave 1 排队已覆盖主诉求，管理面板等真机反馈 |
| markdown stable-prefix 流式缓存 | 暂缓 | duya 走 blessed 全 diff，闪烁主因不同；留待可视窗裁剪一并评估 |
| latex Unicode 渲染 | 被否 | CLI 场景数学公式占比极低，1380 行映射表不值得 |

## 7. Wave 2.5（真机反馈修复，2026-10-12）

真机截图反馈两项：表格裸渲染、滚轮滚不动 transcript（撞输入历史）。

### W2.5.1 GFM 管道表格渲染（`transcript-view.ts`）
- 表格判定：当前行含 `|` 且下一行是分隔行（逐格校验 `/^:?-{1,}:?$/`——单列表格 `|---|`
  无内竖线，整行正则会漏）。正文行收集到空行/无管道行为止；`\|` 转义在切分时还原。
- 渲染：`│` 分隔 + `─┼─` 规则行；列宽按 `visibleWidth`（CJK 感知），单元格上限 48 列
  （`truncateToWidth` 截断带 `…`）；分隔行冒号驱动 left/center/right 对齐；表头 flat accent
  （`accent(escapeTags(cell))`，不与内联样式嵌套），表体走 `renderInlineMarkdown`。
- 短行补空格到列数（ragged 行不移位后续列边框）。

### W2.5.2 滚轮滚动（`TUIApp.ts`）
- 根因：应用未开 mouse reporting 时，Warp 等终端把滚轮合成 ↑/↓——input 焦点下正好是历史
  回溯，滚轮永远滚不到 transcript。
- 修复：`program.enableMouse()` + `program.on('mouse')` 消费 `wheelup/wheeldown`（每 tick
  3 行，`scrollByLines`，follow 语义同 `scrollBy`）；窗口打开时滚轮滚窗口选中行；prompt/
  overlay 激活时忽略。只吃滚轮不拦点击，原生选择保留。
- `stop()` 补 `program.disableMouse()`——否则退出后终端残留在 mouse reporting，shell 吞点击。
- F1 帮助同步（wheel-scroll 条目），启动 notice 更新。

### Wave 2.5 验收实测
- `packages/cli/src/tui` 15 文件 **200/200**（新增表格 7 用例：CJK 对齐/右对齐/转义/截断/
  纯文本不误判/表头 flat）；`packages/agent/src/cli` 98/98；cli tsc（重建 dist）与 agent tsc
  零错误；encoding OK。
- 附注：真机截图里的 `tokens: 1104` notice 行来自旧构建产物——源码 Wave 1 已移除该行为，
  重新构建 CLI 即消失。

## 8. 七项目全面对比调研（2026-10-12，Wave 3+ 输入）

报告：`docs-local/research/tui-agents-comprehensive-comparison.md`。
对象：codex（489 文件 ratatui）/ pi（pi-tui 原版）/ minimax-code / claude-code-haha（改造 Ink）/
DeepSeek-TUI（287 文件）/ grok-build / prime-agent（pi-tui 衍生）。

核心结论：
1. **范式分歧**：5/7 项目收敛到"主屏流式 + 终端原生 scrollback"（历史定稿即退出渲染树）；
   grok 与 duya 是 alt-screen 全控少数派。duya 不换引擎，用「可视窗裁剪 + 内容 hash 缓存」逼近主屏派的性能。
2. **P0 两项**：renderTranscript 可视窗裁剪 + hash 缓存（性能）；审批链路接通（缺陷——
   canAnswerPermissions 恒 false）。审批设计抄 codex（列表选择视图 + InterruptManager 排队）
   + DeepSeek（Destructive 双击 staging 防误批）。
3. **P1**：steering vs queue 产品语义（codex 三队列 / DeepSeek mpsc steer channel）；
   queued 显示组件；中断恢复 checkpoint；键位表驱动分发收尾 + 用户覆盖配置。
4. **P2**：跨会话历史 + 重水化；@文件 mention + frecency；工具输出有界 tail（codex 头尾保留）；
   表格过窄回退（pi）；**pi CURSOR_MARKER IME 光标定位**（对中文用户价值极高，需验证 blessed 可行性）。

## 9. Wave 3（P0-1 渲染性能：per-block 缓存 + 视口行数解耦，2026-10-12）

调研报告 §14 的两项 P0 之一。目标：长会话每帧不再全量重渲所有 blocks。

### W3.1 `transcript-cache.ts`（新文件）
- `TranscriptRenderer`：每 block 一条缓存（Map<blockId, {key, lines}>），key =
  kind + 组续行标志 + 展开态 + showToolResults + toolResultLines + theme指纹 +
  **内容 FNV-1a hash**。hash 而非 rev 计数——正确性不依赖任何变异点记得 bump
  （blocks 的变异全部集中在 TranscriptModel，但 hash 对未来任何外部变异路径免疫），
  成本约为重渲染的 1/50。
- `blocks()`（无选择前缀的 per-block 行数组）/ `heights()` / `totalLines()` /
  `lines()`（flatten + `❯ ` 选择前缀）。**选择前缀在 flatten 时施加**——移动历史
  选中项零重渲染。
- 行数不变式（实证钉死）：`renderTranscript` join 无分隔行，`总行数 = Σ blockHeights`。
  heights()/totalLines() 让滚动算术完全不构建字符串。
- prune：cache.size > 活跃数 + 32 时清除失效块（/clear、会话切换）。
- `stats {hits, misses}`：缓存行为可断言、可度量。

### W3.2 TUIApp 接线
- `paintTranscript`：`transcript.lines(model, options)` 直接出视口切片。
- `revealSelectedBlock`：heights 求和定位；**顺带修掉每块 `+1` 的累积偏移**
  （join 语义下块起始行 = 前序高度裸和，旧代码多算 N-1 行，选中回溯越滚越偏）。
- `scrollBy` / `scrollByLines`：totalLines()，不再每帧全量 `split('\n')`。
- renderTranscript/renderOneBlock 从 TUIApp 退场（保留导出，测试仍以其为黄金参照）。

### Wave 3 验收实测
- 基准：450 块 / 23KB 内容长会话，每帧 14.13ms（全量重渲）→ **0.36ms（缓存），
  39.7x**；50 帧命中 22500 / 失配 450（98%）。
- `packages/cli/src/tui` 16 文件 **209/209**（新增缓存 9 用例：黄金等价/行数不变式/
  命中/流式单块失效/状态迁移/选择零失效/展开切换/clear 存活/组续行等价）。
- agent cli 98/98；cli tsc（重建 dist）+ agent tsc 零错误；encoding OK。

### 剩余 P0
- P0-2 审批链路（headless host 缺 permissionResponder）——见 §10，已落地。

## 10. Wave 4（P0-2 审批链路 + P1 收尾，2026-10-12）

### W4.1 审批链路接通（P0-2）
- **host 半边**（`headless-run-host.ts`）：`HeadlessEngineWiring` 与
  `HeadlessRunHostOptions` 各增 `requestPermission?: ChatOptions['requestPermission']`，
  在 `createAgentExecutionChannel` 注入 executor 的 options bag（与 `toolRegistry` 同一
  层次手法——函数不能过 `RunStartInput.options` 的 canonical JSON 边界）。缺席时行为
  不变：`resolveAskWithoutUser` 决定，探测仍报 `permissionExpiryClock: 'absent'`。
- **TUI 半边**（`overlay.ts` 重写）：单请求 overlay → **codex 式列表选择器**：
  ↑/↓/Enter + 1-3/y/a/n quick-pick；`OverlayState` 变**队列**（并行工具调用可同时
  raise 多个 ask，仅队首可交互，body 显示 `+N more waiting`）；**DeepSeek 式
  destructive 双击 staging**——`isDestructiveRequest`（Bash/execute/shell 的命令文本
  启发式：`rm -r`、`git reset --hard`、`git push --force`、`dd`、`del /s`、
  `Remove-Item -Recurse` 等）标记的请求，allow 首次按键只 stage（body 提示
  "press Enter again to confirm"），同键/Enter 二次确认，移动选择即解除，deny 永不
  stage；请求自带 `expiresAt` 时挂超时定时器，逾期 settle `null`。
- **接线**（`tui-session.ts`）：host 注入 `requestPermission` →
  `TUIApp.requestPermissionApproval()`（promise 化公共入口，frame 路径
  `showPermission` 同走此入口）；`mapPermissionDecision`（导出纯函数）：
  once/always→allow，**deny/null→deny，永不产出 allow 或 'paused'**；
  `canAnswerPermissions: () => true`；新 permission frame 到达时
  `overlay.abortAll()` 作废全部陈旧 ask。
- TUIApp 键路由：`routeContended` 在 windowMgr 之前插入 overlay 分支（方向键/Enter/
  Esc 先给 picker），`handleOverlayKey` 委托 picker。

### W4.2 steering vs queue 语义（P1-a）
- **中断不清队列**（codex 模型）：`onInterrupt` 不再 drop `queuedPrompts`——队首
  prompt 正是用户想让下一轮做的事，`runTurn` finally 的 drain 使其中断落定后立即作为
  新 turn 的 steering 指令开跑；notice 改为 "N queued prompts will steer the next
  turn"。`/exit` 仍结束一切。
- **队列可视化**：`TUIAppOptions.queuedCount?: () => number`，状态栏新增 `⧗ N` 段
  （busy 排队的可见半边）；中断恢复 checkpoint 即 `runTurn` finally 的
  `persistMessages`（中断后的 transcript 每轮落盘，语义已存在）。

### W4.3 键位表驱动分发收尾 + 用户覆盖（P1-b）
- `keymap.ts`（新文件）：覆盖源 = `~/.duya/config.toml` `[tui.keys]`（@iarna/toml，
  cli 已有依赖）+ `DUYA_TUI_KEY_<ID>` env，env 胜 config；`normalizeChord`（接受
  `Ctrl+J` / `C-j` / `Alt+H` / `M-h` / `meta+h` 等写法，不合法 chord 丢弃不绑定）；
  `toBlessedKeys` 显示形式 → blessed 键名。
- `TUIApp.bindAction(id, handler)`：`REBINDABLE_ACTIONS`（help/history/usage/focus/
  expand-all/clear/follow-tail 七个简单全局 toggle）从**override 后的动作表**绑定；
  编辑器/completion 键保持固定（其路由是优先级序，非平表）；**Ctrl+C 永不可重绑**
  （interrupt+exit 通道）。F1 帮助窗口渲染实例的 `actionDefs`（override 同源）。
- 测试注入 `keyOverrides: {}` 钉默认键位，避免真机 config 影响断言。

### W4.4 IME 光标定位（P1-c，核实为已存在）
- 调研结论：`width.ts` 的 `wrapWithCursor` 早已按**可见 cell 宽度**累计 `cursorCol`
  （CJK 感知，blessed 同源宽度表），`TUIApp.placeCursor()` 每帧
  `program.move + showCursor` 把真实终端光标钉在编辑器插入点——pi CURSOR_MARKER 的
  等价物已在（tui-editor-width.test.ts:184 `中文中文` cursorCol 用例钉死）。真实
  终端 IME 候选框跟随终端光标，故本项无需新代码；真机验收归 §4 手感清单。

### W4.5 跨会话历史重水化（P1-d，核实为已存在）
- `tui-session.ts` 启动即 `loadHistory()`（`~/.duya/.cli_history`，与 REPL 同路径）
  → `TUIApp(history)` → `editor.loadHistory()`；`finish()` 时 `saveHistory`。链路
  完整，editor 侧 115 行有测试。无需新代码。

### Wave 4 验收实测
- `packages/cli/src/tui` **19 文件 249/249**（+40：overlay 队列/picker/staging/超时
  17、keymap 15、TUIApp picker 集成 7、F2 重绑集成 1）。
- `packages/agent/src/cli` **7 文件 102/102**（+4：decision 映射）；headless-run-host
  28/28（wiring 注入不破坏既有）；cli tsc（重建 dist）+ agent tsc 零错误；
  `check-text-encoding` OK。
- 真机项：destructive 双击手感、`⧗ N` 段、F2 重绑、IME 候选框位置（§4 清单追加）。
