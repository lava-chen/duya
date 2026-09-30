# Codex Thread 与 Worktree 管理机制参考

> **状态**: 参考资料（reference）· **调研日期**: 2026-09-30 · **调研者**: mavis
> **参考源码**: `E:\cloned-projects\codex`（openai/codex）
> **用途**: 为 duya 的 session 归档对齐（Plan 549）、worktree 框架（Plan 496）提供一手实现细节。
> 本文件只记录**已核实的实现事实**，不记录推测。

---

## 0. 重要更正：本地 clone 处于过期 detached HEAD

调研过程中发现的一个陷阱，任何人复查本文件前必须先知道：

| 项 | 值 |
|---|---|
| 本地 HEAD | `2df6705423`（**2026-08-24**，detached） |
| `origin/main` HEAD | `bcd6d9ab6b`（**2026-09-30**） |
| 本地远端 ref 数 | 4693 |

**本地检出的代码比 master 落后约 5 周。** 在 detached HEAD 上会得出与 master 相反的结论 —— 最初的调查就因此误判"codex 没有 worktree 机制"，而实际上 `codex-worktree` crate 在 `origin/main` 上真实存在。

**复查本文件任何结论前，先执行**：

```powershell
Set-Location E:\cloned-projects\codex
git fetch origin
git log -1 --date=short --pretty='%ad %h %s' origin/main
# 读 origin/main 上的文件而不切换检出：
git show origin/main:codex-rs/worktree/src/lib.rs
```

---

## 1. Thread 管理总览

### 1.1 四层实体

v1 协议文档（`codex-rs/docs/protocol_v1.md`）定义的词汇表与现代实现的映射：

| v1 词汇 | 现代实现 | 位置 |
|---|---|---|
| `Codex` | `ThreadManager`（进程级注册表 + 策略） | `codex-rs/core/src/thread_manager.rs:218` |
| `Session` | `CodexThread`（7 字段的薄管道）→ `Session`（真状态机） | `core/src/codex_thread.rs:202`、`core/src/session/session.rs:40` |
| `Task` | `ActiveTurn`（`Mutex<Option<ActiveTurn>>`，唯一槽位） | `core/src/session/session.rs` |
| `Turn` | 一次模型请求 + 工具执行 + 审批暂停 | — |

核心不变量：**一个 Session 同一时刻最多一个运行中的 Task**（`session/session.rs:39` 注释原文："A session has at most 1 running task at a time, and can be interrupted by user input."）。

`ThreadManagerState` 被 `Arc` 包住是为了能 downgrade 给 `AgentControl`（`Weak`），避免 `ThreadManagerState → CodexThread → Session → SessionServices → ThreadManagerState` 的引用环（`core/src/agent/control.rs:111`）。

### 1.2 存储双层：JSONL 权威 + SQLite 可重建投影

```
$CODEX_HOME/  (默认 ~/.codex)
├── sessions/YYYY/MM/DD/rollout-<ts>-<thread-uuid>.jsonl    ← 权威源
├── archived_sessions/rollout-<ts>-<thread-uuid>.jsonl       ← 扁平，无日期层级
├── session_index.jsonl          append-only 名字索引
├── thread-writer-locks/<thread-uuid>.lock                   ← 跨进程文件锁
├── rollout-migrations/<id>.pending                           ← 崩溃恢复 journal
└── state_5.sqlite          threads / thread_spawn_edges / thread_sections / projects
    thread_history_1.sqlite  thread_turns / thread_items + (byte_offset, ordinal) 双游标
```

**核心不变量**（`thread-store/src/local/live_writer.rs:309-352`，注释原文）：

```rust
// SQLite is a rebuildable view. The flush barrier must win before projection starts so it
// can lag JSONL after failure, but can never get ahead of canonical history.
durable_write(&recorder, write_op).await?;                       // ① JSONL 先落盘
if let Err(err) = materialize_to_sqlite(...).await {
    warn!("failed to project durable rollout: {err}");            // ② SQLite 失败只 warn
}
```

