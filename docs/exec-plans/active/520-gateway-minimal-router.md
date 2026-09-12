# Plan 520 — Gateway 精简为路由 + 状态广播

> 修订版（2026-09-12）：核对代码后修正三处 —— ① `sendMessage` 是活的 CLI 控制面能力，撤出删除清单；
> ② 明确本 plan 只作用于 legacy 直连渠道管线，bots 管线（plan 488 Phase 6）不在范围；
> ③ 撤回入站附件删除（plan 507 成果），补 pairing UI / 命令消费端 / agent_busy 生产者三个缺口。

## 范围澄清（先读）

本 plan 只精简 **legacy 直连渠道管线**（`packages/gateway` 的 adapters + user-mapper + pairing + busy
queue，服务设置页 BridgeSection 的直连渠道绑定）。

**Bots 管线不在本 plan 范围，勿触碰**：plan 488 Phase 6 之后，bot 入站走
`electron/channels/telegram-connector.ts` 等 per-bot token connector → wake → `bot:<agentId>` 持久
会话；出站走 `SendMessageTool` → db-bridge → `channelDelivery`（`electron/channels/channel-delivery.ts`）
直连平台 API。全程不经过 `packages/gateway`，busy/队列对 bots 已有 wake 语义。

| 管线 | 入站 | 出站 | 本 plan |
|---|---|---|---|
| Bots | `electron/channels/*-connector` → wake → `bot:<agentId>` | SendMessageTool → db-bridge → `channelDelivery`（per-bot token） | ❌ 不触碰 |
| Legacy 直连 | gateway adapters → user-mapper → `gateway:inbound` | `gateway:outbound` → `adapter.sendReply` | ✅ 本 plan |

推论：Phase 6 的 busyMode / 队列改造只影响 legacy 直连渠道的用户体验，bots 感知不到 —— 这是有意的，
不是缺陷。若未来要给 bots 管线加 queue/steer/interrupt，另立 plan。

## 目标

将 Gateway 从「平台集成中枢（Bot 绑定 + 消息路由 + 命令系统 + Session 管理 + 权限流程）」精简为：

- **核心职责**：直连渠道生命周期管理 + 双向消息路由 + Profile 路由
- **状态广播**：Agent 忙/闲状态通知各 adapter（由 adapter 自行决定 queue/steer/interrupt）

**三项「改造保留」，对着 legacy 直连渠道重新设计：**

| 特性 | 原设计 | 改造后目标 |
|------|--------|-----------|
| **Typing / Reaction** | 基于 session busy 状态，Gateway 给用户发 typing/reaction | 改为 bot-status 信号：基于 adapter 队列状态，发送「bot 正在处理/队列堆积」等状态指示，服务于用户对 bot 状态的感知（仅 legacy 直连渠道） |
| **Pairing 系统** | 基于 user-mapper，(platform, userId) pairing code 审批 | Bot 绑定 allow-list 由 Main Process 管理（channel-directory），Gateway 只透传绑定配置，不再独立处理 pairing code |
| **Busy Queue** | Gateway 统一管理 queue/steer/interrupt | 已迁移至 adapter 层（Phase 6），各 adapter 自主决策 |

**删除**：Session 创建/映射（user-mapper）、permission request 处理、Home 广播。

**CLI 主动发消息保留（修订）**：`gatewayManager.sendMessage`（gateway-manager.ts:629）的唯一调用链是
`duya channel send`（packages/cli/src/commands/channel.ts:293）→ `POST /v1/channels/send`
（cli-api-server.ts:683）→ `handleChannelSend`（electron/cli/handlers/extra.ts:377，含 audit
`channel.send`）→ `requestChannelSend`（message-bus.ts:960）→ 子进程 `gateway:send`。这是活的 CLI
控制面能力，**整条链保留**。仅删除同名的死代码 handler `ipcMain.handle('gateway:send', ...)`（session
版转发，message-bus.ts:1370 — preload 未暴露、全仓库无 invoke 调用方）。未来可选：把
`/v1/channels/send` 切到 `channelDelivery` 统一 per-bot token 与补投，本 plan 不做。

