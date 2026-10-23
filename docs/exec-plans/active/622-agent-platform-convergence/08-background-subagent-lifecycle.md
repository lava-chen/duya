# 08 — 后台子 Agent 生命周期落盘

状态：implemented（未合并）· 负责人：worker（会话 `mvs_56c889dca78e46a4876dfacd7f12852c`）· 更新：2026-10-23
分支：`codex/622-08-background-lifecycle` · worktree：`.claude/worktrees/622-08`
base：`6c6a411f`（`codex/plan-622`）· owner：worker

关联：[622 README](./README.md) ·
**与 [多 Agent 编排 Phase 1 + Phase 4 F1/F3](../2026-10-23-multi-agent-orchestrator.md) 共用同一份实施**
——本卡是它的**排序与验收对齐**，不是重写。

---

## 目标与边界

**目标**：后台子 Agent 的**生命周期**（不只是通知）落盘，使 Host 重启后
不产生幽灵 running、也不假装还活着。

**今天的失败形态（实测）**：

```text
packages/host/src/worker-subagents/background-lifecycle.ts:64
  private tasks = new Map<string, TaskRecord>()
:69
  private checkouts = new Map<string, CheckoutRunRecord>()
:74
  private drainedAt = new Map<string, number>()
:25
  abortController: AbortController
:136
  subscribers: new Set(),
```

以及 `packages/host/src/worker-subagents/service.ts:82`
`const recentBackgroundSpawns = new Map<string, BackgroundSpawnRecord>();`

⇒ **全部在进程内**。`TaskRecord` 带 `AbortController` 与 `subscribers: Set`，
**结构上不可持久化**。

**DB 侧只有通知类别**：`packages/data/src/main-schema.ts:1804`
`CHECK (kind IN ('queued','followup','background_notification'))`
⇒ **通知落库、生命周期不落库。**

**边界**：

- **复用 `BashTaskStore`**，不新建第二个状态机
  （`packages/host/src/managed-shell/task-store.ts:119` 的 `BashTaskStore`，
  `:141` 的 `rehydrate()`，write-through + PID 存活对账）。
- **不改** `packages/host/src/worker-subagents/service.ts` 以外的子 Agent 语义。
- **不做** Phase 4 F2（持久化 spawn 拓扑 parent→child，落 core-db）——
  本卡只做 F1（生命周期落盘）与 F3（状态映射表）。
- **不改** `packages/data/src/main-schema.ts` 的既有表结构（新增表可以，改既有表不行）。

---

## 验收

### 首个失败证据（今天长什么样）

**今天的失败形态**：`packages/host/tests/worker-subagents/background-lifecycle.test.ts`
**不存在**。实测 `packages/host/tests/worker-subagents/` 下只有
`engine-run.test.ts` / `subagentParams.test.ts` / `transcript.test.ts` /
`worktree-isolation.test.ts`。

**必须先写的用例**（Phase 1 A1 已列好，本卡补充"落盘"那两条）：

```text
packages/host/tests/worker-subagents/background-lifecycle.test.ts   （新建）
  it('rehydrates a background task from disk after a restart', ...)
  it('marks a rehydrated running task as lost, not still running', ...)
```

- 第一条**今天红**：重启后 `tasks` Map 是空的（状态在进程内存里）。
- 第二条**今天红**：连"重启后能不能查到这条任务"都做不到，
  更谈不上把它标成 `lost`。

**Phase 1 A1 的其余用例**（合法转移矩阵、`inFlightCount` 随终态下降、
`tryKill` 三种 outcome、`markDrained` + retention 剪枝、
`subscribe` 回调只收变更、`tryComplete`/`tryFail` 在已被 kill 时不抛、
`run()` 的通知去重）在本卡**同批落地**——它们是本卡的地基。

**落盘的失败形态（写完 Phase 1 后、本卡实施前的红）**：