**SQLite 永远滞后于 JSONL，永不超前。** 投影用增量 byte-offset 游标续读，只处理 newline 结尾的完整行，每行 ordinal 必须严格连续，解析失败的行**挂起**而非丢弃（等更大 ordinal 证明它是否真的消耗 ordinal 空间）。游标推进与写入在同一 `BEGIN IMMEDIATE` 事务内完成。

**rollout 路径解析四级 fallback**（`thread-store/src/local/thread_rollout_resolver.rs:73`）：
live writer → SQLite `rollout_path` → 文件系统扫描 → archived 扫描（仅 `include_archived`）。

### 1.3 归档 = 物理文件移动

**这是 codex thread 系统最反直觉的一点。** `thread-store/src/local/archive_thread.rs:115` 就是一行 `std::fs::rename(source, destination)`：

```
sessions/YYYY/MM/DD/rollout-….jsonl  →  archived_sessions/rollout-….jsonl   （日期层级拍平）
```

完整执行序列（`archive_thread.rs:63-146`）：

```
PHASE 1 — preflight（不碰任何文件）
  lock_lifecycle(所有 id，排序去重防死锁)
  live_recorders 命中任一 → Conflict（整体失败）
  acquire_writer_locks()  ← 跨进程文件锁
  RolloutReferenceIndex::scan(codex_home)

PHASE 2 — 执行
  for (i, (src, dst)) in plan:
      std::fs::rename(src, dst)
      失败 → restore_rollout_moves(&plan[..i]) 逆序回滚已挪的文件
  state_db.mark_archived(thread_id, dst, now())
      失败 → restore_rollout_moves(&plan) 全量回滚
```

**这是一个手写的两阶段提交**：文件先动、SQLite 后动，中间失败用 `restore_rollout_moves` 补偿。没有事务库参与。

#### archive / unarchive / delete 三者对照

| 维度 | archive | unarchive | delete |
|---|---|---|---|
| 文件 | 移到 `archived_sessions/`（**扁平化**） | 移回，**从文件名时间戳重建** `Y/M/D/` | 硬删 |
| spawn 子树 | **递归**整棵 | **只处理单个** | 递归 |
| SQLite | `archived_at` + `rollout_path` | `archived_at=NULL` | 删行 |
| thread_items | **完全不动** | 不动 | 删 |
| 响应载荷 | `{}` 空 | `{thread}` 非空 | `{}` |
| 可逆 | 是 | — | 否 |

**archive 递归而 unarchive 不递归** —— 解档父节点不解档子树，协议层无补偿手段。

#### 归档的可见性语义

- `thread/list` 默认 `archived.unwrap_or(false)`（`app-server/src/request_processors/thread_processor.rs:2492`），**协议不提供"包含全部"选项**，看两边需发两次请求
- v2 `Thread` 结构体上**没有 `archived` 字段**（`app-server-protocol/src/protocol/v2/thread_data.rs:199-272`）。客户端只能靠 `thread/list{archived:true}` 扫描或自己收到的通知
- 归档**会**改 `updated_at`（用文件 mtime 覆盖），**不会**改 `recency_at`（`state/src/runtime/threads.rs:929` 显式 `recency_at = threads.recency_at`）。**"最近更新"与"最近使用"是两个独立排序维度**
- 归档后**不能直接 resume / fork**，CLI 拦截并提示先 `codex unarchive`（commit `d944ce83a2`，2026-08-20）
- 归档**会 unload 整棵已加载子树**（commit `a1d4aea265`，2026-08-23）
- 归档**不删任何 item**，纯可见性 + 位置变更

#### 归档演进史（git log）

| 日期 | commit | 事件 |
|---|---|---|
| 2026-02 | `feat: sqlite 1 (#10004)` | `archived_at` 首次出现 |
| 2026-02 | `#10544` | 列表改为 **SQLite 优先**，文件系统降级 fallback |
| 2026-07-23 | `#35031` | 归档/删除强制 single-writer ownership |
| 2026-08-07 | `#37369` | 归档**首次进入 TUI**（resume picker） |
| 2026-08-18 | `#39256` | 归档移动 rollout 去重（SQLite 可能持有非规范路径） |
| 2026-08-20 | `#39640` | 归档后 resume/fork 需先解档 |
| 2026-08-23 | `#40179` | 归档 tree 时关闭已 resume 的后代 |

