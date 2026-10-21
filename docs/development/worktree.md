# Worktree 与 PR 全流程

每个 agent 先绑定独立 worktree 再开工；主 / 子 agent、单 agent、文档和小修复都执行同一流程。优先由 Harness 分配 managed worktree；仅当创建工具不可用时，才按本指南使用独立 linked worktree。
共享检出只用于只读定位与对账，不能在其中编辑计划、构建、安装或提交。所有改动经 PR 集成。

## 1. 分配与登记

优先复用本任务已绑定且无人占用的 managed worktree；否则通过当前 harness 的创建工具分配。
在该检出的同一计划中记录 task / owner、worktree、分支、base SHA、独占路径及验收；每个 agent 各用一个检出。
没有可用管理工具时，允许手工创建独立 linked worktree；这不是共享检出写入的例外（以下为 Git Bash）：

```bash
git status --short
git worktree list --porcelain
git fetch origin master
git worktree add .claude/worktrees/<name> -b codex/<slug> origin/master
```

新检出不包含共享目录的未提交成果；依赖旧成果时先核对归属，复制本任务切片并校验，不整体 stash 或搬走其他 agent 的工作。

## 2. 配置环境

依赖版本兼容时，从独立 worktree 根运行；可用 `--primary <主检出绝对路径>` 显式指定来源：

```bash
node scripts/junction-worktree.mjs . --dry-run
node scripts/junction-worktree.mjs .
```

只有包管理器、锁文件和平台兼容时才共享第三方 node_modules；脚本应建立 worktree 自己的 workspace overlay。共享 junction 只用于复用依赖，禁止穿过它安装或改写依赖。
需要不同依赖版本时使用真正独立的依赖目录。按[构建](build.md)准备本检出的产物，TUI 先 `build:cli-dev` 再 `dev:tui`。

## 3. 修改、验证与 PR

只在分配检出内修改独占路径；公共文件冲突先协调。同步 base 前保存本任务成果，不对共享 dirty master rebase。
按根规则和[测试指南](testing.md)执行门禁，记录 SHA、环境、命令与结果，再检查暂存 diff 并提交本任务切片。构建或测试可能改写已跟踪的 bundle / 生成文件；命令结束后检查 Git 状态与对应 freshness 校验，只保留本次源代码要求更新的产物。清理时只能撤销能证明由本次命令产生且不属于本任务成果的改动。

所有变更创建 PR，包括文档和小修复。任务分支发布只用于该 PR；禁止直接 push master / main 或以其他远端更新绕过 PR。
正文写问题、行为变化、验证范围和未通过检查，记录 PR URL。最新 head 上必需 review 与必需 CI 未通过时保留为 draft 且不得集成；非必需检查失败要记录并交获授权集成者评估，不自动阻断，也不得绕过仓库必需状态。未评估的失败或风险仍未解决时保留 draft。
PR 创建不等于允许合并，也不等于可以删除 worktree。

## 4. 授权集成与重验

由获授权的集成者核对依赖顺序、最新 PR head、必需 review 与必需 CI，再用 merge commit 集成；未经集成授权的 agent 停在 PR 阶段。不得绕过仓库要求的检查。
合并后确认 PR 的目标 SHA、同步结果与受影响验证。验证失败继续修复，保留分支和检出，不用回收掩盖未完成任务。

## 5. 安全回收与核对

回收条件：PR 已集成并通过合并后验证，或用户已取消且明确安排成果保存；owner 会话退出、无锁、dirty 与 ignored 文件已核对。
先证明 commit 能从集成分支或保留引用到达。未合并、验证失败或归属不明的检出保持原位并写接续记录。

managed worktree 使用创建它的管理工具归档；ignored 文件不在 Git 快照保证内，必需材料先单独保存。
手工检出在目标目录外核对绝对路径与注册身份后执行（Git Bash）：

```bash
git worktree list --porcelain
git -C <worktree-path> status --short
bash scripts/remove-worktree.sh <worktree-path> --dry-run
bash scripts/remove-worktree.sh <worktree-path> --delete-branch
git worktree list --porcelain
```

确认工具报告成功、清单不再包含目标、分支和成果保留状态符合预期，再在任务记录中写回收结果。
`--dry-run` 只检查身份、锁与 dirty 状态；实际执行可能已经摘下部分链接才失败，失败后先对账，不能追加删除命令。
脚本不会替你证明 PR 已合并、owner 已退出或 ignored 文件安全；保留未合并分支也不能替代这些前置检查。
禁止自动用 `--force`、解锁或递归删除绕过失败；Windows junction 可指回主检出。

## 中断、误删与产品边界

先停止写入并保留现存目录、index、未跟踪文件与快照，再核对 Git / PR / 已发生副作用；禁止整树 restore / reset 试探恢复。
只恢复确认误删的路径，重跑受影响验证并记录无法证明恢复的内容。
产品子代理隔离入口在 `packages/host/src/worker-subagents/worktree.ts`；开发规范不证明产品已实现 lease、journal 或自动回收，剩余范围见 [496](../exec-plans/active/496-worktree-framework-implementation.md)。
