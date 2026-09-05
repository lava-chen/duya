# 488 — Bot Channel Integration（外部消息平台绑定/收发）

> **Status**: Phase 1 ✅ · gateway 接线 ✅ · Phase 2 ✅（P2.5 侧栏 UI + agent-scoped CLI，2026-09-05）· P1.5 pending（需手动端到端测试）· **Priority**: P1 · **Owner**: TBD
> **总纲**: [473-grok-bot-framework-overview](./473-grok-bot-framework-overview.md)
> **参考源码**：grok-bot `source/shared/channels.ts`、`source/shared/channel-messaging.ts`、`source/host/extensions/session/channel-store.ts`、`source/host/extensions/session/connector-secret-store.ts`、`source/host/extensions/transcript/background-wakes.ts`、`source/host/extensions/transcript/send-message-shaping.ts`、`source/host/runner/tools/send-message-tool.ts`、`source/host/runner/tools/sand-state-tool.ts`、`source/host/runner/tools/sand-secret-request.ts`、`source/host/extensions/session/agent-session.ts`
>
> **目标**：把 grok-bot 的 bot-level channel 系统（外部消息平台接入）移植进 duya——每个 bot 可绑定多个外部平台频道（Discord/Slack），接收 `[inbound]` 唤醒，并通过 SendMessage 向平台发消息。

---

## 1. 调查总结：grok-bot channel 机制全解析

### 1.1 核心文件映射

| grok-bot 文件 | 职责 | duya 对应物/缺口 |
|---|---|---|
| `source/shared/channels.ts` | 平台常量（Discord/Slack）、`ChannelAddress`（`{platform, chat}`）、地址解析 | **需新建** shared channel types |
| `source/shared/channel-messaging.ts` | 入站/失败 wake prompt 构建器、`CHANNEL_INBOUND_WAKE_CUE = "[inbound]"`、出站消息结构 | **需新建** prompt builders |
| `source/host/extensions/session/channel-store.ts` | `FileChannelStore`：`agents/<id>/channels/<platform>/connection.json`（label 元数据） | **需新建**在 485 `agents/<id>/` 下 |
| `source/host/extensions/session/connector-secret-store.ts` | `connector-secrets/<id>/<platform>.json`（凭证，与 channel store 分离） | **需新建** |
| `source/host/extensions/transcript/background-wakes.ts` | `BackgroundWakes`：`wakeForInbound`/`reviveForInbound`/`deliverToChannel` | 对应 476 WakeBus 模块 |
| `source/host/extensions/transcript/send-message-shaping.ts` | SendMessage 的 `channel` 字段透传 | 对应 481 的 SendMessage 工具扩展 |
| `source/host/runner/tools/send-message-tool.ts` | `buildSandSendMessage` 解析 `channel` target | 对应 481 T2 SendMessage 扩展 |
| `source/host/runner/tools/sand-state-tool.ts` | `OPERATIONS.channel.disconnect` | 对应 481 T1 update_state 扩展 |
| `source/host/runner/tools/sand-secret-request.ts` | `secret-request` 类型 SendMessage → 凭证收集 | 对应 481 新 secret-request 工具 |

### 1.2 Channel 存储结构（完全对照 grok-bot）

```
~/.duya/agents/<agentId>/
├── profile.json            # 485 已定义
├── settings.json           # 485 已定义
├── avatar.<ext>            # 485 已定义
├── channels/               # ← 新增：bot 绑定通道清单
│   ├── discord/
│   │   └── connection.json  # { label: "我的 Discord 频道" }
│   └── slack/
│       └── connection.json  # { label: "团队 Slack" }
└── connector-secrets/      # ← 新增：凭证存储（与 channel store 分离）
    ├── discord.json         # { token: "<bot-token>" }
    └── slack.json           # { token: "<bot-token>" }
```

**凭证安全原则**（对齐 grok-bot）：token 永不进 transcript，bot 只知道凭证"已被提供"，不知道值。

### 1.3 ChannelAddress 格式

```typescript
// grok-bot: platform:chat（如 "slack:C12345"）
interface ChannelAddress {
  readonly platform: string;  // "discord" | "slack" | future
  readonly chat: string;     // 平台特定 chat ID
}
```

### 1.4 入站流程（Inbound Flow）