```text
  it('persists a background task so it survives a process restart', ...)
```
- 红的形态：进程 A 登记了一个 background task，
  进程 B（同一 store 根目录）读回来 **0 条**。

### 验收命令与预期结果

```bash
# 1) 生命周期专属测试
npx vitest run packages/host/tests/worker-subagents/background-lifecycle.test.ts
#    预期：全部 passed（含 Phase 1 A1 的转移矩阵与本卡的落盘两条）

# 2) 同目录合跑，不许打坏旁边
npx vitest run packages/host/tests/worker-subagents packages/host/tests/worker-tool-services
#    预期：全绿（今天 `worker-tool-services/background-task-process.test.ts` 已存在）

# 3) host 包 typecheck
npx tsc -p packages/host --noEmit
#    预期：exit 0

# 4) 下游不许坏
npm run architecture:check     # 预期：仍 OK
npm run plan:sync              # 预期：仍 OK
```

### 完成判据

1. **Phase 1 A1 的全部用例落地并绿**（这是本卡的地基，不是本卡的目标）。
2. **重启后 running → `lost`**，且**不产生幽灵 running**
   （多 Agent 计划 Phase 4 验收原文：「重启 rehydrate 后 running 任务状态为 `lost`，
   且不产生幽灵 running」）。
3. **F3 的映射表写成表并被测试锁定**：
   `RunLifecycleState` ↔ `TaskStatus` 的对应关系有**具名用例**，
   不是文档里的一段文字。
4. **落盘用 `BashTaskStore` 的范式**：write-through + rehydrate + PID/存活对账。
   ⇒ **判据**：新代码里**没有第二套**"写文件 + 重启读回"的机制。

### 变异证明（门禁卡必填）

- **变异 ①**：把 rehydrate 后的状态从 `lost` 改成 `running`
  → "marks a rehydrated running task as lost"那条用例**必须红**。
- **变异 ②**：关掉 write-through（只写内存）
  → "persists a background task so it survives a process restart"那条用例**必须红**。
- **变异 ③**：把 `markDrained` 的剪枝改成不剪枝
  → Phase 1 A1 的 retention 用例**必须红**。

---

## 进度

- [x] 落地 Phase 1 A1 的全部用例（先红后绿，零行为变更）——
      `packages/host/tests/worker-subagents/background-lifecycle.test.ts` 10 例
- [x] 写落盘的两条用例，确认红——**红态证据在 §变异 ②**（关掉 write-through
      即红），不是靠"先写测试再实现"的时序
- [x] 复用 `BashTaskStore` 的 write-through + rehydrate + PID 对账范式落盘
      ——`packages/host/src/worker-subagents/background-task-store.ts`
      （`BashTaskStore` 的**同一个机制**，独立实例 + 独立文件，共享 `isPidAlive`
      探针与「lost on rehydrate」措辞）
- [x] 写 F3 的 `RunLifecycleState ↔ TaskStatus` 映射表 + 锁定它的用例
      ——`packages/host/src/worker-subagents/lifecycle-mapping.ts`
      + `packages/host/tests/worker-subagents/lifecycle-mapping.test.ts` 9 例
- [x] 跑 §验收 的 4 组命令
- [x] 跑 §变异 的 3 组变异
- [x] 划清与 Phase 2 C3（workflow 节点派生后台子 Agent）的边界：
      本卡提供**状态模型**（`TaskPersistedFields` / `PersistedTaskStatus` /
      映射表），C3 消费它

---

## 发现与决策

1. **"通知落库、生命周期不落库"这个表述准确，且它解释了用户看到的现象。**
   `main-schema.ts:1804` 的 mailbox `kind` 有 `background_notification`
   ⇒ 子 Agent 完成时**用户能看到通知**；
   但重启后**没有任何东西知道那个子 Agent 还在跑**。
   ⇒ 裁决：落盘的**主体是任务状态**，通知只是它的一个投影。

