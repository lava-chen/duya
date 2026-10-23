# 多 Agent Orchestrator：测试体系与优化方案

状态：active · 负责人：mavis（会话 `mvs_e147d69268a44fcfbd741886fdb24589`）· 更新：2026-10-23
分支：`codex/multi-agent-orchestrator` · worktree：`E:\Projects\duya\.claude\worktrees\multi-agent-orchestrator` · base：`af6e7eb6` · owner：mavis

## 目标与边界

**本次只交付评估与计划，不改运行时行为。** 用户问题：学习 `E:\cloned-projects\codex` 后，
duya 现有的多 agent 编排是否需要建立完整的测试体系与优化方案。

产出三件事：

1. codex 与 duya 的多 agent 编排对照（结论：**codex 没有可抄的任务队列 / 依赖 DAG / 自动重试**，
   duya 在依赖与重试轴上已经更强；codex 值得抄的是边界表达与测试手法）。
2. 测试体系方案（补测范围与「有区分力」验收标准）。
3. 优化方案（4 个可独立交付的切片）。

本次不处理：`packages/agent/` 遗留层、UI 侧多 agent 视图、跨宿主协议。

关联：610 架构主线（`docs/exec-plans/active/610-architecture-series/`）；
codex 原始调查见 `docs-local/research/multi-agent-orchestrator/codex-multi-agent-map.md`
（gitignored，回收前须拷回主检出）。

---

## 结论（先给）

### 一、需要测试体系，但缺口不在 workflow engine

| 模块 | 规模 | 专属测试 | 用例数 | 判定 |
| --- | --- | --- | --- | --- |
| `packages/host/src/worker-workflows/engine.ts` | 13.5 KB | ✅ | 23 | 已覆盖 |
| `packages/host/src/worker-workflows/`（全目录） | — | ✅ | 12 文件 / 185 | 已覆盖 |
| `packages/agent-core/src/modes/run-lifecycle-tracker.ts` | 12.9 KB | ✅ | 15 | 已覆盖 |
| **`packages/host/src/worker-subagents/background-lifecycle.ts`** | **22.7 KB** | **❌ 无** | **0 直接** | **补测** |
| **`packages/host/src/worker-subagents/service.ts`** | **49.5 KB** | **❌ 无（仅间接）** | **0 直接** | **补测** |
| **`apps/desktop/.../agent-process-pool.ts`** | ~14 KB | ✅ 但过薄 | 6 | 补测 |
| `packages/host/src/managed-shell/task-registry.ts` + `task-store.ts` | 21 KB | ✅ | 有 | 已覆盖 |

`BackgroundAgentLifecycle` 持有真正的 **Worker 状态机**（`isLegalTransition`
`background-lifecycle.ts:177-187`、`tryKill` 三种 outcome `:227`、`inFlightCount`、retention
剪枝、kill-race 容错 `tryComplete`/`tryFail`），却**没有任何专属测试文件**。
`subagentParams.test.ts`（13 例）测的是 SubagentTool 的**参数面**，
`background-task-process.test.ts`（3 例）测的是 **tool 绑定层**，都不覆盖状态机本身。

### 二、需要优化方案，4 项

| # | 问题 | 证据 | 影响 |
| --- | --- | --- | --- |
| O1 | **DAG 被拓扑排序成串行** | `engine.ts:198` `for (const node of topoSort(phase.nodes))` 逐个 await | 同层独立节点 N 倍墙钟浪费；`Semaphore` 只在 `map` 节点内生效（`map-runner.ts:83`） |
| O2 | **无依赖失败级联** | `engine.ts:236-244` 首个失败即整轮 `failed` | 一条支线失败杀死整轮，无关分支不能继续 |
| O3 | **重试无退避** | `node-runner.ts:410` `attempt <= maxRetries && RETRYABLE_CLASSES.has(...)` 立即重试 | `transient` 类错误瞬间烧完重试预算 |
| O4 | **后台编排不可恢复、拓扑不落盘** | `BackgroundAgentLifecycle` 纯内存（`:63`）；`TaskRecord.parentSessionId` / `subAgentSessionId` 不落盘 | Host 重启后运行中的子 agent 全丢；「这个会话派生了哪些 agent」无法回答 |

### 三、codex 值得抄的只有 4 样（不是队列/DAG/重试）

