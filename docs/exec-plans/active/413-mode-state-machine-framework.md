# 413 — Mode 状态机框架：对齐 Grok 多 mode 状态机

> Grok-Build 多 mode 状态机架构学习借鉴 → duya 模式（mode）框架落地
> 状态：Planning
> 优先级：P1

---

## 1. 背景与动机

duya 现有 mode 架构（plan 224）是**声明式 `ModeModifier`**：每个 mode 用
`tools (inject/block/allow)` + `prompt (prefix/suffix)` + `hooks (onEnter/onExit/beforeStream)`
声明如何叠加在 base profile 上。它优雅、可组合，但**没有运行时状态机**：

- mode 是"一次性滤镜"，没有跨 turn 的生命周期状态（Plan 只有 `Pending/Active`，Goal 只有
  `Idle/Executing/Complete`……）。
- 没有"每轮注入动态提醒"的机制（grok 的 `inject_plan_mode_reminders` 会按 `full/sparse`
  交替注入 `<system-reminder>`）。
- 没有**基于 mode 状态**的运行时工具门控（grok 的 plan mode 在 `Active` 时才
  `is_active()` 硬拦截写工具）。
- 没有 mode 生命周期状态的**磁盘持久化**（grok 每次状态变迁 `persist_plan_mode_state`）。
- 多 mode 之间只有 `exclusiveWith` 互斥，没有**仲裁层**（grok 的 `current_prompt_mode` +
  `resolve_turn_prompt_mode`）。

用户明确指出：**不止 plan goal 两种 mode**（还有 yolo、research、conductor、agent 定义等）。
因此需要一个**框架层**，让任何 mode 都能挂接自己的状态机，而不是每个 mode 各自为政。

本计划目标：**学习 grok 的 `SessionActor` 并行状态机 + `PromptMode` 仲裁层设计，在
duya 的 `ModeModifier` 之上加一层轻量的 `ModeTrackerEngine` + `ModeCoordinator`，
让所有 mode（plan/goal/yolo/research/conductor）都能获得：生命周期状态机 + 持久化 +
每轮提醒注入 + 运行时工具门控。** 与 411（仅 goal 模式）互补：411 是单个 mode 的落地，
413 是支撑所有 mode 的**框架地基**。

---

## 2. Grok Multi-Mode 架构分析（学习输出）

### 2.1 总体：并行独立 tracker + 统一仲裁层

grok 的 `SessionActor` 持有**一组并行的 mode 状态机**，彼此独立、各自持久化：

```rust
// acp_session.rs: SessionActor 字段
plan_mode:            Arc<Mutex<PlanModeTracker>>   // Plan 状态机
goal_tracker:         Arc<Mutex<GoalTracker>>       // Goal 状态机
session_yolo_mode:    ...                            // YOLO 模式（权限）
active_agent_type:    Mutex<Option<String>>          // 当前 agent 定义（自定义 agent）
current_prompt_mode:  Mutex<PromptMode>              // 仲裁出的"本轮真正运行的 mode"
```

关键设计拆成三层：

1. **纯状态机层（tracker）**：每个 tracker 是无 async I/O 的纯状态机
   （`PlanModeTracker`、`GoalTracker`），是各自 mode 的**唯一确定性事实源**。
2. **仲裁层（PromptMode）**：`current_prompt_mode` 是"本轮 session 真正处于哪个 mode"
   的单一占位符。`resolve_turn_prompt_mode` 结合 prompt 的 `_meta.mode` 声明与
   `PromptOrigin`（是否 synthetic）算出最终 mode。
3. **checkpoint 注入层**：`inject_plan_mode_reminders` 在每轮 `handle_prompt` 时按
   tracker 状态注入提醒（激活 full / 进行中 full-sparse 交替 / 退出 one-shot）。

### 2.2 PlanModeTracker 状态机（规划）

```
Inactive --/user enter--> Pending --/first prompt--> Active
                         Pending --/turn 结束未消费--> ExitPending
Active --/user exit--> ExitPending --/in-flight turn 结束--> Inactive
Active --mid-turn activate--> Active (buffered reminder)
```

- `Pending` 表示"用户已开但模型还没拿到完整提醒"；`ExitPending` 表示"已退出但当前 turn
  还在跑，需在 safe point 补发退出提醒"。
