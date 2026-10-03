# 518 — Code Review: Branches + Commit History (GitHub Desktop parity)

> **Author**: 2026-09-10 · **Status**: Planning · **Priority**: P2

## 1. Goal

把 [CodeReviewPanel.tsx](src/components/layout/panels/CodeReviewPanel.tsx) 从"只比 working tree"扩成 GitHub Desktop 那种"三栏式 + 全提交历史 + 分支对比"工作面：

- 左侧新增 **History** 面板（tab 切换 Branches / Commits），点 commit / branch 加载对应 diff。
- 顶部 toolbar 从"scope 单下拉"改成"scope + base ref"双下拉；scope 切到 `branch` / `commit` 时第二下拉列出可选 refs/SHAs。
- `base` 固定为工作区（HEAD 或当前分支）。compare 端可选：未提交 / 未暂存 / 已暂存 / 任意本地或远程分支 / 任意 commit SHA / 两个 commit 之间（diff 任一方向）。
- 远程分支显式列出（默认折叠，可展开）。

## 2. Out of scope

按 AGENTS.md § Code Review Workspace："read-only; never add stage, commit, push, reset." 本 plan **不改 working tree**、**不切换 checkout**、**不发 fetch / pull / push**。所有 mutating 操作继续禁止在 panel 里。

## 3. Current state (evidence)

### 3.1 Existing IPC (sufficient for 80% of the work)

| IPC | 用途 | 备注 |
|---|---|---|
| `git:status` | numstat HEAD→工作区 | 已有 |
| `git:review` | HEAD→工作区 文件 + baseRef | 已有 |
| `git:review-diff` | HEAD→工作区 单文件 patch | 已有 |
| `git:review-full-diff` | HEAD→工作区 全 patch | 已有 |
| `git:review-scoped` | uncommitted / unstaged / staged / commit 文件列表 + patch | 已有 — **commit 模式只接受 SHA**，不接受 ref 名 |
| `git:review-scoped-diff` | scoped 下单文件 patch | 已有 |
| `git:list-commits` | `git log --oneline -n50` → `{hash, subject}` | 已有 — **只有 hash + subject**，缺 author / date / parents / refs |
| `git:review-latest-turn` / `-turn-history` / `-turn-detail` | 本会话每轮 review 快照 | 与本 plan 无关，不动 |

### 3.2 Gaps

1. **无 `git:list-branches`**：UI 拿不到本地/远程分支列表。
2. **`git:list-commits` 只 `%H %s`**：UI 没法显示作者、相对时间、merge marker、branches 标签。
3. **无 `git:commit-detail`**：点单笔 commit 拿不到 numstat + 完整 patch + metadata。
4. **`COMMIT_HASH_RE = /^[0-9a-f]{7,40}$/i`** ([git-handlers.ts:423](electron/ipc/git-handlers.ts:423))：scope `commit` 模式拒绝分支名。
5. **Base 固定 `HEAD`**：scope `commit` 的 from 默认 `HEAD~1`，to 默认 `HEAD`（[git-handlers.ts:439-440](electron/ipc/git-handlers.ts:439)），无法"对比 master 与 origin/master"。
6. **UI 只有 scope selector**：toolbar 524-564 行展示了 latest-turn / uncommitted / unstaged / staged / commit 五个 mode，但没分支选择器。

## 4. Design

### 4.1 模型固化（向用户讲清 git/diff 概念）

**三棵树（已在 plan 中做内部沟通，本文件不展开）**：

```
HEAD (committed)
  ↓ git add
Index (staged)
  ↓ 编辑
Working Tree
```

**Ref 三种身份**：

- `refs/heads/<name>` —— 本地分支，会随 commit 移动
- `refs/remotes/<remote>/<name>` —— 远程跟踪分支，跟远端 fetch 走
- SHA 锚点 —— 40 位十六进制，不会变

**patch 由 diff 算出来**：commit 不存 diff，`git show <sha>` = `git diff <parent> <sha>` + commit message。

**方向可逆**：`git diff A..B` 与 `git diff B..A` 出**反向** patch（左右行位置互换）。