**命令系统改造透传，不删除**：Gateway 检测 `/` 和 `@` 命令，包装为 `{ type: 'command', command, args }`
通过 `gateway:inbound` 发给 Main Process 执行，typing/reaction 反馈保留。**消费端设计（修订补充）**：
命令注册表 `commands/{registry,help,types}.ts` 留在 `packages/gateway`，Electron Main 直接
`import` 该 workspace 包（esbuild 打包，无运行时开销）；`message-bus.ts` 的 `gateway:inbound` case
新增 command 分支，Main 侧执行命令（/help 回显走 `getHelpText`，/new 走 session 重置 IPC；
/approve /deny 已随 permission 系统删除，registry 同步移除这两个命令）。

**入站附件保留（修订撤回）**：`buildInboundFiles` / `bufferToAttachment` / `InboundAttachmentRef`
是 plan 507 入站附件持久化的生产端（`message-bus.ts:373 persistInboundAttachmentRefs` 消费）。
「仅纯文本路由」前提不成立 —— 收媒体是要补的方向，不删。

---

## Phase 1 — 删除独立文件 + 目录结构改造

- [x] **`packages/gateway/src/user-mapper.ts`** — 整个文件删掉
  - 移除 `getOrCreateSession` / `getChatIdForSession` / `resetSession` 及对应 IPC
- [x] **`packages/gateway/src/commands/`** — **改造，不删除**
  - `commands/dispatcher.ts` — **删执行逻辑**，改为命令检测 + 透传包装
  - `commands/registry.ts` — **保留**，命令识别（哪些是合法命令）；移除 `/approve` `/deny` 注册
  - `commands/help.ts` — **保留**，help 文本生成（Main Process 执行 /help 时回显用）
  - `commands/types.ts` — **保留**，命令类型定义

---

## Phase 2 — `gateway-manager.ts` 精简

**删除方法：**

| # | 删除内容 | 说明 |
|---|---------|------|
| 1 | `handlePermissionRequest()` | 权限请求 → 发消息给用户 + `/approve`/`/deny` |
| 2 | `handleCommand()` | **改造**：不再本地执行，改为检测命令 + 包装 `{ type: 'command', command, args }` 透传给 `gateway:inbound` |
| 3 | `resetSession()` | /new 触发的 session 重置 |
| 4 | `broadcastHome()` | Gateway 上线/下线通知 |
| 5 | `registerDynamicCommands()` | **改造**：动态命令注册迁移至 Main Process（Main import registry 后直接注册） |
| 6 | `onSessionReset()` | Main Process 通知 session 重置 |
| 7 | `shouldResetSession()` | idle/daily reset 策略 |
| 8 | `parsePermissionCallback()` | 旧版 inline button 兼容 |

（修订：原 #5 `sendMessage` 保留 — CLI 控制面；原 #10/#11 附件相关保留 — plan 507 成果。）

**删除数据结构：**

| 删除 | 说明 |
|-----|------|
| `activeStreams` map | busy 状态追踪（替换为下述的 agent-bus 广播） |
| `busyQueue` map | 排队模式消息队列（移至各 adapter） |
| `lastActivityByChat` map | idle/daily reset（session 维度，已删） |

**删除 busy 相关方法：**

| 删除 | 说明 |
|-----|------|
| `markBusy()` / `clearBusy()` | Gateway 统一 busy 管理 → 替换为状态广播 |
| `hasActiveStream()` / `isSessionBusy()` | 替换为 adapter 自主判断 |
| `getBusyMode()` | queue/steer/interrupt 模式 → 移至 adapter 配置 |

**IPC message handler 删除：**

- `gateway:permission_request` handler
- `gateway:reset_session:response` handler

**改造：busy queue 逻辑迁移至 adapter 层**

Gateway 不再统一管理 queue/steer/interrupt。改为：

