# 621 — Coding Workspace Lifecycle Harness（Session → Checkout → ChangeSet → Integration）

状态：active（既有 A–F 已合并；P0 PR #460 与 P1a draft PR #465 待 review/CI；执行屏障已实现与验证）· 负责人：Codex `/root` · 更新：2026-10-24
分支：`codex/worktree-p1` · worktree：`/workspace/work/duya-worktree-p1` · base：`c4eeef11`（P0）；接续见文末。

关联：[496 Worktree 框架](./496-worktree-framework-implementation.md)（提供隔离实现，本计划接续其「统一生命周期 / 回收 / journal」三项未完成范围）·
[587 C6 ControlPlane 与 Workspace](../active/587-agent-harness-monorepo/07-control-plane-and-workspace.md)（C6.2 身份、C6.3 resolver、C6.5 Goal/Task）·
[618 桌面端管理控制面](./618-duya-desktop-management-layer.md)（`mcp__ccd_pr__` / `mcp__ccd_host__` 的 agent 工具面，本计划只提供其依赖的数据面）·
[620 会话记录架构](./620-session-record-architecture.md)（rollout 分类学单源；`checkout_*` 事件必须从该权威派生）

现况核对基准：`2e6f265d`。`96dadf4d` 只是一次公开树整理（`chore(repo): organize public root tree (#340)`），它携带的 `docs/architecture/2026-10-01-architecture-audit.md` 是 MCP 域审计，不含本主题结论；本计划的每条现状都从当前 master 重新取证。
参照实现：`E:/cloned-projects/codex` @ `c7234c1174`。

## 目标与边界

用户可观察的变化：一个 Session 能回答自己属于哪个 Task、当前在哪个 Git Checkout、跑过哪些 Run、产出哪些 Commit/PR、PR 是否合并、当前 Checkout 能否安全回收；进程重启后答案不变。Desktop / TUI / Web 通过同一个 Host API 得到这些答案，不自行重建映射。

即：**把「身份」与「观测」分开。** 身份持久化并可核对；观测永远可重算、可对账、可过期。任何一处把观测值当身份用，都算违反本契约。

### In scope

| 路径 | 改什么 |
| --- | --- |
| `packages/host/src/workspace/`（新建） | Checkout Provider：创建 / 观测 / 归属 / checkpoint ref / fail-closed 回收 / 写入闸口 |
| `packages/host/src/worker-subagents/worktree.ts` | 收缩为 Provider 的 shim，不再是第二份实现 |
| `packages/host/src/worker-subagents/service.ts` | 接入 Provider；校验子 run 实际 cwd；写入归属；resume cwd 不匹配改为拒绝 |
| `packages/host/src/worker-subagents/background-lifecycle.ts` | 四条终态路径（完成 / 异常退出 / 取消 / 额度中断）记录 Checkout 观测 |
| `packages/agent-protocol/src/checkout-api.ts`（新建） | `HostCheckoutApiV1` 线上契约 |
| `packages/agent-protocol/src/integration-api.ts`（新建） | PR / CI / Review / Merge 契约 |
| `packages/data/src/integration-store.ts`（新建） | 唯一新表（migration 43），外部真相的只读投影 |
| `packages/data/src/core-stores.ts` | 注册新 store 与迁移（仅 B 切片可改） |
| `packages/host/src/checkout-api.ts`、`integration-api.ts`（新建） | Host 侧实现与对账入口 |
| `packages/host/src/http-server.ts`、`local-host.ts` | 路由与组装（仅 B 切片可改） |
| `packages/host/src/scm/`（新建） | 只读 SCM Observer（C）+ 同步写者（E） |
| `packages/ui/`、`apps/desktop/src/preload` + IPC、`packages/cli/src/tui`、`apps/web` | 三端入口（F） |
| `e2e/` | 场景 1–7 的真实链路验证（F） |

### Out of scope

| 不做 | 理由 |
| --- | --- |
| 新建 checkouts / leases 表，或任何 Checkout 的 DB 镜像 | 归属权威是 checkout 内的 owner 文件；加了表就是第二份真相，且崩溃后无法与 git 对账（见决策 D2） |
| 全自动 Merge、自动 GC、Worktree Pool | 用户明确不要求；先做可审计、可恢复、安全 |
| 在 `packages/agent` 内新增权威实现 | 该包正在退役（根 `AGENTS.md`） |
| 在执行位置切换屏障完成前暴露 agent worktree 工具 | 用户于 2026-10-24 明确要求推进主会话工具；原“不新增工具”的决策被覆盖。先完成执行位置一致性，再接入工具与三端 |
| 改 `.architecture-baseline.json` / `architecture-policy.yaml` | 根规则禁止用指纹掩盖新增违规 |
| 跨 session 工作单元（Task 的第二套模型） | 用户决定推后到第二波；第一波 A/B/C 不依赖它，见「待决」 |

## 现状核对（`2e6f265d`）

| 能力 | 现状 | 证据 |
| --- | --- | --- |
| worktree 创建 | 只有一处生产实现，唯一调用点在子代理工具 | `packages/host/src/worker-subagents/worktree.ts:121`、`service.ts:434` |
| 返回形态 | 只有 `{path, branch, repoRoot}`，无归属、无 base、无生命周期 | `worktree.ts:53-60` |
| 分支策略 | `git worktree add -b duya/subagent/<slug>-<hash>` | `worktree.ts:169-176` |
| 重启后的唯一线索 | 把 worktree 路径写进 session 行，与用户自己的目录无法区分 | `service.ts:498` |
| 回收 | **没有实现**；worktree 与分支只增不减 | 全仓无回收调用点 |
| 归属 / 独占 | **不存在**；两个子代理可以被指向同一个目录 | 无相关代码 |
| resume 的 cwd | cwd 不一致只 push 一条 warning，然后**静默**用父会话目录继续跑 | `service.ts:399-407` |
| 子 run 实际 cwd | 创建后不校验子 run 是否真的落在那里 | 无相关代码 |
| Workspace 绑定 | `session_id` 是主键且 `upsertBinding` 已存在即返回旧行 ⇒ 结构上无法切换 | `packages/data/src/workspace-store.ts:190`、`:385-390` |
| 写入互斥 | 现有锁的键是 session 不是 checkout，冲突时直接 UPDATE 覆盖，无 epoch | `packages/data/src/core-stores.ts:514-519`、`:576-583` |
| PR / CI / Review | 全仓无 GitHub 能力 | `packages/{host,data,agent-protocol}` 无 `pull_request` 命中 |
| 安全删除 | 只有开发脚本；产品侧无等价实现 | `scripts/remove-worktree.sh`（无 `rm -rf` 回退、拒绝 dirty/locked/未注册、先 unlink reparse point、detached 必须被某个 ref 包含） |

三条「看起来有、其实没有」：Workspace 绑定不可切换；子代理 resume 会静默离开原 Checkout；PR 关联没有任何落点。

## 契约

### 4.1 四类实体

| 实体 | 是什么 | 身份 | 不是 |
| --- | --- | --- | --- |
| **Session** | 一段对话历史 + 配置 | `sessions.id`（现有真相源，不重建） | 不是执行位置，不是 PR 容器 |
| **Execution Checkout** | 一个真实的 Git 工作副本（linked worktree） | checkout 根路径 + 其内 owner 文件 | 不是 Project，不是 Workspace root |
| **ChangeSet** | 一个 Checkout 上从 base 到 head 的提交序列 | `refs/duya/checkpoint/<session>/<n>` | 不是分支，不作为 Session 字段 |
| **Integration** | 该 ChangeSet 对应的 PR 及其 CI/Review/Merge | `(repo, pr_number)`，外部 GitHub 权威 | 不是 Session 的固定字段，可关联多段 Session 历史 |

关系（全部为多对多或时序，无一是单字段）：

```
Session ──1:N（时序，rollout 事件）──> Checkout 归属变更
Checkout ──1:1（owner 文件，可转移）──> 当前拥有写入权的 Session
Checkout ──1:N（时序）──> ChangeSet（每次成功 Run 打一个 checkpoint）
ChangeSet ──N:1 ──> Integration（一个 PR 对应一组 checkpoint）
Integration ──N:M ──> Session（first_seen / last_seen，同一 PR 跨多段会话）
```

### 4.2 Project Workspace 与 Git Checkout 正交

两者经常被混淆，因为一个 worktree 目录**看起来**就是一个可写目录。规则：

- **Workspace root** 是权限授予：`access` / `access_source` 由 C6.3 resolver 消费，撤销是 `access='none'` 且保留行（`workspace-store.ts:350-360`）。
- **Checkout** 是可回收的临时覆盖层：有 base commit、有 checkpoint、有归属、会被删除。
- Checkout **可以**落在某个 root 的路径下，但**不得**注册为 `workspace_roots` 行。理由：回收 Checkout 会写 `DELETE`，而撤销授权必须保留审计行；两个动作的语义不能共用一张表。
- cwd 解析优先级：Session 的绑定 → 若该 cwd 位于一个已注册 Checkout 内，则 Checkout 先行；否则退回 Workspace root。这条顺序必须只有一处实现。

### 4.3 唯一权威矩阵

