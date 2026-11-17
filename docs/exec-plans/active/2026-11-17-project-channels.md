# Project Channel：独立 Discord 身份与受限 send_message

状态：active，A 已实现合同与存储，B/C/D/E 未开工 · 负责人：用户分派，集成 owner 待指定 · 更新：2026-11-17。
设计检出：`claude/lucid-mestorf-72bac0`，worktree `.claude/worktrees/lucid-mestorf-72bac0`；代码基线：`5e5256decc4a915872add152b122a97ad71e55c1`；设计 owner：本会话。
A 实施检出：`codex/project-channels-protocol-store`，worktree `.claude/worktrees/project-channels-a`；base：`5e5256decc4a915872add152b122a97ad71e55c1`；独占路径：`packages/agent-protocol/src/project-channels.ts` 与协议 exports、`packages/data/src/project-channel-store.ts`、迁移 69 装配、`packages/data/tests/project-channel-store.test.ts`；未合并。

本计划供其他 agent 实施。用户已选择“独立项目身份”，并要求本会话只设计实现步骤、不代为启动实施 agent。接口名、路由和命令在下文标为**拟新增合同**，不代表基线已具备。

关联：[Coordinator 总计划](2026-11-02-project-coordinator.md) · [首版合同](../../design-docs/project-coordinator-contract.md) · [Project-first 决策](../../design-docs/project-first-architecture.md) · [Gateway 能力补全](623-gateway-channel-capability-parity.md)。不接手 Gateway 旧计划的全部后续任务。

## 1. 目标与边界

用户为一个 Project 配置一个真实 Discord Bot，将其邀请到服务器，并授权具体频道和成员；频道内原生 `@该负责人` 后，消息进入该 Project 当前的 Coordinator，负责人查询真实状态或进行既有项目协调，再显式回复原频道。用户也能在本地 TUI 要求负责人通过 `send_message` 向已授权的频道主动发送。

冻结的产品选择：

- 一项目一独立 Discord Bot 身份，首版一条活动连接；同一连接可绑定多个频道。两个项目可以在同一频道出现，必须只由被原生提及的 Bot 对应的 Coordinator 接收。
- Discord Bot 只是 Project 的外部身份，不创建 Personal Bot、不伪造 `botId`、不创建平行 Coordinator 或执行引擎。
- 绑定指向稳定 `projectId`；Coordinator 替换后继续指向该项目。`sessionId` 只是一次已受理输入的执行目标。
- 首版仅 Discord 服务器文本频道、原生 Bot mention、文本收发。禁用 DM、角色 mention、模糊名称匹配、无 mention 自由响应、附件、编辑/删除消息同步及自动 thread 继承；thread 必须独立绑定，否则拒绝。
- 已授权成员可查询项目并提交普通协调请求；绑定意味着允许这些成员获取该项目的信息，不等于平台上所有成员获得权限。群消息不能配置连接、绑定频道、接管 Session、回答工具审批、验收 Task、合并或发布。
- 原有 Task/Session/Run/记忆仍是各自权威。频道不复制第二套项目状态，也不因一句“完成了”改变 Task acceptance。
- 本轮不做其他 IM、cron/PR/CI 外部订阅、Coordinator-to-Coordinator 通信、Personal Bot 删除、完整 Desktop 设置页或自动创建 Discord Application。

### 实施后的最小操作路径（拟新增 CLI）

1. 用户在 Discord Developer Portal 自行创建 Application/Bot，按所需权限邀请进入服务器；实现文档列出必需 intents 和 Send/View/Read History 权限，不索要 Administrator。
2. 在本机使用 `duya project channel connect --project <id> --token-env <变量名>` 或 `--token-stdin` 保存连接。禁止提供明文 `--token` 参数；示例不写真实凭据，也不要求把凭据贴进聊天。
3. 使用 `duya project channel bind --project <id> --guild <id> --channel <id> --allow-user <id>` 绑定频道；`--allow-user` 可重复，空集合拒绝。`--allow-proactive` 显式开启主动发送，默认关闭。
4. `duya project channel list/status/unbind/disconnect` 查看或撤销；普通 `duya project` 仍进入原 TUI，裸 `duya` / `duya tui` 不改变。
5. 在前台常驻 `duya serve` 提供后台接收；退出 TUI 不停止这个 Host。首版不承诺安装 OS daemon，不静默把 client-scoped Host 变成永久服务。

命令由已运行 Host 执行，不绕回旧 Desktop-only `/v1/channels`。若当前为 client-scoped Host，连接配置可保存，但 CLI 必须明确提示常驻接收需要非 client-scoped Host；不得显示虚假的“永久在线”。

