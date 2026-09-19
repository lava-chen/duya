# 415 — duya Workflow 架构方案（独立 run 管理系统）

> 状态：设计稿（待评审）
> 优先级：P1
> 定位：**独立的后台 run 管理系统**（对齐 grok `xai-grok-shell/src/session/workflow`），
> 经 Slash Command 启动，拥有自己的 run 级状态机，**不是 mode**。
> 关联：**RPA 节点体系与整体设计修订 → companion plan [552](./552-workflow-rpa-agent-design.md)（评审通过后 §3.2 节点 schema 与 §8 落地步骤以 552 为准）**；对比 grok-build `xai-workflow`（命令式 Rhai）与 pi-dag（声明式 YAML）
> 复用地基：`SubagentTool` / `BackgroundAgentLifecycle` / `AIClient` / `chat:agent_progress` SSE
> 参考实现报告：`docs/references/grok-workflow-implementation.md`

---

## 1. 定位与决策

### 1.1 一句话定位

duya 的 Workflow 是**一套独立的后台 run 管理系统**，与 mode / agent 会话系统正交。它不占用
主 agent 工具循环，由 Slash Command 启动一条独立 run，在后台并行派发子 agent，再汇总结果。
它有自己的 `WorkflowRunStatus` 状态机，全程自管。

**为什么不是 mode**（依据 grok 源码，见 §7）：grok 的 workflow **不建在它的 mode 系统之上**。
它是一套独立的 run 管理（`WorkflowManager` + `host_service` + `xai-workflow` 引擎），经 Slash
Command 启动。因此 duya 也拆成**两族正交的东西**：

- **run 级**：`WorkflowRunTracker` —— 描述后台 run 的生命周期（预算/暂停/验证/断点续跑）。
- **入口级**：一个极薄的注册（Slash Command + orchestrator 形态的薄 wrapper）—— 只负责"识别
  触发词 → 拿到目标 → 拉起一条 run"，不承担任何 run 状态管理。

不要把 Workflow 塞进 popover mode。mode 是"怎么走 agent 工具循环"，workflow 是"不走路，自己
读脚本编排"。两者混谈会严重混淆（这是本条设计稿反复强调的红线）。

### 1.2 已确认决策

| 决策点 | 结论 |
|--------|------|
| 落地形态 | **独立 run 管理系统 + 极薄入口**（非 mode；对齐 grok） |
| 命令式层地基 | **`map` + `when` 两原语**（不做完整 Rhai 脚本） |
| Verify 时序 | **前台优先，后台进阶**（MVP 前台等待，两条路径共享 `verify.done` 查询） |
| 人在环 | **仅高风险确认**（默认规划后直接执行，识别到高风险才停住确认） |
| 可复用性 | **首个版本就支持复用**（Workflow 可命名保存为 Slash Command） |
| 表达式引用范围 | **任意已完成节点 output** |
| 当前步骤 | **只要设计稿** |

### 1.3 为什么是声明式骨架 + 两原语（对比论证）

| 方案 | 可静态校验 | 动态并行 | 断点续跑 | 表达力 |
|------|-----------|---------|---------|--------|
| 全命令式（grok Rhai） | ❌ 弱 | ✅ 强 | ❌ 难 | 强 |
| 全声明式（pi-dag YAML） | ✅ | ❌ 编译期不可枚举 | ✅ | 弱 |
| **duya 混合** | ✅（骨架） | ✅（map） | ✅ | 中 |

关键洞察：声明式 YAML 的静态校验、确定性、可续跑是刚需；**动态性**的唯一缺口是"输入未知时
无法枚举 fan-out"。这个缺口用 `map`（按运行时输入 fan-out）和 `when`（按前置结果条件分支）
两个受限原语即可全覆盖，无需引入完整脚本语言。

---

## 2. 分层架构（对齐 grok 五层）

grok 把 workflow 拆成引擎 + 外壳，职责清晰。duya 对齐成五层，但引擎用**声明式 YAML + 两原语**
替代 grok 的 Rhai：

```
┌──────────────────────────────────────────────────────────────┐
│  入口层  Slash Command + 极薄 orchestrator wrapper             │
│         识别触发词 → 取目标 → 拉一条 run                         │
├──────────────────────────────────────────────────────────────┤
│  run 层  WorkflowManager + WorkflowRunTracker                │
│         launch/pause/cancel/resume + 11 态 run 状态机          │
├──────────────────────────────────────────────────────────────┤
│  引擎层  WorkflowEngine（YAML 骨架 + map/when + Verify）       │
│         阶段顺序 + 节点拓扑 + journal 断点续跑                   │
├──────────────────────────────────────────────────────────────┤
│  宿主层  WorkflowHost（并发 semaphore + subagent 派发）        │
├──────────────────────────────────────────────────────────────┤
│  存储层  WorkflowRunStore（脚本副本 + args + journal + 快照）   │
└──────────────────────────────────────────────────────────────┘
```

