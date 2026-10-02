# Plan 507 — Channel 附件收发（入站落盘 + 路径注入 / 出站真实上传）

> Status: Planning
> Parent: 488-bot-channel-integration（channel 机制）/ 489（SendMessage 卡族）
> Created: 2026-09-07

## 1. 问题

Bots 侧 channel 连接目前对多媒体/文件是"半支持"：

### 1.1 入站（外部平台 → bot）

媒体在适配器层已被下载，但**全部断在 envelope 映射层**，bot 既看不到内容也看不到路径：

| 层 | 现状 | 位置 |
| --- | --- | --- |
| Telegram bot connector | `TelegramUpdate` 只有 `text` 字段，photo/document/voice/video 消息**完全不可见** | `electron/channels/telegram-connector.ts:18-26` |
| Weixin connector | deep adapter 已下载到 `imagePaths/voicePaths/filePaths`，但 onMessage → envelope 只映射 `text`，附件丢弃 | `electron/channels/weixin-connector.ts:88-95` |
| Feishu connector | `onImageMessage/onFileMessage/onAudioMessage` 回调只给占位文本 `[image]`/`[file: name]`，不下载不传路径 | `electron/channels/feishu-connector.ts:104-112` |
| gateway profile-route 路径 | `forwardInbound` 把附件转 base64 塞进 `options.files`，但 message-bus `gateway:inbound` handler **不解构 options**，整体丢弃 | `packages/gateway/src/gateway-manager.ts:787-798`、`electron/gateway/message-bus.ts:497-571` |
| 类型层 | `ChannelInboundEnvelope` 无 attachments 字段 | `packages/agent/src/channels/types.ts:186-197` |
| 提示词层 | `[inbound]` wake prompt 纯文本，无附件行 | `packages/agent/src/channels/prompts.ts:104-122` |

### 1.2 出站（bot → 外部平台）

`SendMessage type:'attachment'` 在 channel 投递时全部降级为"文本+链接"：

- `channelOutboundToNormalizedReply`：attachment → `{ type:'text', caption+url }`，注释明说等待 multipart 通路 | `electron/channels/connector-runtime.ts:142-152`
- stateless transports（Discord/Slack/Telegram）只发文本/embed 链接 | `electron/channels/channel-delivery.ts:106-159, 342-377`
- **而 deep adapters 早已支持真实媒体发送**：`NormalizedReply` 有 `MediaReply { mediaType: photo|voice|video|document, filePath, caption }`（`packages/gateway/src/types.ts:129-141`），Feishu `sendReply` media 分支完整（`packages/gateway/src/adapters/feishu/index.ts:580-614`）、Weixin `sendMedia`（`weixin/index.ts:322-324`）、Telegram deep adapter `sendMedia`（`telegram/index.ts:414-420`）——只是从没人把 attachment 映射过去。

### 1.3 设计决策（已定）

- **不加 `file` 字段、不拆 file/image**。现有 schema 语义是消息形态而非文件类型：`text+images[]`=气泡内嵌图、`attachment+url`=独立文件消息。`attachment.url` 已接受 `file://`。真实上传由传输层按 MIME 自动分流，模型无需声明类型。
- 入站采用**落盘 + 路径注入**：附件持久化到稳定目录，wake prompt 里写明路径，bot 用 Read/Bash 工具处理（xlsx/pdf 表格也能处理）。不把 base64 塞进 LLM 请求（图片 data-url 注入留作后续 plan，非本期）。
- 出站 `file://` → 真实上传；`https://` → 维持链接文本（平台自行展开预览）。

## 2. 目标 / 非目标

**目标**
1. 入站：三平台（telegram/feishu/weixin）+ gateway route 路径的媒体/文件落盘到稳定路径，`[inbound]` prompt 注入 `[attachment saved to: <path>]`。
2. 出站：attachment `file://` 在 live adapter（feishu/weixin）与 stateless transport（telegram/discord）真实上传；slack 维持链接。
3. 单测覆盖 prompt 渲染 / 映射 / 下载 / 落盘。

**非目标**
- 入站图片作为 vision 输入注入 LLM（后续 plan）
- Slack multipart 上传（`files.getUploadURLExternal` 三段式，价值低——链接展开已可用）
- 附件保留策略 / 自动清理（v1 不清理，目录即审计日志）
- QQ 等其他平台

## 3. 存储

稳定目录（沿用 485 `agents/<id>/` 布局，weixin connector state 已有先例 `agents/<id>/gateway/weixin`）：

```
<userData>/agents/<ownerId>/attachments/inbound/<platform>/<yyyyMMdd_HHmmss_SSS>_<safeName>
```

- `ownerId`：grok-form = bot agentId；gateway route 路径 = session 的 agentProfileId，解析不到则用 sanitize(sessionId)。
- 新建 `electron/channels/attachment-store.ts`：
  - `persistInboundAttachment(ownerId, platform, src: { path } | { buffer }, name): Promise<{ path, name, mimeType, size }>`
  - 原子写（tmp+rename，同 channel-store 惯例），文件名 sanitize，MIME 用 `EXT_MIME_MAP`（`packages/gateway/src/utils/mime.ts`，electron 侧已可 import gateway 源码——connector-runtime.ts:144 已有先例）。
- 尺寸上限沿用 `attachment-builder.ts` 常量：image 10MB / doc 20MB / audio-video 25MB；超限跳过并在 prompt 注入 `[attachment skipped: too large]`。

## 4. 类型（`packages/agent/src/channels/types.ts`）