## 2. 已核对的实现接缝

以下是基线源码事实，不是实现完成证明：

| 接缝 | 当前事实 | 实施约束 |
| --- | --- | --- |
| `packages/gateway/src/adapters/discord/index.ts` / `gating.ts` | 已有 WebSocket、mention 检查和发送；仅过滤本 Bot 的回声；去重主要在内存；规范化消息未携带全部 connection/guild/mention 事实 | 复用适配器，补结构化来源、忽略所有 Bot/webhook 回声和持久边界；不能只换 profile |
| `packages/gateway/src/gateway-manager.ts` | adapters/configs 按 `PlatformType` 索引 | 新项目连接必须按 `connectionId` 隔离；忙碌、去重、重连、发送等也不能继续只按 platform/chat 索引 |
| `apps/desktop/src/main/gateway/message-bus.ts` | 默认按 platform/chat 创建 `gw-*` 普通 Session | Project 消息走新 Host 领域入口；不得落到该默认创建路径 |
| `packages/host/src/local-host.ts` | 现有 channelDelivery 依赖 botDispatcher、bot inbox 和 `bot:<id>`；HTTP Session input 的 actor 固定是 local user | 新增 Project 分支，从 Host 校验身份；不能拿本地用户 HTTP 输入入口冒充外部成员 |
| `packages/host/src/session-input-api.ts` / `packages/data/src/session-inputs.ts` | 有输入 receipt 和控制 lease，但 input receipt 不保存消息正文；standalone enqueue 当前直接尝试 Run 准入，不是完整持久忙碌队列 | C/E 必须补正文载体、串行 drain、恢复和身份绑定，不能把调用现有 enqueue 后返回“已排队”当实现 |
| `packages/host/src/local-host.ts` 的 project settlement | 已持久回流到 mailbox；standalone 没有 renderer idle dispatcher，通常下一轮才消费 | 若要无人值守完成后通知，需要 Host drain 选取已有持久义务；不能依赖 TUI 打开或虚构已有自动唤醒 |
| `packages/host/src/project/identity.ts` | Coordinator 白名单为 `session`、`project` | 增受限 `send_message`，不把旧全功能 Bot 消息能力整体授予 |
| `packages/capabilities/src/SendMessageTool/` 与 Host send-message hooks | 有 channel 发送，但描述/部分 hook 假定 SendMessage 是 Bot 唯一声音 | Coordinator 采用独立工具投影与来源感知的 delivery policy，不能让 TUI 正常回答消失 |
| `apps/desktop/src/main/channels/connector-secret-store.ts` | 凭据与 agent 路径绑定，是本地文件存储，不是现成的 Project/独立 Host secret service | 复用安全原则，不借假 agentId 读取；不得声称已有加密/跨平台 keychain |
| `architecture-policy.yaml` | Host 为 managed 模块，未允许 Host → legacy-gateway；Gateway 未声明协议依赖 | Host 仅依赖中立 transport port；真实 Gateway 装配放 CLI/Desktop，必要依赖由 E 显式声明和评估，禁止加 baseline 掩盖 |

当前检出无 `.codegraph/`；按文件直接核对，未使用其他检出的索引。Workspace context/activity 工具不可用，以 Git 和版本化计划对账。

## 3. 拟新增合同：A 先落地，其他 agent 不各自发明 DTO

### 3.1 身份与持久对象

协议放 `packages/agent-protocol/src/project-channels.ts`，存储实现放 `packages/data/src/project-channel-store.ts`，通过各包既有 exports 暴露。下列是最小字段和不变量；A 可用内部结构规范化，但不能改变语义。

| 对象 | 最小内容 | 约束 |
| --- | --- | --- |
| Connection | connectionId、projectId、platform=`discord`、平台核验的 botUserId、label、enabled、revision、credentialConfigured | 不含 token、secret 文件路径；一个 Project 一条活动 Discord 连接，同一 botUserId 不得同时代表不同 Project |
| Binding | bindingId、projectId、connectionId、guildId、channelId、allowedUserIds、allowProactive、enabled、revision、label | server/channel 归属由平台核验；绑定 ID 由 Host 铸造；用户列表非空，默认不允许主动发送 |
| Inbound event | inboundId、connectionId/generation、bindingId/revision、平台 messageId、guild/channel、senderId、mention IDs、text、receivedAt、正文指纹、已受理 inputId/目标 sessionId 等关联 | 稳定去重键至少 connectionId + messageId；同键不同正文拒绝；这是外部事件与受理证据，不复制 Session/Run 状态机 |
| Delivery | deliveryId、projectId、bindingId/revision、connectionId/revision、发送 Session/Run/epoch、requestId、正文指纹、可选 replyToInboundId、平台 receipt、状态/原因 | 同 Project/requestId 幂等；状态为 queued/sending/sent/failed/unknown/cancelled，不把 queued 当 sent |
| Runtime observation | connectionId、观察到的 botUserId、connected/disconnected/error、observedAt、安全 errorCode | 与持久 enabled/configured 分离；DB 有配置不等于连接在线 |