| 事实 | 唯一权威 | 本地可重建？ |
| --- | --- | --- |
| Session 身份、配置、归档 | `sessions` 表 | 否（账号级数据） |
| Workspace / root / 授权 | `workspaces`、`workspace_roots` | 否 |
| Checkout 存在性与 HEAD | git（`worktree list --porcelain -z`、`rev-parse`） | 是 |
| Checkout 写入归属 | checkout git dir 内的 owner 文件 | 是（从 session 行无法反推归属） |
| Checkout ⇒ Session 的当前指向 | `sessions.working_directory`（现有列） | 是（可扫） |
| 归属历史（何时进、何时出、为何） | rollout 事件 `checkout_entered` / `checkout_left` | 否（历史只能追加） |
| 提交序列 | git 对象 + `refs/duya/checkpoint/*` | 是 |
| PR / CI / Review / Merge | GitHub | 否（但可重新观测） |
| 观测结果的缓存 | `integrations` 表，全部字段 `observed_*` | 是 |

规则：任何 `observed_*` 字段都不得参与判定「能不能写」「能不能删」「是不是同一个」。判定只读权威列。

### 4.4 三套独立状态

**Execution 状态**不新增：用现有 `runs.status`（`running` / `completed` / `cancelled` / `budget_exhausted` / `failed`，`packages/data/src/run-store.ts:242`）。Checkout 侧只补一个派生量：该 Run 的 cwd 是否落在某个 Checkout 内。

**Checkout 状态**不持久化，每次由观测组合得出（不是单值枚举）：

| 维度 | 取值 | 观测手段 |
| --- | --- | --- |
| 注册 | `registered` / `not_registered` | `worktree list --porcelain -z` + 反向 `gitdir` 校验 |
| 工作区 | `clean` / `dirty_tracked` / `untracked` / `ignored` | `status --porcelain`、`ls-files --others`、`ls-files --others --ignored` |
| 归属 | `owned_by:<session>` / `unowned` / `unreadable` | owner 文件 |
| 可用性 | `reclaimable` / `retained:<原因>` | 4.5 的 fail-closed 判定 |
| 锁定 | `locked` / `unlocked` | `worktree list` 的 `locked` 行 |

**Integration 状态**是外部投影：`none` / `draft` / `open` / `checks_failing` / `checks_passing` / `review_requested` / `changes_requested` / `approved` / `merged` / `closed_unmerged` / `unknown`。`unknown` 是合法终态（观测失败），不得折叠成 `open`。

### 4.5 归属、共享与回收

**写入权由 owner 文件独占决定。** 文件形状与 codex 兼容：`{version:1, ownerThreadId}`，写在 checkout 的 git dir（`rev-parse --git-path`）。以 `O_EXCL` 原子创建；已存在且不同 owner 则拒绝。

- **当前绑定**：owner 文件 = 谁可写。1:1，同一时刻只有一个。
- **多 Session 只读关联**：cwd 指向同一 Checkout 但不是 owner ⇒ 只读，**由构造保证**，不需要第二份声明。强制点只有一个：工具执行边界的写入闸口（读 owner 文件 → 比对调用方 session → 拒绝并给出 typed reason）。
- **历史切换**：owner 转移只能经两条路径之一——①当前 owner 显式让出；②证明旧 owner 已死（该 session 无活跃 run、无 worker 持有）。转移前必须重新观测 git 状态，并把 `checkout_left` / `checkout_entered` 成对写入 rollout。**没有超时过期**：崩溃不自动释放，这正是「租约失效后需要重新确认状态」的落点。
- **回收判定 fail-closed**：下列条件全部满足才 `reclaimable`，任一不满足即 `retained:<原因>` 并且**不执行任何删除**。
  1. git 认它是已注册的 linked worktree，且 `.git` 是文件、`--git-common-dir` 指向源仓库、管理目录 `gitdir` 反向指回；
  2. 不是任何活跃 run 的 cwd 宿主，且 owner 已死或已让出；
  3. `status --porcelain` 为空；
  4. 无 untracked、无 ignored（`ls-files --others`）；
  5. detached HEAD 必须被至少一个 ref 包含（`for-each-ref --contains=HEAD`）；
  6. 树内无 reparse point 残留（Windows，先 unlink 再复扫）；
  7. 目录内无活跃锁。

  删除只走 `git worktree remove`，**不提供 `rm -rf` 回退**。

**ChangeSet 打点**：每次 Run 成功结束（`completed`）后，把 HEAD 写入 `refs/duya/checkpoint/<session>/<n>`（`n` 单调递增）。它是 detached HEAD 的唯一保命手段：没有 ref 的 commit 会在 `worktree remove` 时静默消失。保留策略：每 session 保留最近 20 个，更早的只有在被 Integration 引用时才保留。

### 4.6 观测与对账

对账是显式动作，有四个入口，全部幂等：

| 入口 | 触发 | 修什么 |
| --- | --- | --- |
| 单 Session | Host API 读 | 重算该 Session 当前 Checkout 的观测组合 |
| 单 Checkout | Host API 读 | 重算归属与可回收性 |
| 工作区扫描 | 启动 / 手动 | 发现「DB 有、磁盘无」与「磁盘有、DB 无」；前者写 `retained:missing`，后者**不自动收养**，只报告 |
| Integration | 手动 / 轮询 | 重取 PR 状态，更新 `observed_*` 与 `observed_at` |

规则：对账只改观测列与 rollout 事件，永不改身份列；对账发现冲突时给出双方取值，不选边。

## codex 参照：抄什么、不抄什么

| 项 | codex 做法 | 本计划 |
| --- | --- | --- |
| 归属存储 | `codex-thread.json` 写在 worktree git dir，`persist_noclobber` | **抄**（决策 D2） |
| 归属可转移 | 不可，永久 1:1 | **不抄**：需 prove-dead 转移，否则崩溃即永久占位 |
| 创建 | `add --detach --no-checkout` + 钉 `core.worktree` + `reset --hard` | **抄**（含失败回滚） |
| 分支 | 不建分支，`branch: None` | **抄** + checkpoint ref 保命（决策 D3） |
| 枚举 | 从 `worktree list` 反推 + 四重身份校验 | **抄**，不做 DB 镜像 |
| 回收 | 拒绝 dirty / ignored，`worktree remove` 无 `--force` | **抄**，再加 locked / detached-ref / reparse point（沿用仓库既有脚本语义） |
| 起会话顺序 | 建 checkout → 在 checkout 起 thread → **回读 cwd 比对** → 绑定 → 失败则保留并报错 | **抄**（这是 duya 当前缺的最关键一步） |
| resume cwd 不一致 | 提示用户选择，不静默切换 | **抄**（duya 现在静默） |
| PR / CI / Merge | 不在本地；云端任务 + prompt 层署名 | **不抄**：本计划要求离线可答，需一张 `observed_*` 投影表 |
| agent 工具面 | 无 worktree 工具 | **不抄**；按用户新要求，在 P1 执行屏障上接入 enter/exit |
| 自动清理 | keep-count 15，Desktop 侧实现，CLI 禁用 | **不抄**：只做手动 + 显式授权 |

## 迁移与 schema

core DB 迁移链 = `MessageLog.migrations` + `collectCoreDataMigrations()`（`packages/data/src/core-data-host.ts:85-90`），当前最大 id 为 **42**（`core-stores.ts:394`）。`main-schema.ts` 是**另一个数据库**，编号互不相干，不得混用。id 撞车会静默跳过（`core-database.ts:110,119`）。

- **保留 43**：`create_integrations`（+ 关联表），由 B 独占。
- 44 及以后未分配。后续切片需要新表时必须先核对 `collectCoreDataMigrations()` 的实际最大 id，不得凭本文件数字。
- 本计划**不新增** checkouts / leases / changesets 表。

## 分派

第一波 A/B/C 并行，各自独占路径、独立 worktree、独立 PR。第二波 D/E 仅在 A（Provider 接口）与 B（协议 DTO）合并、且契约一致后启动。F 最后。

| 切片 | 交付 | 独占路径 | 依赖 | 不得触碰 |
| --- | --- | --- | --- | --- |
| **A** Provider | 创建 / 观测 / 归属 / checkpoint / 回收 / 写入闸口；`worker-subagents/worktree.ts` 变为 shim | `packages/host/src/workspace/**`、`packages/host/src/worker-subagents/worktree.ts`、`packages/host/tests/workspace/**` | 无 | `service.ts`、`background-lifecycle.ts`、`core-stores.ts`、`http-server.ts` |
| **B** 协议与投影表 | `HostCheckoutApiV1` / `HostIntegrationApiV1` DTO；migration 43；Host 路由与组装 | `packages/agent-protocol/src/{checkout-api,integration-api}.ts`、`packages/data/src/integration-store.ts`、`packages/data/src/core-stores.ts`、`packages/host/src/{checkout-api,integration-api}.ts`、`packages/host/src/http-server.ts`、`packages/host/src/local-host.ts` | A 的 Provider 接口签名（可用接口桩并行） | `packages/host/src/workspace/**`、`scm/**` |
| **C** 只读 Observer | `gh` 调用封装 + PR/CI/review 观测，纯读无副作用 | `packages/host/src/scm/{gh-cli,observe}.ts`、`packages/host/tests/scm/**` | 无 | 任何 DB 写入 |
| **D** Session 生命周期 | 创建/恢复/终止接入；子 run cwd 回读校验；resume 拒绝；四条终态记录观测 | `packages/host/src/worker-subagents/{service,background-lifecycle,resume-target}.ts` | A + B 合并 | `worktree.ts`（A 拥有） |
| **E** Integration 同步 | 调 C 的 observe，写 B 的表；从任一端查询 | `packages/host/src/scm/sync.ts` | B + C 合并 | `integration-store.ts`（B 拥有，E 只调方法） |
| **F** 三端入口 + E2E | Desktop preload/IPC 窄接口、`packages/ui` 面板、TUI footer/面板、Web、`e2e/` | `packages/ui/**`、`apps/desktop/src/preload/**` + IPC、`packages/cli/src/tui/**`、`apps/web/**`、`e2e/**` | D + E 合并 | 服务端逻辑 |