```typescript
export interface ChannelInboundAttachment {
  readonly name: string;        // 原始文件名
  readonly path: string;        // 稳定落盘路径（绝对路径）
  readonly mimeType: string;
  readonly size: number;
  readonly kind: 'image' | 'audio' | 'video' | 'document';
}

export interface ChannelInboundEnvelope {
  // ...现有字段不动
  readonly attachments?: readonly ChannelInboundAttachment[];
}
```

`ChannelOutboundMessage` 不改（`url` 已承载 `file://`）。

## 5. Phase 1 — 类型 + 存储（P1）

- [x] **P1.1** `packages/agent/src/channels/types.ts`：新增 `ChannelInboundAttachment` + envelope `attachments` 字段。
- [x] **P1.2** `electron/channels/attachment-store.ts`：`persistInboundAttachment` + sanitize + 原子写 + 单测（`electron/channels/__tests__/attachment-store.test.ts`）。

## 6. Phase 2 — 入站透传（P1）

- [x] **P2.1 提示词渲染**：`packages/agent/src/channels/prompts.ts` `formatInboundEnvelope` 增加 attachment 行：
  ```
  On telegram, from telegram:12345: alice: 看下这个表
    [attachment saved to: <path> (report.xlsx, application/vnd.openxmlformats-...sheet, 12.3 KB)]
  ```
  附件行计入 `MAX_INBOUND_TEXT_CHARS` 预算；同步更新 `packages/agent/src/prompts/bot/channels.ts` 的 bot 提示词文档（告诉 bot 可以直接 Read 该路径）。单测：prompts 渲染各 kind/超限截断。
- [x] **P2.2 message-bus 透传**：`gateway-manager.ts` `forwardInbound` 增设 `options.attachments = [{ name, path }]`（直接携带适配器已下载的缓存路径，不再只有 base64）；`electron/gateway/message-bus.ts` `gateway:inbound` handler 读取 `options.attachments` → `persistInboundAttachment` 复制到稳定目录 → 写入 envelope。`options.files` 保留不动（兼容）。
- [x] **P2.3 weixin connector**：`weixin-connector.ts` onMessage 把 `msg.imagePaths/filePaths/voicePaths/videoPaths` 映射为 attachments（先 persist 再入 envelope）。
- [x] **P2.4 feishu connector**：扩展 `FeishuAdapterOptions` 媒体回调携带本地下载路径（`onImageMessage`/`onFileMessage`/`onAudioMessage` 加 `localPath` 参数；FeishuChannel 内部 `downloadMessageResource` 下载并落盘）；connector 映射进 envelope。
- [x] **P2.5 telegram bot connector**：`telegram-connector.ts` `TelegramUpdate` 补 `photo/document/video/voice/audio/sticker` 字段；下载走 `getFile` + 文件下载（注入 fetch）；bot 路径不设扩展名白名单，仅尺寸上限（20MB）；`.md/.txt` 以附件落盘、不注入文本；落盘后进 envelope。单测：fetchFn 注入模拟 getFile/下载。

## 7. Phase 3 — 出站真实上传（P1）

- [x] **P3.1 MediaReply 映射**：`connector-runtime.ts` `channelOutboundToNormalizedReply`：
  - `attachment` + `url` 为 `file://` → `MediaReply { mediaType: ext/MIME 推断（image→photo, audio→voice, video→video, else document）, filePath, caption }`
  - `https://` → 维持现有文本链接降级
  - live 路径（feishu/weixin）到此即通：两者 `sendReply` media 分支已实现。
- [x] **P3.2 telegram transport multipart**：`channel-delivery.ts` 增加轻量 multipart helper（boundary + Buffer 拼接，http.request）；`TelegramTransport.send` attachment 分支：`file://` → `sendPhoto`（image/*）/ `sendDocument`（其余）/ `sendVideo`（video/*）/ `sendAudio`（audio/*），带 caption；失败抛错走既有 `queueChannelDeliveryFailure` 重试唤醒链。
- [x] **P3.3 discord transport multipart**：attachment `file://` → `POST /channels/{id}/messages` multipart（`files[0]` + `payload_json` 含 caption）；失败同样走失败队列。
- [x] **P3.4 文档面**：`SendMessageTool` `SEND_MESSAGE_DESCRIPTION` 补一句：channel 投递时 `file://` 附件会上传真实文件。schema/TYPE_FIELDS 校验零改动。

## 8. Phase 4 — 验证（P1）

- [x] **V1** `npm run typecheck:all`。
- [x] **V2** 单测：attachment-store / prompts 渲染 / connector-runtime 映射 / telegram-connector 媒体下载（61 通过）。
- [ ] **V3** 真机冒烟（Telegram bot）：发 xlsx + 图片 → 确认稳定路径落盘、`[inbound]` prompt 含路径、bot 能 Read 处理；bot `SendMessage attachment file://` → 平台收到真实文件（photo 气泡 / document 气泡）。
- [ ] **V4** feishu/weixin live 路径冒烟：发文件、收文件各一轮。
- [x] **V5** ARCHITECTURE.md channel 一节补附件收发数据流。

## 9. 风险

- Feishu 媒体回调扩展需动 deep adapter 接口面（`FeishuAdapterOptions`），确认 `packages/gateway` 其他消费者（gateway-manager 路径）不受签名变化影响——回调加参向后兼容。
- `gateway:inbound` 的 `options.attachments` 与既有 `options.files` 并存期：前者为 path 语义（wake 路径），后者 base64（暂无人消费），后续 plan 收敛。
- Telegram 公网 Bot API 下载上限 20MB（本地 Bot API server 可到 2GB），沿用 `allowsLargeFiles` 判断。