| codex | duya 现状 | 动作 |
| --- | --- | --- |
| `trait AgentControl`（`agent/api.rs:41`）+ `TestAgentControl` 完整 fake（`core/tests/suite/agent_control_tests.rs:54`，701 行） | `WorkflowHost` 端口（`host.ts:59-66`）形状**已等价**，但只被 fixture host 用，无「整套 fake」测试资产 | 抄**手法**：写一个 `FakeWorkflowHost` 完整实现，用于新测试 |
| `is_final` 把 `Interrupted` 明确列为**非终态**（`agent/status.rs:26`） | `RunLifecycleState` 15 态已有 `user_paused`/`backoff_paused`/`infra_paused`/`blocked` 族（`run-lifecycle-tracker.ts:24-57`），**已更强** | 无需抄 |
| 持久化 spawn 拓扑 `thread_spawn_edges`（`state/migrations/0021_thread_spawn_edges.sql`） | 无 | 对应 O4 |
| 状态 = 事件流投影（`agent/status.rs:6` + `session/mod.rs:2731-2735`） | `WorkflowRunTracker` 是纯转移矩阵（`tracker.ts:185-228`），**已等价且更纯** | 无需抄 |

> **负面结论（决定本计划形态）**：codex 全仓检索 `scheduler|dispatch_queue|task_queue|claim_task|
> lease` 与 `depends_on|dep_ids|prerequisite|topolog|DAG` 在多 agent 语境下**零命中**；
> `thread_spawn_edges` 的 `child_thread_id` 是主键 → **一子一父，天生树结构，无法表达 DAG**；
> `requeue` 全仓零命中；agent 侧**无信号量、无池、无排队等空位**。
> codex 的编排是**模型驱动**（每次要并行就调一次 `spawn_agent` 工具）。
> **因此「从 codex 学任务队列与依赖关系」这条路不成立**——duya 这两样已经有了，位置在
> `packages/host/src/worker-workflows/`，而 codex 根本没有。

---

## 最小闭环定义（用户任务标题对应）

「任务队列、依赖关系、Worker 状态、失败恢复」的最小闭环 = duya 已有的 workflow 引擎
（`engine.ts` + `validate.ts` + `journal.ts` + `host.ts`）**补齐并发与失败传播**，
并把子 agent 的后台状态机（`background-lifecycle.ts`）**接入**这条链。

现状盘点（已存在，无需重建）：

| 闭环要素 | duya 现状 | 位置 |
| --- | --- | --- |
| 任务队列 | workflow phase → node 队列；wake 三车道优先队列（user > agent > background，含 dedupe / 抢占 / watchdog） | `engine.ts:188`、`agent-core/src/wake/queue.ts` |
| 依赖关系 | 真实 DAG：`nodeDependencies` 提取 + `topoSort` + **三色 DFS 环检测** + 跨 phase 前向引用拒绝 | `validate.ts:69-128` / `:245-271` / `:234-242`、`engine.ts:113-140` |
| Worker 状态 | run 级 15 态内核（纯转移矩阵 + 历史 cap 64 + snapshot 折叠）；子 agent 级 5 态（`TaskStatus`） | `run-lifecycle-tracker.ts`、`worker-subagents/task-state.ts:1` |
| 失败恢复 | `on_error: skip/fail/retry` + `max_retries`（限 `RETRYABLE_CLASSES`）；journal 断点续跑（`nodeId+reqHash` 缓存命中 + `pruneTrailingFailures`）；HMAC 签名 resume token；预算 reserve→commit→release | `node-runner.ts:379-421`、`journal.ts:131-174`、`host.ts:83-134` |

缺口即上表 O1–O4，加一条**未闭合的接线**：

- **workflow 节点只能派生前台子 agent**：`execution-binding.ts:85` 固定
  `run_in_background: false`，且不传 `isolation` / `max_turns` / `permission_mode`。
  → 现状**无法表达「并行派生 3 个 agent → join → 继续」**，这正是最小闭环缺的那一环。
- **两套状态模型无映射**：`RunLifecycleState`（run 级）与 `TaskStatus`（子 agent 级）各自演进，
  无显式对应表，也无测试锁定二者关系。

---

## 切片（按依赖顺序，单切片一个 commit）

### Phase 1 — 补测（零行为变更，最低风险）

- [ ] **A1** 新建 `packages/host/tests/worker-subagents/background-lifecycle.test.ts`
      覆盖：合法转移矩阵（`pending→running`、`pending→killed`、`running→completed|killed|failed`，
      非法转移抛错）；`inFlightCount` 随终态下降；`tryKill` 三种 outcome
      （`killed`/`not_found`/`already_terminal`）；`markDrained` + retention 剪枝；
      `subscribe` 回调只收变更；`tryComplete`/`tryFail` 在已被 kill 时不抛；
      `run()` 的通知去重（`notified` Set，`:110`）不重复入队。
- [ ] **A2** 扩写 `apps/desktop/src/main/agents/process-pool/__tests__/`：
      `queueMessage` FIFO 与去重、`acquire` 的 `isNew` 语义、busy/idle 转换、
      子进程崩溃检测、`releaseAndWait` 优雅退出后 drain 下一条、`releasedSessions` 抑制误判。