### 4.2 新增 / 扩展 IPC

| IPC | 输入 | 输出 |
|---|---|---|
| `git:list-branches` (new) | `cwd` | `{ locals: [{name, current: bool, head?: sha7}], remotes: [{remote, name, head?: sha7}] }` |
| `git:list-commits` (extended) | `cwd, count?, opts?: { author?: string, grep?: string, ref?: string }` | `{ commits: GitCommitInfo[] }` — 字段扩展见下 |
| `git:commit-detail` (new) | `cwd, sha` | `{ hash, subject, body, author, authorEmail, authorDate, committer, committerDate, commitDate, parents: sha[], refs: string[], files: GitReviewFile[], totals, patch, truncated, binary }` |
| `git:review-scoped` (widened) | 现有 | `commitFrom` / `commitTo` 改接受 ref 或 SHA（去掉 `COMMIT_HASH_RE` 强约束，改用 `validateGitRef`） |

类型定义（[git-types.ts](electron/ipc/git-types.ts)）：

```typescript
export interface GitBranchRef {
  name: string;        // "master" or "origin/master"
  remote?: string;      // "origin" for remote-tracking
  current?: boolean;
  head?: string;       // short sha
}

export interface GitCommitInfo {
  hash: string;        // full sha
  shortHash: string;   // first 7
  subject: string;
  body: string;        // commit message body ("" if none)
  author: string;
  authorEmail: string;
  authorDate: string;  // ISO
  parents: string[];
  refs: string[];      // branch/tag labels at this commit
  isMerge: boolean;
}

export interface GitCommitDetailResult {
  isGitRepo: boolean;
  commit?: GitCommitInfo;
  files?: GitReviewFile[];
  totals?: GitStatusTotals;
  patch?: string;
  truncated?: boolean;
  binary?: boolean;
  error?: string;
}

export interface GitListBranchesResult {
  isGitRepo: boolean;
  locals: GitBranchRef[];
  remotes: GitBranchRef[];
}
```

`GitAPI` 加 `listBranches(cwd)` / `commitDetail(cwd, sha)`；`listCommits` 加 `opts` 形参（**向后兼容** — 不传 opts 行为不变）。

### 4.3 Ref 校验放宽

`COMMIT_HASH_RE` → `validateGitRef(value: string): boolean`，规则：

- 完整 SHA：`[0-9a-f]{7,40}`（同前）
- 分支名 / 标签：字符 `[A-Za-z0-9._/-]` 且不以 `-` 开头，且 **不含** `..`、控制字符、`--`、 `^` / `~`（用 regex 黑名单 + 长度 ≤ 200）
- 远程 ref：`refs/remotes/<remote>/<name>` 或裸 `<remote>/<name>`
- 保留 `HEAD` / `FETCH_HEAD` / `ORIG_HEAD`

不满足 → 返回 `{ isGitRepo: true, error: 'Invalid ref.' }`（与 `git:review-diff` 错误形态一致）。

### 4.4 UI 改造（[CodeReviewPanel.tsx](src/components/layout/panels/CodeReviewPanel.tsx)）

**Layout**（GitHub Desktop 风格）：

```
┌──────────────────────────────────────────────────┐
│ toolbar: [scope▼] [base▼] [compare▼] [+filter]  │
├────────┬─────────────────────────────────────────┤
│History │         Diff area                       │
│────────│                                         │
│[Branch]│ - file list (left)                      │
│ master*│ - diff pane (right)                     │
│ feat/x │                                         │
│ remotes│                                         │
│   ►o/m │                                         │
│[Commit]│                                         │
│ ○ 949d │                                         │
│ │ fix  │                                         │
│ │ Lava │                                         │
│ ● abcd │                                         │
│   ↳ feat/x │                                     │
│ ...    │                                         │
│ search │                                         │
└────────┴─────────────────────────────────────────┘
```

**Toolbar 双下拉**：

