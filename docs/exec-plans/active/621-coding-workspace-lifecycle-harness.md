# 621 — Coding Workspace Lifecycle Harness（Session → Checkout → ChangeSet → Integration）

状态：active（契约阶段）· 负责人：codex/worktree-lifecycle · 更新：2026-10-22
分支：`codex/worktree-lifecycle` · worktree：`.claude/worktrees/worktree-lifecycle` · base：`2e6f265d`（origin/master）

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
| 新增 agent 可调用的 worktree 工具 | codex 全仓 `core/src/tools/` 无此类工具，worktree 是 shell/UX 能力；duya 只保留既有的 `isolation:'worktree'` 与 CLI 入口 |
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
| agent 工具面 | 无 worktree 工具 | **抄**，不新增 |
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
2. **Web 端接入方式**：Host 强制 bearer 且拒绝带 `Origin` 的请求，浏览器 renderer 无法直连。F 开工前必须在「同源反代 / localhost 例外 / 只读快照」三者中定一个，否则 F 会返工。
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

## 进度

- [x] 契约核对（496 / 587 C6 / data stores / worker-subagents / agent-protocol / remove-worktree）
- [x] codex 参照实现取证（worktree crate / metadata / state migrations / TUI 起会话顺序 / git-attribution）
- [x] 契约定稿（本文件 4.1–4.6）
- [x] Provider 接口签名 v0（附录 A，B 可据此并行）
- [ ] 派发 A / B / C（各自 worktree + PR）
- [ ] 第一波合并后启动 D / E
- [ ] D / E 合并后启动 F
- [ ] 场景 1–7 全绿，三端连通

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `2e6f265d` 只读核对 | Windows / Git Bash | `git rev-parse`、逐文件 `Read` / `grep -n` | 0 | 本文「现状核对」表内全部 `file:line`；codex 侧引用自 `c7234c1174` |
| `48d3c383`（仅 `docs/**`） | Windows 11 / Node 22.22.2 | `node scripts/check-text-encoding.mjs` | 0 — `no new violations (11 known)` | 终端输出 |
| 同上 | 同上 | `node scripts/architecture/architecture-check.mjs` | 0 — `tolerated 2800 / baseline 2785`，无新增违规 | 终端输出 |
| 同上 | 同上 | `env -u CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR npm run typecheck:all` | 0 — 11m15s；`typecheck-electron-gate: no new type errors (231 known)`；`eval:agent:core:check` 4/4 pass | 终端输出 |
| 同上 | 同上 | 目标测试 | 不适用：本次仅新增文档，未触碰 `packages/**` 实现 | — |

构建副作用核对：`build:packages` 后 `git diff --numstat` 无内容差异，`packages/capabilities/src/ModuleTool/inline-content.ts` 只是 CRLF/LF 的 stat-dirty 条目，未纳入提交。

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

已实现：无（契约阶段）。
已合并：无。
未提交路径：本文件与 `docs/exec-plans/{README,catalog}.md` 的登记行。
外部副作用：无。
回收：worktree 保留（任务未完成），owner 即本计划。
下一步：把 A / B / C 的路径所有权与接口签名写进各自的派工记录，A 先出 Provider 接口签名供 B 并行；接口签名落定后三路同时开工。
