# @duya/client-core

> 运行/会话投影与纯事件流解码：把协议事件规约成 `SurfaceModel` + `RunSession`；不执行网络或其他 IO，不依赖 React 或 IPC。

## 负责 / 不负责

- **负责**：`RunStatus` / `TurnPhase` / `ToolPhase` / `PermissionPhase` 等表面状态类型、`SurfaceModel.apply()` 穷举归约、`RunSession` 订阅快照，以及纯 SSE frame framing 和 run-envelope JSON 解码。
- **不负责**：读取 HTTP 响应、Host 连接发现、凭据、cursor/resume 与重连策略 → `apps/web` / Host transport；事件合同 → `@duya/agent-protocol`；UI → `@duya/ui`。

解码器只接收 `Uint8Array` 或 `unknown` 值并返回 frame / envelope，不创建请求、流或连接。Web 继续拥有响应读取、选择取消、cursor 和重连。

## 关键文件

| 文件 | 作用 |
| --- | --- |
| `packages/client-core/src/surface/surface-model.ts:449` | `SurfaceModel` 类；`apply()` 在 `:656`，按 `EventType` 穷举 switch，`:1098` 是不可达兜底 |
| `packages/client-core/src/surface/surface-model.ts:74` | `RunStatus` 及各类 surface 类型定义（`SurfaceEffect` 在 `:315`） |
| `packages/client-core/src/session/run-session.ts:75` | `RunSession` 类；快照类型 `RunSessionSnapshot` 在 `:35` |
| `packages/client-core/src/decoding/sse.ts` | 增量 SSE framing；仅解析调用方提供的字节块 |
| `packages/client-core/src/decoding/envelope.ts` | run/error frame JSON 与 envelope 身份校验 |
| `packages/client-core/src/index.ts:1` | 公共面：投影、会话与纯解码模块 |

公共面：`@duya/client-core`、测试夹具 `@duya/client-core/testing`（`envelope` / `RUN_ID` / `SESSION_ID`，见 `packages/client-core/src/testing/index.ts:30`）。

## 排障入口

| 症状 | 先看这里 |
| --- | --- |
| 某类事件在 UI 上不出现 | `packages/client-core/src/surface/surface-model.ts:656` — 穷举 switch，缺一个 `EventType` 就整类静默丢失 |
| 状态字段不对或不更新 | `packages/client-core/src/surface/surface-model.ts:315`（`SurfaceEffect`）→ `:449`（归约实现） |
| 订阅收不到更新 | `packages/client-core/src/session/run-session.ts:35`（快照结构）→ `:65`（listener 签名） |
| 帧未形成或 envelope 被拒绝 | `packages/client-core/src/decoding/sse.ts` → `packages/client-core/src/decoding/envelope.ts` |
| 想知道谁在消费 | `packages/ui/src/lib/run-session-view.ts:1`、`apps/web/src/client/run-stream.ts:32`、`packages/cli/src/chat.ts:37` |

## 边界

- `architecture-policy.yaml:312` — 模块 `client-core`，`managed: true`（零容忍），`requires: [agent-protocol]`。
- 仅纯计算：无 fetch、连接、文件、React 或 IPC；`packages/client-core/package.json` 只依赖 `@duya/agent-protocol`。
- **不新增依赖**：新增协议事件只改 `surface-model.ts` 的 switch；传输获取和重连仍由具体客户端拥有。
