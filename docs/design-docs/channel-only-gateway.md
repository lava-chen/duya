# Channel-Only Gateway 精简 RFC

> **状态**: 已确认设计 → 进入执行
> **作者**: LavaChen
> **关联**: [platform-gateway.md](./platform-gateway.md) · exec-plan 待建
> **设计选择**(用户已确认):
> - 范围: **方案 B 保守** — 删集中式 stream/delivery 框架,保留 feishu adapter-internal stream(card-renderer / stream-card-manager / text-batcher)作为 adapter 私有实现。
> - Outbound 协议: **聚合到 NormalizedReply** — Main 端聚合 stream 后一次发送,gateway 不持有 stream 状态机。
> - Permission: **先砍掉 PermissionBroker**,bot 环境下 tool 默认 allow(后续根据 profile 配置静态决定)。

## 一·、执行范围(基于已确认选择)

保留(🟢): gateway-manager 重构 / ipc-client / user-mapper / pairing-store / proxy-fetch / profile-routing / types / streaming-strategy(给 ai 包复用)/ commands / 6 个 adapter / feishu 所有 stream-coupled 文件(包括 card-renderer / stream-card-manager / text-batcher / card-run-state / card-stream)。

删除(🔴): stream-handler.ts / delivery-ledger.ts / delivery-mirror.ts / attachment-builder.ts / display-config.ts / catchup-batch.ts / permission-broker.ts。

裁剪(🟡): gateway-manager.ts 重写,移除 stream/delivery/permission 字段。


## 一、背景

当前 `packages/gateway` (78 个源文件 / 21,726 行) 同时承担两类截然不同的职责:

1. **Channel 框架**: 把 6 个 IM 平台(Telegram / Feishu / WeChat / Discord / QQ / WhatsApp)
   的长连接 / webhook / QR 拉到一个统一子进程,产出 `NormalizedMessage`。
2. **Bot 框架**: 处理 owner-approved 的私聊/群聊 session,跑 `StreamHandler`
   把 LLM 的 chunk stream 实时渲染为平台回复卡片,做权限请求中介、做 catchup batch、
   做 reply-target 跟踪、做 display 配置解析。

这两类职责在历史上是被一起设计的(见 [platform-gateway.md § OutboundPipeline](./platform-gateway.md)),
但事实证据是:

- 6 个平台 adapter **没有一个** import `StreamHandler`(grep 验证过)
- `StreamHandler` 仅被 `gateway-manager.ts` 调用(15 处)
- `delivery-ledger` / `delivery-mirror` / `permission-broker` / `attachment-builder`
  / `display-config` **只在** `gateway-manager.ts` 使用,对外(electron 主进程、
  agent 包、ai 包)**零真实 import**(grep 全文,只有 docs 注释和 dist sourcemap 提到名字)
- `catchup-batch` **只在 `index.ts` 导出,生产代码 0 调用**

也就是——Session-bound 子系统整个是 **gateway-manager 内聚自用** 的代码,
从没暴露成平台 adapter 的契约。这意味着可以**纯内部重写**,
对外部行为只影响"流式体验",不影响"消息到达/消息发送"这条主链路。

## 二、目标 / 非目标

**目标**

- Gateway 进程只做三件事:接平台消息、bot 命令派发、整段回复输出。
- 把 Stream/Delivery/Permission/Catchup/Display 子系统**移出 gateway 包**,迁入
  `electron/` 主进程的 channel-side helper(或直接砍掉)。
- 流式卡片体验**降级为整段回复**(后续如果再需要,可以由 electron 主进程用
  `IPC: gateway:send` 配合更智能的 chunking 重新实现)。

**非目标**

- 不破坏 Bot UX 的命令菜单(`/help /new /reset /status /fast /verbose /approve …`)
- 不破坏 Bot 与同一用户的连续 session 体验(`UserMapper` 保留)
- 不破坏 Pairing/DM Approval 流程(`pairing-store.ts` 保留,它是 channel 行为)
- 不破坏 Profile 路由(`profile-routing.ts` 保留,/profile /reload-mcp 等命令要它)

