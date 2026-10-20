# @duya/client-core

> 传输无关的运行/会话投影：把协议事件规约成 `SurfaceModel` + `RunSession`；不碰任何传输、React 或 IPC。

## 负责 / 不负责

- **负责**：`RunStatus` / `TurnPhase` / `ToolPhase` / `PermissionPhase` 等表面状态类型，`SurfaceModel.apply()` 的穷举归约，以及 `RunSession` 的订阅快照。
- **不负责**：事件从哪来（HTTP / SSE / IPC）→ `@duya/host`、`apps/web`；事件长什么样 → `@duya/agent-protocol`；UI 怎么画 → `@duya/ui`。

## 关键文件

| 文件 | 作用 |
| --- | --- |
| `packages/client-core/src/surface/surface-model.ts:449` | `SurfaceModel` 类；`apply()` 在 `:656`，按 `EventType` 穷举 switch，`:1098` 是不可达兜底 |
| `packages/client-core/src/surface/surface-model.ts:74` | `RunStatus` 及各类 surface 类型定义（`SurfaceEffect` 在 `:315`） |
| `packages/client-core/src/session/run-session.ts:75` | `RunSession` 类；快照类型 `RunSessionSnapshot` 在 `:35` |
| `packages/client-core/src/index.ts:1` | 公共面：`export *` 上面两个模块 |

公共面：`@duya/client-core`、测试夹具 `@duya/client-core/testing`（`envelope` / `RUN_ID` / `SESSION_ID`，见 `packages/client-core/src/testing/index.ts:30`）。

## 排障入口

| 症状 | 先看这里 |
| --- | --- |
| 某类事件在 UI 上不出现 | `packages/client-core/src/surface/surface-model.ts:656` — 穷举 switch，缺一个 `EventType` 就整类静默丢失 |
| 状态字段不对或不更新 | `packages/client-core/src/surface/surface-model.ts:315`（`SurfaceEffect`）→ `:449`（归约实现） |
| 订阅收不到更新 | `packages/client-core/src/session/run-session.ts:35`（快照结构）→ `:65`（listener 签名） |
| 想知道谁在消费 | `packages/ui/src/lib/run-session-view.ts:1`、`apps/web/src/client/run-stream.ts:32`、`packages/cli/src/chat.ts:37` |

## 边界

- `architecture-policy.yaml:312` — 模块 `client-core`，`managed: true`（零容忍），`requires: [agent-protocol]`。
- 纯状态：无 IO、无 React、无传输依赖。`packages/client-core/package.json` 只依赖 `@duya/agent-protocol`。
- **不新增依赖**：新增协议事件只改 `surface-model.ts` 的 switch；把这个包拖进任何 transport 都会破坏 `managed: true`。