| grok 层 | duya 层 | 说明 |
|---------|---------|------|
| `xai-workflow` 引擎（Rhai） | `WorkflowEngine`（YAML + map/when） | 确定性的编排核心，不依赖会话 |
| `WorkflowManager` | `WorkflowManager` | run 生命周期：launch/pause/cancel/resume |
| `WorkflowTracker` | `WorkflowRunTracker` | run 级 11 态状态机 |
| `HostService` | `WorkflowHost` | 并发 slot + subagent 派发 + scratch |
| `WorkflowRunStore` | `WorkflowRunStore` | 持久化：脚本/args/journal/快照 |

---

## 3. Workflow 定义（YAML 骨架）

### 3.1 顶层 schema

```yaml
name: string                # ≤64，kebab-case
description: string         # ≤1024，何时用
when_to_use: string         # ≤2048，触发条件描述
phases:                     # ≤8 阶段，顺序执行
  - phase:       string     # 阶段 id（唯一）
    title:       string     # ≤128
    detail:      string     # ≤1024
    nodes:       Node[]     # 该阶段的节点（默认顺序，可带 when 依赖）
```

### 3.2 节点（Node）schema

```yaml
# 三种节点：agent / tool / noop
- id: string                 # 全局唯一，供引用
  # agent 节点：发射子 agent
  agent: string              # agent 类型（general-purpose / Explore / verification / ...）
  prompt: string             # 任务提示，支持 ${ref} 插值
  model?: string             # 可选，覆盖模型
  isolation?: 'worktree'     # 可选，隔离工作树

  # tool 节点：直接调用工具（复用 ToolRegistry）
  tool?: string
  input?: object

  # ---- 命令式原语 ----
  map?:                       # 动态 fan-out（agent 或 tool 节点均可）
    over: Expr                # 引用前置节点输出（数组）
    as: string                # 循环变量名，在 prompt/input 中可插值
    parallel: true            # 默认 true
    concurrency?: number      # 并行度上限（默认 4，≤16）
    prompt?: string           # 覆盖节点 prompt（含 ${as}）
  when?: Expr                 # 条件边，false 则跳过本节点

  # 可选兜底
  on_error?: 'skip' | 'fail' | 'retry'   # 默认 skip
  max_retries?: number        # on_error=retry 时，默认 1
```

### 3.3 默认四阶段模板（规划器默认产出，可裁剪）

```
Context  →  Work  →  Verify  →  Synthesize
  │            │        │           │
 盘点/理解    并行实现   后台验证    汇总报告
```

- **Context**：收集项目/需求上下文，产出 `context.summary`。
- **Work**：通常含一个 `map` 节点按 Context 输出 fan-out 并行实现。
- **Verify**：内建，见 §4.4。
- **Synthesize**：收集 all 结果 → 汇总报告。

---

## 4. 命令式层：map + when

### 4.1 表达式求值器（受限）

位置：`packages/agent/src/modes/workflow/expr.ts`

只支持四类合法表达式（超出即静态校验失败，防 prompt injection / 任意代码）：

1. **引用**：`nodeId.output` / `nodeId.succeeded` / `nodeId.failed` / `nodeId.count`
2. **比较**：`==` `!=` `>` `<` `>=` `<=`（操作数必须是引用或字面量）
3. **逻辑**：`&&` `||` `!`
4. **聚合**（针对 map 结果数组）：`any(nodeId.output)` `all(nodeId.output)` `count(nodeId.output)`

实现：一个 ~200 行的递归下降解析器 + visitor，输出 `true/false`（when）或值（map 的 `over`）。
不做 `eval`，不暴露任意函数。

### 4.2 map — 动态 fan-out

- **编译期**：`over` 是表达式，无法枚举 → 运行时才解析。
- **运行时**：`MapRunner` 解析 `over` → 得到数组 → 为每个元素生成一个独立 subagent（复用
  `SubagentTool` 的 `run_in_background` 路径 + `BackgroundAgentLifecycle`），`concurrency`
  控制同时运行数。
- **结果**：收集成数组挂到 `nodeId.output`，供后续节点聚合引用。
- **幂等**：每个 fan-out 子任务继承 `parentSessionId + toolUseId` 的 spawn 去重逻辑
  （`SubagentTool` 已有：`recentBackgroundSpawns` 的 `parentSessionId:tool:{toolUseId}` 与
  `parentSessionId:semantic:{agentType}:{name}:{promptHash}` 双 key），避免重复发射。

### 4.3 when — 条件边

- 节点执行前先求值 `when`；为 `false` 则跳过（record 为 `skipped`，不阻塞后续）。
- 典型用途：`when: "verify.failed > 0"` → 进入修复节点；`when: "someNode.count > 0"` → 条件处理。

### 4.4 内建 Verify 阶段

- Workflow 末尾自动追加一个 verify 节点（若骨架未显式声明）。
- **前台设计**：默认 `run_in_background=false` 的 verification agent，等待其结果决定进入
  Synthesize 还是回退到修复节点。
- **后台设计（进阶）**：Work 完成后先发射 verify 到后台（`BackgroundAgentLifecycle`），
  Synthesize 前阻塞回收结果；失败则回到 Work 修复。两条路径共用一个 `verify.done` 查询。

---

## 5. 引擎与执行

### 5.1 目录结构