### 1.4 生命周期操作

| 操作 | 语义 | 关键实现 |
|---|---|---|
| `start` | 新建 | `InitialHistory::New` |
| `resume` | **幂等**：已跑则直接返回现有 runtime（`Arc::ptr_eq` 相同）；停了则同 id 重建 | `InitialHistory::Resumed{conversation_id}` |
| `fork` | **不动源 thread**。从持久化历史读，源甚至不必在活跃表里 | `InitialHistory::Forked(截断后的 Vec<RolloutItem>)` |
| `rollback`（已弃用） | **日志从不重写** —— 尾部追加 `ThreadRolledBack{num_turns}` 标记 | 所有读取方必须应用该 marker |
| `revert` | copy-on-write：新文件 `<thread-id>_<rollout-id>.jsonl`，CAS 切 SQLite 指针，旧文件不删 | 仅 paginated 模式支持 |

**fork 后新 rollout 内容 = 源 rollout 的严格前缀 + 一条新的 `ThreadSettingsApplied`**（Session 启动时写的，非复制）。

`resume` 与 `fork` 的实现差异**只有一处**：构造的 `InitialHistory` 变体不同，共用同一个 `spawn_thread` 出口。

### 1.5 两层队列

| 层 | 位置 | 语义 |
|---|---|---|
| 内存 | `TurnState.pending_input`（turn 内 steer）、`InputQueue.mailbox`（agent 间） | 进程内，turn 内消费 |
| 持久化 | SQLite `queued_items`（独立 `queue_1.sqlite`） | **跨进程/重启**，"turn 执行中继续输入"走这条 |

层 2 的轮询：先用极廉价的 `PRAGMA data_version` 判断"有无变化"，变了才查 `queued_thread_revisions` 变化索引表（三个 trigger 自动维护）。派发是**先启动成功、再删队列行**（崩溃安全）。`ThreadIdleCause::Interrupted`（用户按 Esc）时**不派发**。

### 1.6 派生树是森林，不是 DAG

`state/migrations/0021_thread_spawn_edges.sql`：

```sql
CREATE TABLE thread_spawn_edges (
    parent_thread_id TEXT NOT NULL,
    child_thread_id  TEXT NOT NULL PRIMARY KEY,   -- ★ 一个子 thread 最多一个父
    status TEXT NOT NULL                            -- Open | Closed
);
```

`Closed` 边**剪断整棵子树的遍历**，不只是隐藏那一个节点（`agent-graph-store/src/store.rs:50-54`）。

三套正交标识：运行时血缘 `SessionSource::SubAgent(ThreadSpawn{parent_thread_id, depth})` / 持久化拓扑 `thread_spawn_edges` / 产品分类 `threads.thread_source`。

---

## 2. Worktree 管理（master 真实实现）

> **本节全部基于 `origin/main`（`bcd6d9ab6b`）核实。**

### 2.1 定位：session 级 managed worktree，不是 per-thread 自动隔离

`codex-rs/worktree/`（crate 名 `codex-worktree`，2026-08 至 09 新增）提供的是**用户主动创建的"受管检出（managed checkout）"**，并把 thread 绑定上去。它**不是**"每个 thread 自动分配一个 worktree"。

| 项 | 值 |
|---|---|
| crate | `codex-rs/worktree/` → `codex-worktree` |
| 文件 | `lib.rs`（WorktreeManager）、`paths.rs`、`git.rs`、`settings.rs`、`metadata.rs` + `tests/worktree.rs` |
| 依赖 | `anyhow` / `codex-git-utils` / `codex-protocol` / `dunce` / `tempfile` / `uuid` |

### 2.2 核心数据结构