- 每次变迁调用 `persist_plan_mode_state()` 落盘，`SessionActor` 其他方法读它做门控。

### 2.3 GoalTracker 状态机（跨 turn 自治）

```
[Idle] --/goal--> [Executing/Active]
[Active] --模型自报 completed--> [Verifying] --skeptic Achieved--> [Complete]
                                        --NotAchieved--> [Active]
                                        --Blocked--> [Blocked]
[Active] --token 超预算--> [BudgetLimited]
[Active] --cap 命中--> [BackOffPaused]
[Active] --gap 指纹停滞--> [NoProgressPaused]
[Active] --infra 错误--> [InfraPaused]
[Active/暂停] --/goal pause--> [UserPaused]
[任意暂停] --/goal resume--> [Active]
```

8 态：`Active / UserPaused / BackOffPaused / NoProgressPaused / InfraPaused /
Blocked / BudgetLimited / Complete`。3 段：`Idle / Planning / Executing`。
（详见 411 计划，此处不重复。）

### 2.4 仲裁层核心逻辑（session_mode.rs）

```rust
// 1. 用户显式切 mode → handle_session_mode
//    - PromptMode::Plan → plan_mode.enter_pending() + persist + emit CurrentModeUpdate
//    - 非 Plan → plan_mode.user_exit() + persist + emit
//    - 其余 name → 解析 AgentDefinition（自定义 agent），update_policies + 重渲染 system prompt

// 2. 每轮定案 → resolve_turn_prompt_mode(origin, declared)
//    - synthetic turn（goal_summary / background wake）：不 reconcile，继承 session 当前 mode
//    - 真实 user turn：reconcile_plan_mode_with_prompt(declared) 把 prompt 声明与 tracker 对齐

// 3. 工具门控 → is_active() 时硬拦截 plan-gated 工具
//    （本 build 无 plan-gated 工具，pass-through；但机制在）
```

### 2.5 提醒注入（token 效率关键）

- **激活**：`Pending → Active`，注入完整激活模板（reentry 用 reentry 模板）。
- **进行中**：`full/sparse` 交替（`should_use_full_reminder()`），省 token。
- **退出**：one-shot 退出提醒，注入后清标志。
- **mid-turn**：turn 进行中 `Pending → Active` 时，缓冲提醒，在 safe point（loop top /
  tool batch 后）投递，避免打断 in-flight batch 的 tool_result 相邻性。

### 2.6 与 duya 的差异总结

| 维度 | Grok | duya（现状） |
|------|------|-------------|
| 状态机 | 每 mode 一个纯 tracker（Plan/Goal） | 无；mode 是静态滤镜 |
| 持久化 | 每次变迁落盘，重启恢复 | 无（仅 conductor canvasId 经 DB） |
| 每轮提醒 | full/sparse 交替 `<system-reminder>` | 无（plan 只有静态 prefix） |
| 工具门控 | `is_active()` 硬拦截 | 声明式 block（静态，不随状态变） |
| 仲裁层 | `current_prompt_mode` + synthetic 判定 | 无；`exclusiveWith` 静态冲突 |
| mid-turn | 缓冲提醒在 safe point 投递 | 无 |

---

## 3. duya 现状与差距

### 3.1 可直接复用的底座

| duya 能力 | 位置 | 对 mode 状态机的意义 |
|-----------|------|---------------------|
| `ModeModifier`（message/session） | `packages/agent/src/modes/types.ts` | 状态机挂接在 session 型 mode 上 |
| `ModeModifierRegistry.resolve` | `modes/registry.ts` | 解析 activeModeIds + 冲突过滤 |
| `applyModes` | `modes/apply-modes.ts` | 组合 tools/prompt/hooks；是状态机注入点 |
| `hooks.onEnter/onExit/beforeStream` | `types.ts` | 状态机生命周期钩子的宿主 |
| `before_model_turn` mailbox 检查点 | `DuyaAgent.ts` / `mailbox.ts` | 每轮提醒注入的理想位置 |
| `before_final_answer` 检查点 | `DuyaAgent.ts` | round-end / 终止判定位置 |
| `StreamOptionsPatch` | `types.ts` | 每轮动态改写流选项的扩展通道 |
| Append-only messages | message 域 | 提醒作为合成 user 消息持久化 |
| `modeModifierRegistry` 单例 | `modes/index.ts` | tracker 注册表 |