2. **`TaskRecord` 结构上不可持久化。**
   `background-lifecycle.ts:25` 的 `abortController: AbortController` 与
   `:136` 的 `subscribers: new Set()` 是**进程内句柄**。
   ⇒ 裁决：**不要**试图把 `TaskRecord` 整个序列化。
   落盘的应该是**一个可序列化的投影**（id / 父会话 / 状态 / 起始时间 / PID / 标签），
   进程内句柄在 rehydrate 时**重建**（`AbortController` 新建、`subscribers` 空集）。
   这正是 `BashTaskStore` 已经在做的事——**照抄它的形状，别自创。**

3. **不要新建第二个状态机（多 Agent 计划明写）。**
   `BashTaskStore`（`managed-shell/task-store.ts:119`）已经有：
   write-through（`:114` 的注释）、`rehydrate()`（`:141`）、
   PID/存活对账（`:174` 的 `'Process exited before agent restart; lost on rehydrate'`）。
   ⇒ 裁决：**复用同一个范式**，但**新建自己的 store 实例**——
   后台子 Agent 的记录与后台 shell 命令的记录是**不同的东西**，
   只是**形状相同**。把它们混在一张表里会让"子 Agent 状态"和"命令状态"
   互相污染。

4. **`recentBackgroundSpawns`（`service.ts:82`）是第二个进程内 Map。**
   它记的是"最近的 spawn 记录"，用于抑制重复通知之类的用途。
   ⇒ 裁决：本卡**不**动它，除非它与落盘状态重复。
   **核对动作**：读 `service.ts:82-110` 与 `:826-830`，确认它与
   `background-lifecycle.ts` 的 `tasks` 是否承载同一事实。
   若承载同一事实 → **合并**，否则记为两个不同的东西并写清区别。

5. **F3 的映射表必须先于 Phase 2 C3。**
   Phase 2 C3 要把 `TaskStatus` 映射进 journal。
   若 `TaskStatus` 的语义还没定（哪些状态可持久化、`lost` 怎么表达、
   `running` 与 `drained` 的区别），C3 会映射出一个**没有定义的词**。
   ⇒ **顺序**：F3（本卡）→ C3（[07](07-workflow-dag-parallel.md)）。

6. **`lost` 是一个必须被显式承认的状态。**
   实测 `BashTaskStore` 的措辞：`'Process exited before agent restart; lost on rehydrate'`
   —— 它**不假装**任务还活着，而是说"它丢了"。
   ⇒ 裁决：后台子 Agent 用**同一套措辞**。
   **禁止**把重启后的 running 任务直接标 `completed` 或 `failed`
   （那是撒谎，且会让"重启后有幽灵 running"变成"重启后有幽灵完成"）。

---

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `d9eb7dba` / 干净 | macOS 12.7.6 · Node v20.20.2 | `ls packages/host/tests/worker-subagents/` | 0 | 4 个文件；**无 `background-lifecycle.test.ts`** |
| `d9eb7dba` / 干净 | 同上 | `grep -n "new Map\|AbortController\|subscribers" packages/host/src/worker-subagents/background-lifecycle.ts` | 0 | `:64` tasks / `:69` checkouts / `:74` drainedAt / `:25` abortController / `:136,:312,:313` subscribers |
| `d9eb7dba` / 干净 | 同上 | `grep -n "recentBackgroundSpawns" packages/host/src/worker-subagents/service.ts` | 0 | `:82` `new Map<string, BackgroundSpawnRecord>()`；`:826-827` 写入 |
| `d9eb7dba` / 干净 | 同上 | `grep -n "background_notification" packages/data/src/main-schema.ts` | 0 | `:1731` 类别名；`:1804` `CHECK (kind IN ('queued','followup','background_notification'))` |
| `d9eb7dba` / 干净 | 同上 | `grep -n "class BashTaskStore\|async rehydrate\|lost on rehydrate" packages/host/src/managed-shell/task-store.ts` | 0 | `:119` class；`:141` rehydrate；`:174` `'Process exited before agent restart; lost on rehydrate'` |