```
Main Process → IPC: gateway:agent_busy { platform, platformChatId, busy: true/false }
  → gateway-manager 定向广播给对应 adapter
  → adapter 自行决定：
      queue 模式：本地队列缓存消息，agent 闲时 flush
      steer 模式：立即透传，旁路当前流
      interrupt 模式：中断当前 stream，优先处理新消息
```

（修订：payload 从 `{ sessionId, busy }` 改为 `{ platform, platformChatId, busy }` —— user-mapper
删除后 Gateway 不再持有 session↔chat 映射，Main 侧自己解析后下发，Gateway 零查表。）

**agent_busy 生产者（修订新增）**：Main 侧监听 agent 运行状态 —— 与 `gateway:display_state`
（typing_start/stop）同源的 stream 生命周期事件，解析 session → platform+chatId（复用
`getSessionStates()` 的 bridgeChannel 信息）后发出 `gateway:agent_busy`。

**保留方法（精简后）：**

| 方法 | 保留内容 |
|------|---------|
| `start` / `stop` / `reloadConfig` / `getStatus` / `init` | 直连渠道生命周期 |
| `sendMessage` | **保留（修订）** — CLI 控制面主动发送（`/v1/channels/send` 链路） |
| `handleInboundMessage` | profile 路由 + busy 广播触发 + `forwardInbound` |
| `handleOutboundEvent` | 查 adapter → `adapter.sendReply()` |
| `forwardInbound` | profile 路由 + 构造 `gateway:inbound` IPC |
| `handleDisplayState()` | **改造保留** — typing 指示符改为 bot-status 信号（adapter 队列深度 → 显示 "..." 或状态） |
| reaction 发送逻辑 | **改造保留** — 🤔→👍/👎 改为队列状态指示（队列堆积→ 🤔，处理完→ 👍，出错→ 👎） |
| `buildInboundFiles` / `bufferToAttachment` / `InboundAttachmentRef` | **保留（修订）** — plan 507 入站附件持久化 |

---

## Phase 3 — `ipc-client.ts` 精简

**删除方法（6 项）：**

| 删除方法 | 说明 |
|---------|------|
| `resolvePermissionByCommand()` | 命令级权限解析（已删 permission 系统） |
| `interruptSession()` | Session 中断 |
| `forwardCommand()` | **命令转发删** — 命令改走 `gateway:inbound`（见 Phase 2 改造） |
| `getOrCreateSession()` | Session 获取（已删 user-mapper） |
| `resolveSessionForChat()` | Session 解析（同上） |
| `resetSession()` | Session 重置（同上） |

**Pairing 改造：原 IPC 方法删除，allow-list 移交 Main Process**

- 原 `checkPairing()` / `generatePairingCode()` / `approvePairingCode()` / `revokePairing()` / `listPairings()` 基于 user-mapper session
- 改造后：直连渠道 allow-list 由 Main Process 通过 channel-directory 直接管理，Gateway 只在 `gateway:inbound` 时透传 `{ platform, userId }`，Main Process 判断是否在 allow-list 内
- 如果不在 allow-list，Main Process 返回 special 响应（`{ type: 'unauthorized' }`），Gateway 透传给 adapter 发「未授权」消息
- **删**：所有 `gateway:pairing:*` IPC 方法

**保留基础 IPC 能力：**

- `request()` / `send()` / `handleResponse()`

---

## Phase 4 — `index.ts` 精简导出和 handler

**保留命令相关导出（Main Process 执行命令用）：**

- `resolveCommand` — 命令检测 + 解析
- `getHelpText` — help 文本生成
- `getCommandRegistry` — 命令注册表查询（Main import 后接管动态注册）
- `isKnownCommand` — 命令识别

**删除 message handler：**

- `gateway:permission_request`
- `gateway:reset`

**保留：**