```
packages/agent/src/modes/workflow/
  schema.ts        # JSON Schema（zod）校验 + TS 类型
  validate.ts      # 静态校验：命名、阶段数、节点数、引用存在、map/when 表达式合法、无环
  expr.ts          # 表达式求值器（§4.1）
  node-runner.ts   # 单节点执行（agent / tool / noop）× on_error 策略
  map-runner.ts    # map fan-out + 并行度 + 结果收集
  engine.ts        # 阶段顺序 + 节点拓扑 + Verify 注入 + journal
  journal.ts       # 节点级事件落盘 + 断点续跑
  tracker.ts       # WorkflowRunTracker 状态机（§6）
  manager.ts       # WorkflowManager（run 生命周期）
  host.ts          # WorkflowHost（并发 + subagent 派发）
  store.ts         # WorkflowRunStore（持久化）
  index.ts         # barrel
```

### 5.2 执行流

```
用户输入目标（/workflow <name> 或普通消息触发）
  → 规划器（LLM 生成 YAML，见 §7）
  → 静态校验（validate.ts）
  → [仅高风险] 展示给用户确认
  → WorkflowManager.launch → WorkflowEngine.execute()
      for phase in phases:
        for node in phase.nodes (拓扑序):
          if when 求值 false → skip
          if map → MapRunner (fan-out)
          else  → NodeRunner
          journal.write(node result)
      → VerifyStage 注入/执行
      → Synthesize 汇总
  → WorkflowManager.apply_outcome → 状态机落终态 → 持久化
```

### 5.3 Journal：断点续跑（对齐 grok §2.3）

- **追加式 JSONL**（`journal.jsonl`），逐条记录每个结果型 host 调用的 `seq / kind / req_hash / result / at_ms`。
- 重组 run 时按 `seq` 重放：若某调用在 journal 有记录且 `req_hash` 一致，直接用缓存结果，
  不再真正调用 host。
- `req_hash = sha256(kind + canonical_json(payload))` 前 16 字节，canonical JSON 排序 key，
  参数语义相同则哈希一致。
- 同 `seq` 的 `kind`/`req_hash` 不一致 → 报 Divergence（"脚本非确定或被中途修改"），拒绝静默重跑。
- 每个节点 `pending|running|succeeded|failed|skipped`，重跑跳过 `succeeded` 节点。
- `BudgetExceeded` 与 `Cancelled` 属于可重放终止，**不写入 journal**（允许提额后完整重跑）；
  `Failed` 时若末尾是 host 错误哨兵，resume 前剪掉，让出错调用下次真正重跑。

### 5.4 复用点

| 能力 | 复用实现 |
|------|---------|
| 并行 agent 发射 / 背景运行 / 去重 | `SubagentTool`（`run_in_background` + `recentBackgroundSpawns` 去重） |
| 后台生命周期 + 任务通知 | `BackgroundAgentLifecycle`（`<task-notification>` + `markDrained`） |
| 进度展示 | `chat:agent_progress` SSE（`buildChatAgentProgressPayload`） |
| 规划 / 汇总 LLM | `AIClient` 直接构造（无 agent 循环） |
| 并发 slot | `WorkflowHost` 内的 `Semaphore`（对齐 grok `semaphore` 实现） |

> Workflow 引擎是同步的（`execute` 是普通 async 函数），对外写操作（派发 subagent、读写
> scratch）都经 `WorkflowHost` 的消息通道，这样引擎本身保持确定性，是断点续跑的前提。

---

## 6. Run 状态机 `WorkflowRunTracker`（两族正交，复用 goal 的 pause/budget 词汇）

> **关键决策（依据 grok 源码）**：grok 的 workflow 是一套**独立的后台 run 管理**，有自己的
> `WorkflowRunStatus`，经 Slash Command 启动，全程自管、不占用主 agent 工具循环。但该状态机的
> 暂停族（UserPaused/BackOffPaused/NoProgressPaused/InfraPaused/Blocked(verification)/
> BudgetLimited）与 `GoalTracker` **共享同一套"会话级自治 run"生命周期语言**。因此 duya 也要把
> run 生命周期语言抽成可复用的基类。

### 6.1 复用对象：已有 `GoalTracker`（非 `session_goals` 表）