```rust
// codex-rs/worktree/src/lib.rs
pub struct ManagedWorktree {
    pub root:       PathBuf,   // worktree 根
    pub cwd:        PathBuf,   // 启动该 thread 应使用的 cwd（root + 源相对路径）
    pub source_root: PathBuf,  // 源仓库根
    pub source_cwd:  PathBuf,  // 源 cwd
    pub head_sha:   String,
    /// UTF-8 branch label，缺失不代表 detached HEAD
    pub branch:     Option<String>,
}

pub struct WorktreeManager { settings: WorktreeSettings }

impl WorktreeManager {
    pub fn create(&self, request: &CreateWorktree) -> Result<ManagedWorktree>;
    pub fn list(&self, source_cwd: &Path) -> Result<Vec<ManagedWorktree>>;
    pub fn bind_thread(&self, checkout: &Path, thread_id: &str) -> Result<()>;
    pub fn owner(&self, checkout: &Path) -> Result<Option<String>>;
    pub fn remove(&self, source_cwd: &Path, root: &Path) -> Result<()>;
}
```

### 2.3 创建流程（`lib.rs::create`）

```
1. 校验 settings.root 是绝对路径
2. dunce::canonicalize(source_cwd) → repository_root() → relative_cwd
3. git rev-parse --verify --end-of-options "<base|HEAD>^{commit}" → head_sha
4. allocate_worktree_root(settings.root, repository_name)
      → 循环 65536 次: Uuid::new_v4().simple()[..4] 作为 bucket
      → fs::create_dir(bucket) 成功即用（AlreadyExists 则重试）
      → macOS 额外写 .metadata_never_index 禁 Spotlight 索引
5. git worktree add --detach --no-checkout <root> <head_sha>
      失败 → remove_empty_bucket(root) 并返回
6. git config --file <config.worktree> core.worktree <root>
   + git --work-tree=. reset --hard --no-recurse-submodules <head_sha>
      失败 → remove_worktree(source_root, root) 回滚
7. is_safe_worktree_cwd(root, cwd) 校验
      失败 → 回滚 + bail
```

**关键设计决策**：

- **永远 `--detach`**，从不建分支。`branch` 字段是"若已有则记录"，不是创建目标
- **`--no-checkout` + 显式 `reset --hard`** 两步：先建空壳再物化，避免 checkout 阶段失败留下半成品
- **只写目标 worktree 的 `config.worktree`**，不动共享设置、不给源仓库开 `worktreeConfig`
- **回滚路径是 `git worktree remove --force` + `remove_empty_bucket`**，两步都做

### 2.4 路径布局（`paths.rs` + `has_managed_layout`）

```
<settings.root>/<4位hex>/<repository_name>/
  e.g.  ~/.codex/worktrees/a3f1/duya/
```

`has_managed_layout` 的严格校验（`lib.rs`）：

```rust
bucket.len() == 4 && bucket.bytes().all(|b| b.is_ascii_hexdigit())
    && 后面恰好还有一个路径组件
```

`allocate_worktree_root` 用 `fs::create_dir` 的 `AlreadyExists` 做原子抢占（不是 `mkdir` + 检查），最多试 65536 次。清理时 `remove_empty_bucket` 只删 bucket 目录（`fs::remove_dir`，非递归，bucket 非空会失败并被忽略）。

### 2.5 thread 绑定：原子 owner 记录（`metadata.rs`）

**这是 worktree 与 thread 的唯一连接点。**

```rust
// 文件名 codex-thread.json，放在 worktree 的 git 路径下（rev-parse --git-path）
struct OwnerRecord {
    version: u8,              // OWNER_VERSION = 1
    owner_thread_id: String,
}
```

`bind_thread` 的原子性保证：

```
1. thread_id 为空 → bail
2. owner(checkout)? 若已存在:
     相同 thread_id → Ok(())            （幂等）
     不同 thread_id → bail("worktree already belongs to thread {existing}")
3. NamedTempFile::new_in(同目录) 写入 → flush()
4. temporary.persist_noclobber(&path)        ← 不覆盖已存在文件
     AlreadyExists → 复查 owner：
        仍是自己 → Ok(())
        不是自己 → bail("worktree was concurrently assigned to another thread")
```