共享文件冲突规则：`docs/exec-plans/{README,catalog}.md` 由本计划 owner 独占；各切片只在自己的 PR 里追加一行「已完成项」，不整表重排。

每个 PR 正文必须写：路径所有权、Base SHA、依赖 PR、实际执行的测试与退出码、未覆盖风险、接续记录。

## 派工记录（第一波，2026-10-22）

Base 统一 `2e6f265d`；每条分支一个独立 worktree、一个独立 PR；契约文档只在 #359，不复制到下游分支。

| 切片 | owner | worktree | 分支 | HEAD | PR | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| 契约 | 主会话 | `.claude/worktrees/worktree-lifecycle` | `codex/worktree-lifecycle` | `3da7bd85` | #359 | 已合并 |
| A Provider | agent `wl-a-provider` | `.claude/worktrees/wl-a` | `codex/wl-a-checkout-provider` | `133e4c77` | #361 | 已合并（58 例） |
| B 协议 | agent `wl-b-protocol` | `.claude/worktrees/wl-b` | `codex/wl-b-checkout-protocol` | `4d7af9b3` | #363 | 已合并（35 例） |
| C Observer | agent `wl-c-observer` | `.claude/worktrees/wl-c` | `codex/wl-c-scm-observer` | `eb819f02` | #362 | 已合并（61 例） |

## 派工记录（第二波，2026-10-23）

Base 为第一波合并点 `a37c5d68`；三个切片各自 rebase 到最新 master（master 在此期间并入 #364/#365/#367/#369），源码零冲突，冲突只在 `packages/host/bundle/` 生成物（两边都重建过 worker bundle）——按 `docs/development/build.md`「生成物不手工合并」处理：取 master 版本后从源码重建并单独提交。

| 切片 | owner | worktree | 分支 | PR | 状态 |
| --- | --- | --- | --- | --- | --- |
| 接缝 | 主会话 | `.claude/worktrees/wl-seam` | `codex/wl-seam-integration` | #370 | 已合并 |
| E Integration 同步 | agent | `.claude/worktrees/wl-e` | `codex/wl-e-integration-sync` | #371 | 已合并（90 例） |
| D Session 生命周期 | agent（成果由主会话接手） | `.claude/worktrees/wl-d` | `codex/wl-d-session-lifecycle` | #372 | 已合并（114 例） |
| 组装接线 | 主会话 | `.claude/worktrees/wl-seam` | `codex/wl-seam2-host-wiring` | #373 | 见下方接续点 |

### 已知的跨切片接续点（合并不是终点）

1. **B 先于 C 合**。C 在自己树里建了 `scm/integration-state.ts`（因为 B 的 `HostIntegrationState` 当时不在 master）。B 合并后 C 必须删该文件改 `import type`，`scm/index.ts` 对外名字不变。**已解决**：接缝提交 #370 删除该文件，union 改从 `@duya/agent-protocol` 导入。
2. **B 的 `checkout-api.ts` 用结构端口，没接 A 的实现**。需要接线提交：`createCheckoutProvider({ isSessionAlive, cwdInUse })` 注入，并补 `resolveSessionCheckoutRoot(sessionId)`。**已解决**：#370 注入 A 的 Provider 并补 resolver；D 切片提供 aliveness port 的真实判据，本波的组装提交把两者接进 `local-host`。
3. **A 改了 `IsolatedWorktree.branch` 的语义**：detached 下返回 12 位短 SHA，不再是分支名。D 必须同时改 `service.ts:186` 的 "on branch …" 文案，以及 `IsolatedWorktree.path` 现在是 `cwd` 而非 worktree 根。**已解决**：#372 改了文案（notice 与后台回执两处）。
4. **`integrations` 表是单行 upsert**，契约 §4.4 要求「状态迁移不覆盖历史」还没有落点。E 必须决定：加 `integration_events` 表，还是把迁移写进 rollout。**已解决**：E 加了 migration 44 `integration_events`，**状态变化才追加**。

### 仍然开放的接续点

5. **归属历史的临时载体**。D 用 `sessions.extensions.checkout` 承载 checkout 归属历史，因为 rollout 事件分类学归 plan 620。620 落地后必须迁移——**这是已知偏离，不是终态设计**。
6. **`resume_from` 的错误码与 rollout 记录**。契约风险 §4 要求 resume 从 warning 改为拒绝时「需要明确错误码与 rollout 记录」；#372 实现的是 typed 错误文案，但 rollout 事件仍待 620 补齐。

## 验收

门禁（每个切片都跑，退出码进验证记录）：`npm run typecheck:all`、`npm run architecture:check`、目标 vitest。

| # | 场景 | 落点 | 判据 |
| --- | --- | --- | --- |
| 1 | 建 worktree → 绑 Session → 多轮 Run → 重启后同一 Checkout | A + D | 重启后 Host API 返回同一路径与同一 owner；cwd 不一致时拒绝而非告警 |
| 2 | 并发 Session 抢同一 Checkout | A + D | 第二个 Session 写入被拒（typed reason）；不产生第二个 owner |
| 3 | 子 Agent 前台/后台完成 / 异常退出 / 取消 / 额度中断 | D | 四条路径都可查询 Checkout 观测，且异常退出后 Checkout 仍 `retained` |
| 4 | PR 创建 → CI 失败 → 修复 → Review 变化 → Merge/Closed | C + E | 每次观测写 `observed_*`，状态迁移不覆盖历史；`unknown` 不折成 `open` |
| 5 | Dirty / untracked / ignored / 未推送 commit / 锁残留 / 无法验证 | A | 六种情形全部 `retained:<原因>`，零删除；detached 且有未覆盖 commit 时必须拒绝 |
| 6 | Windows junction 不被递归删除 | A | 与 `scripts/remove-worktree.sh` 用同一份拒绝矩阵 fixture 时行为一致 |
| 7 | Task/Session/Run/Checkout/PR 可从任一端查询 | B + E + F | 每个方向都有 Host API 入口，UI 不重建映射 |

基线：本计划开工前这些能力**完全不存在**，不记录基线失败；每个切片 PR 记录自己引入的用例首次通过证据。

## 待决

1. **跨 session 工作单元**（用户决定推后）：形态候选是 `agent_job_items.assigned_thread_id` 式派工记录（可重派、`attempt_count`），不是「Task 拥有 Session」的层级。第一波不需要。
2. **Web 端接入方式**：~~Host 强制 bearer 且拒绝带 `Origin` 的请求，浏览器 renderer 无法直连。F 开工前必须在「同源反代 / localhost 例外 / 只读快照」三者中定一个，否则 F 会返工。~~ **已定：同源反代。** `apps/web` 已有 Node BFF（浏览器只连同源 `/api/*`，BFF 持 bearer 连 Host），F 在 BFF 上加转发即可，不需要 localhost 例外或只读快照。
3. **写入闸口的强制面**：只拦文件写入，还是也拦 Bash？场景 2 的「只读关联」只有在两者都拦时才是真的。

## 风险

1. `O_EXCL` 在 Windows 网络盘上的原子性未验证。必须补一个双进程并发 bind 只有一方成功的用例，否则独占是纸面的。
2. 无过期归属 ⇒ 崩溃会话永久占位。prove-dead 判定必须只依赖可观测事实（活跃 run、worker 持有），不能依赖心跳时间，否则又是超时模型。
3. 观测成本：每次查询要跑多条 git 命令。查询必须按 session 的 cwd 精确定位，禁止扫全 `~/.duya/worktrees`。
4. resume 语义从 warning 改为拒绝是行为变更，会打断现有子代理工作流，需要明确错误码与 rollout 记录。
5. checkpoint ref 会无限增长，必须带保留策略；否则 `git for-each-ref` 本身成为新的性能问题。
6. 「对账不收养孤儿目录」意味着磁盘上会积累无法解释的 Checkout。这是有意的（安全优先），但需要 UI 明确展示「未收养」而不是隐藏。

## 决策记录

