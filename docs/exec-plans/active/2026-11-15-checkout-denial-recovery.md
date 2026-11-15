# 非 owner 检出中的 agent 拒绝恢复

状态：active · owner：本会话 · 更新：2026-11-15
分支：`codex/checkout-readonly-recovery` · worktree：`/home/lavachen/.codex/worktrees/checkout-readonly-recovery/duya` · base：`53c9537ba` · owner：本会话

## 目标与边界

当会话工作目录落在另一个 Session 拥有的 managed checkout 时，Bash/PowerShell 会被 owner gate 拒绝，即使命令看起来只读。拒绝结果应直接告诉 agent 用 Read/Grep/Glob 检查，并说明恢复 shell/写入的安全路径；agent 不应因工具拒绝而停在原地或反复调用 shell。

保留 Plan 621 的权限契约：shell 命令不可安全分类，非 owner 仍不能执行 shell；只读文件工具继续可用。Esc / Ctrl+C 属于显式中断，不改变取消语义。本任务不改 run 终态协议或自动恢复被用户中断的回合。

关联：[621 Coding Workspace Lifecycle Harness](621-coding-workspace-lifecycle-harness.md)，特别是 shell 与 Read/Grep/Glob 的 owner 边界。

允许修改：`packages/host/src/workspace/tool-write-gate.ts`、`packages/host/src/worker-prompts/assets/modules/system-coding.hbs`、本计划与计划入口。

## 验收

- `not_owner` 拒绝的错误明确说明 shell 整体受限（包含只读 shell），给出 Read/Grep/Glob 检查方案，并说明恢复 owner 对话或进入当前会话 worktree 的路径。
- system coding 指令要求 agent 拒绝后停止重试 shell、使用只读工具，且不把权限审批描述成 owner 转移。
- `unowned`、`outside_checkout`、`unreadable` 继续给出与各自原因相符的提示，owner 检查逻辑不变。
- 验证包含 `typecheck:all` 与 `architecture:check`；不改变显式 Esc / Ctrl+C 取消行为。

## 进度

- [x] 核对最近两条会话日志及 Plan 621 的 owner gate 约束。
- [x] 更新拒绝诊断和 system coding 恢复指引。
- [x] 执行类型与架构门禁并重建 Host worker bundle。
- [ ] 提交、确认 bundle freshness，并创建 draft PR。

## 发现与决策

- 已有安全设计刻意拒绝非 owner 会话的所有 Bash/PowerShell 命令；不根据 shell 文本判断是否只读，因为复合命令和解释器可能写入。
- 最近两条 CreditDaddy 会话均有 `not_owner` Bash 拒绝；第二条随后收到 TUI `chat:interrupt`，对应 busy 状态下的显式中断操作。第一条 DB 与 Host 日志终态不一致，根因未证实，本次不做猜测性终态改动。
- 最近的 Bash 错误已回到模型，但没有指向安全替代工具的具体建议；修复落点为错误文案和 system coding 提示，不放宽 owner gate。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| dirty worktree / base `53c9537ba` | Linux / 当前 Node | `npm run typecheck:all` | 0 | 所有包构建与类型检查通过；脚本内部还运行了 4 个 recorder eval 检查，均通过 |
| dirty worktree / base `53c9537ba` | Linux / 当前 Node | `npm run architecture:check` | 0 | 没有新增架构违规；已有 baseline 继续容忍 |
| dirty worktree / base `53c9537ba` | Linux / 当前 Node | `npm run build:packages -- --target @duya/host` | 0 | 15 个依赖包及 Host 构建通过；worker bundle 已更新 |
| dirty worktree / base `53c9537ba` | Linux / 当前 Node | `npm run bundle:verify`（提交前） | 1（预期） | 检查到本次源文件仍是未提交修改；提交源与 bundle 后再运行 freshness 检查 |
| dirty worktree / base `53c9537ba` | Linux / 当前 Node | `git diff --check` | 0 | 无空白错误；只保留提示词与 worker 入口的 bundle 变更。为避免共享依赖 junction 造成 metafile 路径噪声，保留既有 metafile 输入路径；本次未改依赖闭包 |

## 接续 / 结果

实现和验证已完成，提交、post-commit bundle freshness 与 PR 未完成。未提交路径：本计划、计划入口、两个 Host 源文件和 worker bundle（system coding 资产与 worker-entry）。外部副作用：分配了独立 managed worktree 并创建了本地 workspace overlay。未合并、未发布。

回收：PR 集成前保留 managed worktree。
下一步：提交本次文件，运行 `npm run bundle:verify` 确认 freshness，再推送分支并创建 draft PR。