**"不覆盖另一个 owner"是用 `persist_noclobber` 在文件系统层保证的**，不是读-改-写。并发分配会有一方明确失败而不是静默夺权。

`owner()` 对 `version != 1` 或空 `owner_thread_id` 直接 bail（不宽容）。

### 2.6 删除的三重拒绝（`lib.rs::remove`）

```rust
1. 必须在 list(source_cwd) 里（否则 bail "not a managed worktree in this repository"）
2. 若 source_cwd 位于 checkout_root 之内 → bail
   "switch to another checkout before deleting the current worktree"
3. git ls-files --others --ignored --exclude-standard -z 非空 → bail
   "worktree contains ignored local files; remove them before deleting it"
4. git worktree remove <root>   （无 --force）
5. remove_empty_bucket(root)
```

内部回滚用的 `remove_worktree()` 才带 `--force`。

### 2.7 `list()` 的防御性校验（最值得抄的部分）

`list()` 对每个 `git worktree list --porcelain -z` 条目做**六层校验**，任何一层不过就跳过：

1. `root` 与其 `bucket` 都必须是**真实目录**（`fs::symlink_metadata().file_type().is_dir()`）—— 挡住 symlink 别名
2. `has_managed_layout` —— 必须在受管根下且是 4 位 hex 桶
3. `canonical_root/.git` 必须是**文件**（linked worktree 形态）
4. `linked_worktree_common_dir(canonical_root)` 必须等于源仓库的 `--git-common-dir`
5. **gitdir backlink 校验**：读 `<git-dir>/gitdir`，canonicalize 后必须等于 `canonical_root/.git`
   （注释说明：*"A different linked checkout can occupy a stale registration's path. Require its administration directory to point back to this checkout."*）
6. `is_safe_worktree_cwd(canonical_root, cwd)` —— cwd 必须在 root 内且是已存在目录

`linked_worktree_common_dir` 额外要求 `checkout == repository_root(checkout)` 且 `git_dir != common_dir`（否则不是 linked worktree）。

结果按 `root` 字典序排序，保证输出确定性。

### 2.8 设置（`settings.rs`）

```rust
pub struct WorktreeSettings {
    pub root: PathBuf,                 // 默认 codex_home.join("worktrees")
    pub auto_cleanup_enabled: bool,    // 默认 true
    pub keep_count: usize,             // 默认 DEFAULT_WORKTREE_KEEP_COUNT = 15
}
```

从 `[desktop]` 配置解析（**不引入新配置格式**）：

| 键 | 类型 | 约束 |
|---|---|---|
| `git-worktree-root` | string | **必须是绝对路径**（否则 bail），空串回退默认 |
| `worktree-auto-cleanup-enabled` | bool | 默认 true |
| `worktree-keep-count` | u64 | **必须 > 0**（0 → bail），默认 15 |

`for_cli(codex_home, desktop)` 的注释说明了设计意图：

> Shares Desktop's allocation root while leaving CLI cleanup disabled.

即 **CLI 与 Desktop 共享同一分配根（互相可见对方的 worktree），但 CLI 不开自动清理**。`auto_cleanup_enabled` 在 `for_cli` 里被硬编码为 `false`。

### 2.9 暴露方式：TUI 直连 + agent 工具，双通道

- **app-server 协议层零命中** —— `git grep -i worktree origin/main -- codex-rs/app-server-protocol/**` 无结果。**worktree 没有 JSON-RPC 接口**
- **TUI 直连 Rust**：`tui/src/app/managed_worktree_creation.rs`、`tui/src/app/agents_overview*.rs`（4 个文件 + 快照测试）、`tui/src/app/session_lifecycle.rs`、`tui/src/app/startup.rs`、`tui/src/app/reconnect.rs`
- **agent 工具**：`tui/assets/tooltips.txt` 含 worktree 条目 → 走 `codex_tui` 动态工具命名空间（见 2.10）
- `agents_overview` 有专门的创建中（busy）状态快照：`overview_worktree_creation_busy_state.snap`

### 2.10 三个控制面（同一套 thread 操作）