```
外部平台（Discord/Slack）
  → Webhook/Long-polling relay（connector 实现）
  → gateway:inbound 消息
  → duya 解析 channel_bindings 表（platform + chat_id）
  → 定位 bot（agentId）
  → BackgroundWakes.wakeForInbound(agentId, envelope)
    envelope = { address: { platform, chat }, sender, text, reaction? }
  → pending_wakes 持久化（connector.inbound）
  → revivieForInbound() → runInboundWake()
  → appendChannelInboundEntries() 写 transcript
    → role: user, content: text, channel: "slack:C12345", channelSender: "Alice"
  → runner.run(buildChannelInboundWakePrompt(envelopes), { hidden: true })
    → prompt 以 "[inbound]" cue 开头
  → Bot 被唤醒，以 hidden turn 处理消息
```

**关键差异 vs duya 现状**：
- duya 现有 `gateway:inbound` → HTTP POST `/sessions/:id/chat` 直跑 inline SSE run（message-bus.ts:495）
- 目标：`gateway:inbound` → connector.inbound wake source → WakeBus → hidden wake run
- 476 P2.3c 完成了 dispatcher 层，未完成 gateway → WakeBus 接线

### 1.5 出站流程（Outbound Flow）

```
Bot 调用 SendMessage({ content: "…", channel: "slack:C12345" })
  → buildSandSendMessage() 解析 channel 字段
  → onSendMessage() → hooks.transport.onUpdate({ type: "send-message", message })
  → BackgroundWakes.deliverToChannel(runSession, message, "slack:C12345")
  → channelDelivery(agentId, addressToken, outbound)
  → Connector transport（Discord/Slack API）实际发送
  → 若失败：queueChannelDeliveryFailure()
    → "[channel-delivery-failed]" wake cue
```

### 1.6 Reaction 处理

```typescript
interface ChannelReaction {
  readonly emoji: string;
  readonly messageQuote?: string | null;
}

interface ChannelInboundEnvelope {
  address: ChannelAddress;
  sender: string;
  text: string;
  reaction?: ChannelReaction | null; // 有 reaction 时 text 可为空
}
```

reaction 触发 `[inbound]` 唤醒，prompt 格式：
`"On Slack, from slack:C12345: Alice reacted ❤️ to your message: 'Hello'"`

### 1.7 凭证收集流程（Secret-Request）

```
Bot → SendMessage({
  type: "secret-request",
  secret: { label: "Slack Bot Token", connector: "slack", field: "token" }
})
→ UI 弹出 masked secure input
→ 用户输入 token
→ 存 connector-secrets/<agentId>/slack.json → { token }
→ Bot 收到 "Secret stored securely" ack
→ Bot 永不看到 token 值
```

### 1.8 Channel Disconnect

```
Bot → update_state({ target: "channel", action: "disconnect", platform: "slack" })
→ 删 connector-secrets/<agentId>/slack.json
→ 删 agents/<agentId>/channels/slack/connection.json
→ 停止 connector transport
```

---

## 2. duya 现状盘点 vs 缺口

### 2.1 现有基础设施

| 已有 | 位置 | 用途 |
|---|---|---|
| `channel_bindings` 表 | `db/schema.ts:175` | gateway 级映射：channel_type+chat_id → duya_session_id（plan 62 产物） |
| `connector.inbound` WakeSource kind | `db/core/pending-wakes.ts:27` | 已定义但只完成了 dispatcher 层 |
| `connector.inbound` rearm 处理 | `wake/wake-rearm.ts:116` | 已有骨架 |
| gateway:inbound 消息 | `gateway/message-bus.ts:495` | 现有 inline SSE run（不走 WakeBus） |
| `platform`/`platformChatId` 选项传递 | `gateway/inbound-request.ts` | 已透传，profile 路由 |
| `agents/<id>/` 目录 | 485 Phase 1-2 | 已有 profile.json/settings.json/avatar |
| 481 T2 SendMessage 工具 | plan 481 | 已有工具壳 |
| 474 `botChannels` catalog 占位 | 474 §7.7 catalog | 占位 `render: null`，P2.5 待注入 |

### 2.2 缺口清单