### 3.2 差距（需新增）

1. **ModeTrackerEngine**：统一注册/持有各 mode tracker 的容器，提供
   `getMode(modeId)` + 状态变迁 + 快照。
2. **持久化**：mode 状态快照落盘（rollout/session 轨迹），崩溃恢复。
3. **每轮提醒注入**：在 `before_model_turn` 前按 tracker 状态注入
   `<system-reminder>`（full/sparse 交替）。
4. **运行时工具门控**：plan/readonly mode 在 `Active` 时硬件拦截写工具（当前是静态 block）——
   需要引入"按状态过滤工具"的机制。
5. **仲裁/协调**：`ModeCoordinator` 处理 synthetic turn 继承、prompt 声明 reconcile、
   mid-turn 状态变更缓冲投递。

---

## 4. duya Mode 状态机框架设计（提议）

### 4.1 目标形态

在**现有声明式 `ModeModifier` 之上**增加一层**运行时状态机**，不推翻 plan 224 的
声明范式。引入两个概念：

- **`ModeTracker`**：某 mode 的纯状态机（`state` + `transition()` 纯函数 + `snapshot()`）。
  每种有状态的 mode 实现一个。无 async I/O。
- **`ModeCoordinator`**：运行时编排器，持有所有 tracker，负责：
  - 轮询/响应 mode 状态变更（`currentMode` 仲裁）；
  - 在 turn 边界注入每轮提醒；
  - 依据状态做工具过滤 + prompt 动态化；
  - 合成 user 消息持久化提醒。

### 4.2 新增文件（平铺，遵循 plan 326 的 7 文件风格）

```
packages/agent/src/modes/engine/
  tracker.ts            # ModeTracker 接口 + 状态定义（泛型 State/Event）
  engine.ts             # ModeTrackerEngine：注册/持有 tracker + 快照收集
  coordinator.ts        # ModeCoordinator：仲裁 + 每轮注入 + 工具门控 + 合成消息
  persistence.ts        # 快照序列化/反序列化（rollout/session 轨迹）
  reminders.ts          # <system-reminder> 渲染 + full/sparse 交替策略
  types.ts              # PromptMode / ModeStateSnapshot / SyntheticOrigin 等类型
  index.ts              # 平铺 barrel
```

### 4.3 ModeTracker 接口骨架

```ts
// 有状态 mode 的最小契约：纯状态机，无 IO
export interface ModeTracker<State extends string, Event> {
  readonly id: string;
  state(): State;
  transition(event: Event): void;          // 纯函数，幂等
  canGateTools(): boolean;                  // 该状态是否激活工具门控
  shouldInjectReminder(): boolean;          // 该状态是否需要每轮提醒
  snapshot(): unknown;                      // 给 coordinator 持久化
  restore(raw: unknown): void;              // 从快照恢复（崩溃恢复）
}
```

### 4.4 ModeCoordinator 生命周期接线（关键）

coordinator 在 `DuyaAgent.streamChat` 的 turn 循环里挂两个点（复用现有 mailbox 检查点）：

1. **`before_model_turn`（每轮 LLM 调用前）**：
   - 对每个当前 mode 的 tracker 求 `shouldInjectReminder()`；
   - 按 `full/sparse` 交替策略渲染提醒，作为合成 user 消息 append 到 timeline；
   - 若状态是 `Pending → Active`，先 `activate()` 再注入激活模板。
2. **`before_final_answer`（本轮收尾）**：
   - round-end 判定：mode 是否还想续轮（如 goal 的 `Continue`）；
   - 触发 tracker 状态变迁（如 plan 的 `ExitPending → Inactive` 在 in-flight turn 结束时）；
   - `persist` 快照。

工具门控：在 `applyModes` 组合出工具集后，coordinator 再按 `canGateTools()` 对
写入类工具做**运行时**过滤（区别于静态 `tools.block`）。这样 plan 的只读约束能随
`Active/Inactive` 动态开合。

### 4.5 仲裁/协调规则（对齐 grok）

