# 11 · 协议的前瞻复审:下一轮重构要预留什么

> 写于 PP-1 交付后的第三轮审计。这一轮不做实现,只回答一个问题:
> **当下一轮重构来临时,现在这套协议会挡路的地方在哪。**
>
> 配套文档:`07-agent-protocol-spec.md`(规格)、`10-reference-comparison.md`(参考对比)、
> `packages/agent-protocol/GAPS.md`(缺口登记,9 条)。

---

## 0 · 方法与可信度

三轮审计里最贵的错误类型是**「没读源码就断言事实」**。这一轮因此先立规矩:

| 结论类型 | 判定标准 |
|---|---|
| **已验证** | 给出 `file:line`,且行号在本轮重新读过 |
| **推断** | 明确标 `推断:` |
| **未验证** | 明确标 `UNVERIFIED`,需要 DB / 运行环境才能确认 |

已知的 UNVERIFIED 项:

- 「1666 条存量 `tool_result` 零 `is_error: true`」——需要 DB,本轮**没有**查。
  更正:上一轮把这个数字当成了「`tool_use` 合并导致丢失」的证据,
  那条因果链是错的(见 §3.1),数字本身的真伪仍未验证。
- 首轮 `vocab-scan` 的词汇表命中率极低,大部分是包管理器和 HTTP 头的误匹配,
  **已废弃**,不作为任何结论的依据。

---

## 1 · 与 Duya 现有接口面的对比

### 1.1 三个派发面,没有共同契约

Duya 有**三个**独立的派发面,协议目前只覆盖其中一个:

| 面 | 位置 | 规模 | 协议覆盖 |
|---|---|---|---|
| Worker stdout | `packages/agent/src/process/worker-protocol.ts` | 25 个 `chat:*` 事件 | 全部(PP-1 已对齐) |
| SSE | `electron/agents/server/router.ts:450` `normalizeWorkerEvent` | 25 个事件 | 映射表已建(`legacy/sse-event.ts`) |
| HTTP 控制面 | 同上,手写条件链 | 见 §1.2 | **无** |
| IPC | `electron/preload.ts` | **180 channel / 37 前缀** | **无** |
| MessagePort | `preload.ts` + `WidgetRenderer.tsx` | 6 个 channel | **无** |

### 1.2 控制面**无法被枚举**——这是本轮最硬的结构性发现

`preload.ts` 声明 180 个 IPC channel,这个数字可以数出来。

**HTTP 侧数不出来。** `router.ts` 没有路由表。它是 3466 行里的手写条件链:

```ts
// router.ts:2943
if (parts[0] === 'plugins' && parts[1] === 'reload' && method === 'POST') { ... }
// router.ts:3237
if (method === 'GET' && parts.length === 2 && parts[1] === 'runs') { ... }
// router.ts:3352
if (method === 'GET' && parts.length === 3 && parts[2] === 'events') { ... }
```

本轮用两种正则交叉扫描(`app.get(` 式注册 / `parts[N] === 'lit'` + 邻近 `method ===`),
得到 **0 个路由注册、16 个路径字面量、15 处 method 判断**。字面量还大量复用
(`trigger` 出现在两处不同深度,语义完全不同)。

**后果**:今天**写不出**针对 Duya 自身 API 的一致性测试,因为没有清单可以对照。
`EventSource` / `EventSink` 定的是事件面,控制面是另一回事。

`electron/agents/server/` 下另有三个大文件同样没有清单:
`interagent-router.ts`(628 行)、`workflow-runtime-manager.ts`(854 行)、
`worker-manager.ts`(571 行)。

### 1.3 体量对比

```
协议包:  217 个具名导出 / 18 个模块 / 0 个运行时依赖
控制面:  180 IPC + ~16 HTTP 字面量 + 6 MessagePort + 4 CLI 命令
```

CLI 侧同样稀薄——`packages/agent/src/cli/index.ts` 只注册了 4 个命令
(`config` / `image <prompt>` / `image:config` / `setup [section]`),
而 `packages/cli` 作为独立 workspace 包另有控制面。

---

## 2 · 与 clone harness 的对比

### 2.1 筛选结果

`E:\cloned-projects` 共 **38 个目录**。按「是否存在 ≥120 行的协议模块」筛,
**21 个**有,17 个没有(后者含 `neuralhydrology`、`pytorch-tutorial`、
`markitdown` 等明显无关项)。

