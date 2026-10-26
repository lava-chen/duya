# 623 — Gateway 通道能力补全（channel capability parity）

> **Status**: Phase 0–2 ✅（2026-10-26）· Phase 3（Host/Desktop 接线）pending · **Priority**: P1 · **Owner**: 本次会话
>
> **参考实现**：`E:/cloned-projects/hermes-agent`（`gateway/platforms/*`、`gateway/platforms/base.py`、`gateway/platforms/ADDING_A_PLATFORM.md`）
> **范围**：`packages/gateway`（网关子进程内的适配器层）。Host/Desktop 侧接线不在本计划已交付范围内，见 Phase 3。

## 1. 目标

duya 的 gateway 已有 6 个通道（telegram / feishu / weixin / qq / whatsapp / discord），但：

1. 平台能力只以「实现了哪些可选方法」隐式表达，调用方无法判断某个通道是否支持 typing / reaction / 编辑；
2. 若干通道的关键能力缺失（feishu 入站媒体全丢、discord 不收附件与 DM、qq 完全没有 gating、weixin 群消息无 @ 门槛）；
3. 参考实现里已有的通道类型（WhatsApp Cloud / Signal / iMessage / 通用 webhook / MS Graph）完全没有。

本计划把通道层收敛成「一张能力表 + 一组共享工具 + 每个通道一套真实协议实现」。

## 2. 现状盘点（改动前，带证据）

| 通道 | 改动前关键缺口 |
| --- | --- |
| feishu | `onImageMessage/onFileMessage/onAudioMessage/onPostMessage` 在 wrapper 里是空实现（`src/adapters/feishu/index.ts:1260-1263`），通道已下载好的本地路径被丢弃；wrapper 不暴露 `sendReaction` / `recallMessage`；`permission_request` / `inline_keyboard` / `stream_*` 直接报 unsupported |
| discord | intents 只有 `1<<9`（`:342`），没有 MESSAGE_CONTENT / DIRECT_MESSAGES ⇒ DM 收不到、非 @ 消息 `content` 为空；无附件下载；`sendTyping` 用发零宽消息冒充；`gating.ts:48` 的 DM allowlist 恒为 false；无 edit / delete / reaction |
| qq | 完全没有 gating（dm/group/mention/allowFrom 全无），群与会话消息一律进 agent |
| weixin | `require_mention` 只存在于类型（`types.ts:70`），群消息任何内容都触发 |
| whatsapp | 断线后不重连（`disconnected` 只置位）；无 `stopTyping` |
| 全部 | 没有 WhatsApp 官方 Cloud API、Signal、iMessage、通用 webhook、MS Graph 通道 |

## 3. 已交付（Phase 0–2）

### P0 能力表与共享层

| 文件 | 作用 |
| --- | --- |
| `src/platform-capabilities.ts` | 11 个平台的声明式描述：入站方式、是否占端口、默认端口/路径、凭据字段（含 secret 标记）、单条长度上限、能力位。`getPlatformCapabilities` / `supportsCapability` / `isKnownPlatform` 为唯一查询入口 |
| `src/adapters/shared/dedup.ts` | `BoundedIdSet`：FIFO 上限 + 可选 TTL（Signal/BlueBubbles 会重投） |
| `src/adapters/shared/signature.ts` | HMAC-SHA256 常量时间校验：Meta/GitHub `X-Hub-Signature-256`、Standard Webhooks(Svix)、时间戳+重放窗口、共享 token、Meta GET challenge |
| `src/adapters/shared/webhook-server.ts` | `WebhookServer`：端口绑定与 EADDRINUSE 翻译、`/health`、原始字节上限（先看 Content-Length 再缓冲）、异常转 500、关闭时 `closeAllConnections` |
| `src/adapters/shared/gating.ts` | 通用 dm/group 策略（open / allowlist / pairing / disabled）+ mention 门槛 + 自由响应群 + `/` 命令旁路 |
| `src/adapters/shared/media-cache.ts` | 入站媒体落盘（按平台隔离目录、文件名消毒、体积上限）、URL 抓取、出站源读取 |

消费点（不是死代码）：`GatewayManager.getStatus()` 回传 `capabilities`；typing / reaction / stopTyping 调用前先查能力表，避免对不支持的平台发起必然失败的请求。

### P1 新增通道（5 个，全部纯 HTTP，无新增依赖）

