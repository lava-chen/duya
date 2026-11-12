# CLI TUI 输入光标、背景与文本选择

状态：active。负责人：本会话。更新：2026-11-12。
分支：`codex/tui-cursor-selection`。worktree：`/home/lavachen/.codex/worktrees/tui-cursor-selection/duya`。
base：`2af62ce3c81b059e3e82c5b41e9f5299bdfd61fc`。独占路径：`packages/cli/src/tui/**` 与本文档。

## 目标与边界

- 输入光标稳定显示在当前输入位置，交互表现按用户对 Pi 的预期确认。
- 移除 composer 的实色填充，保留输入文本与边框提示。
- 全屏转录支持普通鼠标拖选，选区反白并通过 OSC 52 复制到终端剪贴板。
- 本轮仅改 CLI TUI，不改 Host、协议或 Desktop UI。

关联：[Pi / Duya TUI 对照](../../references/pi-tui-workbench.md)、[TUI 全屏框架](2026-11-11-tui-fullscreen-framework.md)。

## 验收

- 在全屏与 inline 两种模式中检查光标、输入背景及选中反馈。
- 覆盖窄终端、CJK 文本、滚动视口与输入焦点切换。
- 运行受影响的 CLI TUI 检查及仓库要求的类型/架构门禁；记录 SHA、dirty 范围、环境、命令和结果。
- 光标闪烁策略、文本选择按键/鼠标语义以用户回复为准。

## 进度

- [x] 阅读 CLI TUI 约束、当前全屏计划与 Pi 全屏选择实现。
- [x] 按用户确认的闪烁光标与普通拖选语义实现三项改进。
- [x] 验证相关测试、类型检查、架构门禁和真实 PTY 启停。
- [ ] 提交并创建 draft PR；未经授权不合并。

## 发现与决策

- 全屏 composer 以前填充主题底色，inline 则将每行包在底色标签中；现在两种模式均透出终端背景。
- 全屏鼠标报告接管按钮事件；普通左键拖动现在在可见转录区维护选区、反色绘制并通过 OSC 52 复制，交互控件仍优先响应点击。
- `placeCursor()` 以前在异步 diff 写出前移动硬件光标，随后被行重绘移走；现在 surface 在每帧 diff 后定位并显示光标，保留终端默认闪烁样式。
- `workspace_get_context` 工具当前不可用，按版本化计划和 Git 状态对账；共享检出干净，HEAD 与 `origin/master` 一致。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `2af62ce3`，只读 | Linux x64 / Node 26.13.0 | `git status --short --branch`; 检查 TUI 文档与 Pi 源码 | exit 0；共享检出干净 | 本会话对账 |
| `2af62ce3` + TUI 修改 | Linux x64 / Node 26.13.0 | 7 个 TUI 测试文件；`npm run typecheck:all`; `npm run architecture:check`; `python3 scripts/smoke-tui-pty.py functional ...` | 111 tests passed；typecheck exit 0；architecture exit 0（无新增违规）；PTY 7 项检查全通过 | worktree `codex/tui-cursor-selection`；`git diff --check` clean |

## 接续 / 结果

实现与验证已完成。下一步：提交独立逻辑变更并创建 draft PR；保留 worktree，等待 review 与用户授权集成。