| 控制面 | 入口 | 特点 |
|---|---|---|
| **人** | TUI `/archive`、`/fork`、`/rename`、picker `Ctrl+A`、CLI `codex archive/delete/unarchive` | 归档当前会话会退出进程 |
| **客户端应用** | app-server JSON-RPC（30+ 方法） | 单点宏注册 `common.rs:203` 同时生成 Rust 枚举 + TS + JSON Schema |
| **Agent 自己** | `codex_tui` 工具命名空间（commit `a8468330bb`，2026-08-24） | agent 可 list / read / fork / message / rename / **archive** / restore 其他 task，走**带审批的本地 MCP** |

TUI 两处值得抄的设计：**软快捷键主动让位**（`Ctrl+A` 若被用户 keymap 占用则静默禁用）、**能力降级而非报错**（远程 app-server 返回 method-not-found → 置 flag 永久停用）。

---

## 3. 值得借鉴的设计模式

### 3.1 存储层

| 模式 | 出处 | 说明 |
|---|---|---|
| **单向屏障不变量** | `thread-store/src/local/live_writer.rs:309` | SQLite 可重建投影，滞后但永不超前；失败只 warn |
| **增量双游标投影** | `thread_history_materialization.rs` | (byte_offset, ordinal) 同事务推进，崩溃后续跑 |
| **手工补偿事务** | `archive_thread.rs:114-140` | `restore_rollout_moves` 让文件操作语义完整，无需事务库 |
| **preflight / execute 两阶段** | `ArchiveThreadsParams.writer_lock_thread_ids` | 先把所有锁拿齐再动一个字节 |
| **`title == first_user_message` 作哨兵** | `helpers.rs:274-287` | 省掉一个 nullable 列表达"用户没改过" |
| **稀疏秩排序** | `state/src/runtime/thread_section_order.rs:9` | `SECTION_POSITION_GAP = 1_000_000`，插入取算术中点，O(1) |
| **三态 PATCH** | `types.rs:676` | `Option<Option<T>>` + `optional_option`：`{}`=不改，`null`=清空 |
| **跨进程文件锁** | `thread-store/src/local/writer_lock.rs` | `try_lock` + 靠 OS 退出自动释放识别陈旧锁 |
| **为旧二进制写 trigger** | `migrations/0025`、`0039` | 新旧版本共存是生产常态 |

### 3.2 Worktree 层

| 模式 | 出处 | 说明 |
|---|---|---|
| **原子抢占目录** | `paths.rs::allocate_worktree_root` | `fs::create_dir` 的 `AlreadyExists` 而非 check-then-mkdir |
| **`persist_noclobber` 绑定** | `metadata.rs::bind_thread` | "不覆盖另一个 owner"由 FS 保证，并发失败可见 |
| **删除前三重拒绝** | `lib.rs::remove` | 拒绝删除当前 cwd 所在树、拒绝有 ignored 文件的树 |
| **gitdir backlink 校验** | `lib.rs::list` 步骤 5 | 挡住"陈旧注册被别的 checkout 占用"的路径劫持 |
| **不引入新配置格式** | `settings.rs` | 复用 `[desktop]`，CLI 与 Desktop 共享分配根但 cleanup 独立 |
| **`--detach` + 两步物化** | `lib.rs::create` | `--no-checkout` 后显式 `reset --hard`，失败易回滚 |

### 3.3 协议层

| 模式 | 出处 | 说明 |
|---|---|---|
| **单点注册表** | `app-server-protocol/src/protocol/common.rs:203` | 宏同时生成 Rust 枚举 + TS + JSON Schema |
| **能力探测错误码** | `ThreadStoreError::Unsupported → -32601` | 客户端可区分"后端不支持"vs"参数错误" |
| **显式并发策略标注** | `common.rs:132-197` | `serialization: thread_id/global/none`，review 时可见 |
| **双向游标分页** | `thread.rs:1517-1520` | `nextCursor` + `backwardsCursor`；游标锚定**页首**时间戳，"so same-second updates are not skipped" |
| **断连式背压** | `app-server/src/transport.rs:156-168` | WebSocket 缓冲 32K，满了直接踢慢客户端 |

---