| 通道 | 实现要点 |
| --- | --- |
| `whatsapp_cloud` | 官方 Meta Cloud API。GET challenge 回显、POST 先验 `X-Hub-Signature-256` 再解析、wamid FIFO 5000 去重、4096 分片、媒体两段式（media id → 带 Bearer 下载；出站先 upload 或直接用 link）、原生 quick-reply（≤3）与 list（>3，单段 ≤10 行）、`status:read` + `typing_indicator` 合并做「已读+输入中」、reaction 走 `gateway:reaction` |
| `signal` | signal-cli HTTP daemon：出站 JSON-RPC 2.0（`send` / `sendTyping` / `sendReaction`），入站 SSE（抖动退避重连、120s 静默视为可疑由 daemon 侧重连覆盖）；`format.ts` 把 markdown 转 `start:length:STYLE`（UTF-16 偏移，`_` 只在词边界生效）；`rate-limit.ts` 令牌桶（容量 50 / 4s 一枚）并在真实 429 上按 `retryAfter` 校准 |
| `bluebubbles` | iMessage（macOS 桥）。启动时探测 `/server/info` 的 `private_api` / `helper_connected` 决定 typing/read 是否可用；webhook 自注册/反注册；tapback（2000-2005 / 3000-3005）直接丢弃；群聊按 `;+;` 判定 |
| `webhook` | 通用入站通道。签名方案 `standard / github / timestamped / token / none`（`none` 仅允许 loopback）、声明式过滤器（all/any/not + exists/equals/contains/in/regex，支持 `payload.` `headers.` 前缀）、prompt 模板、每路由 30 次/分钟上限。**每路由一个持久会话**（`webhook:<route>`），不按 delivery 建会话 |
| `msgraph` | Microsoft Graph 变更通知，纯入站。GET `validationToken` 原样回显；逐条 `clientState` 常量时间比对，全批不通过→403；`accepted_resources` 前缀/通配匹配；非 loopback 绑定强制要求 `allowed_source_cidrs`（IPv4 CIDR） |

### P2 既有通道能力补齐

| 通道 | 改动 |
| --- | --- |
| feishu | 入站图片/文件/语音/富文本 post/thread 真正落到 `NormalizedMessage`（`imagePaths` / `filePaths` / `voicePaths` / `threadId`）；wrapper 暴露 `setMessageReaction`（unicoded → Feishu `emoji_type` 映射）、`deleteMessage`（recall）；`permission_request` / `inline_keyboard` / `stream_end` 降级为文本而不是报 unsupported |
| discord | intents 补 `DIRECT_MESSAGES` + `MESSAGE_CONTENT` + `GUILDS`；真实 typing 端点；附件下载并按 MIME 归档；`editMessage` / `deleteMessage` / `setMessageReaction` / `removeMessageReaction`；`sendReply(text)` 支持 `editTargetMsgId`；media 的 http(s) 源先落地再上传（此前只发 caption，图片丢失）；DM allowlist 真正生效；`free_response_chats` 免除 mention |
| qq | 在 `dispatchMessage` 单点接入通用 gating（chatId 自带 `c2c:` / `group:` / `channel:` 作用域），群 `@` 视为已 mention |
| weixin | 实现 `require_mention`（opt-in，默认关闭——iLink bot 在普通群通常无法被 @，默认开启会静默吞掉群消息），支持 `mention_patterns` 与 `/` 旁路 |
| whatsapp | `disconnected` 后按指数退避重建 client（puppeteer 页面已死，必须 destroy + 重新 start）；实现 `stopTyping`（`clearState`） |

## 4. Phase 3（未做，接续必读）

通道要端到端可用（配置 → 启动 → 入站 → 出站），还差 Host/Desktop 侧。**这些点全部是硬编码平台枚举，新增的平台不会自动生效**：