- **synthetic origin**：goal 续轮、后台唤醒、通知排空等**合成 turn** 不 reconcile
  mode，继承 session 当前 mode（grok `PromptOrigin::is_synthetic`）。
- **prompt 声明 reconcile**：真实 user turn 若有 `_meta.mode` 声明，与 tracker 对齐
  （`enter_pending` / `user_exit` 幂等）。
- **mid-turn 变更**：turn 进行中 mode 切换（如 shift+tab 开 plan）→ 缓冲提醒，
  在 safe point（loop top / tool batch 后）投递，不打断 in-flight batch。

### 4.6 持久化

- mode 状态快照写入 rollout/session 轨迹（对齐 411 的 `goal-orchestration`，
  复用 `core-db` rollout 轨迹或 `~/.duya/sessions/`）。
- 每次状态变迁触发 `persist()`；重启/恢复时 `restore()`。

### 4.7 与现有 mode 的映射

| 现有 mode | 起点状态机 | 说明 |
|-----------|-----------|------|
| `plan-task` | `Inactive/Pending/Active/ExitPending` | 移植 grok `PlanModeTracker` |
| `goal`（411） | `GoalTracker` 8 态 | 直接复用 411 的 state machine，挂到 engine |
| `automation` | 简单 `Active/Idle` | 先只做状态机骨架 |
| `research`（orchestrator） | coordinator 只记录，不做 remind | orchestrator 范式自行管理 |
| `conductor` | 无独立状态机 | 维持现状；engine 留空 |

---

### 4.8 本次拆分的关键决策记录（2026-08-11）

| 决策 | 选择 | 理由 |
|------|------|------|
| plan-task 状态机语义 | **对齐 grok 改 session 型** | 用户确认：toggle ON 跨多轮保持 Active，toggle OFF 退出；plan-task `kind` 'message'→'session' |
| 持久化落盘 | **新增 core-db `mode_state_snapshots` 表**（`UNIQUE(session_id, mode)`） | 复刻 `session_goals`/`mailbox_items` 既有模式；每 mode 一行，`snapshot_json` 列支持 goal 等复杂状态机 |
| 前端 plan-mode 状态 | **复用 `sessions.extensions` JSON 列**（key `plan_mode_enabled`） | 严格对齐 conductor `conductor_canvas_id` 路径，不加新表/列 |
| 覆盖范围 | **Phase 1-2 为主 + Phase 3 前端支撑** | Phase 3 是"plan-task 改 session 型"的 UI 前提；Phase 4+（goal 接入/打磨）另行排期 |
| 每轮提醒形态 | 合成 user 消息 push（非 durable） | 复用现有 transient 过滤；不改 mailbox 三 kind（对齐 grok synthetic origin） |
| 持久化写入频率 | 仅**状态变迁**时 persist | 对齐 grok `persist_plan_mode_state`，非每轮 |

---

## 5. 子 plan 拆分（实施以 413a-e 为准）

> 413 是**总览**。实施按子 plan 逐份进行，每份可独立评审/排期/提交。
> 依赖顺序：`413a → 413b → 413c → 413d`；`413e` 依赖 `413b`（可与 `413d` 并行）。

| 子 plan | 标题 | 聚焦 | 依赖 |
|---|---|---|---|
| [413a-mode-tracker-framework](./413a-mode-tracker-framework.md) | ModeTracker 引擎框架 | `engine/` 纯状态机容器：`tracker.ts` 泛型接口 + `engine.ts` + `persistence.ts` 序列化纯函数 + `coordinator.ts` 骨架 + `index.ts` barrel | — |
| [413b-plan-tracker-state-machine](./413b-plan-tracker-state-machine.md) | PlanModeTracker 状态机 | `plan-tracker.ts` 4 态移植 + `reminders.ts` 四模板 + `plan-task-mode.ts` 改 session 型 + 注册 + 迁移矩阵单测 | 413a |
| [413c-mode-state-persistence](./413c-mode-state-persistence.md) | mode 状态持久化 | core-db `mode_state_snapshots` 表 + `ModeStateStore` + `modeState:*` IPC + `modeStateDb` + `persistence.ts` 落盘/恢复 | 413a/413b |
| [413d-agent-loop-wiring](./413d-agent-loop-wiring.md) | agent 侧接线 | `DuyaAgent.ts` 四处接线点 + `coordinator.ts` 主体（仲裁/门控/buffer）+ coordinator 单测 + e2e | 413b/413c |
| [413e-plan-mode-frontend-session](./413e-plan-mode-frontend-session.md) | plan-task session 化前端 | extensions key + `set_plan_mode` IPC + preload + store + ChatView/MessageInput + mode-id.ts | 413b |