| 缺口 | 优先级 | 依赖 |
|---|---|---|
| **per-agent channel store**（`agents/<id>/channels/`） | P0 | 485（agents/ 目录） |
| **connector credential store**（`agents/<id>/connector-secrets/`） | P0 | 485 |
| **ChannelAddress / platform manifest 类型** | P0 | 无 |
| **gateway:inbound → WakeBus 接线**（完成 476 P2.3c 未竟之工） | P0 | 476 dispatcher |
| **入站 wake prompt 构建器**（`buildChannelInboundWakePrompt`） | P0 | 无 |
| **BackgroundWakes 模块**（wakeForInbound / deliverToChannel） | P0 | 476 WakeBus |
| **出站 channel delivery transport hook 注册** | P0 | 476 |
| **SendMessage `channel` 字段扩展** | P1 | 481 T2 |
| **update_state channel.disconnect 操作** | P1 | 481 T1 |
| **botChannels system prompt section**（474 P2.5） | P1 | 474 P2.0 |
| **secret-request SendMessage 类型** | P2 | 481 |
| **reaction 入站支持** | P2 | P0 模块 |
| **Discord/Slack connector transport 实现** | P3 | P0 模块（先做架构再做具体平台） |

### 2.3 与现有 `channel_bindings` 表的关系

**重要架构决策**：duya 现有的 `channel_bindings` 表（plan 62）是 **gateway/session 级**的——它把外部 channel 绑定到一个 duya **session**（用于 SDK 集成场景）。而 grok-bot 的 channel 系统是 **agent/bot 级**的——绑定到 bot（agent），每个 bot 可以有多个 channel。

两者**不冲突**，但职责不同：

| 维度 | duya 现有 `channel_bindings` | grok-bot channel 系统（488） |
|---|---|---|
| 绑定目标 | external channel → duya session | external channel → bot（agent） |
| 粒度 | 一个 channel 一个 session | 一个 bot 多个 channel |
| 凭证 | 无（SDK 侧管理） | per-agent per-platform token |
| 唤醒 | 直接跑 inline run | connector.inbound → WakeBus → hidden wake |
| 用途 | SDK 接入（代码/浏览器控制） | Bot 对外消息平台（Discord/Slack） |

**结论**：488 不复用 `channel_bindings` 表，在 `agents/<id>/channels/` 独立建 channel store。两套并行，connector transport 各自解析自己的 channel。

---

## 3. 设计

### 3.1 类型定义（新文件 `packages/agent/src/channels/types.ts`）

```typescript
// ========== Platform ==========
const DISCORD_PLATFORM = 'discord';
const SLACK_PLATFORM = 'slack';
const KNOWN_PLATFORMS = [DISCORD_PLATFORM, SLACK_PLATFORM] as const;
type KnownPlatform = typeof KNOWN_PLATFORMS[number];

interface ConnectorManifest {
  platform: string;
  displayName: string;
  blurb: string;
  credentialLabel: string;           // e.g. "Bot Token"
  availability: 'available' | 'coming-soon';
  connectGuide?: string;
}

// ========== Channel Address ==========
interface ChannelAddress {
  readonly platform: string;
  readonly chat: string;
}

function formatChannelAddress(addr: ChannelAddress): string {
  return `${addr.platform}:${addr.chat}`;
}

function parseChannelAddress(raw: string): ChannelAddress | null {
  const idx = raw.indexOf(':');
  if (idx < 0) return null;
  return { platform: raw.slice(0, idx), chat: raw.slice(idx + 1) };
}

// ========== Inbound/Outbound ==========
interface ChannelOutboundMessage {
  kind: 'text' | 'attachment';
  content?: string;
  url?: string;
  caption?: string;
}

interface ChannelReaction {
  readonly emoji: string;
  readonly messageQuote?: string | null;
}

interface ChannelInboundEnvelope {
  address: ChannelAddress;
  sender: string;
  text: string;
  reaction?: ChannelReaction | null;
}

// ========== Store Schemas ==========
interface ChannelConnectionConfig {
  label: string;        // human-readable
}

interface ConnectorSecretRecord {
  [field: string]: string;  // e.g. { token: "..." }
}
```

### 3.2 FileChannelStore（`electron/channels/channel-store.ts`）

```typescript
// 路径：~/.duya/agents/<agentId>/channels/<platform>/connection.json
// 接口：
interface ChannelStore {
  listPlatforms(): string[];
  readLabel(platform: string): string | null;
  listConnections(): Array<{ platform: string; label: string; status: 'configured' }>;
  writeMetadata(platform: string, label: string): void;
  remove(platform: string): void;
}
```