按协议代码量排序的前八:

| 仓库 | 协议文件数 | 总行数 | 关键信号 |
|---|---|---|---|
| `codex` | 26 | 21724 | `protocol.rs` **6043 行**,caps / cancel / resume |
| `openclaw` | 36 | 15005 | zod + discriminatedUnion,resume |
| `hermes-agent` | 38 | 11259 | **jsonrpc**,caps,version const `1.0` |
| `grok-build` | 17 | 10916 | cancel / caps |
| `ZCode` | 27 | 8204 | zod + disc-union,cancel / resume |
| `open-design` | 10 | 6385 | cancel / resume / caps |
| `zed` | 9 | 5542 | — |
| `minimax-code` | 15 | 4088 | cancel / resume |

### 2.2 最有参考价值的一份:`prime-agent/daemon-protocol.ts`

1188 行,但它是全场唯一**同时解决了我们 G-1~G-9 全部形状**的实现。
它有**四条正交的版本轴**:

```ts
DAEMON_PROTOCOL_NAME = "prime-agent.daemon"
DAEMON_PROTOCOL_VERSION = 7                      // wire 协议版本
DAEMON_SCHEMA_REVISION  = 16                     // 载荷修订,只在字段变化时 +
DAEMON_UPDATE_RESTART_FORMAT_VERSION = 1         // 第四轴:更新清单格式
DAEMON_SCHEMA_ID = "protocol-7-schema-16-1bcb9e7f1a49"   // 复合 id + 内容哈希
```

并且它对**每一条命令和每一个事件**挂门禁元数据:

```ts
export interface DaemonCommandCompatibility {
  minProtocol: number;
  minSchemaRevision?: number;
  capability?: DaemonServerCapability;
}

mutate_queued_message: { minProtocol: 7, minSchemaRevision: 15, capability: "queue_message_mutation" },
heartbeats_list:     { minProtocol: 7, capability: "heartbeat_catalog" },
```

三条设计值得直接抄:

1. **schema revision 与 protocol version 分离。** 加字段不必 bump 协议版本,
   只有 wire 语义变更才 bump。`ZCode` 独立地做了同一个决定
   (`ZCODE_PROTOCOL_VERSION = 1` / `ZCODE_PROTOCOL_V4_WIRE_VERSION = 3`),
   并留下注释:*「V4 wire 与 legacy 主协议并存;禁止为了 V4 physical framing
   改写 legacy 版本」*。**两个独立团队都选了同一条路,这不是巧合。**

2. **能力协商是双向的。** attach 时客户端上报 `capabilities?: readonly
   DaemonClientCapability[]`,服务端另有 `DaemonServerCapability`。
   还支持**拒绝型策略**:`telemetryDisabled?: true` 的注释写着
   「a telemetry-enabled worker must reject this attach」——
   协议层能表达「我不接受你」,我们的不能。

3. **瘦身是能力驱动的。** `state?` / `messages?` 对带 `slim_attach` 能力的
   客户端省略,并**指明替代来源**(`use snapshot.summary`)。
   不是「可能没有」,是「没有的话去哪拿」。

### 2.3 逐个提取协议维度（20 个仓库全覆盖）

前一节只深读了 2 份。这一节对**全部 20 个有实质协议模块的仓库**机械提取
11 个设计维度，每个信号都带 `file:line` 证据：

| 仓库 | 最大协议文件 | 版本轴 | 逐消息门禁 | 能力协商 | 双向 | 拒绝握手 | cancel | resume | strict | lenient |
|---|---|---|---|---|---|---|---|---|---|---|
| `codex` | 6043 | — | — | Y | — | — | Y | Y | — | — |
| `open-design` | 2722 | — | — | — | — | — | Y | Y | — | — |
| `typescript-sdk` | 1913 | — | — | Y | Y | — | Y | — | — | — |
| `zed` | 1684 | — | — | Y | Y | — | — | — | — | — |
| `hermes-agent` | 1507 | 3 | — | Y | Y | — | Y | Y | — | — |
| `openclaw` | 1477 | — | — | Y | Y | **Y** | Y | Y | — | — |
| `grok-build` | 1395 | 1 | — | Y | Y | — | Y | Y | — | Y |
| `ZCode` | 1235 | — | — | Y | — | — | Y | Y | **Y** | — |
| **`prime-agent`** | **1188** | **4** | **Y** | **Y** | **Y** | **Y** | Y | Y | — | — |
| `claude-code-haha` | 866 | 1 | — | — | — | — | — | — | — | — |
| `minimax-code` | 628 | 1 | — | Y | — | — | Y | Y | — | — |
| `pi` | 383 | — | — | — | — | — | — | Y | — | — |
| `DeepSeek-TUI` | 284 | — | — | — | — | — | — | Y | — | — |
| 其余 7 个 | ≤324 | — | — | — | — | — | — | — | — | — |