- [ ] **A3** 为 `execution-binding.ts` 补一条接线测试：断言 workflow agent 节点确实经由
      `SUBAGENT_TOOL_NAME` 走到子 agent（防「端口换了名字仍绿」）。
- [ ] **A4** 建 `FakeWorkflowHost`：完整实现 `WorkflowHost`（`host.ts:59-66`），
      可脚本化每个节点的返回值 / 失败次数 / 时序，登记调用序列。仿 codex 的 `TestAgentControl`
      （`core/tests/suite/agent_control_tests.rs:54`）。后续 Phase 2 全部依赖它。

**验收（关键）**：每个新用例必须在 **base `af6e7eb6` 上跑红**，改后跑绿。
「两种状态下答案相同」的断言一律不收（对照：本仓
`packages/host/tests/checkout-aliveness-wiring.test.ts` 的教训）。

### Phase 2 — DAG 并行 + 依赖失败级联（O1 + O2）

- [ ] **C1** `engine.ts` 改为**按依赖分层并发**调度（Kahn 分层），
      复用现有 `Semaphore`（`host.ts:138-169`，`run()` 已带 try/finally RAII）。
      同层无依赖节点并行，跨层仍受依赖约束。`map` 节点的既有并行语义不变。
- [ ] **C2** 新增节点终态 `blocked`（或复用 `skipped` + `errorClass='dependency_failed'`）：
      节点失败 → 其**传递依赖者**标 blocked → 无关分支继续跑完。
      `EngineOutcome` 相应增加 `failed` 之外的聚合语义（部分失败）。
- [ ] **C3** 接线：**允许 workflow 节点派生后台子 agent**。
      在 `execution-binding.ts:80-115` 增加后台分支（`run_in_background: true`），
      并把 `TaskStatus` 映射进 journal，使 `wait` 语义可表达。

### Phase 3 — 重试退避（O3）

- [ ] **E1** `node-runner.ts` 重试加指数退避 + jitter；
      延迟函数可注入（便于假时钟测试），默认退避上限有界。

### Phase 4 — 持久化（O4）

- [ ] **F1** 后台子 agent 状态落盘：复用 `BashTaskStore` 已验证的
      write-through + rehydrate + PID/存活对账范式（`managed-shell/task-store.ts:141-179`）。
      Host 重启后 running → `lost`，不假装还活着。
- [ ] **F2** 持久化 spawn 拓扑（parent→child），对标 codex `thread_spawn_edges`。
      落在 core-db，不进 rollout。
- [ ] **F3** 写明 `RunLifecycleState` ↔ `TaskStatus` 的映射表并用测试锁定。

---

## 发现与决策

1. **不向 codex 学「任务队列 + 依赖关系」**。codex 没有这两个子系统（检索证据见
   `docs-local/research/.../codex-multi-agent-map.md` §9.1/§9.2）；duya 的依赖实现
   （`validate.ts` 三色 DFS + `engine.ts` topoSort）比 codex 完整。**决策：duya 的闭环在
   `packages/host/src/worker-workflows/` 内部收敛，不引入新编排子系统。**
2. **不新建第二个状态机**。run 级 15 态内核已覆盖 codex `AgentStatus` 7 态的全部语义且更细
   （暂停族 + 预算 + blocked）。**决策：补映射与测试，不合并模型。**
3. **Phase 1 先行**。当前 `background-lifecycle.ts`（22.7 KB，持有 Worker 状态机）零专属测试，
   而 Phase 2 会改动同一片语义。**决策：先补测再改行为**，否则无法证明并发改动没破坏状态机。
4. **测试资产形态**：不引入新测试框架，沿用 vitest；新增 `FakeWorkflowHost` 作为编排层
   可替换端口，与 codex `TestAgentControl` 同构。duya 的 `WorkflowHost` 端口
   （`host.ts:59-66`）**已经具备**该形状，只差一份完整 fake 实现。
5. **codex 有而 duya 没有的唯一硬需求是「持久化 spawn 拓扑」**，但它服务于「跨重启回答
   派生了哪些 agent」，不是最小闭环的必要条件 → 放 Phase 4，不阻塞主线。

---

## 验收

- [ ] Phase 1：`npx vitest run packages/host/tests/worker-subagents apps/desktop/src/main/agents/process-pool`，
      新用例在 base 上红、改后绿；`npm run typecheck:all` 与 `npm run architecture:check` 通过。
- [ ] Phase 2：新增用例断言「同层两个无依赖节点的 host 调用**交错**执行」
      （假 host 记录调用序列）——这是 O1 的**有区分力**判据；
      另断言「A 失败后依赖 A 的节点被标 blocked，而无依赖分支仍完成」。