| 日期 | 决策 | 依据 |
| --- | --- | --- |
| 2026-10-22 | **D1** 立项 621，接续 496 剩余范围，不重开 496 | 496 的 §0.1 已把剩余范围限定为统一接口 / 回收 / 主会话进出 / 锁与 journal；本计划是其上层生命周期，不重复隔离实现 |
| 2026-10-22 | **D2** 归属只存 checkout 内的 owner 文件，不建 checkouts / leases 表 | 用户选择。「不得新建第二套真相源」的直接推论；codex `worktree/src/metadata.rs` 证明该模型可支撑产品。代价：历史必须进 rollout，多 session 只读由构造保证 |
| 2026-10-22 | **D3** worktree 改 `--detach` 不建分支，用 `refs/duya/checkpoint/<session>/<n>` 保命 | 用户选择 detached。checkpoint ref 同时满足场景 5「未推送 commit 必须保留」，且不引入分支的 push/PR 语义 |
| 2026-10-22 | **D4** 归属转移只有「让出」与「prove-dead」两条路径，不做超时过期 | 用户要求「租约失效后需要重新确认状态」。超时模型会在长任务上误释放，prove-dead 是可观测事实 |
| 2026-10-22 | **D5** PR / CI / Review 只存 `observed_*` 投影表（migration 43），字段不参与任何判定 | 离线必须能回答「PR 是否合并」；但外部是权威，本地是缓存 |
| 2026-10-22 | **D6** 新增 checkouts 之外的**唯一**新表，且只由 B 切片创建 | 并行开发按合并顺序抢 migration id 必撞车，撞车是静默跳过 |
| 2026-10-22 | **D7** 不新增 agent 可调用的 worktree 工具 | codex 无此工具；agent 只需要「跑在被指定的 cwd 里」，创建属于 shell/UX |
| 2026-10-22 | **D8** 回收实现下沉为 TS，`scripts/remove-worktree.sh` 保持独立，两边用同一份拒绝矩阵 fixture | 产品不能依赖仓库脚本（打包后不存在）；但两份实现必须有等价证明 |
| 2026-10-22 | **D9** Task 方向推后到第二波，不新增 work_items | 用户决定；A/B/C 不依赖它 |
| 2026-10-23 | **D10** F 的三端接入定为「窄契约 + 注册表 + 共享面板」，**不**把 Desktop 迁到 `UiServices` | `24-shared-renderer.md:88` 把 Desktop 的 `UiServices` 迁移明确 defer 到 T23；F 只需要 checkout / integration 两个命名空间，另立窄端口比提前动那次迁移更小 |
| 2026-10-23 | **D11** Integration 的刷新是 **session 作用域**（`refreshForSession`），不是 per-PR | Host 的 HTTP 面只有 `GET /v1/integrations?sessionId=`、`POST /v1/integrations/sync`、`POST /v1/integrations/link`；per-PR 观测是 Host 内部 API（`HostIntegrationApiV1.observeForPr`），不是 HTTP 面的一部分。而且刷新本来就是 session → cwd → origin → checkpoint refs → PRs → store 这一条链 |
| 2026-10-23 | **D12** 两个 Host 共用一处装配（`createHostWorkspaceLifecycleApis`） | headless `startLocalHost` 与 Desktop 内嵌 Host 服务同一组路由。装配写两遍 ⇒ 两个 Host 对同一问题给出不同答案，且 Desktop 那边会静默缺命名空间——这种缺口只在某端暴露 |
| 2026-10-23 | **D13** checkout / integration 两个命名空间用**自己的请求预算**（观测 15s、刷新 30s），不用通用的 5s | 这两个命名空间读 git、打 hosting service，5s 预算在负载下会让「Host 答得出来」变成「Host 答不出来」，而界面分不清「慢」和「没有」——那会把一个可回答的问题渲染成错误 |

## 进度

- [x] 契约核对（496 / 587 C6 / data stores / worker-subagents / agent-protocol / remove-worktree）
- [x] codex 参照实现取证（worktree crate / metadata / state migrations / TUI 起会话顺序 / git-attribution）
- [x] 契约定稿（本文件 4.1–4.6）
- [x] Provider 接口签名 v0（附录 A，B 可据此并行）
- [x] 派发 A / B / C（各自 worktree + PR：#361 / #363 / #362）
- [x] 第一波合并（#359–#363）
- [x] 接缝提交（#370）：删 C 的临时 union 副本，A 的 Provider + C 的 observer 接进 local-host
- [x] 第二波 D / E（#371 / #372）
- [x] 组装接线：aliveness 判据与 integration sync 接进 local-host
- [x] 启动 F（三端 UI + E2E）
  - [x] F-1 窄契约 + 注册表（`packages/ui/src/services/workspace-lifecycle.ts`）
  - [x] F-2 Web 端：BFF 转发 + 浏览器适配器
  - [x] F-3 Desktop 端：preload + IPC + renderer 包装
  - [x] F-4 TUI 端：`/checkout` 与 `/pr`
  - [x] F-5 共享面板 + 接入 TaskDrawer
  - [x] F-6 场景 1 / 2 / 7：Host 层 + 三端连通
- [x] 场景 1–7 全绿，三端连通
- [x] F 合并（#378 → `39f2314f`），CI 5/5 pass

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `2e6f265d` 只读核对 | Windows / Git Bash | `git rev-parse`、逐文件 `Read` / `grep -n` | 0 | 本文「现状核对」表内全部 `file:line`；codex 侧引用自 `c7234c1174` |
| `48d3c383`（仅 `docs/**`） | Windows 11 / Node 22.22.2 | `node scripts/check-text-encoding.mjs` | 0 — `no new violations (11 known)` | 终端输出 |
| 同上 | 同上 | `node scripts/architecture/architecture-check.mjs` | 0 — `tolerated 2800 / baseline 2785`，无新增违规 | 终端输出 |
| 同上 | 同上 | `env -u CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR npm run typecheck:all` | 0 — 11m15s；`typecheck-electron-gate: no new type errors (231 known)`；`eval:agent:core:check` 4/4 pass | 终端输出 |
| 同上 | 同上 | 目标测试 | 不适用：本次仅新增文档，未触碰 `packages/**` 实现 | — |
| 接缝 `57941472` | Windows 11 / Node 22.22.2 | `npm run typecheck:all` | 0 — electron gate 231 known / 111 keys | 终端输出 |
| 同上 | 同上 | 目标 vitest（scm + checkout-api + checkout-integration-http + workspace） | 0 — 123 passed / 1 skipped（8 files） | 终端输出 |
| 同上 | 同上 | `npm run bundle:verify` | 0 — FRESH，`0/1106 bundle inputs changed` | 终端输出 |
| 同上 | 同上 | `npm run architecture:check` | 0 — `tolerated 2822 / baseline 2785`，无新增违规 | 终端输出 |
| E `478dcdb2` | 同上 | `npm run typecheck:all` | 0 — 全量 | 终端输出 |
| 同上 | 同上 | 目标 vitest（scm + integration-store） | 0 — 90 passed（5 files） | 终端输出 |
| 同上 | 同上 | `npm run bundle:verify` / `architecture:check` | 0 — FRESH / 无新增违规 | 终端输出 |
| D `cd5f6e2a` | 同上 | `npm run typecheck:all` | 0 — `typecheck-electron-gate: OK — no new type errors (231 known across 111 key(s))` | 终端输出 |
| 同上 | 同上 | 目标 vitest（workspace + worker-subagents + agent-protocol/hash） | 0 — 114 passed / 1 skipped（9 files） | 终端输出 |
| 同上 | 同上 | `npm run bundle:verify` / `architecture:check` | 0 — FRESH / 无新增违规 | 终端输出 |
| 接线 | 同上 | 目标 vitest（checkout-aliveness-wiring + checkout-integration-http） | 0 — 10 passed | 终端输出 |
| 同上 | 同上 | 反证：把 aliveness port 换成空实现后重跑 | **1** — 用例变红，证明该用例真的覆盖接线 | 终端输出 |
| F 契约 `a617bbb3` / 客户端 `8c093a65` / port `ef033849` | 同上 | `npm run -w @duya/agent-protocol build`、`npm run -w @duya/host build` | 0 | 终端输出 |
| 同上 | 同上 | 目标 vitest（host checkout + integration + workspace + agent-protocol/hash） | 0 — 76 passed / 1 skipped（9 files） | 终端输出 |
| F 面板 `ff145da3` | 同上 | 目标 vitest（ui/workspace + TaskDrawer） | 0 — 面板 10 passed，TaskDrawer 全绿 | 终端输出 |
| 同上 | 同上 | 反证：回收按钮改成按观测禁用，并把 `unknown` 渲染成 `open` | **1** — 恰好 3 条变红，证明 §4.3 与「`unknown` 不折成 `open`」被真正覆盖 | 终端输出 |
| 场景 1/2 `418b02d4` | 同上 | `npm run typecheck:all` | 0 — `typecheck-electron-gate: OK — no new type errors (231 known across 111 key(s))` | 终端输出 |
| 同上 | 同上 | `npm run architecture:check` | 0 — `tolerated 2832 / baseline 2785`，无新增违规 | 终端输出 |
| 同上 | 同上 | 反证 ×3：resolver 返回 null / owner 读取返回 null / 去掉独占检查 | **1** — 每次 2 条变红 | 终端输出 |
| F 装配 `c52d2c47` | 同上 | `npm run bundle:worker` 后 `npm run bundle:verify` | 0 — FRESH，`0/1109 bundle inputs changed` | 终端输出 |
| TUI `a46fcb84` | 同上 | `npx vitest run packages/cli/src/tui/slash/`、`packages/command-catalog/` | 0 — 84 passed + 20 passed | 终端输出 |
| 同上 | 同上 | `npx tsc --noEmit -p packages/cli/tsconfig.json`、`npm run architecture:check` | 0 — 2836 total / 2836 tolerated，无新增违规 | 终端输出 |
| Web `8d318765` | 同上 | `npx vitest run apps/web/tests/` | 0 — 102 passed（11 files） | 终端输出 |
| 同上 | 同上 | `tsc --noEmit -p apps/web/tsconfig.json` + `tsconfig.browser.json`、`npm run architecture:check` | 0 — 无新增违规 | 终端输出 |
| 同上 | 同上 | 反证 ×4：`unknown`→`open` / BFF 不转发 / 去掉 CSRF 闸门 / reclaim 拒绝当错误 | **1** — 分别 3 / 2 / 2 / 2 条变红 | 终端输出 |
| 场景 7 Host 层 `2423ec44` | 同上 | `npx vitest run packages/host/tests/workspace-lifecycle-questions.test.ts` | 0 — 1 passed（五问走真实 HTTP） | 终端输出 |
| 同上 | 同上 | 反证 ×2：断掉 checkout 解析 / 断掉 aliveness 接线 | **1** — 各自变红（后者 reason 由 `owner_alive` 变 `cwd_inside`） | 终端输出 |
| 三端连通 `3015e395` | 同上 | `npx vitest run apps/web/tests/client/workspace-lifecycle-connectivity.test.ts` | 0 — 2 passed（真 Host + 真 BFF + 真适配器，两条传输同一答案） | 终端输出 |
| 同上 | 同上 | 反证 ×2：BFF 重建 `reclaimable` / 客户端把 `dirty_tracked` 折成 `clean` | **1** — 各自变红 | 终端输出 |
| Desktop `8e0d7744` | 同上 | 目标 vitest（workspace-lifecycle 全链路 5 files） | 0 — 32 passed | 终端输出 |
| 同上 | 同上 | `npx vitest run apps/desktop packages/ui/src` | 0 — 516 files passed / 1 skipped，5853 passed / 13 skipped | 终端输出 |
| 同上 | 同上 | `node scripts/typecheck-electron-gate.mjs`、`npm run architecture:check`、`node scripts/check-text-encoding.mjs`、`node scripts/build-electron.mjs` | 全 0 — electron gate 231 known / 111 keys；无新增边界违规 | 终端输出 |
| 同上 | 同上 | 反证 ×3：拔掉 `checkoutApi` / `integrationApi` / `integrationSync` | **1** — 分别 1 / 2 / 1 条变红 | 终端输出 |
| 同上 | 同上 | Desktop 内嵌 Host 真启动后的三条路由实际响应 | `GET /v1/checkouts?sessionId=s-1` → 200 `{"checkout":{"sessionId":"s-1","checkout":null,"isOwner":false}}`；`GET /v1/integrations?sessionId=s-1` → 200 `{"records":[]}`；`POST /v1/integrations/sync` → 200 `{"status":"no_checkpoints","written":[],"failed":[]}` | 真实 SQLite + 真 `startDesktopHostApi()` + 真 bearer |
| 合入 master 后 | 同上 | `npm run typecheck:all` | 0 | 终端输出 |
| 同上 | 同上 | 目标 vitest（cli/slash + command-catalog + ui/workspace + TaskDrawer） | 0 — 118 passed（5 files） | 终端输出 |
| 同上 | 同上 | 浏览器实跑（web dev server + 共享面板 harness） | 三态渲染正确；`unknown` 显示为 `unknown` 并带原因，未折成 `open`；观测为「保留」时回收按钮**无** `disabled`；console 零应用级 error/warn（仅 vite HMR websocket） | 浏览器快照 |
| 合入 master（PR #355）后 | 同上 | `npm run typecheck:all` | 0 — `typecheck-electron-gate: OK — no new type errors (206 known across 102 key(s))` | 终端输出 |
| 同上 | 同上 | `npm run architecture:check` | 0 — `tolerated 2608 / baseline 2785`，无新增违规 | 终端输出 |
| 同上 | 同上 | `npm run bundle:worker` 后 `npm run bundle:verify` | 0 — FRESH，`0/921 bundle inputs changed` | 终端输出 |
| 同上 | 同上 | 目标 vitest（host + web + desktop + ui + cli/slash + command-catalog） | 0 — 696 files passed / 1 skipped，7512 passed / 12 skipped，0 failed | 终端输出 |
| PR #378（`39f2314f`） | GitHub Actions / ubuntu-latest 22.x | `gh pr checks 378` | 0 — 5/5 job pass（build 2m57s · typecheck 5m51s · test 8m29s · architecture 1m42s · test scope 9s） | Actions run 39932014204 |