关系删除/撤销保留审计，不级联抹掉已发送证据。迁移只由 A 分配编号；本基线最后相关迁移为 68，实施时重查，不把 69 当跨分支永久预留。存储事务、CAS 和唯一索引测试必须使用真实 SQLite。

### 3.2 控制面和模型面分离

拟新增 `HostProjectChannelApiV1`，作为独立可选 Host API，不把所有旧 `HostProjectApiV1` mock 一次性改成必填。输入拒绝未知字段，配置/绑定的写操作带 requestId 和 expectedRevision；创建使用稳定请求键。凭据字段只出现在认证后的写入请求中，不进入输出 DTO。

| HTTP 路由（拟新增） | 语义 |
| --- | --- |
| `GET /v1/projects/:projectId/channels` | 连接公开配置、bindings、运行观察；分页返回近期投递记录，不返回正文全集或秘密 |
| `PUT /v1/projects/:projectId/channels/discord` | 本地用户配置/轮换凭据；返回经平台核验的身份与配置 revision |
| `POST /v1/projects/:projectId/channels/bindings` | 创建绑定并核验 guild/channel；空 allowlist、跨连接/项目等明确拒绝 |
| `PATCH /v1/projects/:projectId/channels/bindings/:bindingId` | CAS 更新 allowlist、allowProactive、enabled、label |
| `DELETE /v1/projects/:projectId/channels/bindings/:bindingId` | requestId + expectedRevision，幂等撤销；不是删除审计记录 |
| `POST /v1/projects/:projectId/channels/discord/disconnect` | CAS 停用连接、停止接收/新投递，保留审计；不声称远端已撤销 token |
| `GET /v1/projects/:projectId/channels/deliveries/:deliveryId` | 查询真实投递 receipt，不触发重复发送 |

配置 API 仅认证本地控制面可达，不注册成模型工具。外部入站是 trusted transport 的内部回调，不新增一个可随便 POST senderId/projectId 的公开 webhook 或 bearer-user 输入路径。

Coordinator 模型投影冻结为：

```typescript
// Proposed model input; identity is derived by the Host.
send_message({
  requestId: string,
  channelBindingId: string,
  text: string,
  replyToInboundId?: string,
})
```

- 只有一个 canonical `send_message` 名称；Coordinator 用窄 schema/description，既有 Bot 的 schema 保持兼容，不能在同一 registry 注册两个同名工具。
- `project` 工具新增 `list_channels` 动作，返回已授权 bindingId、显示名和可回复/主动发送权限，不返回秘密或让模型猜 Discord ID。
- 参数不得含 actor、projectId、sessionId、runId、epoch、原始 Discord 目标 ID 或 credential。Host 以活跃 caller、当前 Coordinator 绑定和 binding 归属裁决。
- 使用 replyToInboundId 时必须对应本 Project、本 binding 的真实入站事件，并要求当前 Run 有该事件的回复范围；伪造或旧事件引用不能借此绕过 allowProactive。
- 无 replyToInboundId 的发送要求 binding.allowProactive=true，并受同样的 Project/Run 权限检查。工作 Session 默认不获发送权限。
- 工具返回 deliveryId 与 queued/sent/failed/unknown 等真实状态；实际发送前再次校验连接、binding revision 和撤销状态。

### 3.3 中立 transport port

A 定义中立类型；B 实现 Gateway 侧工厂；C 仅依赖端口；E 装配。端口至少提供：

- 按 connectionId 启动、停止和查询运行观察，启动携带 Host 解析的 token 和运行 generation；token 只进入受信 transport，不进 Worker。
- `verifyIdentity` 和 `inspectChannel`，核验真实 Bot 用户及 guild/channel，而非信任配置里的 botUserId。
- 结构化入站回调包含 connectionId/generation、messageId、guildId、channelId、senderId、authorIsBot/webhook、原生 mention IDs、text 和 observedAt。
- 文本发送包含 deliveryId、connectionId、guild/channel、可选原消息 reply 引用，返回平台 messageId 或可分类错误。适配器不得伪造持久投递状态。
- 停用旧 generation 后，其迟到回调、重连和响应不能污染新配置。