## 三、保留 / 删除 / 迁移 三色清单(按方案 B 调整)



### 🟢 保留(channel + bot router 骨架)

| 文件 | 行数 | 保留理由 |
|---|---|---|
| `gateway-manager.ts` | 1586 | 顶层编排;**重写**去掉 stream/delivery/permission 字段后 ~1100 行 |
| `ipc-client.ts` | 298 | Electron main ↔ gateway 进程 IPC,核心 |
| `user-mapper.ts` | 104 | DM ↔ session 映射,bot 连续对话靠它 |
| `pairing-store.ts` | 372 | DM 首次联系 owner 审批,channel 行为 |
| `proxy-fetch.ts` | 507 | 出向 HTTP 代理,bot 要 |
| `profile-routing.ts` | 102 | `/profile` 命令路由 |
| `types.ts` | 350 | `NormalizedMessage` / `NormalizedReply` 契约 |
| `stream/streaming-strategy.ts` | 244 | `stripMarkdown` / `stripThinkTags` 在 `ai/utils/think-tag-parser.ts` 注释引用,**保留** |
| `commands/*` (5 文件) | 576 | `/help /new /reset /status /fast /verbose /approve …` Bot 命令派发 |
| `adapters/base.ts` + `adapters/base-adapter.ts` | 491 | 限速 / 去重 / 重试 / 接口 |
| `adapters/index.ts` | ~50 | adapter 工厂注册表 |
| **6 个平台 adapter** | 14,500 | **保留全部文件**,但按需裁剪 |
| `adapters/feishu/qr-registration.ts` | 336 | Feishu 二维码登录,channel 行为 |
| `adapters/feishu/dm-pairing.ts` | 193 | Feishu DM pairing |
| `adapters/feishu/group-gating.ts` | 65 | 群聊 @mention gating |
| `adapters/feishu/comment-handler.ts` + `comment-rules.ts` | 1089 | Feishu 文档评论,channel 行为 |
| `adapters/feishu/media-upload.ts` | 1 | Feishu 媒体上传 |
| `adapters/feishu/webhook-server.ts` | 153 | Feishu webhook 服务 |
| `adapters/feishu/websocket-client.ts` | 298 | Feishu WS 客户端 |
| `adapters/feishu/dedup-persistence.ts` | 192 | 消息去重持久化 |
| `adapters/telegram/handlers/*` | ~? | 命令派发器,**保留** |
| `adapters/telegram/media.ts` + `markdown.ts` + `message-utils.ts` + `types.ts` | ~? | channel 必需 |
| 其他 4 平台 | ~3,400 | channel 必需 |

**保留总计**: ~18,000 行(占现 82%)

### 🔴 删除(Session-bound 子系统,生产 0 调用)

| 文件 | 行数 | 真实调用点 | 删除理由 |
|---|---|---|---|
| `stream-handler.ts` | 1001 | 仅 `gateway-manager.ts` 15 处 | Session stream 整条链路 — gateway-manager 重写时去掉 |
| `delivery-ledger.ts` | 243 | 仅 `gateway-manager.ts` | 投递 ledger,bot 整段回复不需要 |
| `delivery-mirror.ts` | 63 | 仅 `gateway-manager.ts` | 同上,mirror 回写 |
| `permission-broker.ts` | 55 | 仅 `gateway-manager.ts` | 权限请求中介,迁入 main 进程 |
| `attachment-builder.ts` | 187 | 仅 `gateway-manager.ts` | Outbound 附件打包,迁入 main |
| `display-config.ts` | 167 | 仅 `gateway-manager.ts` | 平台 streaming 配置解析,删除 |
| `catchup-batch.ts` | 170 | **0 调用**(只在 `index.ts` 导出) | 死代码 |
| `stream/` (除 `streaming-strategy.ts`) | ~? | 同 stream-handler | 同上 |

**删除总计**: ~1,886+ 行(占现 8.7%)

