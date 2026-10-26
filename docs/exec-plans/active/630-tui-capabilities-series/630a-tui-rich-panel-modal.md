# 630a TUI 富面板模态原语

状态：active · 负责人：未认领 · 更新：2026-10-26
分支：未建 · worktree：未建 · base：master · owner：无

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

- 新增演示面板（挂在一条临时 debug 命令或测试 harness 上，两 tab + 搜索 + 详情子菜单），Playwright/终端 harness 跑通：Tab/Shift+Tab 切页、`↓` 进内容、`/` 进搜索、Esc 搜索→内容→header→退出逐级后退、退出后主输入恢复接管。
- 模态期间 transcript 流式更新不抢占焦点、不破坏行分配。
- `npm run typecheck:all`、`npm run architecture:check`、`npm test -- packages/cli` 相对基线零新增失败。

## 进度

- [ ] 模态通道：slash outcome → 面板挂载/卸载协议，输入让位与恢复。
- [ ] `Tabs` 原语：受控选中 + header/content 焦点分离 + 搜索让位。
- [ ] 分页列表 + 过滤搜索 + 详情菜单 + footer 按键提示行原语。
- [ ] 测试 harness 与用例；临时演示面板验收后移除或转 fixture。

## 发现与决策

- 面板宿主复用现有 `showListPanel`/`openSettings` 的 blessed 链实现路径，不引入 React/Ink；duya TUI 的渲染分层（plan 615 StyledSpan）足够表达行样式。
- 采用「模态内只标脏、退出不热生效」的变更模型设计约定，供 631/632 沿用；本切片只需在协议上留出 `pendingChanges` 出口。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| 待执行 | win32 / Node 24 | typecheck:all, architecture:check, cli tests | — | 基线在开工检出重记 |

## 接续 / 结果

下一步：建实现 worktree（owner 登记到本文件），从模态通道开始；完成判据是验收第一条的终端 harness 全绿。