Host 不能 import Gateway；也不把 token-bearing transport 端口暴露给 Worker DB bridge。B 可以给旧 GatewayManager 保留兼容 facade，不要求一次迁移所有旧平台。

## 4. 必须实现的行为链

### 4.1 入站、排队与恢复

1. Gateway 按连接持有 DiscordAdapter，过滤 Bot/webhook、自身回声、非原生提及、DM 和未配置目标；首版不下载附件。Discord 命令不能因旧 `checkMention` 的 slash 特例绕过 Project mention/授权策略。
2. Host 从受信连接回调得到来源，复核 connection generation、enabled、binding、真实 guild/channel、sender allowlist 和对本 Bot 的 mention。空配置 fail closed，不能沿用旧适配器“空 allowlist 即开放”的行为。
3. 事务持久化入站正文及去重记录，再给 transport 受理结果；重复事件不创建第二条执行义务。同一消息 ID 不同内容明确冲突，不能覆盖已受理正文。
4. 在准备执行时解析 Project 当前 Coordinator，使用已有 ensure 语义；复用 Session input receipt、控制 lease、Host Run admission 和现有持久正文载体。actor 由 Host 绑定为 channel 来源，不调用 actor=local user 的公开 HTTP input 服务冒充用户。
5. 忙碌时持久排队，按 Session 串行 drain，不能在内存数组中等待；首版不把群消息自动 steer/interrupt 到正在进行的本地用户回合，以免混淆回复目标和权限。
6. 队列在 boot、连接恢复、Session idle/Run settle 时推进。尊重本地控制 lease；等待/拒绝必须有 receipt 和原因，不绕过 lease。C 与 E 只能补齐一个共享输入交付服务，不新建 Project 专用 Run 启动器。
7. “受理成功但启动结果丢失”依据原 input/admission/Run 事实对账；无法确定则 recovery_required/unknown，不能盲目重新 start。Coordinator 替换时，尚未提交的事件可重解析；已提交/启动的事件先对账旧目标，不直接再发给新 Session。
8. Run 上下文携带 Host 生成的来源与回复范围，消息正文仍是不可信输入；XML、引用、“我是 owner”等文本不取得 principal 身份。binding 在排队期间被撤销时，不继续执行旧授权输入。

特别注意：现有 `session_inputs` 不保存正文，当前 standalone enqueue 也不是完整 busy queue。C 应把缺口补在共享输入载体/交付层并给出回归，而不是只在频道服务上盖一层内存队列。入站 ledger 保存原始平台事件及与 input 的关联，不另存一套独立 Run 执行状态。

### 4.2 回复和主动发送

- 外部入站回合由 Coordinator 显式调用受限 send_message；普通 assistant 文本留本地 transcript，不自动整段镜像到 Discord。Host 不把 TUI 的思考、工具结果、审批信息或私聊全部广播。
- 外部回合结束前检查“是否已建立对应的持久回复义务”，不能仅计数出现过工具名；失败的工具调用不算交付。提醒有界，仍未建立则记录 delivery_missing，不无限重试，不退回自动转发私有 transcript。
- 本地 TUI 普通回合不强制调用 send_message；不能因为工具进入白名单，就触发旧 Bot 的“普通文本不可见/唯一声音”规则。
- 主动发送先建立持久 Delivery，再按连接/binding 校验并发送。出站默认 `allowed_mentions` 关闭，引用回复不 ping 原作者，防止模型文本中的 `@everyone` 或其他 Bot mention 触发额外通知/循环。
- 不支持的超长正文在入队前明确拒绝，首版不静默截断。若实现拆分，必须把 chunk 及 receipt 全部持久化，不能只确认最后一块；不为首版强制要求拆分。
- 已明确未发送的限流/临时错误可按 Retry-After 有界重试；网络超时、进程在 sending 中退出或发送成功后保存 receipt 失败，必须记 unknown。无平台证据时不能自动重发，不能宣称 exactly-once。
- TUI 指令“任务完成后通知频道”仍由 Coordinator 决策。Host 将已有子任务终态通知唤醒到 Coordinator，再由它选获准频道发消息；不能把所有 Task 终态自动广播。C/E 要接通 standalone idle 唤醒，否则只能宣称即时文本闭环，不能宣称无人值守完成通知。

### 4.3 凭据和生命周期