- 依赖 485 `resolveDuyaAgentDir(agentId)` 派生路径
- `assertValidBotId` 前置校验
- 原子写：tmp + rename（对齐 grok）

### 3.3 ConnectorSecretStore（`electron/channels/connector-secret-store.ts`）

```typescript
// 路径：~/.duya/agents/<agentId>/connector-secrets/<platform>.json
// 接口：
interface ConnectorSecretStore {
  setSecret(agentId: string, platform: string, field: string, value: string): void;
  getSecret(agentId: string, platform: string, field: string): string | null;
  removeAgentPlatform(agentId: string, platform: string): void;
}
```

- token 永不进 transcript
- 原子写

### 3.4 AgentSession Channel 接口（`electron/channels/agent-session-channels.ts`）

```typescript
// 挂在 SandAgentSessionStore（或等效 duya session store）
interface AgentChannelOps {
  openChannelStore(agentId: string): ChannelStore;
  listAgentChannels(agentId: string): ChannelConnection[];   // 只返回有 token 的
  listChannelConfigs(agentId: string): ChannelConfig[];       // 含 token（内部用）
  storeConnectorCredential(agentId: string, platform: string, field: string, value: string): void;
  disconnectChannel(agentId: string, platform: string): void;
}
```

### 3.5 BackgroundWakes Channel 模块（`electron/wake/channels.ts`）

```typescript
// 对齐 grok-bot BackgroundWakes 的 channel 相关方法
interface ChannelBackgroundWakes {
  // 入站
  wakeForInbound(agentId: string, envelope: ChannelInboundEnvelope): void;
  reviveForInbound(agentId: string): void;

  // 出站
  deliverToChannel(
    agentId: string,
    addressToken: string,        // "slack:C12345"
    outbound: ChannelOutboundMessage
  ): Promise<void>;

  // 失败处理
  reviveForChannelFailures(agentId: string): void;
}
```

- `deliverToChannel` 调用 `tm.channelDelivery(agentId, addressToken, outbound)`（transport hook）
- 失败时 `queueChannelDeliveryFailure` → `reviveForChannelFailures`

### 3.6 wake prompt 构建器（`packages/agent/src/channels/prompts.ts`）

```typescript
const CHANNEL_INBOUND_WAKE_CUE = '[inbound]';
const CHANNEL_DELIVERY_FAILED_WAKE_CUE = '[channel-delivery-failed]';

function buildChannelInboundWakePrompt(envelopes: ChannelInboundEnvelope[]): string;
function buildChannelDeliveryFailureWakePrompt(failures: DeliveryFailure[]): string;
```

- `buildChannelInboundWakePrompt`:
  - 按 address 分组 envelopes
  - 每组格式：`"On <platform>, from <address>: <sender> <text/reaction>"`
  - 以 `[inbound]` cue 开头
  - 结尾提示 bot 通过 SendMessage 回复，target 用 channel 字段
- reaction 格式：`"<sender> reacted <emoji> to your message: '<quote>'"` 或 `<sender> reacted <emoji>`

### 3.7 botChannels system prompt section（474 P2.5 注入点）

对齐 grok-bot `renderChannelsSystemPrompt`，在 474 的 `botChannels` catalog 占位处注入真实渲染器：

```typescript
function renderBotChannels(ctx: BotPromptContext): string | null;
// 输出示例：
// "You are connected to the following channels:
//  - discord:general (My Discord Server)
//  - slack:C12345 (Team General)
// To send a message to a channel, include "channel": "<address>" in SendMessage.
// Incoming messages will wake you with [inbound]."
```

- 读取 `ctx.channels`（`ChannelSnapshot[]`，由 main 侧注入）
- 无 channel 时返回 null（省略段）

### 3.8 PromptContext.channels 注入（474 P2.0）

```typescript
// packages/agent/src/prompts/bot/loader.ts 或独立 channel-loader.ts
interface ChannelSnapshot {
  platform: string;
  chat: string;
  label: string;
  status: 'configured';
}

interface BotPromptContext {
  // ... 现有字段
  channels?: ChannelSnapshot[];
}
```

Main → agent 传递方式（待 476/488 P0 实施时定）：
- 方案 A：init payload 快照（简单，但 channel 变更需等下次会话）
- 方案 B：IPC 查询（实时，但增加 latency）
- **推荐方案 A**：snapshot 不常变（用户手动配置 channel），变更时开新会话即可

### 3.9 SendMessage channel 字段扩展（481 T2 扩展）