- **scope**：现有 5 个 + 新增 `branch`（"对比分支"）。`branch` 模式下 compare 必填。
- **base（默认折叠）**：始终为工作区（"工作区（HEAD / master）"），**只读**。点击展开显示 `branch: master` 等信息但不可切换。
- **compare**：根据 scope 变化：
  - `uncommitted`：`working tree`（默认）
  - `unstaged` / `staged`：固定
  - `branch`：列出所有 branches（local first, remote collapsed）
  - `commit`：列出 commits（支持搜索）

**左侧 History tab**：

- Branches tab：列出所有 branches，点击 → `scope='branch'` + `compare=<branch>`。
- Commits tab：列出 `git log`，点 commit → 加载 `git:commit-detail` 显示 numstat + patch。
- 搜索框：`git log --grep=<query>` 重新加载 commits。
- 显示：short hash + subject + 作者名 + 相对时间 + 无父（root）/ 多父（merge）/ refs 标签（用 badge）。

### 4.5 Scope 语义整合

| scope | base (固定) | compare | diff 命令 |
|---|---|---|---|
| `latest-turn` | session 第一轮 → session 当前轮 | — | 持久化的 turn snapshot |
| `unstaged` | index | working tree | `git diff` |
| `staged` | HEAD | index | `git diff --cached` |
| `uncommitted` | HEAD | working tree | `git diff HEAD` |
| `branch` | HEAD (当前分支) | 选定的 branch | `git diff <branch>` |
| `commit` | HEAD | 选定的 commit SHA | `git diff <sha>^ <sha>` |
| `commit-pair` | commitFrom | commitTo | `git diff <from> <to>` |

`commit` 模式（点单个 commit 看那笔 commit 引入的变更）取 `<sha>^` 为 from、若 SHA 是 root commit 则传空（git 会自动处理为"空树"）。**`commit-pair` 是新增的"任意两 commit / ref 之间对比"模式**。

### 4.6 Diff 渲染复用

现有 `code-review-diff.test.ts` 测试的 patch renderer **零改动**，所有 scope 都返回同样形态的 patch 字符串（`diff --git a/... b/...` 序列）。File tree、unified/split、folding、wrap、add-to-input 全部沿用。

## 5. Files to change

| 文件 | 改动 |
|---|---|
| [electron/ipc/git-types.ts](electron/ipc/git-types.ts) | 加 `GitBranchRef`、`GitCommitInfo` 扩字段、`GitCommitDetailResult`、`GitListBranchesResult`；`GitAPI` 加 `listBranches` / `commitDetail` |
| [electron/ipc/git-handlers.ts](electron/ipc/git-handlers.ts) | 新增 `git:list-branches` / `git:commit-detail`；扩展 `git:list-commits` 接受 opts 走 `git log --format=...`；把 `COMMIT_HASH_RE` 改成 `validateGitRef` 接受 ref + SHA；`review-scoped` commit case 接受 ref |
| [electron/preload.ts](electron/preload.ts) | 暴露 `listBranches` / `commitDetail`；扩展 `listCommits` 签名加可选 opts |
| [src/lib/git-ipc.ts](src/lib/git-ipc.ts) | wrapper 同步 |
| [src/components/layout/panels/CodeReviewPanel.tsx](src/components/layout/panels/CodeReviewPanel.tsx) | 加 `<HistoryPanel>`（左栏）；toolbar 双下拉 + 远程分支折叠；新 scope `branch` / `commit-pair`；commit 详情渲染复用 `<DiffViewer>` |
| [src/components/layout/panels/registry.ts](src/components/layout/panels/registry.ts) | 不变（panel 已注册）|
| [src/components/layout/panels/code-review-diff.test.ts](src/components/layout/panels/code-review-diff.test.ts) | 不变 |
| [electron/ipc/__tests__/git-handlers.test.ts](electron/ipc/__tests__/git-handlers.test.ts) | 加 `git:list-branches` / `git:commit-detail` / 扩展 `git:list-commits` 测试；`validateGitRef` 单测（接受 SHA / branch / remote / 拒绝注入）|
| 新增 `src/components/layout/panels/HistoryPanel.test.tsx` | 渲染 / 点击切换 scope 的轻量测试 |

