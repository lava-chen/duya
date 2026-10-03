# 496 — Worktree 框架完整实现（Agent 内建隔离工作树 + 主会话进出 + 全栈防护）

> **Status**: Draft · **Priority**: TBD · **Owner**: TBD
> **立项**: 2026-09-10（用户在 worktree 框架状态审计后要求"完整功能实现计划"，并指定 `E:\cloned-projects\codex` 与 `E:\cloned-projects\grok-build` 为参考源码）
> **2026-09-10 修订**: 用户指出默认路径应为 **`.duya/worktrees/`**（不是 `.claude/worktrees/`，后者是 Claude Code 的本地配置前缀，与本项目无关）；同时要求 plan 内容**聚焦参考项目具体代码实现细节**，不再展开 duya 自身规则与历史背景

---

## 0. 立项目的（待补充：调研结论完成后重写）

恢复并完成被 `81202eb4 chore(git): restore workspace from backup-pre-recovery-snapshot`（2026-09-02 23:37）静默回滚的 worktree 隔离栈 + 主会话 worktree 工具 + 安全加固，并按 grok-build 工业实现重新设计：

- 子代理（SubagentTool）`isolation: 'worktree'` 字段从 schema stub → 真创建临时 worktree、子 agent 的 file/bash 工具 cwd 重写到 worktree 根、foreground/background 两条清理路径、`worktreeSummary` 透出 path/branch/kept/cleaned
- 主会话 `EnterWorktreeTool` / `ExitWorktreeTool`（用户主动把当前会话搬进/搬出指定 worktree）
- worktree 守护（leak / nesting / races 加固）
- 路径规范统一到 `.duya/worktrees/<name>`（或经决策保留外置 `E:/Projects/duya-wt/` 方案）

---

## 1. duya 现役 worktree 状态（一句话）

master HEAD `529335e7`：`packages/agent/src/worktree/` 不存在；SubagentTool `isolation?: 'worktree'` 是 schema stub，无副作用；活跃 worktree 落在 `E:/Projects/duya-wt/`（外置盘符，与新规 `.duya/worktrees/` 不一致）。

> 历史背景（plan 439/440 被 `81202eb4` 静默回滚的具体代码）从 plan 文档略去，按需 `git log -- packages/agent/src/worktree/` 取 5 个 commit：`cdbab8d7` `d94063ee` `52fe697d` `1fb8b062` `f94557ea`。

---

## 2. 调研阶段（进行中）

### 2.1 调研对象