- 凭据为连接 scope，不放 Project 数据 JSON、SQLite 公开记录、配置响应、prompt、transcript、日志或命令行。公开输出只有 credentialConfigured。
- C 提供 Electron 无关的 Host secret 端口及本地实现，使用 Host dataRoot 下的连接专属目录、不可由请求选择的文件路径、原子写；目录 0700、文件 0600（支持的平台），拒绝路径穿越/symlink，并处理轮换和回滚。若仍为受权限保护的明文文件，文档必须如实说明，不假称加密。
- 先核验 token 对应的真实 Discord Bot；不同项目不能复用同一平台 Bot 身份。轮换 token 不能静默把原连接变成另一个 Bot；更换身份要求显式重建/重绑。
- 非 client-scoped Host 随启动恢复已启用连接与待处理义务；Ctrl+C/close 停止接收、计时器和 socket，不丢持久待办。client-scoped Host 不因配置了频道而悄悄改变原退出规则。
- Desktop 最终消费同一 Host service/数据库；首版不从 Desktop 再开一个相同项目 Bot 连接。凭据缺失、缺权限、Host ledger-only、平台断线显示不同错误，不显示“在线”。

## 5. 派工与路径所有权

推荐五个实施任务。先做 A 的合同/存储；A 的可编译合同就绪后，B/C/D 可并行；最后由 E 集成。并行 agent 都使用各自检出，公共接缝只有下表指定 owner 写。所有人开工前核对基线包含本计划依赖的 Task 闭环提交，不能从旧 master 假定已有这些能力。

| Agent | 任务和独占路径 | 依赖与交付界面 |
| --- | --- | --- |
| A | 协议与持久化：`packages/agent-protocol/src/project-channels.ts` 及协议 exports；`packages/data/src/project-channel-store.ts`、迁移/组装/exports 与专属测试 | 先交 DTO/port/错误码/存储签名，再交真实 SQLite 事务测试；不写 Gateway、Host composition、工具或 CLI |
| B | 多实例 Discord transport：`packages/gateway/**`（含 package exports/deps 和测试） | 依赖 A 中立类型；交可由外部宿主调用的工厂，不依赖 Electron、不调用 Host HTTP、不存 Project 权限/任务状态 |
| C | Host 领域与共享输入恢复：新增 `packages/host/src/project-channels/**`，必要的 `session-input-api.ts` / `session-input-service.ts` 等共享输入实现与专属测试 | 依赖 A；消费 B 的中立端口而非 import Gateway；负责权限、secrets、inbox→input 关联、outbox、CAS 和 recovery。输出 assembly-ready API；不改 local-host/http-server/http-client |
| D | 工具与客户端：`packages/capabilities/**` 的新增窄工具/既有 Project 投影；Host `worker-tool-bindings/`、`worker-tool-services/`、`worker-tools/builtin.ts`、`worker-tool-registry.ts`、`worker-db-client.ts`、`project/identity.ts`、`project/tool-service.ts`、send-message hooks/提示词；`packages/cli/src/commands/project-channel.ts` 与测试 | 依赖 A 合同及 C 服务签名；交唯一 send_message 投影、list_channels、来源感知提醒及 CLI handler。不能自行修改 local-host、HTTP server/client、CLI 根 index 或 command registry 公共入口 |
| E | 装配与整体验收：`packages/host/src/local-host.ts`、`http-server.ts`、`http-client.ts`、`worker-db-bridge.ts`；CLI `index.ts`/descriptors/registry 与 composition；必要 Desktop 挂载；构建脚本、根依赖/lock、显式架构依赖、生成 bundle、架构文档和本计划 | 依赖 A/B/C/D；装配一条真实链，注册控制面和可信 Worker bridge，接通 idle drain/常驻 Host，跑集成/构建/门禁。只由 E 修改公共入口、根 lock、bundle 和汇总进度 |

如一个真实文件不在清单或需跨 owner 修改，先由 E 指定 owner，再开始写；不要由两个 agent 各修改一半同一文件。A 负责协议/数据包元数据；B 负责 Gateway 包元数据；D 负责 capabilities 包元数据；E 负责 Host/CLI 包元数据与根 lock。Host → Gateway 不作为解决依赖的手段；CLI composition → Gateway、Gateway → protocol 等必要边由 E 明确声明并通过架构检查，不写 baseline。

### A：可直接转发的任务说明

> 按本计划 §1–4 实现独立项目 Channel 的中立协议和持久存储，只改 §5 的 A 路径。先发布可编译的公开 DTO、HostProjectChannelApiV1、transport port、错误码和 Store 方法清单，供 B/C/D 使用；不允许其他 agent 临时扩一套近似类型。使用真实 SQLite 验证唯一 Bot 身份、绑定归属/CAS、入站 request 冲突、Delivery 幂等/unknown、旧库升级与回滚。Project 与 Session/Run 不新增平行状态机，凭据不进入公开 DTO。提交基线 SHA、验证证据和精确接缝；不实现业务接线，不自行发布或合并。