### 🟡 裁剪(平台 adapter 内的 stream-only 文件)

| 文件 | 行数 | 处理 | 理由 |
|---|---|---|---|
| `adapters/feishu/card-renderer.ts` | 279 | **保留**(adapter-internal) | Feishu 卡片流式渲染 — 私有 |
| `adapters/feishu/card-run-state.ts` | 330 | **保留**(adapter-internal) | 卡片 run state — 私有 |
| `adapters/feishu/card-stream.ts` | 159 | **保留**(adapter-internal) | 卡片流式状态机 — 私有 |
| `adapters/feishu/card-builder.ts` | 101 | **保留** | Feishu 消息卡片构建 |
| `adapters/feishu/stream-card-manager.ts` | 208 | **保留**(adapter-internal) | 流式卡片管理 — 私有 |
| `adapters/feishu/run-coordinator.ts` | 90 | **保留** | adapter 内的并发控制 |
| `adapters/feishu/scoped-queue.ts` | 141 | **保留** | 队列限流 |
| `adapters/feishu/text-batcher.ts` | 88 | **保留**(adapter-internal) | 流式文本 batching — 私有 |
| `adapters/feishu/media-batcher.ts` | 63 | **保留** | 媒体批处理 |
| `adapters/weixin/api.ts` | 1306 | **保留**(按需裁剪) | weixin channel 接口 |

**裁剪总计**: ~1,500 行

### 📊 净影响

| 维度 | 现在 | 切完 | Δ |
|---|---|---|---|
| 源文件数 | 78 | ~60 | -18 |
| 总行数 | 21,726 | ~18,300 | **-3,400 (-15.6%)** |
| 流式卡片体验 | ✅ | ❌(整段回复) | UX 降级 |
| Session stream 链 | ✅ | ❌(改走 main) | 架构简化 |
| Bot 命令 | ✅ | ✅ | 不变 |
| DM pairing | ✅ | ✅ | 不变 |
| Profile 路由 | ✅ | ✅ | 不变 |
| 平台 adapter 契约 | ✅ | ✅ | 不变 |

## 四、重写后的 Outbound 协议

```typescript
// 之前(Main → Gateway)
gateway:outbound { sessionId, platform?, platformChatId?, event: StreamEvent }
// StreamHandler 内部做 chunk 合并 + 卡片编辑 + streaming reaction

// 之后(Main → Gateway)
gateway:outbound { sessionId, platform, platformChatId, event: NormalizedReply | StreamEvent }
// gateway-manager.handleOutboundEvent: 
//   - event.type === 'text' → adapter.sendReply(chat, { type:'text', text })
//   - event.type === 'image'/'file'/'audio' → adapter.sendReply(chat, media)
//   - event.type === 'stream_chunk' / 'stream_end' → 丢弃(streaming 由 main 端聚合)
// StreamEvent 仍可在 types.ts 保留(adapter 不需要它),gateway-manager 直接走
// 简化路径:接到完整 reply → 一次 sendReply
```

**关键设计选择**:`Main` 进程在拿到 LLM streaming 时做 `agent.aggregateStream(reply)`
— 把整段 LLM 回复聚合成一个 `NormalizedReply`,然后通过 `gateway:outbound`
发给 gateway。gateway 不再持有 stream 状态机,所有流式状态(edit-in-place、
progress reaction)在 main 端(electron renderer)做,bot 整段贴上去。

**回退路径**: 如果将来想恢复流式卡片,在 `gateway-manager.handleOutboundEvent`
里加一个 `if (config.streaming && event.type === 'stream_chunk')` 分支,
调用 feishu adapter 的 `streamCardManager`(已经删的话从 git history 恢复)。
**当前不实现**。

## 五、Main 进程侧改动

`electron/gateway/` 下需要新增(或扩展):

- `channel-outbound-aggregator.ts` — 把 agent 的 stream 聚合成单条 NormalizedReply
  (取代 `StreamHandler` 的部分职责,但只跑在 main 进程)