- [x] **TODO**：扫 `E:\cloned-projects\grok-build\crates\codegen\xai-fast-worktree\`（执行层 + git 集成 + 性能基准）
- [x] **TODO**：扫 `E:\cloned-projects\grok-build\crates\codegen\xai-grok-workspace-types\src\rpc\worktree.rs`（RPC 协议契约）+ `xai-grok-workspace\src\worktree\`（workspace 业务层）
- [x] **TODO**：扫 `E:\cloned-projects\grok-build\crates\codegen\xai-grok-shell\src\{extensions\worktree.rs, session\{worktree.rs, worktree_pool.rs}}`（shell + pool）
- [x] **TODO**：扫 `E:\cloned-projects\codex\codex-rs\core\tests\suite\worktree_trust.rs` + `worktree_trust_tests.rs`（trust 路径）
- [x] **TODO**：扫 `E:\cloned-projects\codex` 里 AGENTS.md 提及 worktree 的章节（`.worktreeinclude`、`share project hook trust across worktrees` 等）
- [x] **TODO**：codex 的 `codex-rs/app-server` / `app-server-protocol` 是否暴露 worktree RPC（与 duya 的 agent↔electron IPC 形态对照）

### 2.2 调研问题清单

1. **隔离粒度**：grok `xai-fast-worktree` 是 per-task 临时 worktree 还是会话级？是否复用？pool 策略？
2. **生命周期**：创建 / 清理 / leak / 嵌套限制 / 并发竞态 — grok 怎么解决？codex 怎么解决？
3. **git 集成边界**：`git worktree add --detach` vs 新分支？清理时 `git worktree remove --force`？未变更检测？
4. **文件复制加速**：grok `btrfs/`、`overlay/`、`copy/` 子目录的具体加速策略（reflink？overlayfs？rsync？）
5. **trust 与配置继承**：codex 的 `linked worktree trust metadata` + `inherit AGENTS override in linked worktrees` 怎么序列化/校验？
6. **IPC 协议**：grok `xai-grok-workspace-types/src/rpc/worktree.rs` 的 RPC 形态（JSON-RPC? typed channel?），与 duya `electron/ipc/*.ts` 形态对比
7. **pool 模型**：`worktree_pool.rs` 的实现细节 — 何时预热、何时销毁、与 agent session lifecycle 的绑定
8. **journal / 持久化**：worktree 元数据（path / branch / parent commit / 创建时刻 / 清理结果）落盘形态
9. **SubagentTool 集成**：grok 子 agent 是否共享主 worktree，还是各自开？duya 子代理一律父 cwd，是否需要改造？
10. **路径规范**：外置 `E:/Projects/duya-wt/` 与内置 `.duya/worktrees/` 的 trade-off

---

## 3. 调研结论（聚焦参考项目代码细节）

> 注：调研对象为 `E:\cloned-projects\codex`（OpenAI Codex CLI, Rust）和 `E:\cloned-projects\grok-build`（xAI Grok, Rust）。**修正**早期判断：codex **不只**做 trust 校验 — 它有完整的 `codex-rs/worktree/` crate（含 managed worktree 会话支持 + TUI/exec 集成）。

### 3.1 grok-build — `xai-fast-worktree` lib crate

#### 3.1.1 模块结构（`crates/codegen/xai-fast-worktree/src/`）

| 文件 | 行数 | 职责 |
|---|---|---|
| `lib.rs` | ~200 | WorktreeBuilder API 入口、WorktreePlan + WorktreeReport + CleanupReport 结构、`reclaim()` 公开入口 |
| `api.rs` | ~150 | Public re-export 全部枚举与 builder |
| `worktree/plan.rs` | 180+ | `WorktreePlan` 完整字段、`from_create_options()` 转换 |
| `worktree/execute.rs` | **1732** | `execute_create_worktree()`（450 行）+ `execute_create_standalone_worktree()`（250 行）+ `execute_create_git_worktree()` + 全部 test fns（行内 `#[cfg(test)] mod tests`） |
| `git/{checkout,discovery,index,status,worktree}.rs` | | git CLI 包装 |
| `{btrfs,overlay,copy,sync}.rs` | | fs 加速三档 + WorktreeSync 同步 |
| `db/mod.rs` | | SQLite 注册表 |
| `cancellation.rs` | | CancellationToken 抽象 |
| `mount_info.rs` | | Linux btrfs 检测 |
| `bin/cli.rs`、`bin/pool_perf_bench.rs` | | CLI + 性能基准 |

#### 3.1.2 `WorktreePlan` 完整字段（plan.rs）

```rust
pub struct WorktreePlan {
    pub src: RepoPath,                      // 主仓库根
    pub dest: RepoPath,                     // worktree 目录绝对路径
    pub creation_mode: CreationMode,        // Linked/Standalone/GitCheckout
    pub working_tree_mode: WorkingTreeMode, // PreserveWorkingTree/CleanTracked/CleanAll
    pub ignored_files_mode: IgnoredFilesMode,
    pub copy_destination_policy: CopyDestinationPolicy,
    pub fs_walk_parallelism: NonZeroUsize,
    pub cancellation_token: CancellationToken,
    pub creation_lock: CreationLockGuard,   // 同 (src,dest) 互斥
    pub worktree_kind: WorktreeKind,        // Session/Ab/Pool/Fork/Manual/Subagent
    pub session_id: Option<Uuid>,
    pub metadata: serde_json::Value,
    pub btrfs_mode: BtrfsMode,
    pub btrfs_delegate: Option<Arc<dyn BtrfsDelegate>>,
}
```

`from_create_options(opts, src, dest, cwt)` 把外部 opts（含用户态 `WorktreeKind` + `SessionId` + 元数据 JSON）+ `create_worktree_common` 三方输入归并。**核心 invariant**：每个 `WorktreePlan` 持有一个 `CreationLockGuard` —— 同一 `(src, dest)` pair 串行化创建，避免两个并发请求同 worktree。

#### 3.1.3 `execute_create_worktree()` 完整算法（execute.rs 行 1300-1750）

```rust
async fn execute_create_worktree(plan: WorktreePlan) -> Result<WorktreeReport, WorktreeError> {
    // 阶段 0：preflight
    preflight_check(&plan).await?;                       // dest 父目录可写、git 可用
    let src_repo = gix::open(plan.src.as_path())?;       // gix 一次解析，避免后续重复 stat

    // 阶段 1：标记 "in-progress" (防重入 + 部分失败可观测)
    let in_progress_dir = worktree_db.claim_worktree_in_progress(&plan)?;

    // 阶段 2：cancellation-aware 同步 git worktree add (在 spawn_blocking)
    let create_fut = tokio::task::spawn_blocking({
        let plan = plan.clone();
        let token = plan.cancellation_token.clone();
        move || execute_create_inner_blocking(plan, token, src_repo)
    });
    tokio::select! {
        result = create_fut => result??,
        _ = plan.cancellation_token.cancelled() => {
            // 取消路径：清理 worktree dir + .git/worktrees/<name> 注册
            cleanup_partial_worktree(&plan).await;
            return Err(WorktreeError::Cancelled);
        }
    }

    // 阶段 3：补 dirty 文件（仅 PreserveWorkingTree 模式）
    if plan.working_tree_mode == PreserveWorkingTree {
        copy_dirty_files(&plan.src, &plan.dest, &src_repo).await?;
    }

    // 阶段 4：注册到 WorktreeDb（status='created'）
    worktree_db.insert_worktree(&plan).await?;

    Ok(WorktreeReport { path: plan.dest, head_commit, parent_commit, copied: CopyReport {...} })
}
```

**关键 invariant**（execute.rs 的内联测试反复验证）：
- **cancel-after-worktree-add**：必须在取消时调用 `git worktree prune` + `fs::remove_dir_all(dest)`，否则 `.git/worktrees/<name>` 残留主仓库元数据，下次 `git worktree list` 还会列出
- **hard-error reclaim**：fs 创建失败 → 同样 deregister + remove_dir_all
- **`SpawnBlockingGuard`** RAII：如果 spawn_blocking panic，确保 ctx 标记已写回 DB（`status='error'`）

#### 3.1.4 `WorktreeSync` 4 阶段（sync.rs）

```rust
pub fn sync_worktree(
    worktree_path: &Path,
    source_dirty: Option<&SourceDirtyState>,  // 复用上游计算结果
    copy_dirty: bool,
    skip_clean: bool,
) -> Result<()> {
    // Phase 1: git read HEAD (gix)
    let head = gix::open(worktree_path)?.head_commit()?;
    // Phase 2: git reset --hard HEAD
    run_git(worktree_path, &["reset", "--hard", "HEAD"]).await?;
    // Phase 3 (可选): git clean -fd (tracked + ignored)，skip_clean=true 时跳过
    if !skip_clean {
        run_git(worktree_path, &["clean", "-fd"]).await?;
    }
    // Phase 4: 复制 source 端的 dirty 文件
    if copy_dirty {
        if let Some(state) = source_dirty {
            copy_dirty_from_state(worktree_path, state)?;
        } else {
            let state = compute_source_dirty_state(&source_root)?;
            copy_dirty_from_state(worktree_path, &state)?;
        }
    }
    Ok(())
}
```

**性能 trick**：
- `skip_clean=true`：刚 release 的 worktree 已知干净，跳过 `git clean -fd`（~800ms 节省）
- `SourceDirtyState` 复用：106K 文件仓 ~1.4s/次的 `git status` 可在多次 sync 间传递
- **不整体复制 .git/index**：保留 `core.fsmonitor` + `core.untrackedCache`，否则 git status 在 worktree 内会重 hash 每个文件
- `sync_from_precomputed()` 是公开 API，允许调用方注入已计算的 dirty state

#### 3.1.5 `WorktreeBuilder` 链式 API（lib.rs）

```rust
let wt = WorktreeBuilder::new(src_repo_root, worktree_dest_path)
    .creation_mode(CreationMode::Linked)                  // 默认
    .working_tree_mode(WorkingTreeMode::PreserveWorkingTree) // 默认
    .ignored_files_mode(IgnoredFilesMode::Skip)            // 默认
    .copy_destination_policy(CopyDestinationPolicy::ReplaceAllExisting)
    .fs_walk_parallelism(NonZeroUsize::new(4).unwrap())
    .cancellation_token(CancellationToken::new())
    .btrfs_mode(BtrfsMode::Auto)                           // 仅 Linux
    .worktree_kind(WorktreeKind::Subagent)                 // 用于 DB 分类
    .session_id(some_session_uuid)
    .metadata(json!({"reason": "subagent", "parent": parent_id}))
    .create().await?;
```

`create()` 内部：构造 `WorktreePlan` → 取 `CreationLockGuard`（同 `(src, dest)` 互斥）→ 调 `execute_create_worktree()`。

#### 3.1.6 5 个策略枚举 + 默认值

| 枚举 | 变体 | 默认 | 用途 |
|---|---|---|---|
| `CreationMode` | `Linked`(default) / `Standalone` / `GitCheckout` | `Linked` | `Linked` = `git worktree add`；`Standalone` = 完整独立 git repo（不注册到主 repo 的 `.git/worktrees/`）；`GitCheckout` = 原生 CLI 包装 |
| `WorkingTreeMode` | `PreserveWorkingTree`(default) / `CleanTracked` / `CleanAll` | `PreserveWorkingTree` | dirty 文件处理策略 |
| `IgnoredFilesMode` | `Skip`(default) / `Copy{skip_patterns}` / `CopyOnly{skip_patterns}` | `Skip` | `.gitignore` 中文件是否复制 |
| `WorktreeKind` | `Session` / `Ab` / `Pool` / `Fork` / `Manual` / `Subagent` | `Manual` | DB 分类，便于按 kind 过滤/查询/GC |
| `BtrfsMode` | `Auto`(default) / `Force` / `Disabled` | `Auto` | Linux btrfs 文件系统层 CoW；Windows/macOS 自动 Disabled |

#### 3.1.7 subagent worktree 生命周期（最具借鉴价值）

```rust
// 1. snapshot（保留 agent 工作成果到主 repo ref）
fn snapshot_subagent_worktree(
    wt: &WorktreeHandle,
    src_repo_root: &Path,
    ref_name: &str,                       // 如 "refs/subagent-snapshots/<session_id>"
) -> Result<Oid>;

// 2. remove（删除 worktree 目录）
async fn remove_subagent_worktree(wt: &WorktreeHandle) -> Result<()>;

// 3. rehydrate（从 ref 重建工作树）
async fn rehydrate_subagent_worktree(
    dest: &Path,
    src_repo_root: &Path,
    snapshot_ref: &str,
    session_id: Uuid,
) -> Result<WorktreeHandle>;
```

**关键设计：先 snapshot 再 remove（snapshot-then-remove 两阶段）** —— 即使 remove 阶段 crash，worktree 内的成果仍以 ref 形式留在主 repo，下次启动可 rehydrate。这与 duya SubagentTool 集成形态完全契合（每次 `isolation: 'worktree'` 启动 → `worktreeKind: Subagent`；结束 → `snapshot_subagent_worktree` 到主 repo → `remove_subagent_worktree`）。

#### 3.1.8 RPC 协议（xai-grok-workspace-types/src/rpc/worktree.rs, 407 行）

**11 个 RPC 方法**（每个都是 `WorkspaceRpc` trait 子类型）：

```
workspace.create_worktree             # 主入口
workspace.create_worktree_sync        # 同步版（不流式）
workspace.create_worktree_from_worktree_sync  # worktree-of-worktree
workspace.remove_worktree             # 删
workspace.apply_worktree              # 把 worktree 变更应用回主 repo（ApplyMode::Overwrite/Merge）
workspace.show_worktree               # 查询单个
workspace.list_worktrees              # 查询列表（按 repo/types 过滤）
workspace.gc_worktrees                # GC
workspace.rebuild_worktree_db         # 重建 DB
workspace.worktree_db_path            # DB 路径
workspace.worktree_db_stats           # DB 统计
```

**CreateWorktreeRequest 字段**：

```rust
pub struct CreateWorktreeRequest {
    pub session_id: SessionId,
    pub source_path: PathBuf,
    pub worktree_path: Option<PathBuf>,       // 缺省时由 allocator 生成
    pub copy_mode: WorktreeCopyMode,          // Clean | Dirty (默认 Dirty)
    pub git_ref: Option<String>,
    pub copy_ignored_in_background: bool,
    pub ignored_skip_patterns: Vec<String>,
    pub worktree_type: Option<WorktreeType>,  // linked/standalone/git
    pub label: Option<String>,
}
```

**流式 CreateWorktreeResponse status-tagged enum**：

```rust
#[serde(tag = "status")]
pub enum CreateWorktreeResponse {
    Creating { session_id, worktree_path, source_git_root },
    Exists { session_id, worktree_path, commit, source_git_root },
}
```

**流式 WorktreeStatus 进度通知**：

```rust
pub enum WorktreeStatus {
    Progress { current, total, message },
    Analyzing,
    SourceInfo { ... },
    CopyingChanges { phase, current, total, current_file },
    Created { session_id, worktree_path, commit, source_git_root, copied_changes },
    Error { message },
    CopyingIgnored,
    IgnoredCopyComplete { count },
    IgnoredCopyError { message },
    Cancelled,
}
```

**WorkspaceRpc trait 契约模式**：

```rust
pub trait WorkspaceRpc: Send + Sync + 'static {
    const METHOD: &'static str;
    type Request: Serialize + DeserializeOwned + Send + 'static;
    type Response: Serialize + DeserializeOwned + Send + Stream<Item = Result<...>> + 'static;
}
```

每个 RPC 方法都注册为：`register("workspace.create_worktree", move |req, stream| {...})` —— **stream 模式**（异步流式响应）作为统一形态。

#### 3.1.9 WorktreeDb 注册表（db/mod.rs）

**schema**：

```sql
CREATE TABLE worktrees (
    id TEXT PRIMARY KEY,                      -- sha256(full path)[:16]
    path TEXT UNIQUE NOT NULL,
    source_repo TEXT NOT NULL,
    repo_name TEXT NOT NULL,
    kind TEXT NOT NULL,                       -- WorktreeKind as_str
    creation_mode TEXT NOT NULL,              -- CreationMode as_str
    git_ref TEXT,
    head_commit TEXT NOT NULL,
    session_id TEXT,
    creator_pid INTEGER NOT NULL,
    created_at INTEGER NOT NULL,              -- unix ts
    last_accessed_at INTEGER NOT NULL,
    status TEXT NOT NULL,                     -- 'in-progress' | 'created' | 'removed' | 'error'
    metadata JSON_TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

**关键函数**：
- `id_from_path(p)` = `<basename>-<sha256(canonicalize(p).to_string_lossy())[:8]>`（防跨仓冲突）
- `lookup_worktree_by_path(p)` 直接查
- `lookup_worktree_label(cwd)` **沿路径上溯**找 DB 记录（用于 cwd 在 worktree 深处时仍能识别 worktree）
- `touch_worktree_for_cwd(cwd)` 更新 `last_accessed_at`（GC 依据）
- `journal_mode()` 自动选：网络挂载（NTFS remote / nfs）选 per-host，本地 SSD 选 WAL
- `claim_worktree_in_progress(plan)` 创建 `status='in-progress'` 占位行，避免重入 + 部分失败可观测

#### 3.1.10 WorktreePool（pool.rs, 1188 行 macOS-only）

> grok 自家注释：**"this module is preserved as a future-use building block. Current production callers are limited to cleanup_stale_pool_worktrees"** —— 即未来用，当前主要 GC 用。

```rust
pub struct WorktreePool {
    pool_dir: PathBuf,                       // ~/.grok/worktree_pool/<instance_id>/<pool_id>/
    size: NonZeroUsize,
    fill_token: CancellationToken,
    instance_id: Uuid,
}

impl WorktreePool {
    pub async fn acquire(&self) -> Result<PooledWorktree>;  // rename(.ready → .claimed)
    pub async fn release(&self, wt: PooledWorktree);        // git reset + clean + rename → .ready
    pub async fn fill_background(&self);                    // 后台持续 fill
    pub async fn cleanup_stale(&self);                      // adopt 其他实例 orphan
}
```

**关键技巧**：
- `.ready` / `.claimed` / `.claiming` 标记文件放在**池目录旁**（不放在 worktree 内部），避免污染 git status
- 原子 `rename(.ready → .claimed)` 实现并发安全
- `acquire()` 时 in-place sync（**不做 `git worktree move`**，因为 move 会触发完整 git 元数据更新，~1s 开销）
- `release()` 时 `git reset --hard HEAD` + `git clean -fdx` 后重新标记 `.ready`
- 启动时 adopt 其他实例残留的 orphan（验证 `.git` 文件指向主 repo 后迁移）
- 硬上限 `pool_size * 2`

#### 3.1.11 测试套件（execute.rs 行内 `#[cfg(test)] mod tests`）

```
test_linked_create_basic
test_linked_create_parent_dir_missing_creates_it
test_linked_create_with_ignored_files_copy
test_linked_create_with_ignored_files_skip
test_linked_create_with_ignored_files_copy_only
test_linked_create_preserves_symlinks
test_linked_create_with_dirty_files_makes_worktree_git_status_fast
test_linked_cancel_after_worktree_add_deregisters     # 取消路径
test_linked_hard_error_reclaims_and_deregisters      # 硬错误路径
test_standalone_create_is_not_registered_as_worktree
test_standalone_promotable_to_full_repo_after_rename
test_unicode_safe_paths_in_worktree_dest
test_nested_directories_in_worktree_dest
test_git_worktree_at_existing_dir_errors_cleanly
```

**对本 plan 验收测试的指导**：直接复用这些 case 名作为本 plan 的 test plan checklist。

---

### 3.2 OpenAI Codex — `codex-rs/worktree/` crate + trust 路径

> 重要修正：codex **不是只做 trust 校验**，它有完整的 `codex-rs/worktree/` crate（含 managed worktree 会话支持）。

#### 3.2.1 crate 布局

| 文件 | 行数 | 职责 |
|---|---|---|
| `codex-rs/worktree/src/lib.rs` | 155 | `WorktreeConfig` + `create()` 入口 + `excluded_from_gitignore()` |
| `codex-rs/worktree/src/paths.rs` | 76 | `allocate_worktree_path(parent_dir)` 路径分配算法 |
| `codex-rs/worktree/src/git.rs` | 106 | git 命令包装 + SandboxPolicy 隔离 |
| `codex-rs/worktree/src/git_tests.rs` | 168 | git 测试套件 |
| `codex-rs/worktree/src/settings.rs` | - | 配置（`WorktreeConfig { auto_resolve, .. }`） |
| `codex-rs/worktree/src/error.rs` | - | `WorktreeError` enum |
| `codex-rs/worktree/tests/worktree.rs` | 371 | E2E 测试（managed worktree lifecycle） |
| `codex-rs/core/tests/suite/worktree_trust.rs` | 159 | trust 校验测试 |
| `codex-rs/core/src/worktree_trust_tests.rs` | 159 | trust 单元测试 |

#### 3.2.2 路径分配算法（paths.rs）

```rust
/// Allocates a unique worktree directory under parent_dir.
/// Walks parent_dir's siblings; picks <parent_basename>-<hash> to avoid name collisions.
pub fn allocate_worktree_path(parent_dir: &Path) -> PathBuf {
    let parent_basename = parent_dir.file_name().unwrap().to_string_lossy().to_string();
    let unique = short_hash(parent_dir);                  // 8-char hash
    let mut candidate = parent_dir.with_file_name(format!("{}-{}", parent_basename, unique));
    // 递归向上：避免与 sibling worktree 冲突 → 追加 -1, -2, ...
    while candidate.exists() {
        candidate = parent_dir.with_file_name(format!("{}-{}-{}", parent_basename, unique, next));
        next += 1;
    }
    candidate
}
```

**特点**：
- 不放在 `.git/` 内（不在主 repo 的 `.git/worktrees/` 路径下），而是作为 sibling —— 与 grok 不同
- 通过 hash 防 sibling 冲突；hash 算法简单（路径截取 + FNV-style hash）
- 不持久化（每次启动重新算），但因 path unique + path 自描述足够

#### 3.2.3 git 命令 + SandboxPolicy 隔离（git.rs 核心）

```rust
pub(crate) fn git_cmd_no_add(
    cwd: &Path,
    args: &[&str],            // ["rev-parse", "--show-toplevel"] 等
    sandbox: &SandboxPolicy,
) -> Result<String> {
    let cmd = Command::new("git").current_dir(cwd).args(args).output()?;
    // 关键：把 worktree path 加入 sandbox writable roots
    sandbox.with_writable_root(worktree_path).run(cmd)?;
}
```

**关键点**：codex 在 git 命令层面显式把 worktree 路径加进 `SandboxPolicy::with_writable_root()`，确保 sandbox 模式下 worktree 可写。**这是 duya 缺失的能力**（duya 的 BashWorker 没有 sandbox-aware path 加白）。

#### 3.2.4 trust 校验（worktree_trust.rs）

**4 种伪造场景**（`forged_worktree_project_config_cannot_start_host_mcp` 测试）：

```
1. missing .git          → 完全伪造，no git metadata
2. other-checkout .git   → 是别的 worktree 的 .git 链接（验证 canonical path 不在主 repo 的 .git/worktrees/ 下）
3. symlink .git          → .git 是符号链接
4. registered .git       → .git 是真实 registered worktree（合法）
```

**信任逻辑**（4 步）：
```rust
fn is_trusted_worktree(wt: &Path, main_repo: &Path) -> Result<bool> {
    let dot_git = wt.join(".git");
    // 1. .git 必须存在
    if !dot_git.exists() { return Ok(false); }
    // 2. .git 不能是符号链接
    if dot_git.is

---

## 4. 设计

### 4.1 架构总览（目标终态）

```
┌─────────────────────────────────────────────────────────────────┐
│ Electron renderer (UI)                                           │
└─────────────────────┬───────────────────────────────────────────┘
                      │ IPC (electron/preload.ts + ipc-handlers)
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│ Electron main process (electron/main.ts)                          │
│   worktree:list  worktree:create  worktree:remove  worktree:gc   │
└─────────────────────┬───────────────────────────────────────────┘
                      │ MessagePort + Agent Server (HTTP+SSE)
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│ packages/agent                                                   │
│                                                                  │
│  ┌─ SubagentTool ──────────────────────────────────────────┐    │
│  │ if (input.isolation === 'worktree') {                   │    │
│  │   const wt = await worktreeManager.create({...})       │    │
│  │   isolatedContext.workingDirectory = wt.path           │    │
│  │   // foreground + background cleanup paths             │    │
│  │ }                                                       │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌─ EnterWorktreeTool / ExitWorktreeTool (new) ─────────────┐    │
│  │ 主会话级：用户主动把会话搬进/搬出指定 worktree           │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌─ packages/agent/src/worktree/ ───────────────────────────┐   │
│  │  worktree-manager.ts       (创建/清理生命周期)           │   │
│  │  creation-mode.ts          (Linked/Standalone/Git)       │   │
│  │  working-tree-mode.ts      (Preserve/CleanTracked/Clean) │   │
│  │  ignored-files-mode.ts     (Skip/Copy{patterns}/CopyOnly)│   │
│  │  cancellation.ts           (AbortSignal 抽象透出)        │   │
│  │  worktree-db.ts            (worktrees.db 注册表 + kind)  │   │
│  │  worktree-gc.ts            (max_age_secs + auto GC)       │   │
│  │  worktree-sync.ts          (sub-agent 复用 — V2 stub)    │   │
│  │  worktree-trust.ts         (V2: codex-style TODO 注释)   │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌─ packages/agent/src/git/ ─────────────────────────────────┐   │
│  │  git-cli.ts (走 git CLI via bash worker)                  │   │
│  │  git-discovery.ts (find main repo root + fsmonitor 检测)  │   │
│  │  git-status.ts (porcelain v2 -z, 同 grok sync 算法)       │   │
│  │  git-clean.ts (--fd 跳过 .gitignore 加速)                 │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
              electron/db/worktree-db.ts (better-sqlite3)
              ~/.duya/worktrees.db  ── 类似 grok ~/.grok/worktrees.db
```

### 4.2 模块映射（grok → duya 一一对应）

| grok 模块 | duya 落地位置 | 说明 |
|---|---|---|
| `xai-fast-worktree` (lib) | `packages/agent/src/worktree/{worktree-manager, mode, working-tree-mode, ignored-files-mode, cancellation, worktree-db, worktree-gc}.ts` | 单 crate 拆成多文件 |
| `xai-grok-workspace-types/src/rpc/worktree.rs` | `packages/agent/src/worktree/rpc-types.ts` + `electron/preload.ts` worktree:* IPC | 11 个 RPC 方法 → IPC channel 一一映射 |
| `xai-grok-workspace/src/worktree/mod.rs` (`prepare_worktree_creation` 等) | `packages/agent/src/worktree/{prepare, claim-in-progress, create-streaming, background-copy}.ts` | 业务编排 |
| `xai-grok-shell/src/session/worktree.rs` (resume/rehydrate) | `packages/agent/src/worktree/{resume, rehydrate}.ts` | 会话级 |
| `xai-fast-worktree/src/sync.rs` (WorktreeSync) | `packages/agent/src/worktree/worktree-sync.ts` | sub-agent 复用（V2 stub，本 plan 不实现） |
| `xai-fast-worktree/src/db/mod.rs` (WorktreeDb) | `electron/db/worktree-db.ts` (复用 plan 326/327/328 的 core-db pattern) + `~/.duya/worktrees.db` | worktrees.db 注册表 |

### 4.3 待决问题（决策推荐）

- [x] **D1**：路径规范（`.duya/worktrees/` vs `E:/Projects/duya-wt/`） — **推荐：双路径支持，默认 `.duya/worktrees/<plan-id>-<slug>/`**；用户可通过 `config.toml [worktree] base_dir` 配置外置（迁移现有活跃 worktree 由用户在 plan 479 phase 3 完成后自行决定）
- [x] **D2**：分支命名 — **强制** `<type>/<plan>-<slug>` 形态（与 AGENTS.md 对齐）；新增 `scripts/create-worktree.sh` 强制分支名格式
- [x] **D3**：sub-agent worktree 策略 — **默认各开临时**（每次 `isolation: 'worktree'` 创建独立 worktree，foreground/background 两条清理路径）；会话级复用作为 V2 增强
- [x] **D4**：worktree pool — **不实施**（保留接口 `worktree-sync.ts` 留 V2 stub），待未来高频 sub-agent 场景出现再启动 plan
- [x] **D5**：trust metadata — **不实施**（本 plan 仅在 `worktree-trust.ts` 留 TODO 注释，未来 plan 立项）
- [x] **D6**：journal 形态 — **复用 plan 441 journal**，worktree 元数据作为 session metadata 字段持久化（不新增事件类型）；新增 `worktree_entered` / `worktree_exited` 仅作为 session metadata key
- [x] **D7**：IPC 协议 — **复用 duya 现有 IPC invoke 模式**（不是 typed RPC），但 channel 命名与 grok RPC 方法对齐（`worktree:create` 对应 `workspace.create_worktree`）
- [x] **D8**：清理策略 — **foreground + background 双路径**（与原 52fe697d 设计一致）：foreground = foreground sub-agent 完成后 `cleanupIfUnchanged(cleanupPolicy)`；background = background sub-agent 完成通知到达时由 spawn task 异步清理

### 4.4 实施分阶段

#### Phase 0 — 路径规范 + 命名合规
- [ ] **P0.1** 新建 `scripts/create-worktree.sh`（封装 `git worktree add` + 强制分支名 `<type>/<plan>-<slug>` + 路径规则 + node_modules junction 处理 — 对齐 plan 493）
- [ ] **P0.2** AGENTS.md "Worktree → PR workflow" 章节更新：明确 `.duya/worktrees/<name>` 默认 + 外置配置项
- [ ] **P0.3** `scripts/remove-worktree.sh` 增强：junctioned node_modules 安全检查（与 plan 493 协议对齐）+ Windows NTFS junction 兼容

#### Phase 1 — WorktreeManager 核心（恢复 + 加固）
- [ ] **P1.1** `packages/agent/src/worktree/` 目录结构 + 枚举定义（与 grok 一一对应）：
   - `creation-mode.ts` (Linked/Standalone/Git)
   - `working-tree-mode.ts` (Preserve/CleanTracked/CleanAll)
   - `ignored-files-mode.ts` (Skip/Copy{patterns}/CopyOnly{patterns})
   - `worktree-kind.ts` (Session/Ab/Pool/Fork/Manual/Subagent — 仅 Subagent/Session/Manual 落地)
   - `worktree-types.ts` (接口：`WorktreeBuilder`, `WorktreeReport`, `CleanupReport`, `CopyReport`, `DirtyFilesReport`, `WorktreeHandle`)
- [ ] **P1.2** `worktree-manager.ts` 主体（参考 `cdbab8d7` + grok `WorktreeBuilder`）：
   - `createWorktree({source, dest, mode, workingTree, ignored, cancellationToken, kind, sessionId, metadata})`
   - 流程：`git worktree add --detach` → 复制 dirty 文件 → 注册到 DB → 返回 `WorktreeHandle{path, branch, parentCommit, kept}`
   - 错误恢复：失败时既删 worktree dir 也 deregister `.git/worktrees/<name>`（grok `test_linked_cancel_after_worktree_add_deregisters` 等价测试）
- [ ] **P1.3** `cancellation.ts`（AbortSignal 抽象透出 — Node AbortSignal 与 grok CancellationToken 语义差异要在抽象层明示）
- [ ] **P1.4** `electron/db/worktree-db.ts` (WorktreeDb 注册表，复用 plan 326/327 的 better-sqlite3 模式)：
   - 表 `worktrees(id, path UNIQUE, source_repo, repo_name, kind, creation_mode, git_ref, head_commit, session_id, creator_pid, created_at, last_accessed_at, status, metadata JSON)`
   - 单例表 `meta(key, value)`
   - journal_mode 自动选（plan 441 已有 `xai_sqlite_journal` 参考；TS 端需独立处理）
   - `id_from_path` = sha256(full path).slice(0,8)
   - `lookupByPath(cwd)` 沿路径上溯找 DB 记录
- [ ] **P1.5** `worktree-gc.ts`（max_age_secs + auto_gc 钩子 — V1 仅接口 + 手动 trigger；auto_gc 待 plan 476 wake bus 落地后接）
- [ ] **P1.6** P1 单元测试（worktree-manager.test.ts）：简单创建 / 父目录自动建 / 取消清理 / 硬错误清理 / standalone 独立性（不在 source 注册）/ 文件名空格/Unicode 安全 — 对齐 grok `test_linked_*` 模式

#### Phase 2 — SubagentTool `isolation: 'worktree'` 真接入（恢复 52fe697d）
- [ ] **P2.1** `SubagentTool.ts` execute() 改造（与原 52fe697d 同结构）：
   - `if (input.isolation === 'worktree')` 真分支
   - `const wt = await worktreeManager.create({source: parentCwd, dest, creationMode: Linked, workingTree: PreserveWorkingTree, kind: Subagent, sessionId, metadata: {reason: 'subagent', parentSession, agentProfileId}})`
   - `isolatedContext.workingDirectory = wt.path`
   - 子 agent 的 file/bash 工具 cwd 已在执行链路上由 `isolatedContext` 接管（**实施前 grep `isolatedContext.workingDirectory` 在所有消费方的引用路径**，plan 504/481/506 都要看）
   - foreground 完成：`cleanupIfUnchanged(wt, {policy: 'cleanupIfUnchanged'})` — 若 worktree HEAD == source HEAD + 无未提交变更 → 删除；否则保留
   - background 完成：spawn task 异步 cleanup（与 52fe697d 同形态）
- [ ] **P2.2** SubagentToolResult 增加 `worktree: {path, branch, parentCommit, kept, cleaned}` 字段；XML 通知 (`WORKTREE_TAG`/`WORKTREE_PATH_TAG`/`WORKTREE_BRANCH_TAG`) 真填充（之前 stub 状态）
- [ ] **P2.3** P2 集成测试：sub-agent `isolation: 'worktree'` → 子 agent 在 worktree 内跑 → 父 agent 拿到 `worktree.path` → 用户可继续在 worktree 内工作或释放

#### Phase 3 — 主会话 EnterWorktree / ExitWorktree 工具（恢复 1fb8b062）
- [ ] **P3.1** `EnterWorktreeTool`：用户调用时把当前 session 的 workingDirectory 重写到指定 worktree（创建新 worktree + 重写 session cwd + session metadata 落 `worktree_entered`）
- [ ] **P3.2** `ExitWorktreeTool`：用户调用时清理当前 worktree + 把 session cwd 重写回主 repo + session metadata 落 `worktree_exited`
- [ ] **P3.3** SessionTool.metadata.worktree 接入 plan 441 journal（`worktree_entered` / `worktree_exited` 两条 metadata key）
- [ ] **P3.4** P3 集成测试：主会话进入 worktree → 在 worktree 内跑多轮 → 退出 worktree → 后续轮次回到主 repo

#### Phase 4 — IPC + UI 集成
- [ ] **P4.1** `electron/preload.ts` + `electron/ipc/worktree-handlers.ts`（IPC channel 命名与 grok RPC 对齐）：
   - `worktree:create` (req: `{sessionId, sourcePath, worktreePath?, copyMode, gitRef?, copyIgnoredInBackground?, ignoredSkipPatterns?, worktreeType?, label?}` → 透传 package 化 `WorktreeCreateRequest`)
   - `worktree:create-sync`
   - `worktree:create-from-worktree-sync`
   - `worktree:remove` (req: `{worktreePath?, idOrPath?, force, dryRun}`)
   - `worktree:apply` (req: `{sessionId, worktreePath, mode: 'overwrite' | 'merge'}`)
   - `worktree:show` (req: `{idOrPath}`)
   - `worktree:list` (req: `{repo?, types?, includeAll}`)
   - `worktree:gc` (req: `{dryRun, maxAgeSecs?, force}`)
   - `worktree:db-rebuild` / `worktree:db-path` / `worktree:db-stats`
- [ ] **P4.2** `electron/main.ts` 注册（对齐 `git:*` / `db:*` 现有模式）
- [ ] **P4.3** UI：Sidebar 显示活跃 worktree 列表（从 `worktree:list` 拉）+ worktree 卡片（path / branch / created_at / last_accessed_at / status）+ 进入/退出/删除按钮
- [ ] **P4.4** UI 集成测试：sidebar 显示 → 点击进入 → 主会话进入 worktree → 退出恢复

#### Phase 5 — journal 持久化（落盘 worktree 元数据）
- [ ] **P5.1** session metadata key `worktree_entered` / `worktree_exited` 注册到 `PERSISTED_METADATA_KEYS`（plan 441）
- [ ] **P5.2** WorktreeDb 元数据与 session metadata 双写（session metadata 存当前态，WorktreeDb 存历史注册）

#### Phase 6 — 安全加固 + 集成测试 + Playwright 冒烟
- [ ] **P6.1** `worktree-trust.ts` 留 TODO（不实现）+ `worktree-leak.ts` 防泄露测试（kill -9 后重启能正确识别 dead worktree）
- [ ] **P6.2** `worktree-nesting.ts` 嵌套测试（sub-agent 在 worktree 内再开 sub-agent → 递归创建 → 正确清理）
- [ ] **P6.3** `worktree-race.ts` 并发竞态测试（两个 sub-agent 同时开 worktree + 同时清理 → 无 `.git/worktrees/<name>` 残留）
- [ ] **P6.4** Playwright 冒烟：sidebar → 创建 worktree → 主会话进入 → 跑一轮 → 退出 → 删除

### 4.5 验收
- [ ] **G1** `npm run typecheck:all` 绿
- [ ] **G2** 单元测试全绿（含 worktree-manager / SubagentTool plan 486 / SubagentTool plan 496 / EnterWorktreeTool / WorktreeDb / journal metadata）
- [ ] **G3** Playwright e2e：sub-agent `isolation: 'worktree'` 真实场景 + 主会话 enter/exit worktree 真实场景
- [ ] **G4** worktree GC 真实场景：创建 5 个 → 等 max_age_secs → GC 触发 → 仅保留 alive + 路径合法
- [ ] **G5** 不破坏现有 plan 479 活跃 worktree（在它未关闭前不要对 `E:/Projects/duya-wt/` 路径下手）

---

## 5. 非目标

- 不迁移 master checkout 路径本身
- 不改 plan 479 已经在 `E:/Projects/duya-wt/` 跑的活跃分支（**但 plan 479 phase 3 完成合入后，下一个新 worktree 必须按新规范；旧 worktree 用户可手动迁移或自然终止**）
- 不实现 btrfs / overlay 加速（Windows NTFS 没有等价文件系统层，grok-build 是 Linux/macOS 设计）
- 不实现 WorktreePool 预热池（grok 自家也注明 future-use；保留接口 stub `worktree-sync.ts`）
- 不实现 trust metadata 校验（codex 的强项；duya 暂无强 trust 模型，作为未来 plan 单独立项）
- 不实现 apply-mode 的 merge 复杂逻辑（仅 overwrite，merge 留接口；plan 506 已经处理过类似分叉语义）
- 不动 plan 441 journal 核心契约（仅 metadata key 扩展）

---

## 6. 风险

1. **路径迁移风险**：外置盘符方案如被废弃，plan 479 phase 3 正在跑的 worktree 需要重新 checkout — 节点可能丢失未推送 commit（**P0.1 必须先与 plan 479 owner 协调合并节点**，再升级 scripts）
3. **sub-agent 重构波及面**：plan 504 Session Tool / 481 Bot Toolset / 506 rollout fork 均已落地，引入 worktree 隔离可能要回看它们的 file/bash 工具 cwd 假设 — **P2.1 实施前需 grep `isolatedContext.workingDirectory` 在所有消费方的引用路径**
5. **node_modules junction 风险**（AGENTS.md 已记 incident 2026-08-25）：新 worktree 必须按 plan 493 已落地的 junction 协议处理 — **P0.3 与 plan 493 owner 联合 review scripts/remove-worktree.sh**
7. **恢复 commit 的代码漂移**：被回滚的 4 个 commit 距今已 18 天（Aug 23 → Sep 10），期间 master 上有 ~30 个 commit 影响 `SubagentTool.ts` 与相关模块（已知 `31a2b308 refactor(agent): rename AgentTool → SubagentTool`）— **不能直接 cherry-pick，需要手动重写**（Cherry-pick 估计解决冲突 < 10 处）
9. **WorktreeDb 与 core-db 命名空间冲突**：plan 326/327 已建 core-db，复用其 better-sqlite3 模式建独立 `~/.duya/worktrees.db`，不与 duya-main.db 共享
11. **journal_mode Windows 适配**：plan 441 的 `xai_sqlite_journal` 是 Rust，TS 端需单独处理网络挂载判断（参考 grok `JournalMode::for_db_path` 的 statfs 等价 TS 实现）
13. **gc auto trigger 时机**：plan 441 journal 已建 wake bus（plan 476），worktree-gc 可接入，但**本 plan 仅做手动 GC + 接口预留**，auto trigger 留待 plan 476 wake bus 落地后扩展
15. **package `path` 等同物风险**：`packages/agent/src/worktree/` 不与 npm `worktree` 包冲突（同名风险低）但需要在 import 路径上避免混淆
17. **node 进程 abort 行为**：Node AbortSignal 与 grok `tokio_util::sync::CancellationToken` 在语义上有微妙差异（Node abort 是单向 cancel，不可恢复；grok 是可重用 token）— **P1.3 的 cancellation.ts 抽象层必须明示这一差异**
19. **sub-agent 工具 cwd 假设破坏**：plan 504/481/506 内可能有代码假设 sub-agent 与父会话共享 cwd — P2.1 实施时需在每个 sub-agent 消费点加 cwd 重写（**这是波及面最大的风险**）
21. **UI 工作量低估**：P4.3 的 sidebar worktree 卡片 + 进入/退出/删除按钮可能需要 1-2 天 UI 工作量；playwright e2e 是真渲染测试，工作量再 +1 天

---

## 7. 决策记录

| 日期 | 决策 | 上下文 |
|---|---|---|
| 2026-09-10 | 立项 plan 496 | 用户审计发现 worktree 框架仅剩 stub，明确要求完整功能实现并指定 codex + grok-build 为参考 |
| 2026-09-10 | 主要参考对象 = grok-build `xai-fast-worktree` | 三层架构完整 + WorktreeBuilder 链式 API + cancellation token + WorktreeDb 注册表 + WorktreeSync pool + sub-agent snapshot/rehydrate 生命周期，TS 移植最自然 |
| 2026-09-10 | 次要参考 = codex trust 路径 | trust 校验 + fsmonitor 保留 + AGENTS.md 继承 — 借鉴价值低于 grok，作为未来 plan 立项 |
| 2026-09-10 | 路径方案：D1 决策 | 默认 `.duya/worktrees/<plan-id>-<slug>/`；外置通过 `config.toml [worktree] base_dir` 配置；现有 plan 479 活跃 worktree 不迁移 |
| 2026-09-10 | 分支命名：D2 决策 | 强制 `<type>/<plan>-<slug>` 形态；`scripts/create-worktree.sh` 强制校验 |
| 2026-09-10 | sub-agent 策略：D3 决策 | 各开临时 worktree + foreground/background 双路径清理 |
| 2026-09-10 | pool 不实施：D4 决策 | grok 自家注明 future-use；保留 V2 stub |
| 2026-09-10 | trust 不实施：D5 决策 | 留 TODO + 未来 plan 立项 |
| 2026-09-10 | journal 复用 plan 441：D6 决策 | 不新增事件类型；worktree metadata 仅扩展 session metadata key |
| 2026-09-10 | IPC 复用现有模式：D7 决策 | channel 命名与 grok RPC 对齐（`worktree:create` 对应 `workspace.create_worktree`），不引入新架构 |
| 2026-09-10 | 清理双路径：D8 决策 | foreground/background 双路径清理（与原 52fe697d 一致） |

---

## 8. 调研原始记录（后续填入）

### 8.1 grok-build 待调查清单

- `crates/codegen/xai-fast-worktree/src/lib.rs`、`api.rs`、`discovery.rs`、`util.rs`、`sync.rs`、`auto_gc.rs`、`mount_info.rs`
- `crates/codegen/xai-fast-worktree/src/worktree/{mod.rs, execute.rs, plan.rs}`
- `crates/codegen/xai-fast-worktree/src/git/{mod.rs, checkout.rs, discovery.rs, index.rs, status.rs, worktree.rs}`
- `crates/codegen/xai-fast-worktree/src/btrfs/`、`overlay/`、`copy/`、`db/`
- `crates/codegen/xai-fast-worktree/src/bin/{cli.rs, pool_perf_bench.rs}`
- `crates/codegen/xai-grok-pager/src/worktree_cmd/`
- `crates/codegen/xai-grok-shell/src/extensions/worktree.rs`
- `crates/codegen/xai-grok-shell/src/session/{worktree.rs, worktree_pool.rs}`
- `crates/codegen/xai-grok-shell/src/util/config/worktree.rs`
- `crates/codegen/xai-grok-workspace-types/src/rpc/worktree.rs`
- `crates/codegen/xai-grok-workspace/src/worktree/`

### 8.2 codex 待调查清单

- `codex-rs/core/src/worktree_trust_tests.rs`
- `codex-rs/core/tests/suite/worktree_trust.rs`
- 相关 worktree 引用文件：`core/src/commands/init.rs`、`core/src/project_doc.rs`、`core/src/git_info.rs`、app-server 相关协议
- AGENTS.md 中 worktree 相关章节

### 8.3 codex git history (worktree 相关)

```
4b0f44d304 Add worktree classification to thread telemetry (#43621)
bc3545b805 Validate linked worktrees before inheriting project trust (#39616)
dffc4bf75d [codex] preserve fsmonitor for worktree Git reads (#26880)
2afa2b0c33 fix: validate linked worktree trust metadata
7a857a306a fix(git-utils): validate linked worktree trust targets
55d9c76f52 Canonicalize linked worktree hook trust keys
820b234810 core: inherit AGENTS override in linked worktrees
934a40c7d9 Use root repo hooks in linked worktrees (#21969)
327f449cc6 share project hook trust across worktrees
eb04235b41 Codex worktree snapshot: new-branch-cleanup
```