**结论是一个否定性结果，但它是本轮最有价值的对比产出：**

> **20 个仓库里,只有 `prime-agent` 同时具备「版本轴 + 逐消息门禁 + 双向能力
> 协商 + 拒绝型握手」四件套。** 其余每一个都缺至少两件。

两个反直觉的数据点:

1. **`codex` 的 `protocol.rs` 是全场最大的协议文件（6043 行），却没有任何版本协商。**
   扫到的三个 `*_VERSION` 常量全部来自无关文件（`tui/src/pets/image_protocol.rs`
   的 SIXEL / kitty 终端能力探测、`rollout-trace` 的 trace schema）。
   **协议做得最大 ≠ 协议做得成熟。** 这对「照着 codex 抄」的直觉是个直接反驳。
2. **`grok-build` 走了宽松路线**（lenient: Y），`ZCode` 走了严格路线（strict: Y）。
   两者是**同一个问题的两种解**，且都没有版本轴兜底——见 §2.2 末段。

### 2.4 这套方法的边界（必须写明）

信号提取是**基于关键词的**，所以下述情况会漏报:

- 一个仓库用 `requiredSince` / `introducedIn` 而不是 `minProtocol` 命名门禁字段
- 一个仓库在**第二个文件**里做门禁，而该文件名不含 `protocol` / `events` / `wire`
- 一个仓库的版本协商在运行时字符串里而非常量里

**本轮实际踩到三个假阳性**，都靠人工识别后剔除：

| 假阳性 | 实际是什么 |
|---|---|
| `codex` 的「门禁表」 | `ITERM2_KITTY_MIN_VERSION`——TUI 图片协议的终端能力探测 |
| `zed` 的「门禁表」 | `gpui_windows/src/events.rs` 的 `min_size`——窗口尺寸，不是协议 |
| `DeepSeek-TUI` 的「门禁表」 | `tui/src/core/events.rs` 的 `min_slack: f64`——TUI 布局字段 |

所以上表应读作**「没有证据表明具备」，而不是「已证明不具备」**。
但对 `prime-agent` 的结论是**正面的、可复核的**：它的门禁表是
`Record<命令名, { minProtocol, minSchemaRevision?, capability? }>` 这样的
显式字面量表，扫不漏。

### 2.5 我们 vs 三个典型

| 维度 | 我们 | `prime-agent` | `ZCode` | `grok-build` |
|---|---|---|---|---|
| 版本轴 | 1(`MAJOR.MINOR`)+ **装饰性** `since` | 4,全部有门禁 | 2 | 1 |
| 逐消息门禁 | **无** | 命令 + 事件全覆盖 | 无(靠 `.strict()`) | 无 |
| 能力协商 | 单向(runtime→host) | 双向 | 1 个 flag | 双向 |
| 拒绝型握手 | 无 | 有 | 无 | 无 |
| 未知事件 | 忽略(`extension.custom`) | — | **直接拒** | 忽略 |

我们和 `ZCode` 走的是**同一个问题的两种解**,而且都没有逐消息门禁兜底:
`ZCode` 靠 `.strict()` 让错误立刻炸,我们靠宽松解码让它不炸但也不报。

**但这两条路在没有版本轴时都是安全的**——因为协议还没发布,改字段就是破坏性变更,
所有 host 同步升级即可。**一旦开始有独立版本的 host,`ZCode` 那条路立刻变危险**
(新字段会让老 host 硬失败),而我们这条路只是继续静默。

所以结论不是「我们该学 `ZCode` 用 `.strict()`」,而是
**「我们必须先补版本轴,宽松解码才有意义」**。顺序不能反。

---

## 3 · 本轮推翻的四个事实断言

完整 diff 见提交 `924232ed`。这里记录**为什么错**,因为错误类型比错误内容更值得留存。