```typescript
// buildSandSendMessage 输入扩展
interface SendMessageInput {
  type?: string;        // "text" | "widget" | "secret-request" | ...
  content?: string;
  reply_to?: string;
  images?: string[];
  channel?: string;    // ChannelAddress token, e.g. "slack:C12345"
  // ... 其他字段
}
```

- `channel` 字段可选，传递到 message.extra.channel
- transport.onUpdate 携带 channel 字段路由

### 3.10 update_state channel.disconnect（481 T1 扩展）

```typescript
// OPERATIONS 扩展
OPERATIONS = {
  // ... 现有操作
  channel: {
    disconnect: "(platform: string). The connector closes the live connection and removes credentials."
  }
}
```

- 调用 `deps.state.disconnectChannel({ platform })`
- 同步删 credential store + channel store

### 3.11 secret-request 类型（SendMessage type="secret-request"）

```typescript
interface SecretRequestContent {
  type: 'secret-request';
  secret: {
    label: string;          // e.g. "Slack Bot Token"
    connector: string;      // e.g. "slack"
    field: string;          // e.g. "token"
  };
}
```

- UI 弹出 masked input，存 connector-secret-store
- Bot 收到 ack：*"Secret stored securely for <connector> <field>"*

---

## 4. 分阶段实施

### Phase 0 — 类型与存储地基 ✅

- [x] **P0.1** `packages/agent/src/channels/types.ts`：ChannelAddress / ConnectorManifest / ChannelInboundEnvelope / ChannelReaction / ChannelOutboundMessage 类型 + `formatChannelAddress` / `parseChannelAddress` 纯函数 + 单测。
- [x] **P0.2** `electron/channels/channel-store.ts`：`FileChannelStore` 类。路径派生基于 `app.getPath('userData')`（与 485 约定对齐）。
- [x] **P0.3** `electron/channels/connector-secret-store.ts`：`FileConnectorSecretStore` 类 + `getConnectorSecretStore()` 单例。
- [x] **P0.4** `electron/channels/index.ts`：barrel export + 接口类型重导出。

> ✅ 2026-09-03: Phase 0 完成。类型检查干净（electron 无 channels/ 错误；packages/agent 预存错误与本次无关）。

### Phase 1 — 入站唤醒（核心路径）✅ P1.1–P1.4 ✅ · P1.5 pending

- [x] **P1.1** `packages/agent/src/channels/prompts.ts`：`buildChannelInboundWakePrompt` / `buildChannelDeliveryFailureWakePrompt` / `buildChannelOutboundMessage` 纯函数。覆盖 reaction / multi-envelope / 8000-char clamp。单测待补充。
- [x] **P1.2** `electron/wake/channels.ts`：`DefaultChannelBackgroundWakes` 类（`wakeForInbound` / `reviveForInbound` / `deliverToChannel`（stub） / `reviveForChannelFailures`）+ `queueChannelDeliveryFailure`。channelDelivery 暂时打桩，Phase 2 P2.2 接入真实 transport。
- [x] **P1.3** gateway → WakeBus 接线（完成 476 P2.3c 未竟）：
  - **Dispatcher 侧**：`wake-dispatcher.ts` drain 添加 `connector.inbound` 分支，检测 `item.source === 'connector.inbound'` 时 fire-and-forget 调用 `reviveForInbound(sessionId)`
  - **Dispatcher 侧**：`wake/channels.ts` 新增模块级 `reviveForInbound(sessionId)` 函数，从 `inboundEnvelopeStore` 构建 rich `[inbound]` prompt，通过 `runWakePromptInExistingSession` 执行
  - **Gateway 侧**：`gateway/message-bus.ts` `gateway:inbound` case 改造，移除 SSE forwarding（HTTP POST + SSE handlers），替换为 `enqueueInboundWake` + `notifySessionIdle` 调用，立即返回
  - SSE 响应链保持：`reviveForInbound` → `runWakePromptInExistingSession` → agent server SSE → `sendToGatewayProcess`（`gateway:outbound`）不变
- [x] **P1.4** `electron/channels/agent-session-channels.ts`：`listAgentChannels` / `listChannelConfigs` / `storeConnectorCredential` / `getConnectorCredential` / `disconnectChannel` / `getAgentChannelAddress`。凭证永不暴露给 agent subprocess；`listChannelConfigs` 标记 `hasCredentials` 而不返回 token。
- [ ] **P1.5** 端到端入站：手动发一条 `gateway:inbound` 消息 → bot 收到 `[inbound]` wake → transcript 出现 channel 入口。