## 4. 反直觉 / 易踩坑清单

1. **归档不是软删除**，是物理 `fs::rename` + 日期层级拍平
2. **archive 递归、unarchive 不递归** —— 解档父不解档子树
3. **重复 archive 静默成功**：返回 `{}` + 零通知，做 ack 同步的客户端会一直等
4. **archive 通知无序**：响应后跟 0..N 条，**最深的子孙先到、父最后到**（`archive_thread_ids[1..].reverse()`）
5. **archive 通知是全局广播**，不受 `thread/unsubscribe` 约束
6. **子孙归档失败不影响整体成功**（只 `warn!`），可能出现"父已归档、子仍活跃"的分裂态
7. **批次语义是"首个必须成功，后续 best-effort"** —— 返回的 `Vec<ThreadId>` 才是真正成功的集合
8. **单数 `archive_thread` 只是复数版包装**，`writer_lock_thread_ids` 为空 → 无子树 preflight 保护
9. **v2 `Thread` 没有 `archived` 字段**，`archived` 是纯查询参数
10. **`thread/unsubscribe` 不卸载 thread**，turn 继续跑、状态缓存保留，等 idle 超时才 `thread/closed`
11. **归档后不能直接 resume/fork**，必须先解档
12. **`is_pinned` 是死代码**（migration 0043 建的列全仓零引用，语义已被 0045 的 `thread_sections` 取代）
13. **Thread section 能力 TUI 零接入** —— 全部 6 个 `thread/list` 调用点都是 `section_id: None`
14. **fork 后新 rollout = 源严格前缀 + 一条新的 `ThreadSettingsApplied`**
15. **worktree 的 `branch` 字段缺失不代表 detached** —— 永远是 `--detach` 创建的
16. **CLI 共享 Desktop 的 worktree 分配根但不开自动清理**（`for_cli` 硬编码 `auto_cleanup_enabled: false`）

---

## 5. 与 duya 现有工作的对应关系

| duya 计划 | codex 对应物 | 状态 |
|---|---|---|
| Plan 549 归档对齐 codex | `thread-store/src/local/archive_thread.rs` + `unarchive_thread.rs` | 计划中；调研前提经本次核实成立 |
| Plan 496 worktree 框架 | `codex-rs/worktree/`（master `bcd6d9ab6b`） | 计划中；**调研前提成立**（本地 clone 过期导致一度误判） |
| Plan 547 session/project 菜单 | TUI `resume_picker` + `session_archive_commands.rs` | 已完成 |

### 5.1 Plan 549 需要修正的一处前提

Plan 549 §1.2 表格写 `codex` 的归档视图是「`list_threads({ status: 'archived', true/false/None })` 三态过滤」。**核实后 codex 实际是二态**：`archived.unwrap_or(false)`，只有"只归档"和"只未归档"，**没有"全部"选项**。若 duya 要做三态，那是超出 codex 的增强，需在 plan 里显式标注为 duya 自有决策。

### 5.2 Plan 496 需要修正的前提

Plan 496 §3.2 的 crate 描述（`lib.rs` 155 行 / `paths.rs` 76 行 / `tests/worktree.rs` 371 行）与 master 实测基本吻合，但有两处偏差需在实施前核对：

1. master 上 crate 已新增 `metadata.rs`（thread 绑定），plan §3.2.1 的文件表里**没有这一项**
2. `paths.rs` 的桶分配是 `Uuid::new_v4().simple()[..4]` + `create_dir` 原子抢占，plan 未记录该算法

---

## 6. 未核实 / 待补

- `tui/src/app/managed_worktree_creation.rs` 与 `agents_overview*` 的完整交互流未细读
- `codex_tui` 工具命名空间中 worktree 相关工具的完整 schema 未查
- worktree 的自动清理（`auto_cleanup_enabled` + `keep_count`）的实际执行点未定位
- `git.rs` 的 `GitOperation` 分组（`WorkingTree` / `Metadata`）用途未逐项核实
- `origin/main` 之后是否还有 worktree 相关变更未跟踪（本地 clone 需 `git fetch` 后复查）