环境备注：`wl-f` worktree 里裸 builtin import（`from 'stream'`）在 vitest 下解析失败，`packages/cli/src/tui/__tests__/*` 与 2 个既有 desktop 测试文件因此**收集失败**（`Cannot find module '<worktree>/stream'`）。同样文件在主检出与 `wl-f-tui` 通过，`apps/web` 侧全部通过；与本次改动无关（这两个文件未被本分支触及），CI 的干净检出不受影响。

构建副作用核对：`build:packages` 后 `git diff --numstat` 无内容差异，`packages/capabilities/src/ModuleTool/inline-content.ts` 只是 CRLF/LF 的 stat-dirty 条目，未纳入提交。第二波三个切片都遇到过这一条：构建脚本改写了该文件的换行符，提交前已 `git checkout --` 还原。

## 附录 A — Provider 接口签名（v0，冻结给 B 并行）

A 切片的对外形状。B 只依赖这份签名，不依赖 A 的内部实现；签名变更必须先改本节并通知 B。类型放 `packages/host/src/workspace/types.ts`。

```ts
export interface CheckoutRoot {
  /** Linked worktree 根，绝对路径，canonical（dunce 等价：解析 junction 后的真实路径）。 */
  root: string;
  /** 调用方实际应当使用的 cwd = root + 源仓库内的相对目录。不是 root 本身。 */
  cwd: string;
  sourceRoot: string;
  sourceCwd: string;
  /** 创建时钉住的 base，detached HEAD 的起点。观测到的新值不覆盖它。 */
  baseSha: string;
}

export interface CheckoutOwner {
  sessionId: string;
  boundAt: number;
}

/** 观测组合，不是枚举：五个维度各自独立。 */
export interface CheckoutObserved {
  registered: boolean;
  worktree: 'clean' | 'dirty_tracked' | 'untracked' | 'ignored';
  owner: CheckoutOwner | null | 'unreadable';
  locked: boolean;
  reclaim: { ok: true } | { ok: false; reason: CheckoutRetainReason };
  observedAt: number;
}

export type CheckoutRetainReason =
  | 'not_registered' | 'unreadable' | 'dirty_tracked' | 'untracked' | 'ignored'
  | 'locked' | 'detached_unreferenced' | 'reparse_point' | 'owner_alive' | 'cwd_inside';

export interface CheckoutProvider {
  create(input: {
    sourceCwd: string;
    base?: string;
    ownerSessionId: string;
    label: string;
  }): Promise<CheckoutRoot>;

  observe(root: string): Promise<CheckoutObserved>;

  /** 从 git 反推，不读注册表。只返回本仓库的 managed checkout。 */
  list(sourceCwd: string): Promise<CheckoutRoot[]>;

  /**
   * 写入归属。`takeover` 是必填参数，不是可选布尔：
   * 让「我忘了声明接管依据」和「我有依据」在类型上不可混同。
   */
  bind(
    root: string,
    sessionId: string,
    takeover: 'fresh' | 'explicit-release' | 'prove-dead',
  ): Promise<void>;

  release(root: string, sessionId: string): Promise<void>;

  /** 把当前 HEAD 写入 refs/duya/checkpoint/<session>/<n>，返回 ref 名。 */
  checkpoint(root: string, sessionId: string): Promise<string>;

  /** 唯一删除入口。拒绝时给出 retained 原因，不抛异常。 */
  reclaim(root: string): Promise<{ removed: true } | { removed: false; reason: CheckoutRetainReason }>;

  /** 写入闸口：工具执行边界调用，按 cwd 反查 checkout 再比对 owner。 */
  assertWritable(
    cwd: string,
    sessionId: string,
  ): Promise<{ ok: true; root: string } | { ok: false; reason: 'not_a_checkout' | 'unowned' | 'not_owner' }>;
}
```

约束：

- `create` 失败必须自行回滚到「没有这个 checkout」，不留半个目录、不留 `.git/worktrees/<name>` 注册。
- `observe` / `list` / `assertWritable` 是纯读，不得产生副作用（包括不得 `worktree prune`）。
- `reclaim` 不抛异常表达「拒绝」，因为拒绝是正常结果而不是错误；只有 IO 失败才抛。
- `bind` 的 `prove-dead` 判定只允许读「该 session 是否有活跃 run」「是否被任何 worker 持有」，不得读时间戳。

## 接续 / 结果

已实现：Provider（A）、协议与投影表（B）、只读 observer（C）、Session 生命周期（D）、Integration 同步（E）、组装接线、F（三端 UI + 真实链路验证）。
已合并：#359 契约 · #361 A · #362 C · #363 B · #370 接缝 · #371 E · #372 D · #373 组装接线 · #378 F（merge `39f2314f`）。
未提交路径：无。
外部副作用：无。
回收：`wl-f`、`wl-f-web`、`wl-f-tui`、`wl-f-desktop` 四个 worktree 已摘除，owner 即本计划。
下一步：既有场景 1–7 已验收；后续执行见下方 P0 接续。