> **后续阶段（原 Phase 4，另行排期，不在 413a-e）**：411 goal 接入 `engine`、mid-turn
> 状态变更缓冲增强、prompt `_meta.mode` reconcile、SSE `current_mode` 前端透传、
> automation/research 状态机补齐、`config.toml` 开关、文档收口。

---

## 6. 风险与权衡

| 风险 | 缓解 |
|------|------|
| 推翻 plan 224 声明范式 | 413 是**叠加层**，不删 `ModeModifier`；tracker 只给"有状态"的 mode 用 |
| 每轮注入引入 token 开销 | `full/sparse` 交替 + 只在 `shouldInjectReminder()` 为真时注入 |
| 与 mailbox 检查点语义冲突 | 复用 `before_model_turn/final_answer` 检查点，但提醒作为**合成 user 消息**（对齐 grok synthetic origin），不再复用 mailbox 三 kind |
| 与 411 goal 重复 | 411 是 goal 单 mode 落地；413 提供框架，411 的 `GoalTracker` 直接挂载 |
| 状态机复杂度失控 | tracker 保持**纯函数**（无 IO），全部单测覆盖迁移矩阵 |
| 运行时工具门控与静态 block 并存 | 门控是"叠加"过滤，只在 `canGateTools()` 时缩减；静态 block 仍生效 |

---

## 7. 参考

- Grok-Build 源码（学习对象，本地 `E:\cloned-projects\grok-build\crates\codegen\xai-grok-shell\src\session\`）：
  - `acp_session.rs` — `SessionActor` 并行 tracker 字段
  - `acp_session_impl/session_mode.rs` — 仲裁（`resolve_turn_prompt_mode` / `reconcile_plan_mode_with_prompt`）+ 提醒注入（`inject_plan_mode_reminders`）+ mid-turn 激活 + `persist_plan_mode_state`
  - `plan_mode.rs` — `PlanModeTracker` 4 态 + 全部迁移 + `PlanModeSnapshot` + 模板
  - `goal_tracker.rs` — `GoalTracker` 8 态
  - `acp_session_impl/turn.rs:693` — 注入点；`turn.rs:2079` / `tool_calls.rs:396` / `turn_end.rs:204` — safe-point flush
- duya 底座：
  - `packages/agent/src/modes/`（types.ts / registry.ts / apply-modes.ts / index.ts / plan-task-mode.ts）
  - `packages/agent/src/agent/DuyaAgent.ts` — mode dispatch (474-552)、applyModes (583)、每轮前缀刷新 (708-727)、`before_model_turn` (928)、`before_final_answer` (1360)、`_claimMailboxAtCheckpoint` (1662)
  - `packages/agent/src/agent/session/mailbox.ts`（before_model_turn / before_final_answer）
  - `packages/agent/src/agentsmd/loader.ts:646` — `<system-reminder>` 包装
  - `packages/agent/src/agent/types.ts:48` — SSE `mode_changed` 事件
  - `packages/agent/src/ipc/db-client.ts:229-249` — `goalDb`（`modeStateDb` 模仿对象）
  - `electron/db/core/stores.ts:551-679` — `GoalStore`（`ModeStateStore` 模仿对象）
  - `electron/agents/db-bridge.ts:138,243-278` — `dispatchDbAction` + `goal:*`
  - `electron/ipc/core-db-adapters.ts:116-123` — `SESSION_EXTENSION_KEYS`
  - `electron/ipc/db-handlers.ts:1176-1184` — `set_conductor_mode`
  - `src/types/mode-id.ts`、`src/components/chat/MessageInput.tsx`、`src/stores/conversation-store.ts`、`src/components/chat/ChatView.tsx` — 前端 mode 状态链路
  - `docs/exec-plans/active/411-goal-mode.md`（goal 单模式落地）