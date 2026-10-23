# 08 — 后台子 Agent 生命周期落盘

状态：todo · 负责人：待认领 · 更新：2026-10-23
分支：待建（建议 `codex/622-08-background-lifecycle`） · worktree：待分配
base：`d9eb7dba96f63b3e07b4fba9c068acd017616913` · owner：待认领

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

- [ ] 落地 Phase 1 A1 的全部用例（先红后绿，零行为变更）
- [ ] 写落盘的两条用例，确认红
- [ ] 复用 `BashTaskStore` 的 write-through + rehydrate + PID 对账范式落盘
- [ ] 写 F3 的 `RunLifecycleState ↔ TaskStatus` 映射表 + 锁定它的用例
- [ ] 跑 §验收 的 4 组命令
- [ ] 跑 §变异 的 3 组变异
- [ ] 划清与 Phase 2 C3（workflow 节点派生后台子 Agent）的边界：
      本卡提供**状态模型**，C3 消费它

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

---

## 接续 / 结果

- **已实现 / 已验证 / 已合并**：本卡**尚未开工**。以上是开工前的基线取证。
- **未提交路径**：无。
- **副作用**：无。
- **阻塞**：**被多 Agent 编排 Phase 1 阻塞**（A1 的补测是本卡的地基，
  两者是同一批工作，**不重复做**）。

**下一步**：认领本卡，**第一件事就是 Phase 1 A1 的补测**——
新建 `packages/host/tests/worker-subagents/background-lifecycle.test.ts`，
先写合法转移矩阵那条，确认它红（或绿，取决于现状——**如实记录**）。
**完成判据**：转移矩阵的每一条转移都有用例，且
`tryKill` 的三种 outcome 与 `markDrained` 的剪枝都被钉住。

**回退**：本卡会改 `packages/host/src/worker-subagents/{background-lifecycle,service}.ts`，
可能新增 `packages/data/src/**` 的表与 `packages/host/src/managed-shell/task-store.ts`
⇒ **按子步分提交**：
(1) Phase 1 补测（**零行为变更**）→ (2) F3 映射表 → (3) F1 落盘。
每个子步可单独 revert。**落盘有文件格式**，回退时要考虑**旧数据的读取**
（新代码必须能读旧目录，即使目录是空的）。