### 3.1 `tool_use` 没有「合并 start 和 finish」

原注释称 legacy `tool_use` 事件把调用和结果合在一起,因此 `is_error` 被丢掉。
**这是编的因果链。** 已验证的事实:

- `SubagentToolUseEvent` 与 `SubagentToolUseStartedEvent`
  (`worker-protocol.ts:269-283`)**除判别符外逐字段相同**
- router 原样转发两者,data 同形(`router.ts:466-477` vs `:491-502`)
- `DuyaAgent.ts:2394-2397` 写明区别:`started` 是参数流式生成中的**临时播报**,
  `tool_use` 是**权威重发**
- 消费端 fallthrough 到同一个 upsert(`agent-sse-client.ts:452-453`、
  `stream-session-manager.ts:2013-2014`)

真实语义是**同一次调用播报两次(临时 + 权威)**,不是 start/finish 合并。
结果事件走独立的 `tool_result`(`router.ts:503-507`)。

**这个错误造成了一个真实的设计洞**,见 G-6。

### 3.2 `envelope.ts` 对重放的描述是反的

原注释称重放走 fresh counter 导致 `id` 对不上、`Last-Event-ID` 不可信。
**重放路径是对的**:`router.ts:2412-2423` 写回每条记录的原始 `eventId`,
`:2437` 从 `session.lastEventId` 续上,`:2432-2436` 还留着当时的修复记录。

真正的缺陷是**反过来的**,而且更严重——见 G-8。

### 3.3 `framing.ts` 数字错 + 断句

100 KB 应为 **64 KB**(`router.ts:676` / `:2838` 都是 `64 * 1024`)。
另有两处句子在早前清理文档反向引用时**丢了主语**,变成无头句。
本轮已修,并把剩下 5 处反向引用(`framing.ts` / `capabilities.ts` /
`index.ts` / `payloads.ts` / `registry.ts`)一并清掉。

### 3.4 `since` 是装饰性的

`EventMeta.since` 30 个事件全是 `'1.0'`,唯一消费者是断言**格式**的快照测试。
没有任何派发或门禁读它。见 G-9。

### 3.5 四条断言的共同载体:`file:line` 引用

上面四条里,没有一条是「读错了代码」。它们的载体是同一个东西:
**注释里一句没人验证过的 `file.ts:LINE`**。

把协议包源码里的 29 处 `file:line` 引用全部解析后,只有 22 处能落到唯一文件:

| 状态 | 数量 | 说明 |
|---|---|---|
| 可解析 | 22 | 落在唯一文件、行号在范围内 |
| **歧义** | **5** | `types.ts` 匹配 **63** 个文件,`worker-protocol.ts` 匹配 2 个 |
| **无法解析** | **1** | `ai/types.ts:344` 少写了 `packages/` |
| 外部仓库 | 1 | grok-build,无法从本仓校验 |

再叠加锚点检查(注释里紧邻引用的反引号符号**必须出现在所引行范围内**),
又抓出 2 处。其中最典型的一处:

```
run.ts  引用 router.ts:1697 说 handleDeleteChat 在那
实际    handleDeleteChat 在 router.ts:1670
```

**关键在于:这句话支撑的结论并没有因此变错**——`:1681-1683` 的
「worker ack 之前就硬迁移 STREAMING → COMPLETED」依然成立。
所以**人读代码发现不了它**,只有机器能。

### 3.6 由此加的门禁

`test/13-citation-drift.test.ts`,6 条断言,四级:

1. 引用的文件能解析到**唯一**文件(歧义即失败)
2. 行号范围在文件内
3. **锚点必须出现在所引范围内**——这一级才有牙齿
4. 引用外部仓库的必须在注释里写明 `external`

外加一条**覆盖率地板**:可检引用数 > 20、可跑锚点检查数 > 5。
没有它,一个「什么都没匹配到」的提取器会让上面 4 条全部变成永远绿的空断言。

已用注入假引用的方式验证过两级都会红(超范围 / 锚点不在范围内)。

> 这条门禁是本轮**唯一**能防止同类错误复发的机制。
> 前面三轮的评审全靠人读代码,而 §3 的四条里有三条是人读不出来的。

---

## 4 · 面向下一轮重构的结论

按「不解决会在哪一步爆」排序。

### 4.1 承重决策:`seq` 必须由 runtime 铸造(G-8)