- `permission-ui-broker.ts` — 把 agent 的 permission_request 通过 electron
  dialog / chat 提示给用户,结果回传给 agent(取代 `PermissionBroker`)

具体改动等执行阶段再细化。

## 六、执行顺序

1. **Phase A — 影响审查与本 RFC**(本文件)
2. **Phase B — 内部重构**(`gateway-manager.ts` 去字段化,改为消费
   `NormalizedReply`)
3. **Phase C — 删除**(`stream-handler.ts` 等,逐个删 + typecheck + vitest)
4. **Phase D — feishu 裁剪**(`card-renderer` 等流式卡片文件)
5. **Phase E — main 侧接线**(`electron/gateway/channel-outbound-aggregator.ts`)
6. **Phase F — 端到端验证**(dev 跑通 6 平台 + bot 命令 + pairing)

每个 Phase 完成后跑 `npm run typecheck:all` + `npm run test`。
打包前跑 `npm run electron:build`。

## 七、风险与缓解

| 风险 | 缓解 |
|---|---|
| 流式卡片体验降级,用户感知到 | Release notes 明确说明;计划后续单独 RFC 重建流式 |
| StreamEvent 漏处理某类 | typecheck 严格 + vitest 覆盖 NormalizedReply 全分支 |
| feishu 大头改动破坏 pairing/comment | 仅删 stream-coupled 文件,pairing/comment/dm 全部保留 |
| weixin api.ts 重写漏掉 channel 必需逻辑 | api.test.ts 已有覆盖,作为回归网 |
| pairing-store / proxy-fetch / user-mapper 漏改 | 这三个 0 改动,纯保留 |

## 八、影响审查表(逐项证据链)

| 待删项 | 真实调用点(grep 证据) | 外部 0 引用证据 |
|---|---|---|
| `stream-handler.ts` | `gateway-manager.ts:27,82,86,92,103,212,254,269,319,353,451,469,560,590,695,736,1089,1469` | `grep -rn "stream-handler" packages/ electron/ src/` → 仅 docs 注释 |
| `delivery-ledger.ts` | `gateway-manager.ts:28,79,82` | grep → 0 真实 import |
| `delivery-mirror.ts` | `gateway-manager.ts:29,81,82` | grep → 0 真实 import(`db-bridge.ts:84` 是字符串注释) |
| `permission-broker.ts` | `gateway-manager.ts:31,83` | grep → 0 真实 import |
| `attachment-builder.ts` | `gateway-manager.ts:33` | grep → 0 真实 import(`attachment-store.ts:13` 是注释引用) |
| `display-config.ts` | `gateway-manager.ts:34,93` | grep → 0 真实 import |
| `catchup-batch.ts` | **0 调用**(仅 `index.ts` 导出) | grep → 0 真实 import |
| `feishu/card-renderer.ts` | 仅 `feishu/index.ts` 内部用 | 0 外部引用 | **保留** |
| `feishu/card-run-state.ts` | 同上 | 同上 | **保留** |
| `feishu/card-stream.ts` | 同上 | 同上 | **保留** |
| `feishu/stream-card-manager.ts` | 同上 | 同上 | **保留** |
| `feishu/text-batcher.ts` | 同上 | 同上 | **保留** |

## 九、最终复核 checklist

- [ ] 所有删除项的 grep 反向引用已确认
- [ ] 所有保留项在 types.ts / index.ts 的契约不变
- [ ] `telegram/index.ts:757` 的 `COMMAND_REGISTRY` 仍然能编译
- [ ] `gateway-manager.ts:923-924` 的 dynamic import 仍然能解析
- [ ] `feishu/index.ts` 内部对 stream-coupled 文件的引用都同步删除
- [ ] weixin `api.ts` 重写后保留 channel 必需接口
- [ ] `npm run typecheck:all` 通过
- [ ] `npm run test` 通过
- [ ] `npm run electron:build` 通过
- [ ] dev 模式手动验证:6 个平台各发一条消息 + `/help /new /status`