- `init` / `start` / `stop` / `reload` / `getStatus`
- `gateway:send` handler（**修订保留** — CLI 控制面链路，调 `gatewayManager.sendMessage`）
- `gateway:inbound` handler
- `gateway:outbound` handler
- `gateway:display_state` handler（**改造**：bot-status 信号，非 session 反馈）
- `gateway:agent_busy` handler（新增：定向广播 busy 状态给对应 adapter）
- `gateway:feishu:qr_*` handlers（飞书 QR 登录保留）

---

## Phase 5 — Electron 层 IPC 调整

**`electron/gateway/message-bus.ts`：**

删除 IPC handler case：

| 删除 | 说明 |
|-----|------|
| `gateway:create_session` | Session 创建（已删） |
| `gateway:reset_session` | Session 重置（已删） |
| `gateway:permission` | 权限请求转发 |
| `ipcMain.handle('gateway:send', ...)`（message-bus.ts:1370，session 版 `forwardToGateway`） | **死代码（修订新增）** — preload 未暴露、全仓库无 invoke。注意与子进程消息 `gateway:send`（requestChannelSend 用，保留）同名，删的是 renderer-facing handler |

修改/新增 IPC handler：

| 修改 | 说明 |
|-----|------|
| `gateway:inbound` | 保留，不再创建 session，只路由；**新增 command 分支** — `{type:'command'}` 走 Main 侧命令执行（import `packages/gateway` 的 registry/help），新增 unauthorized 分支 — allow-list 未命中时回 `{type:'unauthorized'}` |
| `gateway:outbound` | 保留，纯路由 |
| `gateway:display_state` | 保留，typing/reaction |
| `gateway:agent_busy`（新增） | Main Process → Gateway → 对应 adapter 广播 busy 状态 |
| `gateway:pairing:*` | **删** — allow-list 改由 Main Process channel-directory 管理 |

**`electron/preload.ts` / `electron/ipc/gateway-handlers.ts`：**

删除：
- `gateway.resetSession`
- `gateway.permission`

保留：
- `gateway.displayState`
- `gateway.agentBusy`（新增）

删：
- `gateway.pairingList` / `gateway.pairingApprove` / `gateway.pairingRevoke`

**Pairing UI 改造（修订新增）：**

- [x] **`electron/gateway/pairing.ts`** — 整个文件删掉（plan 原版未点名）
- [x] **`src/components/settings/BridgeSection.tsx`** — 移除 pairing code 审批 UI（`pairingList`/`pairingApprove`/`pairingRevoke` 三处调用，:241-270），改为 channel-directory allow-list 的增删 UI（`{ platform, userId }` 列表 + 添加入口）
- [x] channel-directory 增加直连渠道 allow-list 的读写与 IPC（渲染层可管理）

---

## Phase 6 — 各平台 Adapter 改造（仅 legacy 直连 adapter）

> 修订：只作用于 `packages/gateway/src/adapters/` 下的直连渠道 adapter。bots 管线
> （`electron/channels/`）不在范围，勿改。

每个平台 adapter（Telegram / Feishu / Discord / WhatsApp / QQ / WeChat）新增：

| 新增 | 说明 |
|-----|------|
| `busyMode: 'queue' \| 'steer' \| 'interrupt'` | 适配器本地模式配置 |
| `messageQueue: InboundMessage[]` | queue 模式的本地消息队列 |
| `onAgentBusy(isBusy: boolean)` | 接收 Gateway 的 busy 状态广播 |
| `flushQueue()` | agent 闲时 flush 队列 |
| `steer(message)` | steer 模式：旁路注入 |
| `interrupt()` | interrupt 模式：中止当前流 |

Adapter 收到消息时：

```
onMessage(message):
  if agentBusy:
    switch adapter.busyMode:
      case 'queue':    queue.append(message); return
      case 'steer':    steer(message); return
      case 'interrupt': interrupt(); forward(message); return
  forward(message)

onAgentBusy(false):  # agent 变闲
  flushQueue()
```

---

## Phase 7 — 验证