这是唯一一个**其他一切都依赖它**的决策。

现状:计数器 per-turn(`router.ts:1329` 每次 POST 归零),
id 空间和环形缓冲 per-session(500 条,`session-store.ts:152-153`)。
第二轮对话会重新铸造第一轮的 id,`getEventsSince` 的 `eventId > lastEventId`
过滤随之失效。

**必须在任何 transport 工作之前定。** 因为:
- 断线续传依赖它
- 事件去重依赖它
- G-6 的 revision 语义依赖它(「后到为准」要有全序)

### 4.2 补上逐消息门禁(G-9)

这是 G-1/G-2/G-3/G-4/G-6 的**共同解法**。

现在这五条只有两种结局:逼运行时造它没有的数据(→ P0-1、N-1 那类编造的集合),
或留在类型里当摆设(→ host 照着类型写代码然后踩空)。

门禁让「运行时没有」变成**可声明的事实**。代价是一个字段加一个查表函数。

**建议**:先给 G-3(`checkpoint.saved`)装一条,证明机制可用,再推广。

### 4.3 控制面需要一份清单

180 个 IPC channel + 无法枚举的 HTTP + 6 个 MessagePort。
协议定义了事件面,没有定义控制面。

下一轮如果要做 strangler fig(**不建 duyav2,同仓库渐进替换**),
需要能回答「这个 host 用了哪些接口」「这些接口还在吗」。
今天答不了。

**建议**:在协议包里加一个 `ControlSurface` 描述模块(不是事件——是
「有哪些能力入口、各自的前置条件」),并让 `preload.ts` 的 channel 声明
成为它的数据源。这样控制面第一次变得可枚举、可 diff、可测试。

**注意**:这一条**不能**用 zod schema 实现(会违反 drift test #10 的偏离守卫),
要用类型 + 一次生成或一次漂移测试。

### 4.4 三个派发面应当收敛到 `EventSink`

`normalizeWorkerEvent`(`router.ts:450`)是当前**唯一**的事件归一化点,
但它埋在一个 3466 行文件的中间。IPC 和 MessagePort 各自有独立的事件处理
(`stream-session-manager.ts:2013`、`agent-sse-client.ts:452`)。

下一轮重构若要换 transport,理想状态是**只有 `EventSink` 铸事件**,
三个派发面都变薄。今天不是这样,所以换 transport 的成本会远高于协议本身的价值。

**建议**:不现在做(会碰 122 条 `@duya/ai` 消费边),但**在协议里写下这个方向**,
让 PP-2 的 adapter 从一开始就往 `EventSink` 上靠,而不是再加一条平行的转换链。

### 4.5 `extension.custom` 是唯一的前向兼容机制,需要被验证

我们保留了它,ZCode 走 `.strict()`,prime-agent 靠门禁。
三条路里 ours 最宽松,也最依赖 host 正确实现「MUST be ignored」。

**建议**:加一个测试,用真实的旧版 host 消费一条带未知命名空间的事件,
断言它不进 transcript、不进持久化。这条机制从未被端到端验证过。

---

## 5 · 与已有决策的一致性

本轮没有推翻任何既有决策,但补充了一条约束:

| 决策 | 本轮状态 |
|---|---|
| 不建 duyav2,同仓库 strangler fig | 成立;§4.3 是它的前置条件 |
| 类型优先而非 schema 优先 | 成立;§4.3 必须遵守 drift test #10 的偏离守卫 |
| 协议包零运行时依赖 | 成立,未松动 |
| 门禁是棘轮 | 941 条冻结,本轮 0 新增 |
| 注释不写文档反向引用 | 本轮清掉最后 5 处 |
| 不擅自改需要决策的缺口 | G-1/G-2/G-3/G-6/G-9 全部保持未决 |

新增的一条经验,值得写进计划:

> **收紧 union 之前必须先问「这个值在代码里的真实取值集合是什么」。**
> 答不上来就只能保持 `string` 加转换点——**编一个集合比没有集合更糟**,
> 因为那是个 host 会去分支的集合。
> 三轮里最贵的三个错误(`AssistantMode` / `StopReason` / 40 个 `ErrorCode`)
> 全部出自这一个动作。而 §3.1 的教训是它的推论:
> **编造因果链比编造取值集合更糟**,因为前者会顺带编出设计结论。
