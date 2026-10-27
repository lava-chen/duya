# 630a TUI 富面板模态原语

状态：active · 负责人：630a agent · 更新：2026-10-26
分支：codex/630a-tui-rich-panel-modal · worktree：`.claude/worktrees/630a-rich-panel` · base：d80ca3c6 · owner：630a-rich-panel

## 目标与边界

用户在 TUI 输入 `/plugin`、`/provider` 一类命令后，能得到一个全屏多面板界面：顶部 Tabs、可搜索分页列表、详情子菜单、行内操作键，Esc 逐级后退退出后回到原 transcript。本切片只做界面原语，不做任何业务面板。

允许修改：`packages/cli/src/tui/`（面板宿主、原语组件、键位让位）、`packages/cli/src/tui/slash/types.ts`（`TuiSlashHost` 扩展）、对应 `__tests__/`。
本次不处理：plugin / provider 业务数据、Desktop、键位可重映射（沿用硬编码 key，但 footer 按键提示组件预留）。

关联：[系列](README.md)；631、632 阻塞于此。

## 现状事实（2026-10-26 核对）

- `TuiSlashHost` 已有 `choose` / `chooseFiltered` / `promptText`（含 secret）/ `showPanel` / `showListPanel` / `showDetailPanel` / `openSettings`（`packages/cli/src/tui/slash/types.ts:26-67`），实现于 TUIApp。全部是单列表/单面板级别，没有多 tab、没有焦点分层、没有模态让位协议。
- 命令派发在 `packages/cli/src/chat.ts:1697-1740`，返回结构化 outcome。
- 参考形态（claude-code-haha）：`local-jsx` + `immediate` 把 JSX 交 REPL 作全屏模态 pane；模态期间主输入/滚动 keybinding 以 `isActive` 让位；`Tabs` 的 header 焦点与内容焦点分离，子组件搜索时父级 `disableNavigation` 让位方向键；退出只经 `onDone` 显式清除。

## 验收

- 新增演示面板（挂在测试 harness 上，两 tab + 搜索 + 行内操作键），注入真实字节跑通：Tab/Shift+Tab 切页、`↓` 进内容、`space` 在可切换 tab 上切换、Esc 搜索→内容→header→退出逐级后退、退出后主输入恢复接管。
  落地时把原计划的「`/` 进搜索」改为「content 焦点下普通字母直接进过滤框」，理由见「发现与决策」；`/` 不是必需的第二个入口。
- 模态期间 transcript 流式更新不抢占焦点、不破坏行分配。
- `npm run typecheck:all`、`npm run architecture:check`、`npm test -- packages/cli` 相对基线零新增失败。

## 进度

- [x] 模态通道：`TUIApp.showRichPanel()` 将面板挂到 dock，Promise 在离开时 resolve；键位在 `keypress` 与 `bindKey` 两条通道上让位（`C-a/C-e/C-u/C-k/C-w/C-d`、`←/→`、`Tab`、`S-tab`、`space`），退出后编辑器重新接管。
- [x] `Tabs` 原语：`RichPanelController` 受控选中 + header/content 焦点分离；每个 tab 一个 `ListState`，切页保留各自 query 与游标；disabled tab 跳过。
- [x] 分页列表 + 过滤搜索 + 行内操作键 + footer 提示行：`ListState`（过滤/滚动/翻页/`refresh` 保留游标）+ tab 条上的单字母/控制键 row action；详情子菜单沿用既有 `showDetailPanel`。
- [x] 测试：`__tests__/tui-rich-panel.test.ts` 18 例（11 例面板状态机 + 2 例 `ListState` + 5 例经真实 `TUIApp` 注入字节），`tui-window.test.ts` 14 例回归全绿；演示面板以测试 fixture 形式存在，不留临时 debug 命令。

## 发现与决策

