# 03 — Control Plane 11 个域

> CP = "整个事情怎么持续推进"的大脑。Runtime 管"这一次怎么跑",CP 管"这件事怎么持续跑下去"。
> **先读 [00 合同](00-contracts.md)。** 本文件是实施细节。

---

## 1. 11 域职责

| 域 | 职责 | 端口 | 当前状态 |
| --- | --- | --- | --- |
| `projects/` | Project 身份(namespace,不等于文件夹) | `ProjectRepository` | store 在 `db/core/project-store.ts` |
| `workspace/` | 本机执行上下文:roots/cwd/policy/capabilities/environment | `WorkspaceRepository` | **已就位** |
| `goals/` | 目标生命周期(10 态机) | `GoalRepository` | **两个 owner** |
| `tasks/` | 任务分解与依赖 | `TaskRepository` | **两个 owner** |
| `runs/` | Run 创建/dispatch/终态/receipt | `RunRepository` | 部分覆盖 |
| `scheduler/` | 何时运行(cron/事件/条件) | `ScheduleRepository` | **无** |
| `wake/` | 触发与唤醒 | `WakeRepository` | 在 `agent/src/wake/` |
| `steering/` | 运行中的人工干预 | `SteeringRepository` | **无** |
| `approvals/` | 权限审批的 durable owner | `ApprovalRepository` | 部分,**生产调用为 0** |
| `checkpoints/` | 运行快照与恢复点 | `CheckpointRepository` | **无** |
| `storage/` | repository interface 定义 | — | `repository-port.ts` |

**Workspace 明确留在 CP 内部,不独立成包**(00 合同 §E)。

---

## 2. 域的共同形状

每个域遵循同一模板,避免 11 份不同的风格:

```ts
// 1. 领域类型(纯,无 IO)—— 可以进 protocol 或留在本域
export interface Goal { readonly id: GoalId; readonly projectId: ProjectId | null; ... }

// 2. repository interface(CP 依赖它,不知道实现)
export interface GoalRepository {
  create(goal: Goal): Promise<Goal>;
  find(id: GoalId): Promise<Goal | null>;
  // ...
}

// 3. service(纯决策,依赖注入的 repo)
export class GoalService {
  constructor(private readonly repo: GoalRepository, private readonly clock: Clock) {}
}

// 4. SQLite 实现 —— 归 packages/data,不放这里
```

**禁止:** 域目录里出现 `new Database()`、`db.prepare()`、直接 SQL。

---

## 3. `goals/` 的两个 owner 裁决

当前 Goal 生命周期由**两处**驱动:

| owner | 位置 | 性质 |
| --- | --- | --- |
| `session_goals` 表 | `db/core/stores.ts:632` | **数据 owner** |
| `modes/goal/` 状态机 | `packages/agent/src/modes/goal/` | **行为 owner**(10 态机 + 独立验证) |

**裁决:数据与生命周期决策归 CP,执行期的"Goal 模式"行为归 runtime。**

- CP `goals/`:状态机本身、`pause/resume/budget_limited` 决策、跨 run 持久
- Runtime:某一次 run 期间"当前 goal 处于哪个态"怎么影响工具注入

`modes/goal/GoalTracker` 是**进程内单例**(`process singleton`,见 ARCHITECTURE.md)—— 这本身就是需要迁出的信号:CP 域不能有进程内单例。

---

## 4. `tasks/` 的三个 subject(不合并)

引用 587 §08 裁决,实测确认是**三个不同 subject**:

| subject | 实现 | substrate | 归属 |
| --- | --- | --- | --- |
| A. TODO 清单(per session,持久) | `stores.ts` TaskStore | SQLite core.db | CP `tasks/` |
| B. 后台 subagent 注册表 | `BackgroundAgentLifecycle` | 内存 Map + AbortController | Runtime |
| C. 后台 bash 命令 | `bash-task-store.ts` | JSON `~/.duya/bash-tasks/` | Runtime |

**必须在类型上区分**,否则 S1 的 Session 解耦会被 B/C 拖住 —— B/C 天然是 session 作用域的。

建议:
```ts
type TaskSubject =
  | { kind: 'todo'; projectId: ProjectId | null }   // A: CP
  | { kind: 'subagent'; runId: RunId }               // B: runtime
  | { kind: 'bash'; runId: RunId }                   // C: runtime
```

---

## 5. `approvals/` 的当前缺陷

`permission-coordinator.ts`(25 KB)是 CP 里最接近成形的部分,但:

- **生产构造调用为 0**(13 号评审 F02 实测)
- router 在 durable refusal 后**继续发 allow**(`router.ts:2220/2226/2244`)
- worker 侧仍自己设 300000ms timer(`agent-process-entry.ts:2343`)

**本系列的 CP 是审批的唯一 durable owner。** 详见 [04 §审批](04-runtime-owns-execution.md#5-审批归-cp)。

---

## 6. 缺失域的最小实现

`scheduler/` `steering/` `checkpoints/` 当前**完全不存在**。先建骨架,但**每个骨架必须同时给出**"第一个真实迁入源",否则就是 587 禁止的空包。

| 域 | 第一个迁入源 |
| --- | --- |
| `scheduler/` | `cron-file.ts` + `Scheduler.ts`(587 §08 判 LIVE) |
| `wake/` | `packages/agent/src/wake/` 全量 |
| `steering/` | `MessageSessionTool` / `SendMessageTool` 的运行期注入路径 |
| `checkpoints/` | `journal/` + runtime 的 `InMemoryCheckpointStore` 的持久化侧 |

---

## 7. 门禁

| 门禁 | 检查 | 变异证明 |
| --- | --- | --- |
| G10 | CP 域无 `db.prepare` / `new Database` | 在某域 service 里加一条 SQL |
| G11 | CP 域无进程内单例 | 加一个 module-level `let singleton` |
| G12 | 每个域有真实迁入源(非空壳) | 建一个只有 interface 没有实现的域 |