> **修正**：duya 已存在完整的 run 生命周期状态机 —— plan 411 的 `GoalTracker`
> （[goal-tracker.ts](file:///e:/Projects/duya/packages/agent/src/modes/engine/goal-tracker.ts)，
> 10 态，对齐 grok `goal_tracker.rs`），已实例化 `goalModeTracker` 并注册进
> `modeTrackerEngine`（见 [modes/index.ts](file:///e:/Projects/duya/packages/agent/src/modes/index.ts)
> 与 [goal-mode.ts](file:///e:/Projects/duya/packages/agent/src/modes/goal-mode.ts)）。
> 它已实现 pause 族（`user_paused/backoff_paused/no_progress_paused/infra_paused/blocked`）、
> `budget_limited`、`resume`、`verifying` 等词汇 —— 这才是"会话级自治 run 生命周期语言"。
> 设计稿初版误引 plan 331 的 `session_goals` 表（`active/paused/usage_limited/complete`，
> 仅 4 态，是旧的简化版），现已修正：**复用对象是 `GoalTracker`，不是 `session_goals` 表**。

### 6.2 抽基类 `RunLifecycleTracker`（新增，从 `GoalTracker` 提炼）

> **修正（2026-09-20，grok-build 官方源码核证）**：grok 的 goal_tracker 与 workflow_tracker 实为
> **复制式平行实现**——无共享 trait/基类，仅共享 `PauseKind` 词汇枚举（`xai-workflow/lib.rs:43`），
> 状态结构体互不引用。据此 companion plan [552](./552-workflow-rpa-agent-design.md) 已裁决：不抽
> 强类型抽象基类，改抽**小内核**（状态枚举 + paused 族判定 + revision + history cap + elapsed 折叠 +
> 快照消毒，共享词汇不共享结构体），goal/workflow 各自持有专属字段。以下基类骨架**降级为参考实现**。

`GoalTracker` 已把"通用 run 生命周期"与"goal 专属语义"（objective/gaps/planFile/baselineCommit/
verify rounds）耦合在一个类里。Workflow 需要同构的生命周期，但不需要 goal 专属字段。因此抽取
一个抽象基类承载通用生命周期转移，`GoalTracker` 与 `WorkflowRunTracker` 各自继承并挂专属字段。

位置：`packages/agent/src/modes/engine/run-lifecycle-tracker.ts`。本小节是 Phase 1 的**权威规格**
（可直接照此落码），下列代码块即基类文件的内容骨架。

#### 6.2.1 类型定义（state / event / pauseKind / history / snapshot）

```ts
/**
 * RunLifecycleTracker — 通用「会话级自治 run」生命周期状态机（plan 415 Phase 1）。
 *
 * 从 plan 411 `GoalTracker` 提炼的抽象基类，承载 goal 与 workflow 共用的
 * run 生命周期词汇（pause 族 / budget / verifying / 断点续跑），遵循 plan 413
 * `ModeTracker` 纯函数约束：transition 只改内存、snapshot/restore 无副作用。
 *
 *    inactive → planning → [high_risk] awaiting_confirm → active ⇄ verifying
 *        → complete | budget_limited | cancelled | interrupted | failed
 *        → user/backoff/no_progress/infra paused | blocked
 */

/** 通用 run 生命周期状态（goal 与 workflow 共用）。 */
export type RunLifecycleState =
  | 'inactive'           // 无 run（静止态）
  | 'planning'           // 规划中（LLM 生成 YAML / 目标梳理）
  | 'awaiting_confirm'   // 仅高风险：等用户确认
  | 'active'             // 执行中
  | 'verifying'          // 验证中
  | 'user_paused'        // 用户暂停
  | 'backoff_paused'     // cap/限流自动暂停
  | 'no_progress_paused' // 无进展自动暂停
  | 'infra_paused'       // 基础设施错误自动暂停
  | 'blocked'            // 验证卡住，需用户输入（映射自 verification 暂停）
  | 'budget_limited'     // 预算耗尽（终态，提额可恢复）
  | 'complete'           // 完成（终态）
  | 'interrupted'        // 进程/会话中断（终态，resume 回 active）
  | 'cancelled'          // 用户取消（终态，仅 clear/start 复位）
  | 'failed';            // 失败（可恢复）

/** 暂停子类型（对齐 grok `PauseKind`）。`'verification'` 映射到 `blocked`。 */
export type PauseKind = 'user' | 'back_off' | 'no_progress' | 'infra' | 'verification';

/** 事件驱动转移（带 payload，对齐 `GoalTracker` 的对象事件风格，幂等）。 */
export type RunLifecycleEvent =
  | { type: 'start'; objective?: string; budget?: number }
  | { type: 'plan_ready'; highRisk?: boolean }   // 规划完成 → active（或 awaiting_confirm）
  | { type: 'confirm' }                          // 高风险确认通过 → active
  | { type: 'report_verifiable' }                // → verifying
  | { type: 'verdict'; verdict: 'achieved' | 'not_achieved' | 'blocked' }
  | { type: 'budget_limit' }
  | { type: 'stall' }
  | { type: 'infra_error' }
  | { type: 'pause'; kind: PauseKind; message?: string }
  | { type: 'resume'; budget?: number }           // budget_limited 提额恢复用 budget
  | { type: 'interrupt' }
  | { type: 'complete' }
  | { type: 'cancel' }
  | { type: 'fail'; message?: string }
  | { type: 'clear' };

/** 一条生命周期历史记录（cap 64，grok `MAX_HISTORY_ENTRIES`）。 */
export interface RunLifecycleHistoryEntry {
  at: number;        // epoch ms
  event: string;     // 如 'start' / 'plan_ready' / 'verdict:achieved'
  detail?: string;   // 可选：pauseMessage / objective / 失败原因
}

/** 持久化快照（纯 JSON，写入 `mode_state_snapshots`，`mode='xxx-run'`）。 */
export interface RunLifecycleSnapshot {
  state: RunLifecycleState;
  objective: string;
  budget: number;        // 预算上限（goal=token / workflow=agent）
  elapsedMs: number;     // 快照时计算：Date.now() - createdAt
  createdAt: number;
  history: RunLifecycleHistoryEntry[];  // 冗余落盘，cap 64
  pauseMessage?: string; // 当前暂停/失败原因
}
```

#### 6.2.2 状态分组与判定辅助

状态按"可操作分组"归类，供 `isPaused` / `isTerminal` / `isResumable` 与 UI 复用：

```ts
/** 全部暂停类状态（resume 可回 active）。`blocked` 映射自 verification 暂停。 */
const PAUSED_STATES = new Set<RunLifecycleState>([
  'user_paused', 'backoff_paused', 'no_progress_paused', 'infra_paused', 'blocked',
]);

/** 终态（不可 resume，仅 clear / start 复位）。 */
const TERMINAL_STATES = new Set<RunLifecycleState>([
  'budget_limited', 'complete', 'cancelled', 'interrupted', 'failed',
]);
```

| 判定 | 定义 | 说明 |
|------|------|------|
| `isPaused()` | `state ∈ PAUSED_STATES` | 5 种暂停（含 blocked）均可免提额恢复 |
| `isTerminal()` | `state ∈ TERMINAL_STATES` | 终态集合 |
| `isResumable()` | `isPaused() \|\| state==='failed' \|\| state==='interrupted'` | 免提额恢复 |
| `needsTopUp()` | `state==='budget_limited'` | 必须带 `resume{budget}` 提额才能回 `active` |
| `canGateTools()` | `state==='active' \|\| state==='verifying'` | 运行时工具门控（对齐 goal） |
| `shouldInjectReminder()` | `state==='active' \|\| state==='verifying'` | 每轮续跑提醒（对齐 goal） |

> **修正 `interrupted` 可恢复**：`interrupted` 是"进程/会话被打断"，grok 的 `from_snapshot`
> 在恢复时把 active 强制标为 interrupted，随后 run 可 resume 回 `active`。因此 `interrupted`
> 属于**可恢复**（不是不可恢复），与 `cancelled`（用户主动取消，不可恢复）区分开。

#### 6.2.3 完整转移矩阵

`transition(e)` 幂等：合法且状态变化返回 `true`；非法 / no-op 返回 `false` 且不抛错。
`pause(kind)` 按 kind 落对应 paused 态；`verification` 统一落 `blocked`。

| 当前态 | 事件 | 下一态 | 备注 |
|--------|------|--------|------|
| `inactive` | `start` | `planning` | 无条件进入规划；触发 `onStart` |
| `planning` | `plan_ready` (highRisk=falsy) | `active` | 默认直入执行 |
| `planning` | `plan_ready` (highRisk=true) | `awaiting_confirm` | 高风险停住确认 |
| `planning` | `cancel` | `cancelled` | 规划阶段取消 |
| `planning` | `fail` | `failed` | 规划失败 |
| `planning` | `clear` | `inactive` | |
| `awaiting_confirm` | `confirm` | `active` | 触发 `onConfirm` |
| `awaiting_confirm` | `cancel` | `cancelled` | |
| `awaiting_confirm` | `fail` | `failed` | |
| `awaiting_confirm` | `clear` | `inactive` | |
| `active` | `report_verifiable` | `verifying` | 触发 `onReporting` |
| `active` | `budget_limit` | `budget_limited` | 触发 `onBudgetLimit` |
| `active` | `stall` | `no_progress_paused` | |
| `active` | `infra_error` | `infra_paused` | |
| `active` | `pause`(kind) | 对应 paused / blocked | |
| `active` | `interrupt` | `interrupted` | |
| `active` | `complete` | `complete` | 触发 `onComplete` |
| `active` | `cancel` | `cancelled` | 触发 `onCancel` |
| `active` | `fail` | `failed` | 触发 `onFail` |
| `active` | `clear` | `inactive` | 触发 `onClear` |
| `verifying` | `verdict`=achieved | `complete` | 触发 `onVerdict`+`onComplete` |
| `verifying` | `verdict`=not_achieved | `active` | 回 work 修复；触发 `onVerdict` |
| `verifying` | `verdict`=blocked | `blocked` | 触发 `onVerdict` |
| `verifying` | `pause`(kind) | 对应 paused / blocked | |
| `verifying` | `interrupt` | `interrupted` | |
| `verifying` | `complete` | `complete` | |
| `verifying` | `cancel` | `cancelled` | |
| `verifying` | `fail` | `failed` | |
| `verifying` | `clear` | `inactive` | |
| 任一 paused | `resume` | `active` | 免提额恢复 |
| 任一 paused | `pause`(kind) | 切换 kind | 如 user→back_off |
| 任一 paused | `complete`/`cancel`/`fail`/`clear` | 对应终态 / inactive | |
| `budget_limited` | `resume`(budget) | `active` | 提额恢复；无 budget 则 `false` |
| `budget_limited` | `clear` / `start` | `inactive` / `planning` | |
| `complete` | `clear` / `start` | `inactive` / `planning` | |
| `interrupted` | `resume` | `active` | 会话恢复；取消 ghost agent 由调用方负责 |
| `interrupted` | `cancel` / `fail` / `clear` | `cancelled` / `failed` / `inactive` | |
| `cancelled` | `clear` / `start` | `inactive` / `planning` | 不可 resume |
| `failed` | `resume` | `active` | 重跑 |
| `failed` | `cancel` / `clear` | `cancelled` / `inactive` | |

**防降级**：`failed` / `interrupted` / `cancelled` 收到的 `complete`（或更高优先级结局）一律
返回 `false`，不把失败结局降级为完成；调用方若确需记录，自行写入对接的上层日志。

#### 6.2.4 基类实现契约（字段 / 公共 API / protected 钩子）

```ts
export abstract class RunLifecycleTracker
  implements ModeTracker<RunLifecycleState, RunLifecycleEvent, RunLifecycleSnapshot>
{
  /** 子类 id：goal='goal'，workflow='workflow-run'。 */
  readonly abstract id: string;

  // 基类私有字段（子类只读，通过钩子初始化）
  protected currentState: RunLifecycleState = 'inactive';
  protected runObjective = '';
  protected runBudget = 0;          // 预算上限（可由 resume{budget} 提额）
  protected runCreatedAt = 0;
  protected historyLog: RunLifecycleHistoryEntry[] = [];
  protected runPauseMessage?: string;

  // ── 公共 API（子类无需重写） ──
  state(): RunLifecycleState;
  isPaused(): boolean;
  isTerminal(): boolean;
  isResumable(): boolean;
  needsTopUp(): boolean;
  canGateTools(): boolean;           // 仅 active/verifying
  shouldInjectReminder(): boolean;   // 仅 active/verifying
  pauseMessage(): string | undefined;
  objective(): string;
  budgetLimit(): number;
  snapshot(): RunLifecycleSnapshot;
  restore(raw: RunLifecycleSnapshot): void;   // 折叠语义见 6.2.5
  transition(e: RunLifecycleEvent): boolean;  // 按 6.2.3 矩阵实现

  // ── protected 定制点（goal / workflow 各自实现） ──
  protected onStart(e: { objective?: string; budget?: number }): void;
  protected onPlanReady(): void;      // 规划完成：子类暂存 YAML 引用 / 目标细化
  protected onConfirm(): void;
  protected onReporting(): void;
  protected onVerdict(v: 'achieved' | 'not_achieved' | 'blocked'): void;
  protected onBudgetLimit(): void;
  protected onComplete(): void;
  protected onCancel(): void;
  protected onFail(message?: string): void;
  protected onClear(): void;
  protected pushHistory(event: string, detail?: string): void;  // 基类实现，cap 64
}
```

契约要点：
- `transition` 是唯一改动状态的入口；`move(next, label)` 私有助手统一"置态 + pushHistory"。
- `start` 统一落到 `planning`（goal 未来迁移时其"phase=planning"升级为 state；workflow 则是
  LLM 生成 YAML 阶段）。子类若不需要显式规划阶段，可在 `onStart` 后紧随一次 `plan_ready`。
- 子类专属计数（goal 的 `totalWorkerRounds` / `consecutiveNotAchieved`、workflow 的
  `agentsUsed` / `currentPhase` / `journalRef`）**不进基类**，由子类挂在自身字段并在钩子中更新，
  快照时由子类 `snapshot()` 覆写为父类型再追加专属字段（见 WorkflowRunTracker §6.3）。

#### 6.2.5 snapshot/restore 折叠语义

`restore(raw)` 折叠半开 / 半途态，其余原样（对齐 grok `from_snapshot`）：

| 快照态 | 恢复后 | 理由 |
|--------|--------|------|
| `verifying` | `active` | 重启不能复活一个半开的验证，回 work 后模型可重报完成 |
| `planning` | `inactive` | 半途规划不保留，等用户重新触发 |
| `awaiting_confirm` | `inactive` | 等用户重新触发 |
| paused 族 / `blocked` / 终态 / `interrupted` | 原样 | 都是用户的持久决定 |

非法快照（state / history 类型不符）抛错，由持久化层 `applySnapshot` 上报失败，绝不让 tracker
处于不一致状态。`mode_state_snapshots` 的 `status` 字段由持久化层按 `state()` 同步。

#### 6.2.6 抽取策略与兼容性

- **新增** `run-lifecycle-tracker.ts`，`WorkflowRunTracker` 继承它（Phase 1 就用）。
- **goal 暂不迁移**（用户倾向方案）：`GoalTracker` 保持现状、独立实现，避免牵动 plan 411 的
  `update_goal` 工具与 macro 语义。基类以 `GoalTracker` 为蓝本设计，保证未来 goal 平滑瘦身到
  继承基类（映射见下表，开放问题 5）。
- 持久化走 `mode_state_snapshots`（plan 413c）：workflow 的 run 快照写入 `mode='workflow-run'`；
  goal 仍走它自己的 `mode='goal'` 快照，互不干扰。

goal → 基类迁移映射（**仅备忘，不实施**；未来迁移时执行）：

| GoalTracker 现状 | RunLifecycleTracker 对应 | 处理 |
|------------------|--------------------------|------|
| `idle` | `inactive` | 直接映射 |
| `active`（phase=planning） | `planning` | phase 升级为 state |
| `active`（phase=executing） | `active` | |
| `verifying` / `blocked` | 同名 | 一致 |
| `user/backoff/no_progress/infra_paused` | 同名 | 一致 |
| `budget_limited` / `complete` | 同名 | 一致 |
| `start` → `active` | `start` → `planning` → `plan_ready` → `active` | 规划阶段显式化 |
| `GoalSnapshot` | `RunLifecycleSnapshot` + goal 专属字段 | 子类覆写 `snapshot()` 追加 |

#### 6.2.7 单测矩阵（Phase 1 必测）

`run-lifecycle-tracker.test.ts`（Vitest，纯函数，无 Electron），覆盖：

| 组 | 用例 |
|----|------|
| 转移矩阵 | 6.2.3 每行：合法事件返回 `true` 且 `state()` 正确 |
| 非法转移 | 每个状态 × 非法事件返回 `false` 且状态不变（如 `inactive` 收 `complete`、`complete` 收 `cancel`） |
| pause kind | `verification` 落 `blocked`；`user/back_off/no_progress/infra` 落对应态；paused 中再 pause 切换 kind |
| 幂等 | 重复同一事件返回 `false`；`resume` 在 paused 返回 `true` 一次后再次为 `false` |
| 分组判定 | `isPaused/isTerminal/isResumable/needsTopUp/canGateTools/shouldInjectReminder` 全状态穷举 |
| 提额恢复 | `budget_limited` 无 `budget` 的 `resume` → `false`；带 budget → `active` 且上限更新 |
| 防降级 | `failed/interrupted/cancelled` 收 `complete` → `false` |
| snapshot↔restore | 折叠映射（verifying→active、planning→inactive、awaiting_confirm→inactive、其余原样）；round-trip 后 `state()` 一致 |
| 非法快照 | state/history 类型错误抛错；`transition` 不抛错（契约） |
| 钩子 | 每个受保护钩子在各触发点时被调用（用 `Object.create(RunLifecycleTracker.prototype)` + 覆写钩子的探针实例） |

### 6.3 run 级状态机 `WorkflowRunTracker`

`WorkflowRunTracker extends RunLifecycleTracker`（继承 §6.2 基类），挂 workflow 专属字段：
`currentPhase`（多阶段）、`agentsUsed`（agent 预算消耗）、`executionEpoch`（epoch 防竞态）、
`journalRef`（断点日志路径）。

```
（A）run 级：WorkflowRunTracker —— 继承 RunLifecycleTracker 的 pause/budget 词汇
inactive → planning → [high_risk] awaiting_confirm → active → verifying
        → complete | budget_limited | blocked | paused(×N) | failed | cancelled | interrupted
```

- run 级 tracker 描述**后台 run 的生命周期**：agent 预算、暂停/退避/cap、验证暂停、断点续跑。
- `planning`：LLM 生成 YAML。`awaiting_confirm`：**仅高风险**时停住确认（默认跳过）。
- `active(phase)`：多阶段执行；`verifying`：Verify 阶段。
- 断点续跑：`journal` 记录每节点 `pending|running|succeeded|failed|skipped`，重跑跳过
  `succeeded` 节点；`interrupted`（会话中断）恢复时回到 `active` 且取消 ghost agent（对齐
  grok `from_snapshot`：恢复时若 run 当时是 `active` 强制标 `interrupted`）。
- 预算：`agentsUsed` 按逻辑 agent 调用计费（对齐 grok `MAX_AGENT_BUDGET`），耗尽 → `budget_limited`。

### 6.4 入口级：极薄注册（非 mode）

```
（B）入口级：workflow 可选注册 —— 仅触发，不管理状态
```

- 只做：注册一个 Slash Command（`/workflow <name>`）+ 一个 orchestrator 形态的薄 wrapper，
  识别触发词 → 取目标 → 拉一条 run。
- **不套用 413 的 `injectTurnReminders`/`filterTools`/`onRoundEnd`**：那些挂在
  `before_model_turn`/`before_final_answer` 检查点，只服务"走 agent 工具循环的 mode"；
  workflow 是 orchestrator 形态，全程自管，不进主循环，硬套会让 run 状态机被错误地"每轮驱动"。
- **不新增 popover mode**：Workflow 不进入 `types.ts` 的 `ModeModifier` 注册表，避免与
  plan-task/research/conductor 的互斥、提醒、工具门控逻辑纠缠。

> 若未来确实需要 UI 入口，那是"Workflow 面板/列表"的独立 UI，不是 popover mode。

---

## 7. 规划器（LLM 生成 YAML）

- 复用 `AIClient` 直接构造（无 agent 循环）。
- 输入：用户目标 + 项目上下文（workingDirectory / AGENTS.md）+ 可用 agent 类型列表
  （`getAgentDefinitions()`）。
- 输出：严格 JSON/YAML 对应该 schema；用 `schema.ts` 校验，失败则带错误信息让 LLM 重试一次。
- **高风险判定**：规划器对每个节点做轻量风险标记（是否含写文件 / 改配置 / 外部副作用 /
  删除操作）。命中高风险节点时置 `awaiting_confirm`，停住只展示该节点的 YAML 片段让用户确认；
  否则默认直接执行。

### 7.1 可复用 Slash Command

首个版本即支持把 Workflow 命名保存为可复用入口（对齐 grok 的 save-as-command）：

- **保存**：Workflow 执行一次后（或规划确认时）可 `save-as <name>`，把 YAML 固化。
- **存储**：写入 `~/.duya/workflows/<name>.yaml`（TOML 配置风格，单一权威源）。
- **触发**：以 `/workflow <name>` Slash Command 一键触发，规划器直接复用已固化 YAML（跳过
  重新规划），仅按需更新 Context 阶段。
- **权限**：复用入口复用现有 Slash Command 权限模型（gateway 分组绑定）。
- **校验**：固化 YAML 每次触发前仍过 `validate.ts` 静态校验，防文件被篡改 / 版本升级破坏 schema。

### 7.2 decide 通道与工作流节点（plan 551 Phase 4 设计增补，实施归 415）

> 来源：plan 551（Jev / System One 决策模型基础设施）。本节只是设计增补——415 实施时合入，
> plan 551 不写引擎代码。基础设施已落地：`@duya/ai` `DecisionClient`（`packages/ai/src/system-one/`）、
> `@duya/agent` `DecisionService`（`packages/agent/src/decisions/`）、
> `@duya/computer-use` decide 通道（`packages/computer-use/src/decide/`）。

**tool 节点内循环**：desktop 自动化类 tool 节点的执行体直接复用 computer-use decide 通道的
内循环（settle → describe → 一次 fan-out → act），status 契约（`done | likely_done |
needs_confirmation | error | stuck | ambiguous | blocked | max_actions`）映射为 tool 节点的
成功 / 失败 / `awaiting_confirm`。规划只归 LLM，感知决策归 DecisionClient（"LLM plans, Jev decides"）。

**可选 `decide` 节点原语**：在 agent / tool / noop 之外新增第四种节点：

```yaml
- id: risk_gate
  type: decide
  ask:                     # 每个问题一个 noul / score，引用 context 的 state
    risky: { kind: noul, instructions: "…" }
  policy: { done_at: 0.85, reject_at: 0.45 }   # 可配置；灰区 → uncertain
```

- `decide` 节点的答案写入 `context.decide.<node_id>`，noul/score 值可直接进 `when` 表达式求值
  （如 `when: "decide.risk_gate.risky < 0.6"`）；灰区（uncertain）行为由 `on_uncertain` 决定
  （`fail` / `skip` / `awaiting_confirm`）。
- 无决策后端（未配 key）时 `decide` 节点按 `on_uncertain` 降级，Workflow 其余部分不受影响。

**§7 规划器高风险判定的增强**：节点级 risk noul 预筛作为 `awaiting_confirm` 的触发依据之一——
规划器对每个 tool 节点的动作描述跑一次 risk noul（419 预筛通道同款语义：只产出建议），
`p ≥ irreversible_at` 的节点置 `awaiting_confirm`。现有规则标记（写文件 / 外部副作用等）
仍是第一道，Jev 预筛是补充，不替代。

---

## 8. 落地步骤（待评审后细化为子 plan）

1. **Phase 1 — 地基**：`schema.ts` + `validate.ts` + `expr.ts` + `RunLifecycleTracker` 基类
   （从 `GoalTracker` 提炼，权威规格见 §6.2，含 §6.2.7 单测矩阵）。
2. **Phase 2 — 执行器**：`node-runner` / `map-runner` / `engine` / `host` / `journal`，
   先接 Sync subagent 打通单节点。
3. **Phase 3 — 规划器**：LLM 生成 YAML + 高风险判定（仅高风险确认）+ 静态校验。
4. **Phase 4 — Verify 内建**：前台验证优先，预留后台化 + 修复回退。
5. **Phase 5 — 状态/续跑**：`WorkflowRunTracker`（复用 `RunLifecycleTracker`）+ `journal`
   断点续跑 + `mode_state_snapshots` 落盘。
6. **Phase 6 — 复用入口**：`save-as` + `~/.duya/workflows/` 存储 + `/workflow <name>`
   Slash Command。
7. **Phase 7 — 前端**：Workflow 面板/列表 UI + 阶段/并行进度 UI + 汇总报告。

---

## 9. 已定决策与开放问题

**已定**：
- 独立 run 管理系统（非 mode） / map+when 两原语 / 前台 Verify 优先 / 仅高风险确认 /
  首版支持复用 / 任意已完成节点 output 引用 / 抽 `RunLifecycleTracker` 基类复用 goal 词汇。

**仍开放（进入实现前需再评审）**：
1. **高风险判定的具体规则集**：哪些动作算高风险需要人工确认（写文件 / 改配置 / 网络副作用 /
   删除）？规则集是否可配置。
2. **map 的 `over` 深度**：是否支持嵌套引用（如 `map.over = "context.items.tasks"`）还是仅限
   一层数组。
3. **`on_error` 策略**是否需要 `retry`（带 `max_retries`），还是 MVP 只做 `skip`/`fail`。
4. **cap 预算**：单次 Workflow 的 agent 调用上限（对齐 grok `MAX_AGENT_BUDGET`）与
   `concurrency` 默认值。
5. **`RunLifecycleTracker` 抽取范围**：goal（plan 411 `GoalTracker`）是否同步瘦身到继承该基类，
   还是 workflow 先独立使用、goal 后续再迁移（**推荐后者**，避免牵动 plan 411 已接线的
   `update_goal` 工具与 macro 语义）。基类设计以 `GoalTracker` 为蓝本，保证未来平滑迁移。