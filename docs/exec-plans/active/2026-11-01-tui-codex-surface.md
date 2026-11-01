# TUI 学 codex：输入框纯色背景与已发命令的 UI

状态：active · 负责人：mavis 会话 · 更新：2026-11-01
分支：codex/tui-codex-surface · worktree：E:\Projects\duya\.claude\worktrees\tui-codex-surface · base：4f0738ba · owner：mavis

## 目标与边界

用户可见的两处变化：

1. 输入框（composer）是一块纯色背景，规则线也画在背景上——codex 用
   `user_message_style()` 填满整个 composer 矩形（`chat_composer.rs`）。
2. 已发送的命令（用户消息）画成一条横贯面板的背景带，前面是暗色 `› `——
   codex 用 `history_prompt_style()`（`history_cell/messages.rs` `UserHistoryCell`）。

允许改：`packages/cli/src/tui/`（颜色词表、标签解析、span、主题、transcript、
own renderer、TUIApp）与其测试。本次不做：effort 边框换色、popup 主题、其它
codex 对齐项。

关联：只读对照 `E:\cloned-projects\codex`（不引入依赖、不 vendor）。

## 验收

- `npm run typecheck:all`、`npm run architecture:check` 通过。
- `node node_modules/vitest/vitest.mjs run packages/cli/src/tui`：1334 例全绿。
- 新增 `packages/cli/src/tui/__tests__/tui-codex-surface.test.ts` 覆盖：背景槽
  的字节、composer 的全屏填充、inline 行内背景、已发命令的带宽与前缀。
- 真机：`npm run build:cli-dev && npm run dev:tui`（全屏为默认；inline 用
  `DUYA_TUI_INLINE=1`）。

## 进度

- [x] 定位 codex 对照实现（`style.rs` / `chat_composer.rs` / `messages.rs`）与 duya 渲染链路
- [x] 颜色词表加背景槽：`colorFromTagBody` / `tagBodyFor` 接受 slot
- [x] 三个解析器认背景：`core/tags.ts`、`screen/own/markup.ts`、`markdown/inline.ts`
- [x] 主题加 `composerBg` / `promptBg` 两枚表面色（dark 236/238，light 255/254）
- [x] composer 纯色背景：全屏走 region `background` 填充，inline 走行内背景带
- [x] 已发命令：整行背景带 + 暗色 `› ` + 保留用户色文本
- [x] 补测试并同步既有断言
- [ ] 门禁与 PR

## 发现与决策

- **duya 的标签词表只有 `-fg`**：`colorFromTagBody` 只认前景，`SpanStyle.bg` 是死
  字段。ANSI 层（`terminal/ansi.ts`）本来就会把 span 的 bg 转成 `48;5;n`，缺的
  是「标签/主题能表达 bg」。所以改动从颜色词表起，而不是绕开标签层直接用 span。
- **blessed 支持 `-bg`**：`element.js` `_parseTags` 把 `-bg` 路由到独立背景栈，
  `program._attr('236 bg')` → `48;5;236`。own renderer 走自己的解析器，因此
  四个解析器要同步。
- **没有终端背景探测**：codex 的填充是按终端真实背景 blend 出来的（dark 白
  12%/16%，light 黑 4%/2%）。duya 在 plan 611 W1.1 已否决 OSC 11 探测，只有
  `COLORFGBG` 启发式（只说 dark/light）。因此改用固定 256 灰阶：dark
  `236`(#303030)/`238`(#3c3c3c)，light `255`(#eeeeee)/`254`(#e4e4e4)。保留的
  不变量是「已发命令比输入框更显眼」——dark 更亮、light 更暗。
- **行尾空格会被裁掉**：`frame.ts` 的 `renderRow` 只保留最后一个非空格 cell，
  背景带会被切掉右端。改为：带背景的空格 cell 计入行内容。
- **选中态箭头会撑破整行**：历史选择的 `❯ ` 前缀是 2 列，prepend 到满宽行会
  多出一行并错位高度记账。已发命令的带宽在「该块被选中」时扣掉这 2 列
  （`SELECTION_CARET_COLUMNS`）。
- **inline 没有 region 可填**：inline 模型里 composer 就是几行文本，背景必须
  随行走——每行补空格到终端宽再包一层背景标签。
- **保留 duya 的用户色**：codex 的已发命令文本用终端默认前景；duya 一直用
  `user` 绿表示「这是你说的」，这次只加背景带与前缀，不改文本色。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| worktree dirty（未提交） | Windows / Node 22 | `tsc -p packages/cli/tsconfig.json --noEmit` | 0 | 类型通过 |
| worktree dirty | Windows / Node 22 | `npm run typecheck:all` | 0 | 全仓类型门禁通过（含 build:packages 与各包 typecheck） |
| worktree dirty | Windows / Node 22 | `node scripts/architecture/architecture-check.mjs` | 0 | OK — no new boundary violations；与 master 基线输出逐行一致（那 5 条未触发指纹是既有漂移） |
| worktree dirty | Windows / Node 22 | `vitest run packages/cli/src/tui` | 1334 passed | TUI 全绿 |
| worktree dirty | Windows / Node 22 | `vitest run packages/cli` | 1609 passed / 135 files | CLI 包全绿 |
| worktree dirty | Windows / Node 22 | 渲染探针（own surface，30 列） | 规则行 `90;48;5;236`、正文行整行 `48;5;236` | 背景带覆盖整行 |

## 接续 / 结果

已实现：背景槽（词表 + 三个解析器 + span 序列化）、主题表面色、composer 纯色
背景（全屏 + inline）、已发命令背景带。

已验证：`npm run typecheck:all` exit 0；架构门禁 OK 且与 master 基线逐行一致；
`vitest run packages/cli` 135 files / 1609 例全绿；全量 `vitest run` 14577 例中
14546 passed，唯一失败是 `packages/ui` 的 `PanelMoreMenu.test.tsx` 30s 超时，
单独复跑 6 例全过（本文件自身需 46s，并行负载型 flake，与本次改动无关）。

PR：<https://github.com/lava-chen/duya/pull/567>（分支 `codex/tui-codex-surface`，
base `master`，未合并）。提交：`e14ee917` 功能，`8435eb9f` 测试基建别名。
未合并前保留分支与 worktree。

回收：owner 是本会话，未回收（等集成后走 `scripts/remove-worktree.sh`）。
下一步：等 PR #567 的 CI（architecture / test scope / typecheck / test）与
review；获授权后再合并并把本计划移入 archive、更新 plans README。