### B：可直接转发的任务说明

> 按本计划 §3.3、§4.1 第1项、§4.2 transport 要求实现多连接 Discord 运行层，只改 §5 的 B 路径。复用 DiscordAdapter；按 connectionId 隔离 socket、限流、重连、busy、去重和发送，返回经平台核验的身份/频道事实。结构化传递 mention/guild/sender/author 类型；默认拒绝其他 Bot/webhook、DM、未绑定 thread，不用 slash/正则 mention 绕过规则。验证双项目 Bot 同频道只响应被 @ 的实例、无回声、撤销/轮换的旧 generation 不复活、allowed_mentions 关闭、发送错误分类和清理；保留旧 Gateway 行为的回归。交中立 factory 给 E，不引入 Host 或个人 Bot 产品依赖。

### C：可直接转发的任务说明

> 按本计划 §3–4 实现 Host Project Channel 领域服务，只改 §5 的 C 路径。覆盖可信来源鉴权、非空成员白名单、当前 Coordinator 解析、持久入站正文/去重、统一 Session input/lease/admission 的串行 drain 和崩溃恢复；不能用 actor=local user 的 HTTP 服务或假 botId。实现连接 scope secret 存储、绑定撤销、带 caller Run/epoch 的发送授权和持久 outbox，unknown 不盲重试。输出供 E 注入的领域 API/transport port/启动关闭及 idle 唤醒接缝，给 D 服务签名；不自己改公共 composition。用真实 SQLite 和受控 transport 证明 race、重启、跨项目、撤销及 unknown 场景。

### D：可直接转发的任务说明

> 按本计划 §3.2、§4.2 和 CLI 路径实现 Coordinator 窄 send_message、project.list_channels、按真实入站来源的回复义务，以及独立 Host CLI handler，只改 §5 的 D 路径。Project/身份从可信 caller 推导，不向模型暴露凭据、原始目标或配置动作；维护 canonical send_message 唯一注册和既有 Bot 兼容，默认不给工作 Session。TUI 普通回复仍可见，外部回复只通过持久发送义务，不自动镜像 transcript。CLI 凭据仅 env/stdin，不进 in-process duya_cli 工具、argv 或输出；实现 host 不可用/旧版本/stale revision 的清晰错误。交注册函数给 E 挂到 `duya project channel`，不要改 CLI 根入口或 HTTP client。

### E：可直接转发的任务说明

> 集成本计划 A/B/C/D，不重新实现其领域规则；只改 §5 的 E 公共入口和集成测试。Host 注入中立 transport，Gateway 由 CLI/Desktop composition 装配，禁止 Host 直接依赖 Gateway。接通认证 HTTP、受信 Worker bridge、常驻 Host 启动恢复、Session idle/terminal drain、关闭清理和 CLI 子命令，不能只提供“文件存在”的半接线。用本检出生产 Worker + 真实 Host HTTP/SQLite + 本地模型 fixture + 受控 Discord transport 跑 §6；再取得用户独立授权后用测试 Discord Bot/频道真机验收。记录所有未覆盖项，不代用户推送、创建 PR 或合并。更新本计划及架构说明，不加 baseline 规避边界。

### 集成顺序与交接格式

1. A 冻结合同，E 核对包边界和共享文件 owner；此时 B/C/D 才按同一接口开工。
2. B/C/D 各自可用中立 fake port 验证局部，但必须交真实实现、可编译签名和限制；D 在 C 签名冻结后接实服务。
3. E 在包含 A 的基线上集成 B/C/D，处理公共挂载，再运行实际链路。单包测试全绿不能直接宣布整体完成。
4. 不同分支的合入由用户授权的集成者完成；不可把另一 worktree 的通过结果当当前分支证据。每次交接提供 source/base/head SHA、分支/owner、dirty 文件、命令/退出码、接口变化、已知失败、外部副作用、下一动作。
5. 实施 agent 的分支需要包含 `5e5256decc4a915872add152b122a97ad71e55c1`，不要求该提交已经在远端 master。设计文档当前未提交，派工时附本文件全文或先由用户授权发布设计，不能让别的检出猜测本文内容。

## 6. 验收矩阵