遗留（需用户手工处理）：`C:\Users\lavachen\.duya\worktrees\` 下有 6 个早期测试残留的 checkout 目录（`duya-identity-repo-*` 2 个、`duya-questions-repo-*` 4 个）。根因已修（`isolateCheckoutStorage()` 改为 `await` 且用 `DUYA_APP_DATA_PATH` 隔离，新跑不再产生残留），但这 6 个目录在工作区外，回收站策略不允许 agent 删除。

## P0 接续：执行归属与隔离恢复（2026-10-24）

状态：active · owner：Codex `/root` · 分支：`codex/worktree-p0`
worktree：`/workspace/work/duya-worktree-p0` · base：`686f3c81eace1477010b3b94c74f59ac78732a36`

### 目标与边界

让现有隔离 checkout 在真实工具执行中校验写入归属；父会话可在自己的目录恢复隔离子代理，子代理仍使用原 checkout；创建基线在提交与重启后不漂移；模型不再被提示合并不存在的分支。
独占范围：Host workspace / tool execution / subagent 链路、对应测试、capabilities 的子代理提示及本计划。当前没有共享任务查询工具，已通过版本化计划与 Git 对账；Harness 无 managed-worktree 创建工具，按开发指南手工创建独立 linked worktree。
主会话 enter/exit、子会话隔离参数、三端操作 UI 与 sync-base 属于后续 P1–P4，本轮不改 UI。

### 验收与进度

- [x] 记录当前相关测试基线：8 files，84 passed / 1 skipped。
- [x] 持久化创建基线；新 Provider 实例在 HEAD 前进后仍返回原 base，历史缺失时不把 HEAD 冒充 base。
- [x] 恢复隔离子代理时验证原 checkout、重新绑定原 owner，并把原 cwd 传到前台/后台执行；丢失或被占用时拒绝。
- [x] 在真实 registry 与 worker 派发边界校验写入；保留读能力，覆盖实际路径及 deferred 调用。
- [x] detached HEAD 提示统一使用 commit / checkpoint，不承诺不存在的分支。
- [x] 独立进程验收发现并修复 BashWorker CJS 的 `createRequire(import.meta.url)` 崩溃；真实 worker 的 owner 写入成功，非 owner 拒绝。
- [x] 相关回归、`typecheck:all`、`architecture:check` 与必要构建；提交任务分支并创建 [draft PR #460](https://github.com/lava-chen/duya/pull/460)。

### 发现与决策

- `assertWritable` 当前只有定义和测试，生产 registry / worker 分支未接入。
- `service.ts` 将子代理原 cwd 与父 cwd 比较后拒绝，工具没有让父会话指定原 cwd 的参数。
- Provider `list()` 将注册 HEAD 填入 `baseSha`，与不可变创建基线契约相冲突。
- 兼容现有 owner 文件；新增创建元数据不改变归属权威。文件/工具边界检查不宣称提供任意 shell 命令的 OS 级路径隔离。
- 真实 worker DB bridge 返回 `parent_id`，原 resume 校验只读 `parent_session_id`；现在兼容两者并拒绝缺失或不同父会话。checkout 附件也随本地行适配器透传，缺失 checkout 不回退到父目录。
- Shell 的“只读命令”分类不是写入隔离证据（包括解释器与复合命令），因此非 owner 保留 Read/Grep/Glob，shell 一律需要 owner；普通手工 linked worktree 未被 Duya 管理时不受 owner 文件限制。
- 基线复现检出：`/workspace/work/duya-worktree-p0-base`，detached `686f3c81`，源码未改，仅独立 workspace overlay 与本检出相同的第三方依赖；未穿过共享链接安装。保留至任务交付后核对回收。
- 安装的 Node 依赖和 SQLite 已验证可用。根 postinstall 的 Electron rebuild 最初因用户目录缓存不可写失败；后续以工作目录缓存准备 Electron，完整 `electron:build` 已通过。没有修改 home 或关掉 TLS 校验。
- 扩展到 Host/Runtime 302 files：296 passed，6 failed；34 个失败全部在未修改源码的基线重现，按 `(file, test, error)` 比对无新增。原因均为旧测试硬编码写入受限的用户目录，与本轮改动无关，未修改这些测试。
- 显式 `check-packaged-artifacts.mjs --bundle` 在本轮和原始 base 构建中都报 `ajv-formats/dist/formats` 自包含扫描 finding。命中位于依赖的代码生成模板字符串；本轮不改扫描器或缺陷 baseline，也不将此项报告为通过，交 PR review 评估。

### 验证记录与接续

环境：Linux / Node v24.19.0；验证源为 base `686f3c81` + 本轮源码，已提交至 `bcb2e7b9`（worker 产物提交）；随后仅修改文档。独立依赖与本检出产物。

| 命令 / 操作 | 退出码 / 结果 | 范围 |
| --- | --- | --- |
| 变更前目标 vitest | 0；8 files，84 passed / 1 skipped | workspace、subagent 参数/隔离、deferred dispatcher |
| `npm run build:packages` | 0 | base 的全包构建 |
| 目标 vitest（含新增回归） | 0；19 files，177 passed / 1 skipped | workspace、subagents、runtime discovery/execution |
| `npm run typecheck:all`（两轮） | 0 | 全仓类型与静态检查；最后一次 Host adapter 次序调整随最终完整构建重验 |
| `npm run architecture:check` | 0；2725 tolerated，无新增违规 | 未改 baseline |
| Host/Runtime vitest | 1；302 files，296 passed / 6 failed；2869 passed / 34 failed / 1 expected fail / 1 skipped | 失败集已在 base 逐项复现，新增失败 0 |
| base 的上述 6 个失败文件 | 1；34 failed / 23 passed | `(file, test, error)` 与改动检出一致 |
| `npm run electron:build` | 0 | 第一轮完整构建；真实 worker 随后暴露 URL 初始化问题，已修复并重建 worker |
| `checkout-shell-worker.test.ts` | 0；1 passed | 真 pipeline → 真 pool → 本检出 bundled BashWorker 子进程；验证磁盘成果与拒绝路径 |
| `check-packaged-artifacts.mjs --bundle` | 1；`ajv-formats/dist/formats` finding | 原始 base 同样复现，未改 baseline |
| 最终 `npm run electron:build` | 0 | 包含 BashWorker URL 修复；Host 也重新类型构建 |
| 最终 `npm run architecture:check` | 0；2725 tolerated，无新增违规 | 最终源代码，未改 baseline |
| 最终 Host/Runtime vitest | 1；303 files，297 passed / 6 failed；2873 passed / 34 failed / 1 expected fail / 1 skipped | 包含真 BashWorker 子进程；34 个失败签名与 base 完全相同 |
| `npm run bundle:verify` @ `bcb2e7b9` | 0；FRESH，0/950 | 主 worker 与独立 BashWorker 都已刷新 |

已实现并验证 P0，交付 [draft PR #460](https://github.com/lava-chen/duya/pull/460)；未合并。代码、测试、构建脚本和产物已提交并推送，本文档随最后一个交付记录提交；无其他任务的改动。
副作用：任务分支已推送、已创建 draft PR；独立依赖/构建/测试数据及基线检出保留。未发布或合并。
回收：未回收；待 PR 集成与合并后验证。
下一步：核对 #460 最新 head 的 review/CI，处理本 PR 引入的问题；后续 P1 实现主会话 enter/exit 与执行屏障。原有测试和显式 bundle 扫描的基线问题已在 PR 中列明，未作通过声明。

### P0 CI 修正（2026-10-24）

最新接续：`c4eeef11` 已在本任务检出接入 `master@f6120e04`。源代码无冲突，三个生成 bundle 由合并后的源码重新构建，未按冲突两侧选择旧产物。同步后的 `typecheck:all`、`electron:build`、`architecture:check`、`agent-retirement-gate`（772/772，新增 0）均 exit 0；workspace / subagents / Runtime discovery+execution 及 master 新增相关回归 25 files，222 passed / 1 skipped，exit 0。日志为 `/workspace/work/duya-worktree-p0-sync-*.log`。依赖变更来自 master，安装只在本检出真实 node_modules 进行，额外 lockfile 重排已精确撤销。
同步前 GitHub 将 #460 标为生成产物冲突，未运行 `c4eeef11` 的新 CI；本次同步提交后重新核对最新 head。未授权集成，保留 draft 和两个证据检出。P1a 的 per-session 执行屏障在独立分支 `codex/worktree-p1` 继续推进。

`d8e7b845` 的 GitHub 类型检查与测试已通过；architecture job 在独立的 Agent retirement reference ratchet 失败。新增真实 shell worker 测试重复硬编码了 worker 产物路径，增加一个 selector。测试现在复用生产 `resolveBashWorkerPath`，该函数支持注入 bundle 目录；不改门禁或 baseline。
修正后的 `typecheck:all`、`electron:build`、`architecture:check`、`agent-retirement-gate`（772/772，新增 0）与真实 shell worker 测试均 exit 0。日志留在 `/workspace/work/duya-worktree-p0-ci-fix-*.log`；验证环境与上表一致。生成的 worker bundle 随源代码更新。P0 仍待最新远端 CI 与 review，不合并。

## P1a 接续：执行位置版本与切换屏障（2026-10-24）

状态：active · owner：Codex `/root` · 分支：`codex/worktree-p1`
worktree：`/workspace/work/duya-worktree-p1` · base：`c4eeef11`（依赖 #460；不合并）

### 本轮目标与边界

先完成 P1 的执行安全切片：每个 WorkerSession 持有单调递增的执行位置版本；一轮工具上下文捕获版本，排队或等待审批后的旧调用不得在切换后执行。切换必须等待当前前台工具结束；切换进行中阻止新工具进入。所有 registry、独立 shell worker、deferred executor 路径遵守同一屏障，异常时归还执行占用。
本轮不暴露 enter/exit 工具或 UI：run manifest、权限与 prompt 当前按 run 冻结，必须在后续切片一起接续；本轮不能宣称主会话 enter/exit 已完成。屏障仅管本 worker 的前台工具执行，后台 shell 活跃性与持久化切换 journal 仍是主会话工具接入的前置条件。
独占范围：Host session / tool dispatch、Runtime deferred dispatch 的零 IO lease hook、相应测试、生成 worker 产物与本文档。无 workspace_get_context 或 managed worktree 创建工具，使用版本化计划/Git 对账与手工 linked worktree；第三方依赖复用 P0，workspace overlay 和产物属于本检出。

### 验收

- [x] 记录相关测试基线：Host workspace 9 files / 84 passed / 1 skipped；Runtime discovery/execution 9 files / 61 passed。
- [x] 单调版本防止 A→B→A 后旧调用重新有效；切换失败/取消也不恢复旧版本。
- [x] 同步取得执行占用，在最后一个异步检查之后拒绝过期上下文；执行中拒绝目录切换，异常释放占用。
- [x] 普通 registry、真 BashWorker 与 deferred 调用覆盖；等待审批或排队的旧调用没有磁盘副作用。
- [x] 新一轮上下文可继续执行；既有未附带屏障的外部调用保持兼容。
- [x] `typecheck:all`、`architecture:check`、`agent-retirement-gate`、必要构建与相关测试；提交依赖 P0 的 [draft PR #465](https://github.com/lava-chen/duya/pull/465)。

### 验证与接续

本轮源码已接入 WorkerSession 与三条派发路径；run 活跃期间的裸 `setWorkingDirectory` 明确拒绝，不能伪装成一次完整的 worktree 切换。未来 enter/exit 需要独立的控制操作能力处理自身执行占用，并把 journal、后台任务与下一轮 prompt/permission/skills 重建连成一个事务；本轮不按工具名偷偷豁免屏障。
Node 24.19 / Linux；env：`DUYA_DATA_ROOT` / `DUYA_APP_DATA_PATH` 使用 `/workspace/work/test-data-p1`。首次针对性验证 21 files / 161 passed / 1 skipped（包括真实 shell 子进程）。Host/Runtime 扩大回归 310 files / 304 passed / 6 failed；2933 passed / 34 failed / 1 expected fail / 1 skipped。6 个失败文件在 P0 `c4eeef11` 重跑，34 个 `(file, test, error)` 签名完全一致，无新增失败；见本地 `duya-worktree-p1-failure-comparison.json`。
`architecture:check` exit 0（2726 tolerated，无新增违规）；`agent-retirement-gate` exit 0（772/772，新增 0）。首次完整类型检查与最后的同步回调类型收窄后 Host 构建均 exit 0。源码提交 `6f8c432d`。
期间 master 更新到 `f6120e04`。P0 #460 的三个生成 bundle 冲突已通过源码重建解决，推送 `ac73b758` 后 CI 重新运行。本轮也接入该 master 并按新依赖验证，第三方依赖安装只在 P0 真实 node_modules 执行，没有穿过本 worktree 的链接安装。

| 最终验证（`501299bf`，包含 master 同步与本检出产物） | 退出码与结果 |
| --- | --- |
| `npm run typecheck:all` | 0 |
| `npm run electron:build` | 0；完整 desktop / worker / CLI / gateway / recorder 构建 |
| `npm run architecture:check` | 0；无新增违规 |
| `npm run agent-retirement-gate` | 0；772/772，新增 0 |
| Host / Runtime vitest | 1；313 files，307 passed / 6 failed；2967 passed / 34 failed / 1 expected fail / 1 skipped |
| 基线失败对比 | 0；34 个 `(file, test, error)` 与 P0 完全一致；新增 0 |
| `npm run bundle:verify` | 0；FRESH，0/953 first-party inputs changed |
| 显式 `check-packaged-artifacts.mjs --bundle` | 1；仅既有 `ajv-formats/dist/formats` finding；与 P0 `ac73b758` 报告逐项一致，未改扫描器或 baseline |

日志为 `/workspace/work/duya-worktree-p1-final-*.log`；失败对比 `duya-worktree-p1-final-failure-comparison.json`。最后接入 P0 `ac73b758` 时，已用 `git diff --exit-code 501299bf -- . ':!docs' ':!packages/host/bundle'` 证明源码与依赖完全一致，复用本检出已验收的 P1 bundle，保留 P0 最新接续记录。没有用 P0 产物覆盖 P1 实现。
已交付：[draft PR #465](https://github.com/lava-chen/duya/pull/465)，依赖 [#460](https://github.com/lava-chen/duya/pull/460)，源码与产物 head 为 `f4854159`，本记录随交付文档提交；本轮源码无未提交改动。第三方依赖 overlay 为本地 untracked 配置，未进入 PR。
远端：#460 的 `ac73b758` 已通过 architecture（包含修复后的退役引用门禁）与 test scope，类型、测试、构建继续运行；#465 刚创建，CI / review 待完成。两个 PR 均保留 draft，未合并、未发布、未回收。
下一步：核对 #465 最新 head 的 CI / review，修复本 PR 引入的问题；P1b 接入 Host 持久化切换 journal、后台任务占用、主会话 enter/exit 工具，以及下一模型轮的 prompt / permission / skills / catalog 原子刷新。之后再接子会话隔离参数与三端共用入口。P1a 完成不代表 P1 主会话工具已完成。

## P1b–P4 全量接续（2026-10-24）

用户要求快速完成全部剩余范围。owner：Codex `/root`；分支 `codex/worktree-complete`；独立 worktree `/workspace/work/duya-worktree-complete`；base `edc90abe`（依赖 #460 / #465，两个 PR 最新 CI 已全绿，尚未合并）。Harness 无 workspace_get_context / managed worktree 工具，按 Git 与本计划对账并手工创建检出；依赖使用本检出的 overlay，禁止穿过链接安装。

实现顺序与验收：

- [x] Host 单一 checkout 控制服务：enter/name/path/base、exit/keep/remove、同步基线/冲突/abort；git 注册和 owner 文件仍为权限权威。
- [x] SessionStore 原子更新执行位置与切换 journal，重启恢复；run admission 与切换互斥；后台 shell 和子任务占用时拒绝切换/回收，不自动杀任务。
- [x] agent 的 enter_worktree / exit_worktree / sync_worktree 工具；控制调用交还自身执行占用，旧批次调用仍被 epoch 拦截；下一模型轮重建 cwd、AGENTS、skills、权限和 catalog。
- [x] 子会话 use_worktree、source_branch、branch_name；子代理无改动安全清理、有成果保留完整回执。
- [x] HTTP / Desktop 共用控制服务，TUI slash 与共享 UI 接入实际操作和当前执行位置展示。
- [ ] 实际 Git、DB、worker 和 UI 链路验证；记录基线失败并比较；类型、架构、retirement、完整构建、产物新鲜度通过后 PR 交付。未经授权不合并。

范围覆盖 Host / data / protocol / Runtime 控制端口、CLI / command-catalog、共享 UI 与 Desktop/Web 适配器；不改变既有 manifest 指纹：执行位置是显式的会话覆盖层，记录实际切换，不重写已经冻结的 run-start 事实。


2026-10-25 接续验证：

- 已实现协议、SQLite CAS/journal、Host 控制服务、主会话工具和下一模型轮刷新；Desktop/Web/TUI 共用控制路径，子会话支持隔离和独立分支，子代理保留清理回执。默认从本地 HEAD 创建；显式 `fresh` 使用本地 origin/HEAD，不隐式联网。
- 实际 Git/DB 已覆盖脏源目录排除、保留修改、安全删除、run admission、重启恢复、子会话稳定目录、同步冲突和 owned-merge abort。主会话工具测试验证真实 WorkerSession 下一轮 AGENTS 与 cwd 刷新、旧批次写入拒绝。
- 本地 Chromium + Playwright 已跑共享 UI → HTTP → 真实 Host → Git，验证创建、返回、重新进入、保留修改与清理空检出；环境没有 Playwright MCP，因此使用本地浏览器执行。可复现命令：`node node_modules/playwright/cli.js test --config=e2e/workspace/playwright.config.ts`（需 Node SQLite ABI 与已安装 Chromium）。
- 架构检查无新增违规；retirement 引用 ratchet PASS（772/772），旧 agent 包整体退休仍为仓库既有 OPEN 状态，不属于本切片。
- 当前基线 `edc90abe` + 本切片未提交文件；完整类型检查、Electron 构建、打包 worker 回环和相关回归继续执行，最终退出码与 PR 记录在后续接续项。未合并，保留本检出。


### 2026-10-25 用户要求立即收尾并通过 PR 交接

实现状态：P1b–P4 的代码已补齐；验收和集成尚未全部完成。独立分支 `codex/worktree-complete`，base `edc90abe5d32c4d478292ea866dc1ebde3312d05`，PR 目标为 `codex/worktree-p1`（依赖 #465 / #460）。最终交付提交为本段所在提交；不合并，不回收当前 worktree。只有本任务代码、测试、文档和新产物入库，node_modules overlay 不提交。

已验证（Linux / Node 24，源码在本检出，最后一轮 dirty 范围为本 PR）：

- `vitest run`：workspace、managed-shell、session-service、checkout-integration-http、CLI slash、worker-subagents、run-turn-provider-integration、turn-pipeline-producer，**34 文件 / 372 passed / 1 skipped**（既有跳过用例）；额外 `location-skills.test.ts` **1 passed**。新真实 worker 回环实际执行 enter → write → exit，并核对文件只落在隔离目录；实际技能加载器验证旧项目技能移除、新目录技能加载。
- `node node_modules/playwright/cli.js test --config=e2e/workspace/playwright.config.ts`：**1 passed**，真实 Chromium / 共享组件 → HTTP → Host → Git，含创建、保留修改、重新进入、安全删除、同步冲突和 abort。它没有覆盖完整 Desktop IPC 或 Web BFF 外壳。
- `npm run architecture:check` exit 0；`npm run check:test-coverage` exit 0；`npm run agent-retirement-gate` 引用 ratchet PASS（772/772，退休整体仍 OPEN）；`npm run electron:build` exit 0。已重新生成最终 worker 产物。
- 全量 Host 209 文件第一次运行：1807 pass / 35 fail / 1 skip。其中 34 项与既有基线逐用例名称相符，均为 `/home/agent/.duya/test-namespaces/...` 的 ENOENT；额外 1 项是旧 assembly 调用次数断言，已更新并在上述 372 项回归中通过。
- `npm run typecheck:all` 最后一轮仍在运行，**没有最终成功结论**。前一轮已定位并修正新增 router logger 参数错误；另一次 memory 声明找不到发生在并行 build 清理 dist 时。不要改 baseline 掩盖错误。
- `npm run bundle:verify` 在提交前报告 38 个未提交输入，必须在交付提交后重跑；严格 `node scripts/check-packaged-artifacts.mjs --bundle` 仍命中既有 `ajv-formats/dist/formats` 模板扫描误报（evidence: no externals），同基线表现。本 PR 未扩充缺陷 baseline。

给接手 agent 的执行顺序：

1. 核对当前 PR head、依赖 #465/#460、同一计划和 `git status`；从本分支继续建自己的独立 worktree，避免改共享 `/workspace/duya`。本地依赖使用既有 overlay，不穿过链接 npm install。
2. 优先查看当前 `typecheck:all` 的最终退出码和最新 PR CI。若仍在同一环境，日志为 `/workspace/work/duya-worktree-complete-typecheck.log`；否则从当前 PR head 重跑 `npm run typecheck:all`、`npm run architecture:check` 和提交后的 `npm run bundle:verify`，修复新增错误后推送。
3. 补齐真实 Desktop IPC / Web BFF 外壳验收，尤其聊天轮切换、重启恢复、后台进程占用、子会话并行，以及所有控件操作。新 browser spec 只证明共享组件与真实 Host 链路。
4. 评估严格打包扫描的既有 ajv 模板误报；需要修扫描器时修检测逻辑并加回归，禁止直接加 baseline。未知 PID 的进程 intent 当前保守保留，后续可增加有监督的恢复/解释入口，不能把未知当已退出。
5. 等最新 head 的必需 review / CI 全绿后再请求集成授权。依赖顺序 #460 → #465 → 本 PR；未经用户明确授权不合并、不删除 worktree。

可选后续增强（本 PR 不宣称已对齐）：非 Git 的 WorktreeCreate/Remove hooks、项目级默认基线设置、未知进程 intent 的自动对账、多个并行子代理的独立技能注册表。目前有后台子代理时主会话控制工具会拒绝切换，避免全局技能串目录。


最终交付：[Draft PR #476](https://github.com/lava-chen/duya/pull/476)，代码提交 `9afe4c01` 已推送，base 为 `codex/worktree-p1`。提交后 `npm run bundle:verify` exit 0，**FRESH，0/958 输入变化**；该项已完成，只有新增源码改动后才需重新生成产物并复验。最新完整类型检查仍待最终退出码，CI/review 未等待完成，按用户要求交接。下一位 agent 以 PR 描述中更新后的待办为准。所有已跟踪任务文件已提交，剩余未跟踪项仅为依赖 overlay。

## 2026-10-25 Windows 接续验证、CI 修复与外壳补验

owner：ZCode 会话（接手 PR #476）。worktree `.claude/worktrees/worktree-complete`，分支 `codex/worktree-complete`，起点 head `92b5fb5f`。环境 Windows 10.0.26200 / Node v24.16.0 / Git Bash。

### 前任遗留项的处置

- `typecheck:all`（前任无最终结论）：92b5fb5f 原样与修复后复跑均 exit 0。`architecture:check` exit 0（2775 tolerated，无新增违规）。
- CI：#476 base 为 `codex/worktree-p1`，`test.yml` 的 `pull_request` 只匹配 `master`，分支永远无 CI。已用 `workflow_dispatch` 手动触发（run 40154181380，head 92b5fb5f）获取信号。
- ajv 打包扫描误报评估：**确认是扫描器误报，非打包缺陷**。`worker-metafile.json` 证实 `ajv-formats/dist/formats.js` 是已打包 input（12263 字节、0 import）；bundle 里的 `require("ajv-formats/dist/formats")` 位于 ajv standalone codegen 的带标签模板字面量（`(0,MTe._)\`require(...).${r}\``），是生成代码的数据。扫描器手写词法器在 15MB 压缩代码中被更早的正则字面量内引字符（如 `/"/g`）带偏、误入代码位。本 PR 不修扫描器（正确修法是完整 tokenizer 或改用 metafile imports 作为事实源，修错会漏报真问题），也不加 baseline；单独立项处理。