### 本卡实施后的验证（worker · 分支 `codex/622-08-background-lifecycle`）

环境：macOS 12.7.6 · Node **v20.20.2**（仓库 `engines` 要求 ≥22）·
worktree `.claude/worktrees/622-08` · base `6c6a411f`。
**本卡不触碰 SQLite**（落盘沿用 `BashTaskStore` 的文件快照范式），
因此 `better-sqlite3` 原生模块未参与本卡任何命令，无 segfault 风险。

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `6c6a411f` + 本卡改动（dirty：8 个文件） | macOS 12.7.6 · Node v20.20.2 | `npx vitest run packages/host/tests/worker-subagents/background-lifecycle.test.ts packages/host/tests/worker-subagents/lifecycle-mapping.test.ts` | **0** | 2 files / **25 passed**（状态机 10 + 落盘 6 + 映射 9） |
| `6c6a411f` + 本卡改动 | 同上 | `npx vitest run packages/host/tests/worker-subagents packages/host/tests/worker-tool-services` | **0** | 8 files / **68 passed**；改动前基线：6 files / 35 passed + `engine-run.test.ts` 收集失败（`Failed to resolve entry for package "@duya/ai"`——**环境性**：worktree 未构建产物；`npm run build:packages` 后消失） |
| `6c6a411f` + 本卡改动 | 同上 | `npx tsc -p packages/host --noEmit` | **0** | 无输出 |
| `6c6a411f` + 本卡改动 | 同上 | `npm run architecture:check` | **0** | 检测 2611 / tolerated 2611 / blocking 0 / baseline 2785 → `OK — no new boundary violations.`（新增的 3 条依赖边均为 permitted） |
| `6c6a411f` + 本卡改动 | 同上 | `npm run plan:sync` | **0** | `16 done rows · 28 file refs · 14 test-name refs` → `OK` |
| `6c6a411f` + 本卡改动 | 同上 | `npm run typecheck:all` | **0** | `no new type errors (206 known across 102 key(s))`（与基线同数） |
| 变异 ①（rehydrate 的 `lost` → `running`） | 同上 | `npx vitest run packages/host/tests/worker-subagents/background-lifecycle.test.ts` | **1** | **红**：`marks a rehydrated running task as lost, not still running`（`expected 'running' to be 'lost'`）+ `does not leave a ghost running task behind after a restart`；2 failed / 14 passed。已完全回退 |
| 变异 ②（关掉 write-through，只写内存） | 同上 | 同上 | **1** | **红**：`persists a background task so it survives a process restart`（`expected [] to deeply equal [ 'task-1' ]`）等 6 例；6 failed / 10 passed。已完全回退 |
| 变异 ③（`markDrained` 剪枝改成不剪枝） | 同上 | 同上 | **1** | **红**：Phase 1 A1 的 retention 用例 `keeps a drained record queryable until the retention window elapses, then prunes it`（`expected { taskId: 'task-1', … } to be undefined`）；1 failed / 15 passed。已完全回退 |
| 回退后复跑 | 同上 | `npx vitest run packages/host/tests/worker-subagents packages/host/tests/worker-tool-services` | **0** | 8 files / 68 passed（`grep -rn "MUTATION" packages/host/src/worker-subagents/` 无命中） |

---

## 接续 / 结果

