# Worktree 开发与隔离

> AGENTS.md 里只有契约，细节在这里。两条不同的 worktree 不要混为一谈。

## 两种 worktree

| | 开发用 worktree | 运行时隔离 worktree |
| --- | --- | --- |
| 谁创建 | 人 / Claude Code，用 `git worktree add` | 产品内建：子代理 `isolation: "worktree"` |
| 位置 | 仓库内 `.claude/worktrees/<name>` | duya data root 下 `worktrees/<repo>-<hash>/<slug>-<suffix>` |
| 依赖 | 靠 `scripts/junction-worktree.mjs` 建 junction overlay | 无（子代理只跑文件/命令工具） |
| 生命周期 | 人写代码 → PR → 合并 → 拆卸 | 子代理跑完 → 父代理按分支合并 |
| 实现 | `scripts/remove-worktree.sh` | `packages/host/src/worker-subagents/worktree.ts` |

**不要把开发用流程套到运行时 worktree 上，反之亦然。** 运行时 worktree 在仓库外，
没有 junction，因此没有「递归删除穿过 junction」的风险；但它同样受
[fail-closed 原则](#安全拆卸fail-closed)约束：脏的、locked 的、未合并的都不自动删。

## Worktree Development Contract

```
- Read the active execution plan and scoped AGENTS.md before editing.
- Parallel writing agents MUST use separate managed worktrees.
- Never modify the shared checkout from an isolated session.
- The Harness owns worktree creation, environment setup, locking,
  recovery, integration and deletion.
- Do not install dependencies through shared node_modules junctions.
- Record task ID, base commit, branch and verification evidence.
- Run targeted tests, typecheck and applicable architecture gates.
- Do not claim completion based only on a model-generated verdict.
- Changes must pass review and required CI gates before integration.
- Never force-remove a dirty or active worktree automatically.
- Preserve unmerged work and task state before cleanup.
```

契约是给模型看的短清单；下面的流程是给人和工具看的可执行步骤。两者冲突时以契约为准。

## 开发用 worktree 全流程

### 1. 创建

```bash
git worktree add .claude/worktrees/<name> -b <type>/<slug> origin/master
```

- 基于 `origin/master`，不是本地 `master`（本地 master 常常带着未推送的提交）。
- 分支名带类型前缀（`feat/`、`fix/`、`refactor/`），PR 标题沿用它。
- 一个 worktree 一个分支一个任务。不要在同一个 worktree 里混两个任务。

### 2. 依赖环境（必做，先于任何 tsc/vitest）

```bash
node scripts/junction-worktree.mjs .claude/worktrees/<name>
```

脚本幂等，且**不会**在主检出里创建任何链接。它做两件事，第二件才是关键：

a. **第三方依赖来自主检出** —— `<worktree>/node_modules` 以及每个 workspace 包自己的
   `node_modules`（`agent`、`conductor`、`gateway`、`plugin-core`、`voice`、`cli`、
   `computer-use`）。少建这些 junction 就会出现假的 TS2307。

b. **workspace 包必须解析到 worktree 自己的副本** —— 主检出的
   `node_modules/@duya/*` 是指回主检出 `packages/*` 的 junction，只挂一个
   `node_modules` 会让 `@duya/agent-runtime` 解析到**主检出**的 `dist/*.d.ts`，
   也就是上一次主检出所在分支编译出来的声明。于是所有 worktree 都对着同一份声明
   做类型检查：只有一个分支能自洽，其余报出自己源码里根本不存在的符号
   （如 `TS2741: Property 'modeExit' is missing … but required in type
   'RunEnginePorts'`），那个「通过」的也只是碰巧。脚本的解法是在
   `packages/node_modules/@duya/*` 和 `apps/node_modules/@duya/*` 建**真实目录**
   （overlay），Node 和 TS 会先查它们，第三方依赖再落到共享链接。约 14 个
   junction，几 KB。

**绝不要在 worktree 里 `npm install` 来「修」解析问题**：写入
`<worktree>/node_modules/@duya/*` 会**穿过** junction 改写**主检出**的链接，
一次性弄坏所有其它 worktree。

### 3. 构建依赖

```bash
npm run build:core
```

依赖包的 `types` 指向 `dist/`，没构建就是 TS2307，看起来像接线故障。

### 4. 原地验证

```bash
npx vitest run <相关文件>      # 针对性测试
npm run typecheck:all          # 提交前必过
npm run architecture:check     # 架构边界
```

已知坑：`typecheck:cli` 在默认堆下 OOM 崩 tsc，重试：

```bash
NODE_OPTIONS=--max-old-space-size=6144 npx tsc -p packages/cli --noEmit
```

### 5. 提交

Conventional Commits，英文，一条 commit 一个逻辑变更，调试残留先清掉。
在自己分支上提交不需要额外确认。

### 6. 推送

```bash
git push -u origin <branch>
```

### 7. PR

```bash
gh pr create --base master --head <branch>
```

标题沿用 commit 标题格式；正文写 what / why / 怎么验证的，并附 Claude Code footer。

### 8. 合并

```bash
gh pr merge <n> --merge
```

用 merge commit，保留显式的历史节点。**不 squash，不 fast-forward-only。**

### 9. 同步回 master，清理

合并落地后：

```bash
git fetch origin master && git log --oneline -3 origin/master
git pull --rebase origin master   # 本地 master 常有未推送的提交
scripts/remove-worktree.sh <name> --delete-branch
```

### 中途同步 base

分支活得比 master 久是常态。同步前先确认 master 没有动过你的文件：

```bash
git fetch origin master
git rebase origin/master      # 或 git merge origin/master，看团队习惯
```

- 冲突就地解，不要用 `git checkout --theirs/--ours` 蒙混。
- rebase 过的分支要 `git push --force-with-lease`，不要用 `--force`。
- PR 上出现冲突提示时，先 rebase 再推，别让 CI 一直红。

### 并行 worktree 的冲突

多个 worktree 改到同一个文件时，冲突不在合并期才出现——两个分支各自都能干净地合进 master，
但合第二个时第一个已经改了同一处。预防手段：

- 开工前用 `git grep -l <关键词>` 看是否有人在动同一片代码。
- 任务切分按**文件归属**切，不按功能切。
- 合并顺序由改动范围决定，不由 PR 创建顺序决定；先合小的。

### 巡检

```bash
git worktree list              # 所有 worktree 和它们的分支
git worktree prune              # 清掉已被手工删掉的 worktree 残留元数据
```

长期不用的 worktree 用 `scripts/remove-worktree.sh <name>` 拆掉，别手动删目录。

## 安全拆卸（fail-closed）

```bash
scripts/remove-worktree.sh <name-or-path> [--delete-branch] [--force] [--dry-run]
```

脚本是 **fail-closed** 的：所有前置检查在**任何改动之前**完成，任何一项不满足就中止，
一个字节都不动。它**不会**：

- 删除不是本仓库已注册 linked worktree 的目录（手滑传错路径曾经会一路走到删除）
- 丢弃未提交的改动（脏 worktree 直接被拒；`--force` 会先把改动存成快照）
- 删除 git 标记为 locked 的 worktree（有活动会话占着）
- 跟随 junction/reparse point（先逐个 unlink，再**重新扫描**，有残留就中止）

检查项：

1. 目标存在、是目录、不是主检出、不是当前工作目录
2. 目标是 `git worktree list` 里**已注册**的 linked worktree（且有 `.git` 文件）
3. git 没有把它标记为 `locked`
4. 工作树干净（否则需要 `--force`，快照写到 `.claude/worktree-snapshots/<name>-<ts>/`）
5. 树内没有残留 reparse point（unlink 失败即中止）

**没有 `rm -rf` 回退。** 删树的只有 `git worktree remove`，而它拒绝的正是我们要拒绝的
状态（脏 / locked / 含 submodule）。旧版本脚本在 git 删除失败后会退化成
`chmod -R u+w` + `rm -rf "$TARGET"`，那是审计里点名的高危路径，已删除。

### 禁止手工删除 worktree

Windows 上 GNU `rm` 不把 NTFS junction 当 symlink，它会**穿过** junction 递归删除，
把主检出里 junction 指向的 `packages/*` 源码一起删掉。已经发生过两次：
2026-08-25 删掉 **3,471** 个跟踪文件，2026-10-03 又删掉 **3,492** 个。

`rm -- <dir>` 和「可恢复的回收站启动器」同样不安全——它们在这里也会跟随 reparse point。
`Remove-Item -Recurse`、`cmd /c rd /s /q`、`rm -rf` 一律禁止用在 worktree 路径上。

单个 junction 要单独摘掉时用 `cmd /c rmdir <junction>`（**不带** `/s`），只摘链接不碰目标。

### 万一还是删错了

删除表现为**未暂存的工作树删除**，所以在主检出里：

```bash
git status --short          # 确认是纯 " D" 模式（没有已暂存的改动）
git restore .               # 从 HEAD 恢复全部跟踪文件
```

先看 `git status --short` 再 restore，避免把真实工作一起冲掉。

## 运行时隔离 worktree（产品内建）

子代理可以带 `isolation: "worktree"` 跑在独立工作树上：

- Host 在 `packages/host/src/worker-subagents/worktree.ts` 里创建 worktree，
  目录在 duya data root 下（**不在仓库里**，所以用户的 `.gitignore`、编辑器和
  `git status` 都看不到它，`git worktree list` 是唯一能发现它的地方）。
- 前提：当前目录是 git 仓库、至少有一个 commit、**工作树干净**。否则以
  `WorktreeError` 拒绝，并给出可执行的补救句子。
- 子代理会收到一段 spawn notice，告知自己的 cwd、分支名，以及「你的改动不会出现在
  父工作区，除非被合并或 cherry-pick」。
- 父代理在回执里拿到分支名，负责合并/采纳。
- `isolation` 不能和 `resume_from` 同时使用（worktree 只能给新子代理用）。

### 当前缺口

- **没有自动清理**：子代理结束后 worktree 和分支都留在磁盘上，没有回收路径。
- **没有锁**：无法表达「这个 worktree 正被某个会话占用」。
- **没有 journal**：path / branch / base commit / 验证证据没有统一落盘，
  因此系统重启后不知道哪些任务已验证、哪些有未提交成果、哪些需要恢复。

这些缺口由 [plan 496](../../docs/exec-plans/active/496-worktree-framework-implementation.md)
承接。在补齐之前：**不要在脚本里对运行时 worktree 做递归删除**。

## 相关

- 工程闭环契约（Goal → Task → Run → Worktree → PR → Verification → Integration）：
  [engineering-loop.md](./engineering-loop.md)
- 脚手架：`scripts/junction-worktree.mjs`（建环境）、`scripts/remove-worktree.sh`（拆）