### Phase 2 — 出站与工具扩展 ✅ P2.2 · P2.3 · P2.4 ✅

- [ ] **P2.1** SendMessage channel 字段扩展（481 T2 协作）：`buildSandSendMessage` 解析 `channel` → `message.extra.channel` → transport.onUpdate 携带 + 单测。
  - ⚠️ 阻塞：duya 的 SendMessage 工具定义未找到，需调研是 MCP 工具还是 conductor 工具。
- [x] **P2.2** `electron/channels/channel-delivery.ts`：`channelDelivery` registry + Discord/Slack HTTP API 真实实现（`POST /channels/{id}/messages`、``/api/chat.postMessage`）+ `getTransport`/`registerTransport`/`registeredPlatforms` 工具函数。`deliverToChannel` 已从 stub 升级为真实实现。
- [x] **P2.3** `duya channel disconnect` CLI 子命令：
  - ✅ `packages/cli/src/commands/channel.ts`: `disconnectChannel()` 函数 + `runChannelCommand.disconnect` 条目
  - ✅ `electron/cli/cli-api-server.ts`: `POST /v1/channels/disconnect` 端点 + `handleChannelDisconnect` 导入
  - ✅ `electron/cli/handlers/extra.ts`: `handleChannelDisconnect()` 实现（调用 `disconnectChannel(agentId, platform)`，agentId 从 session 的 agentProfileId 派生）
  - ✅ `electron/services/controlPlaneAudit.ts`: `'channel.disconnect'` 已加入 `AuditEventKind`
- [x] **P2.4** botChannels system prompt section（474 P2.5 协作）：`renderBotChannels` 已在 `packages/agent/src/prompts/bot/channels.ts` 实现并从 `bot/index.ts` 和 `prompts/index.ts` 导出。只需 rebuild agent dist 即可生效。
- [x] **P2.5** Bot 设置侧栏 + agent-scoped CLI 配置（2026-09-05，同日重构为 **gateway profile routes 复用**）：
  - ✅ **绑定语义（最终版）**：bot 绑定 channel = gateway profile route（`channels.profile_routes`，(platform[, chatId]) → bot config-agent id），复用 gateway 的 6 个真实适配器与 `matchProfileRoute` 入站路由；worker `_resolveAgentProfile` 按 config agent 加载 bot 人格。平台凭据仍在 `channels.adapters.<platform>.credentials`，绑定不涉凭证。
  - ✅ `electron/gateway/message-bus.ts`: init config 现在传 `profileRoutes`（此前 gateway 的 profile-routing 从未被喂过数据，处于休眠）
  - ✅ `electron/channels/profile-routes.ts`: route CRUD + 校验（bot live / 平台已配置）+ gateway 热重启
  - ✅ `electron/ipc/bot-channel-handlers.ts` + `electron/cli/handlers/bot-channels.ts`: bind/unbind/list 语义
  - ✅ `src/components/layout/panels/BotSettingsPanel.tsx`: 列出已配置的 gateway 平台，绑定=选平台+可选 chatId
  - ✅ CLI：`duya channel connect/bindings/disconnect --agent [--chat]`
  - ⚠️ 早期版本曾接 488 per-agent token store（Discord/Slack 直连 transport），已被上述 route 方案替换；`channel-delivery.ts` transport 保留供 488 直连管线使用

### Phase 3 — 凭证收集与 Reaction ✅ P3.1 · P3.2 ✅

- [x] **P3.1** secret-request SendMessage 类型：
  - ✅ `packages/agent/src/channels/types.ts`: `SecretRequestContent` 接口定义
  - ✅ `electron/ipc/db-handlers.ts`: `secret:store` IPC handler（调用 `storeConnectorCredential(agentId, platform, field, value)`）
- [x] **P3.2** reaction 入站支持：
  - ✅ `packages/gateway/src/types.ts`: `gateway:reaction` message type added to `GatewayToMainMessage` union
  - ✅ `packages/gateway/src/adapters/feishu/index.ts`: `onReactionAdded`/`onReactionRemoved` callbacks wired to query DB via IPC for sessionId and send `gateway:reaction` to main process
  - ✅ `electron/gateway/message-bus.ts`: `gateway:reaction` case handler creates `ChannelInboundEnvelope` with reaction data and calls `wakeForInbound(sessionId, envelope)`
- [x] **P3.3** delivery failure wake：
  - ✅ `packages/agent/src/channels/types.ts`: `DeliveryFailure` 新增 `sessionId` 字段
  - ✅ `electron/wake/channels.ts`: `queueChannelDeliveryFailure` key 从 `${platform}:${chat}` 改为 `sessionId`（修复 key 不匹配 bug）
  - ✅ `electron/wake/channels.ts`: `deliverToChannel` 新增 try/catch，失败时调用 `queueChannelDeliveryFailure(failure)` + `reviveForChannelFailuresWake(sessionId)`
  - ✅ 接口签名更新：`deliverToChannel(agentId, sessionId, addressToken, outbound)`

### Phase 4 — Connector Transport 实现（示例）✅ P4.1 ✅ P4.2 ✅ P4.3

- [x] **P4.1** Discord connector transport：已在 `electron/channels/channel-delivery.ts` 实现，`DiscordTransport.send()` 调用 Discord Bot API `POST /api/v10/channels/{channelId}/messages`
- [x] **P4.2** Slack connector transport：已在 `electron/channels/channel-delivery.ts` 实现，`SlackTransport.send()` 调用 Slack Web API `/api/chat.postMessage`
- [x] **P4.3** Connector manifest 注册表：`registerTransport()` + `getTransport()` + `registeredPlatforms()` 工具函数已实现，Discord/Slack 已默认注册
- [ ] **P4.3** Connector manifest 注册表（`source/shared/channels.ts` 的 `CONNECTOR_MANIFESTS` 对等物）：Discord（available）、Slack（available）、其他（coming-soon）。

### Phase 5 — 收口与集成

- [ ] **P5.1** 端到端演示：Discord/Slack webhook → duya → bot 唤醒 → bot 回复 → 发送到 channel。
- [ ] **P5.2** 与 476 WakeBus 完整集成：connector.inbound 的 `pending_wakes` 持久化 + rearm + roster 投影。
- [ ] **P5.3** `npm run typecheck:all` 全绿 + 所有新增单测绿。
- [ ] **P5.4** 更新 ARCHITECTURE.md：新增 "Bot Channel Integration" 章节。

---

## 5. 与现有 plan 的接口

| 消费者/依赖 | 接口点 | 方向 |
|---|---|---|
| **485** 存储布局 | `agents/<id>/channels/`、`agents/<id>/connector-secrets/` 目录 | 488 P0.2/P0.3 派生自 485 路径 |
| **476** WakeBus | `connector.inbound` WakeSource / `BackgroundWakes` | 488 P1.2/P1.3 依赖 476 dispatcher |
| **481** 工具建档 | T1 update_state（channel.disconnect）/ T2 SendMessage（channel 字段） | 488 P2.1/P2.3 协作 |
| **474** bot system prompt | `botChannels` section + `BotPromptContext.channels` | 488 P2.4 注入 474 catalog |
| **483** 多 Bot UI | channel 配置 UI / channel 状态显示 | 488 外部接口（UI 属于 483） |
| 现有 `channel_bindings` 表 | 不冲突，并行存在 | gateway SDK 接入 vs bot-level channel |

---

## 6. 非目标

- 不实现 Discord/Slack connector transport 的**生产级** API（Phase 4 只做 stub + 真实实现可后续独立 plan）。
- 不做 channel 消息的**持久化 transcript 隔离**（channel 消息进主 transcript，channelSender 字段标记来源）。
- 不做 channel 的**rate limit / quota 管理**（后续可扩展）。
- 不复用 `channel_bindings` 表（两套系统职责不同）。

---

## 7. 风险

- **gateway 接线复杂性**：现有 `gateway:inbound` 的 inline SSE run 替换为 WakeBus 路径可能影响现有 SDK 接入。需要仔细回归测试。
- **双 source 路由**：一个 external channel message 可能同时命中 `channel_bindings`（session 级）和新的 `agents/<id>/channels/`（bot 级）。需要明确路由优先级。
- **channel 变更通知**：用户配置/删除 channel 时，bot 需要重新渲染 `botChannels` section。涉及 prompt cache 失效。
- **凭证安全**：connector-secrets 目录权限需严格（仅 electron main 可读写，agent 子进程不可见）。