- **已实现**：
  - `packages/host/src/worker-subagents/task-state.ts`——`TaskRecord` 拆成
    **「可持久化字段」`TaskPersistedFields`** / **「进程内句柄」`TaskRuntimeFields`**
    （`AbortController` + `subscribers`）/ **「仅内存」`TaskVolatileFields`**；
    新增 `PersistedTaskStatus`（`TaskStatus` + `lost`）与 `RecoveredTaskRecord`。
  - `packages/host/src/worker-subagents/background-task-store.ts`（新）——
    `BackgroundTaskStore`：版本化 JSON 快照 + 写穿透 + 写队列合并 + 留存裁剪
    + `rehydrate()` 时按 **owner PID 存活对账**；快照文件按 **owner scope**
    （`SESSION_ID`）分片，避免多 worker 进程互相覆盖，同时同一 session 重启
    后仍能找回自己的文件。
  - `packages/host/src/worker-subagents/background-lifecycle.ts`——每次状态变更
    写穿透；`rehydrateFromStore()` + `getRecovered()` / `getRecoveredAll()`；
    生产单例挂上默认 store 并在启动时自动 rehydrate。
  - `packages/host/src/worker-subagents/lifecycle-mapping.ts`（新）——F3 映射表
    （15 run 态 → 5 task 态），反向索引由正向表派生，不会两边漂移。
  - 测试：`packages/host/tests/worker-subagents/background-lifecycle.test.ts`
    （16 例）、`packages/host/tests/worker-subagents/lifecycle-mapping.test.ts`（9 例）。
- **已验证**：§验证记录 的 4 组门禁命令 + 3 组变异全部实跑（退出码见上表）。
- **已合并**：**否**。PR 堆叠在 #384（`codex/plan-622`）之上，未授权合入。
- **未做（明确不在本卡范围）**：
  - **没有动 `packages/data/src/**`**：落盘沿用 `BashTaskStore` 的**文件快照**
    范式，而不是新增 SQLite 表 + 迁移。理由见下条决策 1。
  - 没有把 `lost` 投影到模型/UI 可见的词汇表：`@duya/capabilities/background-task-tool.ts`
    的 `BackgroundTaskStatus` 没有 `lost`，而该路径是本波次禁区。
  - 没有做 Phase 4 **F2**（spawn 拓扑 parent→child 落 core-db）。
  - 没有动 `packages/host/src/worker-subagents/service.ts`：
    `recentBackgroundSpawns`（`:82`）仍是进程内 TTL 表，它记的是"最近一次 spawn
    的回执"（用于抑制重复 spawn），与本卡的"任务状态"**不是同一个事实**，
    故按卡片决策 4 保持分离。
  - 没有动 `packages/host/src/managed-shell/task-store.ts`：只 **import** 了它的
    `isPidAlive`，让两个 store 对"活着"的定义不可能漂移。
- **决策（父 agent 需要知道的两条）**：
  1. **落盘介质 = 文件快照，不是 core-db 表。** 卡片的判据是"新代码里**没有第二套**
     『写文件 + 重启读回』的机制"，而 `BashTaskStore` 就是文件快照；新增 SQLite 表
     会引入**第二套介质 + 迁移机制**，且子 Agent 记录与 shell 命令记录本就该分开
     （卡片决策 3）。若要改成 core-db 表，那是一次独立改写，不是本卡的增量。
  2. **`lost` 的可见范围。** `TaskStatus`（5 态）保持不变，`lost` 只存在于**持久化
     词汇** `PersistedTaskStatus` 与 `RecoveredTaskRecord`。原因：
     `packages/host/src/worker-tool-services/background-task.ts` 把
     `TaskRecord.status` 直接投影到 `@duya/capabilities` 的 `BackgroundTaskStatus`
     （无 `lost`），把 `lost` 加进 `TaskStatus` 会打破那个文件的类型，而该文件在本卡
     的禁改路径里。⇒ 恢复出的记录通过 `getRecovered*()` 暴露，**不混进 live `tasks`**
     （它们没有 controller / subscribers，本来就不能被驱动或 kill）。
- **副作用**：无（未合并；分支与 worktree 保留）。
- **阻塞**：无。

**下一步**：PR 合入后，按 §发现与决策 5 的顺序把 F3 映射表交给
[07](07-workflow-dag-parallel.md) 的 C3 消费；若要让用户看到"重启后这个子 Agent 丢了"，
需要先给 `BackgroundTaskStatus` 增加 `lost`（`@duya/capabilities` 路径，需单独授权）。