- [x] `npm run typecheck:all` 通过（gateway 包 + web 全绿；electron tsc 相对 origin/master 基线 0 新增错误——electron 不在 gate 内有预存红）
- [x] `npm run test` 全部通过（83 个失败文件与 origin/master 基线完全一致，0 新增回归）
- [ ] 直连渠道绑定后消息仍能正确路由（手动冒烟测试，legacy 线）
- [ ] **`duya channel send` 仍可用（修订新增）** — `/v1/channels/send` → `sendMessage` 链路无回归
- [ ] Typing 指示符和 reaction 改造后正常工作（基于 adapter 队列状态，legacy 渠道）
- [ ] Pairing 改造后：未授权用户收到「未授权」消息，authorized 用户正常聊天；BridgeSection allow-list UI 可增删
- [ ] **入站附件不回退（修订新增）** — 直连渠道收图后 `persistInboundAttachmentRefs` 仍落库（plan 507 行为保持）
- [ ] Adapter busyMode 配置生效（queue/steer/interrupt）
- [ ] **命令透传闭环（修订新增）** — 直连渠道发 `/help`，Main 侧执行并经 adapter 回显
- [x] 确认 `user-mapper.ts`、`electron/gateway/pairing.ts` 和 pairing IPC 全网无引用
- [x] 确认 `gateway:create_session` / `gateway:reset_session` / 死代码 `ipcMain.handle('gateway:send')` 已清除

---

## 精简后 Gateway 架构

```
┌─────────────────────────────────────────────────────────┐
│                      Gateway (legacy 直连渠道)            │
│                                                          │
│  渠道生命周期  │  消息路由  │  状态广播  │  UI 反馈       │
│  (init/start)  │  (in/out)  │  (busy)    │ (typing/reaction)│
└────────┬───────────────┬──────────────┬─────────────────┘
         │               │              │
         ↓               ↓              ↓
    adapters         Main Process    platforms
  (queue/busy)      (Session/命令)   (用户可见)

Inbound:
  adapter 收到消息
  → adapter.onMessage()
    → 检查 agentBusy 状态 → queue/steer/interrupt（adapter 自主决策）
  → gateway-manager.handleInboundMessage
    → 检测命令：resolveCommand(text) → / 或 @ 前缀？
    → 是命令 → gateway:inbound { type: 'command', command, args, platform, chatId, profile }
    → 普通消息 → gateway:inbound { type: 'message', prompt, platform, chatId, profile }
    → Main 侧 allow-list 校验，未命中回 { type: 'unauthorized' } → adapter 发「未授权」
  → Main Process 执行命令或处理消息

Outbound (回复流):
  Main Process → IPC: gateway:outbound { sessionId, event }
  → gateway-manager.handleOutboundEvent → adapter.sendReply()

Outbound (CLI 控制面，修订保留):
  duya channel send → POST /v1/channels/send → requestChannelSend
  → gateway:send → gatewayManager.sendMessage → adapter.sendReply()

Busy 广播:
  Main（stream 生命周期，与 display_state 同源）→ IPC:
    gateway:agent_busy { platform, platformChatId, busy }
  → gateway-manager → 对应 adapter → queue/steer/interrupt

Gateway 不再：
  - 创建/管理 Session（user-mapper 删除）
  - 本地执行 slash 命令（检测 + 透传给 Main 执行）
  - 处理权限请求（/approve /deny）
  - 统一管理 busy 队列
  - 广播 Home 状态
  - 独立处理 pairing（改由 Main Process channel-directory 管理）

Gateway 仍然：
  - Typing 指示符改为 bot-status 信号（adapter 队列状态）
  - Reaction 改为队列状态指示（🤔=队列堆积，👍=处理完，👎=出错）
  - Profile 路由
  - 直连渠道生命周期管理
  - 状态广播（agent busy → adapters）
  - 命令检测和透传（/ @ 前缀 → gateway:inbound { type: 'command' } → Main 执行）
  - CLI 控制面主动发送（/v1/channels/send → sendMessage）
  - 入站附件持久化（plan 507）
```