| 场景 | 必须观察到的结果 | 主要 owner |
| --- | --- | --- |
| 两个项目、两个 Bot、同一频道，只 @ A | 仅 A Project 产生一条输入，B 无 Run/发送；无输入原文串到 B | B/C/E |
| 无 mention、其他 Bot/webhook、未绑定频道/DM/thread、空 allowlist | 不唤醒、不下载附件、不泄露项目信息 | B/C |
| 未授权成员、正文伪造 owner/project/source、越权 binding | Host 拒绝；工具别名/延迟调用不能绕过 | C/D/E |
| 同一事件重复，或同 requestId 不同正文 | 原 receipt 返回/明确冲突，不重复 Run 或发送 | A/C |
| Coordinator 正忙/有本地 lease，之后 idle | 可证明持久等待与串行消费，既有回合不被打断，尊重 lease | C/E |
| 入站落盘后重启；提交输入前后各崩溃；准入回执丢失 | 事件正文可恢复；同一入站不盲目再起 Run，unknown 可查 | A/C/E |
| Coordinator 替换、解绑、停用、token 轮换与迟到响应 | 未提交事件解析新负责人；已提交先对账；旧授权和旧 generation 不能继续发 | B/C/E |
| @询问项目状态 | 生产 Worker 读取真实 Project/Task，通过受限 send_message 回原频道；不新建 gw-* Session | D/E |
| 在 TUI 要求发到已授权频道 | allowProactive 开启时成功；关闭时明确拒绝；普通 TUI 回答不被隐藏 | C/D/E |
| 子任务无人值守完成 | 既有 terminal 义务唤醒 Coordinator，由它显式决定发送；TUI 关闭后仍可完成，不自动验收 Task | C/E |
| 模型普通文本或失败 send_message 后结束外部回合 | 不泄露整段 transcript；仅真实持久回复义务算交付；有界提醒/可查 delivery_missing | D/E |
| 限流、平台明确拒绝、超时、发送后保存 receipt 失败 | 按证据区分 retryable/failed/unknown；不把 queued 当 sent，不无限重试 | B/C |
| 凭据安全与权限 | env/stdin 输入无回显；API/日志/Worker/prompt/SQLite 公共记录无 token；文件权限与轮换回滚正确 | C/D/E |
| 退出 TUI/重启 Host/Ctrl+C | 非 client-scoped Host 独立接收；client-scoped 语义不偷偷改变；进程/定时器/socket 清理 | B/E |
| 既有能力回归 | 普通 Gateway、Bot 发送、duya/duya tui/duya project、Task acceptance、审批和普通 Session 仍符合原语义 | 全体/E |

实施时各 owner 先按测试 Inventory 取相关基线，再添加专属用例，按文件/用例/错误签名比较失败。新增测试建议文件名由 owner 统一：data `project-channel-store.test.ts`；Gateway `project-discord-runtime.test.ts`；Host `project-channels-{service,recovery,http,worker}.test.ts`；CLI `project-channel.test.ts`。这是拟新增测试，不宣称基线已有。

E 的真实本地验收必须包含：同检出生产 Worker、真实 Host HTTP/SQLite、当前 CLI/PTY、本地脚本 provider，以及走生产 DiscordAdapter 的本地受控 REST/WebSocket 端点。只 mock transport 的测试可证明领域逻辑，不能替代适配器或生产 Worker 证据；本地端点的注入仅限测试，不允许模型/公网请求改 API origin。

最终执行受影响测试及 `npm run build:cli-dev`、`npm run typecheck:all`、`npm run architecture:check`；新增依赖/懒加载/打包接缝在推送前执行 `npm run electron:build`，修改 main/preload 后也必须重建。生成 bundle 只由 E 重建/核对，提交级 `bundle:verify` 的 dirty 限制如实记录，不越权提交。若新增 MCP connector 入口，按根规则补 conformance；若只加内建工具，不虚称已跑完整 connector 验收。

真实 Discord 外部验收需用户提供测试 Application/Bot、最小权限邀请、测试服务器/频道和允许成员，并明确授权实际发消息；token 通过安全配置入口输入，不进计划/聊天。没有这项验收时，只能标“本地生产链路已验证，真实 Discord 未验证”。

## 7. 进度与验证记录