### CI run 40154181380 失败归因与修复（绿的部分：architecture / test scope / typecheck×3）

前任 Linux 只跑 Host 209 文件，未覆盖 apps/desktop 与跨平台路径，遗留以下回归：

| 失败（文件×用例） | 平台 | 根因 | 修复 |
| --- | --- | --- | --- |
| run-create-ack-real-bridge×7、terminal-publication-barrier×3、h8-2-worker-run-channel-seam×7、desktop-native-run-closed-loop×2 | 全平台 | `9afe4c01` 的 `getDesktopCheckoutService()` 要求先经 `createDesktopHostWorkspaceLifecycleApis` 初始化，desktop bridge 测试环境未初始化即触发 run:create admission | `desktop-host-api.ts` 改为按 `getCoreStores()` 身份懒构造（生产等价：启动路径本就用同一 singleton）；4 个 harness 补 `SessionStore` 迁移与 stores 形状 |
| citation-drift×6（envelope.ts×5、run.ts×1）+ sse-event.ts×1 | 全平台 | `9afe4c01` 移动 router.ts 行号未更新 agent-protocol 的 file:line 引用；本轮 router 提取又带出 1 处 | 更新 7 处引用行号，`13-citation-drift.test.ts` 全绿 |
| workspace-lifecycle-handlers×1 | 全平台 | 新增 `control` 通道未更新通道清单断言 | 断言补 `workspace-lifecycle:checkout:control`，并新增 control 契约用例 |
| session-checkout-service×2、tool-write-gate×1 | 仅 Windows | 开发机全局 `core.autocrlf` 把 worktree 检出重写为 CRLF，内容断言失配 | `makeRepo` fixture 显式 `core.autocrlf=false`（托管 worktree 共享该配置） |
| checkout-integration-http×1 | 仅 Windows | Host 注册时把路径归一化为 `c:/...`，与原生 `C:\...` fixture 逐字比较失配 | 改用进入前 `status` 的 cwd 作"回家"基准（平台无关且语义更准） |
| run-turn-provider-integration×1（60s 超时）、build 矩阵 ui-states E4.4 主题切换 E2E×1（60 过 1 失） | macos / 三平台 | 疑慢机 flake（同套件 ubuntu/windows 及本机均过） | 不改断言，待新 CI 复核 |