- 面板宿主复用现有 `showListPanel`/`openSettings` 的 blessed 链实现路径，不引入 React/Ink；duya TUI 的渲染分层（plan 615 StyledSpan）足够表达行样式。
- 采用「模态内只标脏、退出不热生效」的变更模型设计约定，供 631/632 沿用；本切片只需在协议上留出 `pendingChanges` 出口。
- 落地形态是把 `WindowManager` 拆成 `ListState`（每列表导航机）+ `PanelController`（面板 chrome 与焦点协议）+ `RichPanelController`，而不是新建第二个模态栈：Esc、过滤、选中、滚动这些行为在 F1/Ctrl+R/Ctrl+P/`/settings` 里已经答过一次，再答一次就会出现「第三个窗口的 Esc 和前两个不一样」。
- 不做 `/` 进入搜索：content 焦点下过滤框本来就吃掉每个普通字母，`deep seek` 这类查询不能因为多一个前导键而失效；也因此 `space` 在无可切换项的 tab 上仍是查询文本。代价是 tab 条上的字母才是 row action，且 `space` 不能作为 row action 键位。
- `onClose` 由 `WindowManager.close()` 统一触发（Esc、F1 抢占 dock、命令调 `handle.close()` 都算离开）；但 picker tab 的 `onSubmit` 不触发它——在那里「选中」本身就是那次写。
- 命令通过 `onOpen` 拿到 `RichPanelHandle`（`syncTab`/`activeTabId`/`activeSelectedValue`/`close`），不是返回值：Promise 已被「用户离开」占用，而 dock 上同时只可能有一个面板。
- `showRichPanel` 在 `TuiSlashHost` 里是可选方法且命名与 TUIApp 完全一致，沿用 `liveTuiPreferences` 那次教训：契约与实现差一个名字，可选调用会静默落到默认分支。
- 面板打开期间控制键一律被吃掉：`C-a/C-e/C-u/C-k/C-w/C-d` 先给面板，面板不要也不退回编辑器——dock 盖住的那行草稿是看不见的，静默改动它只会在下一次 Enter 时以「提示词丢了前半截」的形式暴露。`←/→` 同理。
- 验收里「模态期间流式更新不抢占焦点」一条以 `printNotice()`（走 transcript 模型 + 渲染调度器）为证据，不是真 provider 流；真机流式与 PTY 手感留给第一个挂载面板的用户命令（631/632）补。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| base `d80ca3c6` + 本切片 6 文件（提交前 dirty） | win32 / Node 24.16 / 共享 node_modules junction 检出 | `npm run typecheck:all` | 0 | 全链通过；electron gate 报「no new type errors（206 known across 102 key(s)）」，9 个 baseline key 缩小但故意不 `--write` |
| 同上 | 同上 | `npx vitest run packages/cli` | 0 | 122 files / 1445 tests 全绿；开工基线即全绿，无既有失败可比较 |
| 同上 | 同上 | `npx vitest run packages/cli/src/tui` | 0 | 95 files / 1181 tests，含新 `tui-rich-panel.test.ts` 18 例与 `tui-window` 14 例回归 |
| 同上 | 同上 | `npm run architecture:check` | 0 | 「OK — no new boundary violations」，tolerated 2872 / baseline 2530；「3 baseline fingerprint(s) no longer triggered」按 2026-10-25 约定不重录 |
| 同上 | 同上 | `npm run bundle:verify`（放在最后） | 0 | FRESH 0/988；`build:packages` 会把 `packages/capabilities/.../inline-content.ts` 改成 CRLF 使工作树虚脏，先 `git checkout --` 再验 |

## 接续 / 结果

已实现并通过上述门禁；真机 PTY 验收未做——630a 只是原语，还没有面向用户的命令把面板挂上去，第一个真实挂载点是 631/632。
交付：分支 `codex/630a-tui-rich-panel-modal`，两个 commit（原语 + 计划台账），经 PR 集成。下一条动作：等本 PR 的 review/CI 与用户集成授权，再按 632 → 631 顺序开工。