- [x] 用户确认独立项目身份，首版产品和权限边界明确。
- [x] 核对 Gateway、输入/发送、生命周期和架构限制；给出合同、路径 owner 和可转发任务说明。
- [x] A：协议与持久化（合同/API/port/错误码/幂等键 + 迁移 69 真实 SQLite 存储；21 项专属用例通过）。
- [ ] B：多实例 Discord transport。
- [ ] C：Host 领域、持久收发及恢复。
- [ ] D：工具投影与 CLI handler。
- [ ] E：公共装配、实际链路及门禁。
- [ ] 用户授权的真实 Discord 验收、PR/review/CI、授权集成。

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `5e5256decc4a915872add152b122a97ad71e55c1`，开始设计时工作区干净 | Linux，Node v26.13.0，npm 11.20.0 | Git 与上述源码只读核对 | 成功；功能代码无修改 | §2 接缝表；不代表新增功能测试通过 |
| 同 SHA，新增本计划及三个入口/关联文档 | 同上 | `git diff --check`；脚本检查本计划相对链接、UTF-8、尾空白、文件末尾和 Git 可见性 | 退出 0；全部通过，仅四个文档路径变更 | 未修改功能代码，未运行功能测试或外网验收 |
| `5e5256decc4a915872add152b122a97ad71e55c1`，A 新增协议/存储/测试/迁移 69 | Linux，Node v22.22.2，npm 10.9.7，better-sqlite3 真实文件库 | `vitest run packages/data/tests/project-channel-store.test.ts` | 退出 0；21/21 通过 | 唯一 Bot 身份、绑定归属/CAS、入站去重与正文冲突、Delivery 幂等/unknown、观测 generation fencing、旧库升级/回滚 |
| 同上 | 同上 | `vitest run packages/agent-protocol/test`（基线 29 文件/465 项）；`vitest run packages/data/tests`（基线 22 文件/150 项，5 失败） | 协议 465/465 通过；数据 145/150，5 项 `migratePreviousDefaultDatabases` fs-copy 基线失败保持不变 | 新增测试文件全绿；5 项失败在改动前已存在，错误签名一致（`database-migration.test.ts:86` EPERM/copyfile），非本切片引入 |
| 同上 | 同上 | `tsc --noEmit -p packages/agent-protocol/tsconfig.json`；`tsc --noEmit -p packages/data/tsconfig.json`；`npm run typecheck:protocol`；`npm run architecture:check`；五项 `check:*` | 全部退出 0 | 协议零依赖不变量经 01/02 漂移测试；架构无新增违规（tolerated 3228/3228）|
| 同上 | 同上 | `npm run build:packages` | 退出 1（非本切片） | `@duya/capabilities` 资产复制在 worktree 中 EPERM（沙箱 fs shim 拒绝 copyfile）；与 5 项基线测试同因，protocol/data 单独 tsc 通过 |

## 8. 接续 / 结果

本轮交付为设计与派工计划，不实现功能、不启动其他 agent、不配置真实凭据、不发送外部消息。文档未提交、未推送；原 Task 闭环仍在上述基线提交，不能把本设计状态标成已实现/已合并。

设计 worktree 保留；新增本计划并更新计划入口/目录及 Coordinator 总计划链接。下一步由用户指定 E（集成 owner）并先派 A，A 交付一致合同后分派 B/C/D；不建议五个 agent 同时自由修改公共入口。

### A 交接（合同已冻结，供 B/C/D 依赖）

A 分支 `codex/project-channels-protocol-store`（base `5e5256decc4a915872add152b122a97ad71e55c1`）已交付可编译公开合同，`@duya/agent-protocol` 主入口与 `./project-channels` 子路径导出：`ProjectChannelConnection`、`ProjectChannelBinding`、`ProjectChannelInboundEvent`、`ProjectChannelDelivery`、`ProjectChannelRuntimeObservation`、`HostProjectChannelApiV1`、`ProjectChannelTransportPort`、`ProjectChannelSendMessageInput`、错误码集合与 `inboundDedupKey` / `deliveryRequestKey` / 两个正文指纹函数。B/C/D 直接 import，不得另造近似类型。

关键语义（已由 Store 测试钉死）：入站去重键为 `connectionId + messageId`，同键正文不同抛 `inbound_fingerprint_conflict`；投递幂等键为 `projectId + requestId`，`queued` 不等于 `sent`，无平台证据落 `unknown` 不自动重发；连接/绑定写作为 revision CAS，撤销保留审计行；connection `generation` 与持久化 `revision` 分离，旧 generation 观测被 `observe` 拒绝。存储仅接受平台核验后的 `botUserId`，无任何 token 字段。

A 未做业务接线：不实现 Gateway、Host composition、工具或 CLI。B 依赖 `ProjectChannelTransportPort` 工厂；C 消费 `ProjectChannelStore`（从 Host db handle 构造，迁移 69 已在 `collectCoreDataMigrations()` 装配）；E 负责公共入口与集成。未提交 PR，未合并；未取得真实 Discord 验收。