- [ ] Phase 3：退避用注入的假延迟断言「第 N 次重试的等待 ≥ 第 N-1 次」。
- [ ] Phase 4：重启 rehydrate 后 running 任务状态为 `lost`，且不产生幽灵 running。

门禁命令（每次提交前）：`npm run typecheck:all`、`npm run architecture:check`、
受影响包 vitest。基线失败须按文件 / 用例 / 错误签名记录，不得只报数量。

---

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `af6e7eb6`（干净） | Windows 11 / Node | `git diff e4289e38 af6e7eb6 -- packages/host/src/worker-workflows packages/host/src/worker-subagents packages/agent-core/src/{modes,wake} apps/desktop/src/main/agents packages/host/src/managed-shell` | 0 / 输出为空 | 编排代码在两 base 间**无差异**，评估结论对最新 master 成立 |
| `af6e7eb6`（干净） | 同上 | `git worktree add .claude/worktrees/multi-agent-orchestrator -b codex/multi-agent-orchestrator origin/master` | 0 | worktree 已建，base `af6e7eb6`（领先本地 master `e4289e38` 4 个提交） |
| `af6e7eb6`（干净） | 同上 | `node scripts/junction-worktree.mjs <worktree>` | 0 / 56 link(s) created | 依赖 overlay 就绪，未穿过共享 junction 安装 |
| `af6e7eb6`（干净） | 同上 | codex 只读调查（grep + 精读 `core/src/agent/**`、`agent-graph-store/**`、`core/tests/suite/agent_control_tests.rs`） | n/a | `docs-local/research/multi-agent-orchestrator/codex-multi-agent-map.md` |
| `af6e7eb6`（干净） | 同上 | duya 只读调查（grep + 精读 `engine.ts`、`validate.ts`、`journal.ts`、`host.ts`、`node-runner.ts`、`background-lifecycle.ts`、`wake/queue.ts`、`run-lifecycle-tracker.ts`、`execution-binding.ts`） | n/a | 本文件「结论」节各行号锚点 |
| `af6e7eb6`（干净） | Windows / Node v24.16.0 / npm 11.13.0 | `npm run build:packages` | 0 / built 20 package(s) | worktree 首次需构建产物；构建后 `packages/capabilities/src/ModuleTool/inline-content.ts` 出现 CRLF churn，已 `git checkout --` 还原（非本任务成果） |
| `af6e7eb6`（干净） | 同上 | `npx vitest run packages/host/tests/worker-workflows packages/host/tests/worker-subagents packages/agent-core/test/modes`（**构建前**） | **1** / 11 文件在 import 期失败 | 失败签名：`Failed to resolve entry for package "@duya/ai"`（vite import-analysis）——**环境性**（worktree 未构建产物），非断言失败；59 tests passed |
| `af6e7eb6`（干净） | 同上 | 同上命令（**构建后**） | 0 / 17 files, 237 tests passed | 编排面基线全绿；这是 Phase 1 补测的对照基线 |
| `af6e7eb6`（干净） | 同上 | `npm run architecture:check` | 0 / `OK — no new boundary violations` | tolerated 2608 / baseline 2785；另有「255 fingerprint 不再触发」的既有提示，**未用 `--write` 重录基线**（worktree 内禁止顺手重录） |
| `af6e7eb6`（干净） | 同上 | `npm run typecheck:all` | 0 / `no new type errors (206 known across 102 key(s))` | electron gate 另有「9 baselined key(s) shrank」的既有提示，同样未重录 |

---

## 接续 / 结果

- **已实现**：仅计划文档（`docs/exec-plans/active/2026-10-23-multi-agent-orchestrator.md`）与
  codex 调查（gitignored）。**未改任何运行时行为**——本次是评估任务。
- **PR**：待创建（分支 `codex/multi-agent-orchestrator` → `master`）。
- **未提交路径**：无。
- **副作用**：worktree `E:\Projects\duya\.claude\worktrees\multi-agent-orchestrator`（56 个
  junction 指向主检出依赖）；主检出 `git status` 未变。
- **阻塞**：无。
- **回收**：不回收——PR 未合并，Phase 1–4 待由后续 agent 在本分支续做。
- **下一步**：执行 Phase 1 / A1。新建
  `packages/host/tests/worker-subagents/background-lifecycle.test.ts`，
  首个用例直接锁定 `isLegalTransition` 的合法转移矩阵；
  判据 = 该用例在 base `af6e7eb6` 上**红**（模块当前无导出测试入口）、
  在实现落地后**绿**，且 `npm run typecheck:all` 通过。