## 6. Phases

### Phase 1 — Bridge 扩展（半天）

1. `git-types.ts` 加类型。
2. `git-handlers.ts`：
   - `validateGitRef()` 实现 + 单测。
   - `git:list-branches` → `git for-each-ref refs/heads/ refs/remotes/ --format='%(HEAD)%(refname:short) %(objectname:short)'`。
   - `git:commit-detail` → `git show <sha> --stat=200,120 --format=...` + `git show <sha> -- patch`。
   - 扩展 `git:list-commits`：`git log --format='%H%n%h%n%s%n%b%n%an%n%ae%n%aI%n%P%n%D'`，无 opts 时仍 `%H %s` 行为**不变**（向后兼容）。
3. `preload.ts` / `git-ipc.ts` 暴露。
4. 单测覆盖。

### Phase 2 — UI 改造（半天）

1. 左栏 `<HistoryPanel>`：tabs(Branches / Commits) + 列表 + 搜索框。
2. Toolbar 双下拉：scope + compare。
3. 新 scope `branch`、`commit-pair` 接入 review-scoped。
4. 点 commit → 加载 `git:commit-detail` 渲染。
5. 远程分支折叠 / 展开。
6. 渲染测试 + 视觉走查（Playwright MCP）。

### Phase 3 — 收尾（半天）

1. 跑 `npm run typecheck:all` + 全量 `npm test`。
2. `electron:build` smoke test（AGENTS.md 建筑 release gate）。
3. 更新 ARCHITECTURE.md（如果动了数据库 schema / IPC 形状）。
4. 用 Playwright MCP 真机走查 diff 渲染。

## 7. Risks

| 风险 | 缓解 |
|---|---|
| `git for-each-ref` 在 detached HEAD 下 current 全 false | UI 显示 "(detached HEAD at <sha>)" |
| 远程分支列表大（`refs/remotes/*/pull/*/head`） | 默认只列 `refs/remotes/<known-remotes>/*`，每 remote 至多 30 条 |
| Ref 校验放宽导致命令注入（`git diff $(rm -rf)`） | `validateGitRef` 通过后 `git diff <ref>` 时仍走 child_process.spawnSync 的 array args，**不 shell 拼接**；Git CLI 拒绝含 `--` 起始的 ref |
| `git show` 输出超 1MB | 沿用现有 partial-diff 截断逻辑 |
| Commit message 含换行 | `list-commits` 解析用 `\0` 分隔，`\n` 在 body 内 |

## 8. Acceptance

- [ ] `git:list-branches` 输出包含本地 + 远程分支（远程默认折叠）。
- [ ] `git:list-commits` 扩展后字段向后兼容（`{hash, subject}` 仍在）。
- [ ] `git:commit-detail` 返回完整 metadata + numstat + patch。
- [ ] UI 能切换 base 固定 / compare 选分支或 commit 看到正确 diff。
- [ ] 点单笔 commit 看到 "该 commit 引入的变更"（`git show <sha>^..<sha>`）。
- [ ] 远程分支折叠 / 展开工作正常。
- [ ] `npm run typecheck:all` 全绿。
- [ ] `electron/ipc/__tests__/git-handlers.test.ts` 全绿 + 新增用例。
- [ ] `code-review-diff.test.ts` 不变（patch 形态不变）。
- [ ] Playwright MCP 真机走查三种新 scope。

## 9. Worktree

按 AGENTS.md § Worktree → PR workflow：这是单 panel 增强 + IPC 表面变更，跨 multi-module（electron + src/），**建议开 worktree + PR**。分支名 `feat/code-review-history`。

## 10. References

- [AGENTS.md § Code Review Workspace](AGENTS.md)
- [electron/ipc/git-handlers.ts](electron/ipc/git-handlers.ts)
- [electron/ipc/git-types.ts](electron/ipc/git-types.ts)
- [src/components/layout/panels/CodeReviewPanel.tsx](src/components/layout/panels/CodeReviewPanel.tsx)
