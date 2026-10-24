# TUI 粘贴多媒体与附件

状态：active · 负责人：本会话 · 更新：2026-10-24
分支：codex/tui-paste-attachments · worktree：.claude/worktrees/tui-paste-attachments · base：origin/master f6120e04

## 目标与边界

用户在 `duya chat` TUI 里能：

1. 粘贴图片/文档的文件路径（终端拖拽文件 = 粘贴路径文本，含引号/转义空格形态），输入框出现 chip 占位符，提交时随消息作为附件发给 agent。
2. Ctrl+V（终端拦截时用 Alt+V）读取系统剪贴板截图/复制的文件（Windows），落临时文件后作为附件提交。

允许修改：`packages/cli/`（TUI 与 chat 链路）。协议层零改动——`StartAgentRunInput.attachments?: FileAttachment[]` 已存在，Host `readAttachments` 与 worker（image→base64 block、path 文件→[System Attached File] 上下文）链路已就绪，TUI 只是没接。

本次不处理：`@` 补全从插文本改为结构化附件（candidates.ts 有刻意声明，另行立项）、非 Windows 剪贴板读取、附件预览浮层、macOS/Linux 剪贴板。

参考实现：`E:\cloned-projects\minimax-code`（`packages/tui/src/tui/features/composer/terminal-image-paste.ts` 的路径判定、`clipboard-image.ts` 的多平台读取、chip 占位符与"删除 chip 即丢弃附件"语义）。

## 验收

- `npx vitest run packages/cli/src/tui/__tests__/attachments.test.ts`（及新增其他测试）全绿；改动前先记录基线。
- `npm run typecheck:all`、`npm run architecture:check` 退出码 0。
- 真机冒烟（Windows Terminal + `build:cli-dev` + `dev:tui`）：拖拽 png/pdf 进 TUI 出 chip；Ctrl+V 截图出 chip；提交后 worker 日志出现附件处理链（或 message attachments 字段非空）。冒烟未跑前计划不标完成。

## 进度

- [x] 调研 minimax-code 实现与 duya 协议/worker 现状
- [x] 分配 worktree 并配置依赖 junction
- [ ] attachments.ts：路径判定、chip、限额、FileAttachment 映射
- [ ] clipboard-image.ts：win32 PowerShell 读剪贴板（图片→PNG 临时文件、FileDropList→路径）
- [ ] TUIApp 接线：bracketed paste 路径识别、C-v/M-v 绑定、提交时按 chip 存活过滤附件
- [ ] chat.ts/TurnQueue：提交载荷扩为 { text, attachments }，startAgentRun 透传
- [ ] 单测 + 门禁
- [ ] 真机冒烟
- [ ] commit + PR

## 发现与决策

- 协议已就绪：`run-api.ts` `StartAgentRunInput.attachments`、host `run-turn-overrides.ts` `readAttachments`（要求非空 id）→ `options['files']` → worker `worker-process-entry.ts` 分流 imageFiles/docFiles。TUI 缺口只在 CLI 侧。
- chip 采用纯文本标签（`[Image #1 name.png]`），不做 minimax 的区间映射编辑器改造：duya 编辑器是纯文本缓冲，提交时按"标签仍在提交文本中"过滤附件即可获得同样的"删 chip = 丢附件"语义，孤儿附件自然丢弃。标签保留在 prompt 里（worker/模型可见文件名）。
- 剪贴板读取用 PowerShell（`System.Windows.Forms.Clipboard`），不引 `@mariozechner/clipboard` 原生依赖：Windows 原生模块重建是本仓已知痛点，且 PowerShell 形态 minimax 已在 WSL 路径验证。
- 临时文件放 `os.tmpdir()/duya-tui-clipboard-*`，TUI 退出时清理；worker 在 turn 开始即读文件，进程存活期覆盖消费窗口。
- 限额对齐 minimax：≤10 个附件、总量 ≤100MB。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| （待填） | | | | |

## 接续 / 结果

（进行中）
下一步：实现 attachments.ts 与 clipboard-image.ts，跑单测与门禁。