| # | 位置 | 需要做的 |
| --- | --- | --- |
| 1 | `apps/desktop/src/main/gateway/message-bus.ts:1078-1226` | `getOrBuildInitConfig` 只构造 weixin/telegram/qq/feishu 四段（连 discord 都没有）；新平台不加分支永远不会被启动 |
| 2 | `apps/desktop/src/main/config/gateway-setting-adapter.ts`（`JSON_KEYS` / 读 / 写 / `GATEWAY_READ_KEYS` 四处） | 设置键 ↔ ConfigStore 映射 |
| 3 | `apps/desktop/src/main/config/schema.ts:465-519` | config.toml 默认 adapter 模板 |
| 4 | `apps/desktop/src/main/gateway/config-events.ts:60-75` | 设置变更热重载前缀（discord 前缀当前缺失） |
| 5 | `apps/desktop/src/main/services/network/bridge-tester.ts` | 「测试连接」分支 |
| 6 | `packages/ui/src/components/settings/BridgeSection.tsx`（`ChannelType` / `CHANNELS` / 面板 / `keyToChannel`）+ `ChannelIcon.tsx` + `i18n/{zh,en}.ts` | 设置 UI；建议改为从 `PLATFORM_DESCRIPTORS` 渲染，避免再次出现「UI 有表单但写不进配置」（whatsapp 就是这种状态） |
| 7 | `packages/agent-protocol/src/channels.ts:19,65` | bot-channel 体系的 `KNOWN_PLATFORMS` / `CONNECTOR_MANIFESTS`（与 gateway 的 11 平台不一致：有 slack，无 qq/whatsapp/signal…） |
| 8 | `apps/desktop/src/main/channels/connector-runtime.ts:291-348` | `buildConnector` switch（入站 connector） |
| 9 | `apps/desktop/src/main/channels/channel-delivery.ts:501-502,643-644` | `registerTransport`（出站 fallback） |
| 10 | `packages/cli/src/program/descriptors.ts:1192` | 命令描述里写死 "telegram / qq / feishu" |

另外两处已知但未处理的架构问题（不在本计划范围，避免范围蔓延）：

- `GatewayManager` 用 `Map<PlatformType, PlatformConfig>` 存配置（`gateway-manager.ts:191,228`），同一平台多账号会互相覆盖；
- 出站流式链路是死的：`handleOutboundEvent` 只接 `chat:text|chat:done|chat:error`，`streaming-strategy.ts` 全仓无 import。

## 5. 验证

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 基线（改动前） | `node node_modules/vitest/vitest.mjs run packages/gateway` | 9 files / 63 tests 全绿 |
| 改动后 | 同上 | 19 files / 177 tests 全绿（新增 10 files / 114 tests） |
| 类型 | `tsc -p packages/gateway/tsconfig.json --noEmit` | 0 error |
| 架构 | `npm run architecture:check` | no new boundary violations（3 条 baseline 指纹已不再触发，可择机 `--write` 收缩） |
| 影响面 | `grep -rn "PlatformType\|@duya/gateway"` 排除 gateway 自身 | 无外部消费点，`PlatformType` 扩枚举不波及 desktop/CLI |

新增测试重点（不是覆盖率的摆设）：

- `platform-capabilities.test.ts`：每个 `PlatformType` 必须有 descriptor 且必须有已注册的 adapter 工厂；声明 `typing / typing-stop / reaction / message-delete` 的平台，实例上必须真有对应方法（防止能力表写成宣传册）；
- `signature.test.ts`：篡改 body、错密钥、超窗重放、多签名轮换、非 ASCII token；
- `signal/format.test.ts`：`_` 词边界（`get_user_name` 不得变斜体）、astral 字符按 UTF-16 计数、分片后样式不丢；
- `webhook-server.test.ts`：原始字节直传（签名必须对原始 body 计算）、超限 413、handler 异常 500、close 幂等；
- `webhook/filters.test.ts`、`shared/gating.test.ts`、`msgraph/index.test.ts`（CIDR）、`whatsapp-cloud/message-utils.test.ts`（按钮 ≤3 / list >3 / 标题 20 字上限）。

> 说明：以上是「适配器层已实现 + 单测已验证」。**没有**做真实凭据的端到端冒烟（无 Meta/Signal daemon/BlueBubbles 环境），也没有过 Host 接线，因此不能宣称「已可用」。

## 6. 风险与踩坑

- **凭据与 webhook 暴露面**：`whatsapp_cloud` / `webhook` / `msgraph` 都绑端口，默认 `127.0.0.1`；对外必须走隧道，`msgraph` 非 loopback 绑定强制 CIDR 白名单。
- **WhatsApp 两条通道别混用**：`whatsapp`（Web/puppeteer，社区路径，扫码）与 `whatsapp_cloud`（官方 API，模板/24h 窗口限制）能力不同；Cloud API 没有 reaction、不能发群。
- **Signal 依赖外部 daemon**：一个手机号只能挂一个网关实例，daemon 不做多路复用；adapter 启动时 `listAccounts` 探活，失败即抛错而不是静默假运行。
- **QQ typing / inline keyboard 未实现**：能力表里已撤回这两项声明，不要为了对齐其它平台再声称支持。
- **`packages/gateway` 的 console 使用**：本包是子进程、没有注入 logger，新代码保持与既有适配器一致的 `console.warn/error`（仅在错误路径），不引入半套日志封装。