### 外壳验收补齐（新增用例，全部通过）

- Desktop 聊天轮光标：`handlePostChat` 内联块提取为 `decideChatExecutionDirectory`（沿用本文件 `resolveBotProviderConfigFallback` 的导出纯函数模式），4 用例覆盖 client / recover-transition / pinned（含 options 不变性）/ 缺目录 pinned。
- Desktop IPC control 通道：转发已解析命令且结果逐字返回（未知字段被 parser 剥除）、非法 sessionId / 非法命令拒绝。
- Desktop 嵌入式 Host 真链路（`desktop-host-workspace-lifecycle.test.ts`）：真 `startDesktopHostApi` + 真 SQLite + 真 Git，`HostSessionHttpClient` 驱动 enter → status → exit(remove)，保留修改与拒绝删除均有断言。
- Web BFF 双 transport（`workspace-lifecycle-connectivity.test.ts`）：TUI 客户端与 Web adapter 对同一 Host 的 control 一致（enter/status/exit 一轮，含拒绝路径）。

### 本轮验证记录（Windows / Node v24.16.0）

| 命令 / 范围 | 结果 |
| --- | --- |
| `npm run typecheck:all` | exit 0（92b5fb5f 与修复后各一轮，均在本 worktree） |
| `npm run architecture:check` | exit 0；无新增违规 |
| 新增/修复的外壳与 harness 用例（router 4、IPC 9、desktop 嵌入式 4、web 连通 3、4 个 bridge harness 25、citation-drift 6） | 全部通过 |
| PR 回归集（workspace / managed-shell / worker-subagents / checkout-* / run-turn-* / session-service / CLI worktree，33 文件） | 32 passed / 1 skipped；285 passed / 5 skipped；exit 0 |
| `node scripts/check-packaged-artifacts.mjs --bundle` | 仅既有 ajv 误报（见上），其余 0 finding |

### 后续：新会话 worktree 组合交互（P5 提案，未实现）

参照：ZCode Desktop 新版 New session 流（用户截图）与 `E:\cloned-projects\ZCode` 旧版 `packages/ui/src/git-branch-switcher/`（display.ts / switchAssist.ts）、`v4/SessionPane.tsx` 的 worktree 徽标数据。截图中的形态：选文件夹（Search folders + Recent + Open folder）→ Branch 行（默认当前分支，展开为可搜索分支列表，键盘选择，如 pr-441）→ Worktree 开关（默认开）→ 描述任务开始会话；侧栏会话项带 🔗 计数与 ⚠️ 徽标。

duya 落地边界（复用本 PR 的 Host 能力，缺的只有分支列表与 UI）：

- 新会话面板：选 workspace（已有）→ 可选分支 + Worktree 开关 → 创建会话后立即 `control enter { base: 分支, branchName }`（复用既有 pending/409 防线与 run admission）。
- 需新增 Host 只读 API：按 root 列分支（含当前分支标记）；UI 侧 BranchPicker（可搜索 + 键盘导航）。
- 侧栏会话徽标：在 worktree 中（分支名 / 🔗）与 pending transition（⚠️ → recover 入口）。
- 学 switchAssist 的受阻引导：`checkout_background_busy` / dirty 等拒绝 code 映射为原因 + 动作入口，而非只报错。
- 不做独立分支切换器（只在 enter 语境选基线）；分支列表只读。

状态：仅设计记录，待用户排期后另开切片实现。
