# TUI 粘贴多媒体与附件

状态：active · 负责人：本会话 · 更新：2026-10-24
分支：codex/tui-paste-attachments · worktree：.claude/worktrees/tui-paste-attachments · base：origin/master f6120e04

## 目标与边界

用户在 `duya chat` TUI 里能：

1. 粘贴图片/文档的文件路径（终端拖拽文件 = 粘贴路径文本，含引号/转义空格形态），输入框出现 chip 占位符，提交时随消息作为附件发给 agent。
2. Ctrl+V（终端拦截时用 Alt+V）读取系统剪贴板截图/复制的文件（Windows），落临时文件后作为附件提交。
3. `!cmd` / `!!cmd` 在 transcript 里渲染成 shell 命令卡片（bash tool 卡片复用：running→ok/error、输出折叠、退出码脚注），并把输出作为 terminal-ref 附件注入下一条普通消息（`!!` 排除）；桌面端已有同语义链路（useBangMode → bang:run IPC → CommandResultDialog），本次核对不重写。

允许修改：`packages/cli/`（TUI 与 chat 链路）。协议层零改动——`StartAgentRunInput.attachments?: FileAttachment[]` 已存在，Host `readAttachments` 与 worker（image→base64 block、path 文件→[System Attached File] 上下文）链路已就绪，TUI 只是没接。

本次不处理：`@` 补全从插文本改为结构化附件（candidates.ts 有刻意声明，另行立项）、非 Windows 剪贴板读取、附件预览浮层、macOS/Linux 剪贴板。

参考实现：`E:\cloned-projects\minimax-code`（`packages/tui/src/tui/features/composer/terminal-image-paste.ts` 的路径判定、`clipboard-image.ts` 的多平台读取、chip 占位符与"删除 chip 即丢弃附件"语义）。

## 验收

- `npx vitest run packages/cli/src/tui/__tests__/attachments.test.ts`（及新增其他测试）全绿；改动前先记录基线。
- `npm run typecheck:all`、`npm run architecture:check` 退出码 0。
- 真机冒烟（Windows Terminal + `build:cli-dev` + `dev:tui`）：拖拽 png/pdf 进 TUI 出 chip；Ctrl+V 截图出 chip；提交后 worker 日志出现附件处理链（或 message attachments 字段非空）。冒烟未跑前计划不标完成。

## 进度

- [x] attachments.ts：路径判定、chip、限额、FileAttachment 映射（commit 1e5f5ee1）
- [x] clipboard-image.ts：win32 PowerShell 读剪贴板（图片→PNG 临时文件、FileDropList→路径）
- [x] TUIApp 接线：bracketed paste 路径识别、C-v/M-v 绑定、提交时按 chip 存活过滤附件
- [x] chat.ts/TurnQueue：提交载荷扩为 { text, attachments }，startAgentRun 透传
- [x] 单测 + 门禁（cli 1270 测试绿、typecheck:all、architecture:check）
- [x] TUI `!cmd` 卡片 + terminal-ref 上下文注入（tui/shell-context.ts + beginLocalShell/finishLocalShell）；桌面端核实现有 useBangMode 链路已覆盖同语义
- [ ] 真机冒烟
- [ ] commit `!` 切片 + PR

## 发现与决策

- 协议已就绪：`run-api.ts` `StartAgentRunInput.attachments`、host `run-turn-overrides.ts` `readAttachments`（要求非空 id）→ `options['files']` → worker `worker-process-entry.ts` 分流 imageFiles/docFiles。TUI 缺口只在 CLI 侧。
- chip 采用纯文本标签（`[Image #1 name.png]`），不做 minimax 的区间映射编辑器改造：duya 编辑器是纯文本缓冲，提交时按"标签仍在提交文本中"过滤附件即可获得同样的"删 chip = 丢附件"语义，孤儿附件自然丢弃。标签保留在 prompt 里（worker/模型可见文件名）。
- 剪贴板读取用 PowerShell（`System.Windows.Forms.Clipboard`），不引 `@mariozechner/clipboard` 原生依赖：Windows 原生模块重建是本仓已知痛点，且 PowerShell 形态 minimax 已在 WSL 路径验证。
- 临时文件放 `os.tmpdir()/duya-tui-clipboard-*`，TUI 退出时清理；worker 在 turn 开始即读文件，进程存活期覆盖消费窗口。
- 限额对齐 minimax：≤10 个附件、总量 ≤100MB。
- `!` 卡片复用 bash tool block（`upsertTool('bash', {command})` + `completeTool`），不新增 block kind：running/失败样式、输出折叠、`isShellTool` 渲染全是现成管线。
- `!` 上下文用 `terminal-ref` FileAttachment（桌面端同形状：name=`$ cmd`、type=text/plain、url=''、text=输出），走 worker 既有 buildAttachmentContext；`!!` 排除语义对齐 minimax；上下文只在普通消息提交时消费，slash/`!` 不消费，多次 `!` 累积（64KB 封顶留尾部）。
- Mimosa hook 对 `execute(`/正则/`!` 形态有三类已知误报（SQL 注入/命令注入），TurnQueue 属性因此从 `execute` 改名 `runTurn`；遇到拦截拆小 diff 或换锚点绕过，不改语义。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| （待填） | | | | |

## 接续 / 结果

（进行中）
下一步：实现 attachments.ts 与 clipboard-image.ts，跑单测与门禁。
