# Gap register — `agent-protocol` PP-1

协议里**已记录但未解决**的缺口。每一条都写明:现象、根因、为什么现在不修、
以及**关闭它的验收标准**。放在这里而不是散在模块注释里,是因为这些是
「消费方迁移前必须有答案」的问题,不是「以后有空再优化」的问题。

规则:**一条 gap 只能被两种方式关闭——实现它,或在 `DECIDED:` 写下裁决并说明代价。**
不能既不实现也不裁决就把它留在类型里。

---

## G-1 · 闭合 `ErrorCode` 与代码实际使用的错误码几乎不相交

**严重度** 高 · **归属** PP-6(错误分类落地)· **状态** 未决

### 现象

`errors.ts` 定义了 40 个闭合 `ErrorCode`。逐个在 `packages/` `electron/` `src/`
里搜索字面量,**其中 32 个查无此串**。

代码真实在用的是另一套自由字符串,例如:

```
internal_error   missing_arg       invalid_request      agent_not_found
platform_unavailable   db_unavailable   cron_not_found    connector_auth_required
provider_error    unknown_action    invalid_arguments    unsupported_file
http_<status>     skill_not_found   not_in_catalog      connection_revoked
no_agent          invalid_id        slack_error          scheduler_unavailable
path_not_found    insert_failed     copy_failed          rm_failed
sync_failed       plugin_registry_error   missing_query   missing_operation
invalid_channel_id   blocked        skill_read_failed
```

而 worker 的 `chat:error` 定义是 `code?: string`——**自由字符串,没有闭合约束。**

### 根因

和 `AssistantMode`、`StopReason` 同源:40 个 code 是照着 07 §11 的规格写的,
不是从代码里的真实取值集合推出来的。规格给出的是一个**应当存在**的分类法,
不是**当前存在**的分类法。

### 为什么现在不修

修它需要先做一个决策,而这个决策不是我的:

**哪些层的 code 值得上 wire?** 现在至少有三层各自在发 code——
connector 层(`provider_error` / `http_<status>`)、CLI HTTP 层
(`missing_arg` / `invalid_request` / `db_unavailable`)、agent 层。
把三层全部收进一个 40 值的集合,和只收 agent 层,得到的映射表完全不同。
后者更小也更可能正确,但会丢 connector 层的可诊断性。

### 关闭条件

1. 写下裁决:**哪一层的 code 进入 `ErrorCode`,哪一层保持自由字符串**
   (建议:agent 运行期错误进,connector/HTTP 层的 code 保留在 `details` 里)。
2. 为每一个进入集合的真实 code 写一条映射,并**为未映射的 code 规定兜底**
   (当前倾向 `unclassified`,而 `UNCLASSIFIED_ERROR_CODES` 已为此预留)。
3. `worker-event-coverage.test.ts` 增加断言:代码里出现的每个 `code` 字面量
   要么在映射表里,要么被显式标为「留在 details」。
4. 补一个反向断言:`ErrorCode` 里每个值都能追溯到至少一个真实产生点,
   否则它就是又一个 spec-only 的词。

---

## G-2 · `PermissionRequest` 的三个必填字段当前无生产者

**严重度** 高 · **归属** PP-5 / PP-6 · **状态** 未决

### 现象

```ts
// packages/agent/src/process/worker-protocol.ts
export interface AgentPermissionEvent {
  type: 'chat:permission';
  sessionId: string;
  request: { id: string; toolName: string; toolInput: Record<string, unknown> };
}
```

而 protocol 的 `PermissionRequest` 必填:

| 字段 | 当前来源 |
|---|---|
| `requestId` | `request.id` ✔ |
| `toolName` | `request.toolName` ✔ |
| `toolInput` | `request.toolInput` ✔ |
| `kind` | **无** |
| `mode` | **无** |
| `expiresAt` | **无**——全仓找不到任何权限 timer |

全仓 `expiresAt` 相关的命中全是无关物(MCP lease、API 超时、DB lease)。

### 根因

`expiresAt` 的文档写着「单一权威时钟」,并描述了「旧实现里 agent 铸值、
worker 定时」的双时钟问题。**那段描述的是理想状态,不是代码现状**——
现在根本没有时钟可冲突。写成现状描述是一次没做来源核实的断言。

### 为什么现在不修

`expiresAt` 必填是**有意为之的设计**:没有期限的审批请求无法安全地
「等一会儿再说」,而 `permission.expired` 事件依赖它才能构造。
但要让它成立,运行时必须真的设 timer——那是 PP-6 的实现,不是 PP-1 的类型。

`kind` 和 `mode` 同理:runtime 有足够信息推断(`toolName` 能推出 kind,
bot approval card 路径能推出 mode),但那是 adapter 的工作。

### 关闭条件

1. 运行时在 `chat:permission` 上带出期限,或协议接受 `expiresAt` 可选
   并规定「缺失时 host 必须自己设期限」——**二者选一,不能两者都不做**。
2. `kind` 的取值集合从真实代码推导(`tool_use` / `read_path` / `write_path` /
   `execute` / ... 已列,但需确认每个都有产生点)。
3. `mode` 与 `AssistantMode` 一样做**双向**核对:runtime 真的能产出全部三种吗?
4. 字段文档改成陈述**要求**,不再陈述现状。

---

## G-3 · 协议承诺 `checkpointGeneration` 恢复,但没有 checkpoint 事件

**严重度** 中 · **归属** PP-4 · **状态** 未决

### 现象

worker 有:

```ts
export interface CheckpointEvent {
  type: 'checkpoint';
  sessionId: string;
  data: { messages: Array<Record<string, unknown>>; generation: number };
}
```

protocol 的 `ResumeSupport.checkpointGeneration` 和
`ResumeBoundary { kind: 'checkpoint_generation'; generation }` 都在,
但 `EVENT_META` 里**没有任何 checkpoint 事件**。

### 后果

host 无法得知某个 generation 存在。它只能盲目地拿一个数字去 resume,
然后收到 `invalid_resume_point`。**一种被对外承诺、却无法被发现的恢复方式,
比不承诺更糟**——调用方会写代码去试它。

### 为什么现在不修

加事件会改变 `RunEventPayloads` 和快照,是 PP-4 的范围。但**这个洞必须在
PP-4 之前被记录**,否则 PP-4 会照着「resume 支持 checkpoint」这句话去实现,
而不知道没有事件能通知 host。

### 关闭条件

二选一,并在规格里写明:

- **A**:新增 `checkpoint.saved` 事件(携带 `generation`),`ResumeSupport`
  才允许 `checkpointGeneration: true`。注意 `CheckpointEvent.data.messages`
  是完整消息数组,上 wire 前必须确认它不是凭据或超大载荷的载体。
- **B**:`checkpointGeneration` 暂时恒为 `false`,从 `ResumeSupport` 的
  能力面移除,等 PP-4 再加。

---

## G-4 · 四个真实事件没有 protocol 对应物

**严重度** 中 · **归属** PP-2 · **状态** 未决

`worker-event-coverage.test.ts` 的 `UNMAPPED` 已登记,这里只标注**产品影响**:

| worker 事件 | 字段 | 影响 |
|---|---|---|
| `chat:research_updated` | `state, phase, query, subQuestions, sourcesGathered, coverageGaps, rounds, stallRounds, history` | research 是 popover 里的真实 mode,有完整进度状态,protocol 无事件 |
| `chat:title_generated` | `title` | 会话标题是用户可见的(会话列表),protocol 无事件 |
| `chat:workflow_run` | `event, run` | workflow 是产品功能,protocol 无事件 |
| `chat:db_persisted` | `success, messageCount, reason` | 折叠进 `diagnostic`;但**写库失败不只是日志** |

前三个看起来都该是正式事件而不是 diagnostic——它们是产品状态,不是结构化日志。
第四个需要裁决:持久化失败要不要让 host 知道?(07 §13 的前向兼容要求是
「老 host 不崩」,不是「老 host 无感」。)

### 关闭条件

每个事件二选一:新增 protocol 事件,或写明「为什么 diagnostic 足够」。

---

## G-5 · `chat:done` 不带任何字段,但 `RunCompletedPayload` 有五个

**严重度** 低 · **归属** PP-2 · **状态** 未决

```ts
export interface AgentDoneEvent { type: 'chat:done'; sessionId: string; }
```

protocol 的 `RunCompletedPayload`: `status, stopReason, usage, cancelRequested`。

`stopReason` 在代码里**存在**(`DuyaAgent.ts:3154` `stopReason: turnStopReason`,
经 hook 传递),但**不走 `chat:done`**。`usage` 同理需要确认来源。

所以这些字段不是「无来源」,而是「来源在另一条链上」——adapter 需要跨链
把它们汇到 `run.completed`。这是 PP-2 的工作,但要记下来,
否则容易以为「chat:done 有这些字段」。

### 关闭条件

PP-2 的 adapter 里明确 `RunCompletedPayload` 各字段的取值路径,
或把无来源的字段从 payload 里去掉。

---

## G-6 · 同一个 `tool.call_started` 会发两次,协议无法表达「这是更正」

**严重度** 高 · **归属** PP-2 / PP-4 · **状态** 未决

### 现象

worker 对一次工具调用发**两个**事件,只有判别符不同:

```ts
// packages/agent/src/process/worker-protocol.ts:269-283
export interface SubagentToolUseEvent      { type: 'chat:tool_use';        sessionId: string; id: string; name: string; input: unknown }
export interface SubagentToolUseStartedEvent { type: 'chat:tool_use_started'; sessionId: string; id: string; name: string; input: unknown }
```

router 把两者原样转发,data 逐字段相同(`router.ts:466-477` vs `:491-502`)。
语义差别写在 `DuyaAgent.ts:2394-2397`:「the authoritative input arrives with
`tool_use`」——`tool_use_started` 是参数还在流式生成时的**临时播报**,
`tool_use` 是**权威重发**。

消费端把两者 fallthrough 到同一个 upsert,按 id 覆盖:

```
src/lib/agent-sse-client.ts:452-453        case 'tool_use_started': case 'tool_use':
src/lib/stream-session-manager.ts:2013-2014 case 'tool_use_started': case 'tool_use':
```

### 为什么这是协议问题而不只是实现细节

第二轮评审把 `tool.call_started` 改成了 **durable**。durable 的定义是
「重放后必须能重建同样的状态」。但同一次调用会带着**同一个 `toolCallId`
发两次不同的 `input`**,于是 durable 事件流里出现了自相矛盾的两条记录:

- host 若按 `seq` 顺序应用 → 状态取决于两条都到还是只到一条
- host 若按 `toolCallId` 去重 → 丢掉哪一条是未定义的
- host 若按 `toolCallId` 覆盖 → 隐式实现了「后到为准」,但这是**碰巧对**,
  不是协议保证的:重放可能只重放第一条

**协议现在没有任何字段能区分「首次播报」和「更正」。** 没有 `revision`,
没有 `supersedes`,没有 `provisional: true`。

### 关闭条件

二选一:

- **A(推荐)**:`ToolCallStartedPayload` 加 `readonly revision: number`(或
  `supersedes?: EventSeq`)。runtime 负责单调递增,host 负责丢弃低 revision。
  成本:一个字段 + 一处 runtime 赋值。
- **B**:承认 `tool.call_started` 是 **volatile**,durable 语义交给
  `tool.call_completed` 单点承担。代价:崩溃在工具执行中途时,
  恢复后**完全看不到这次调用发生过**——这正是 `payloads.ts:364-367`
  论证 durable intent 时说要避免的情况,所以 B 与那段论证冲突,
  选 B 必须同时删掉那段论证。

选 B 之前必须先回答:一次崩溃在工具执行中途的运行,恢复后 host 怎么知道
有副作用可能已经发生?

---

## G-7 · 同一个「失败」比特在本仓有三个名字,且 wire 上全部可选

**严重度** 中 · **归属** PP-6 · **状态** 未决

### 现象

| 层 | 字段 | 可选性 | 位置 |
|---|---|---|---|
| worker 事件 | `error?: boolean` | 可选 | `worker-protocol.ts:304` |
| router 转发 | `error` | 原样透传 | `router.ts:506` |
| `@duya/ai` 内容块 | `is_error?: boolean` | 可选 | `types.ts:79` |
| protocol | `isError: boolean` | **必填** | `events/payloads.ts` |

前三个是**不同的结构**(SSE 事件 vs 持久化消息内容块),所以两个名字本身
不算错;但它们**都是可选的**,而缺失和 `false` 在语义上无法区分——
「工具失败了但没人标记」和「工具成功了」在 wire 上长得一模一样。

protocol 把它改成必填是对的。**但这意味着 adapter 必须自己决定**
`error` 缺失时填 `true` 还是 `false`,而这个决定没有任何依据。

### 与 G-1 的关系

这是 G-1 的一个具体实例:错误分类没有闭合集合,于是每个字段各自退化成一个
可选布尔。G-1 关闭时如果决定「agent 运行期错误进 `ErrorCode`」,
本条应当**一并关闭**为 `RunErrorInfo` / `ToolCallFailedPayload` 上的枚举字段。

### 关闭条件

随 G-1 一起裁决。若 G-1 决定错误上闭合集,则 `isError` 降级为
「由 `error.code` 推导的冗余」或直接删除。

---

## G-8 · id 空间是 per-session 的,计数器却是 per-turn 的

**严重度** 高 · **归属** PP-4 · **状态** 未决

### 现象

```
router.ts:1329   let seqNum = 0;                              // 每次 POST 重新归零
router.ts:1568   seqNum++;
router.ts:1569   sessionManager.updateLastEventId(sessionId, seqNum);   // 写进 session 级状态
router.ts:1570   sessionManager.recordEvent(sessionId, eventType, sseEvent, seqNum);
```

`session.lastEventId` 和事件环形缓冲(`SESSION_EVENT_BUFFER_SIZE = 500`,
`session-store.ts:152-153` 保留最近 N 条)**在轮次之间从不重置**。

所以第二轮对话会**重新铸造第一轮已经用过的 id 1..M**。

### 断线重连为什么因此失效

重连路径本身**是对的**,不要误伤:

```
router.ts:2411   const missedEvents = sessionManager.getEventsSince(sessionId, lastEventId);
router.ts:2412-2423   写回 record.eventId 原始 id
router.ts:2437   let seqNum = session.lastEventId;   // 续上同一 id 空间
router.ts:2432-2436   注释明确记录了这是修过的 bug(之前是 seqNum = 0)
```

坏的是 `getEventsSince` 的过滤条件 `eventId > lastEventId` 撞上了上面的
id 复用:第二轮之后,一个带 `Last-Event-ID: 42` 重连的客户端,
可能收到**第一轮**的事件,或者因为所有新 id 都 `<= 42` 而**一个都收不到**。

### 关闭条件

protocol 侧已经有答案——`seq` 由 runtime 铸造,不由 host 计数
(`envelope.ts` 的 `seq` ownership 一节)。需要 PP-4 落地:
runtime 侧保证 `(sessionId, seq)` 单调且不复用,`id` 恒等于 `seq`,
`getEventsSince` 的比较才有意义。

在 runtime 落地前,**不要**在文档或 host 代码里声称「`Last-Event-ID`
断线续传可用」。

---

## G-9 · `since` 字段是装饰性的:声明了版本轴,却没有任何门禁消费它

**严重度** 高 · **归属** PP-3 / PP-7 · **状态** 未决

### 现象

`EventMeta.since`(`events/registry.ts:74`)声明「引入该事件的协议版本」,
30 个事件**全部**是 `'1.0'`。全仓唯一的消费者是快照测试:

```ts
// test/05-event-type-snapshot.test.ts:82-86
it('every event declares the protocol version that introduced it', () => {
  for (const [type, spec] of Object.entries(EVENT_META)) {
    expect(spec.since, `${type} has no valid since`).toMatch(/^\d+\.\d+$/);
  }
});
```

这个测试断言的是**格式**,不是行为。没有任何派发、过滤或门禁读它。

所以现状是:协议**看起来**有逐事件的版本轴,实际上第一个 MINOR  bump 之后,
一个 1.0 的 host 会收到它完全不认识的 1.1 事件,而没有任何机制拦住它。

### 为什么这条比 G-1~G-8 更根本

G-1(错误码)、G-2(permission 时钟)、G-3(checkpoint)、G-4(无对应物的四个事件)、
G-6(双发) 全部是同一类形状:**类型里声明了,生产者没有**。

在没有逐消息门禁的前提下,这类问题只有两种结局:

- 强行让生产者补齐 → 协议逼迫运行时造它没有的数据(正是 P0-1 / N-1 的成因)
- 留在类型里当摆设 → 就是现在的状态,host 会照着类型写代码

**逐消息门禁是第三种结局**,它让「运行时没有」变成一个**可声明的事实**而不是缺陷。

### 参考实现

`prime-agent` 的 `daemon-protocol.ts` 对**每一条命令和每一个事件**都挂了门禁元数据:

```ts
export interface DaemonCommandCompatibility {
  minProtocol: number;
  minSchemaRevision?: number;
  capability?: DaemonServerCapability;
}

mutate_queued_message: { minProtocol: 7, minSchemaRevision: 15, capability: "queue_message_mutation" },
heartbeats_list:     { minProtocol: 7, capability: "heartbeat_catalog" },
get_model_catalog:   { minProtocol: 7, capability: "model_catalog" },
```

它同时有**四条**版本轴(`DAEMON_PROTOCOL_VERSION = 7`、
`DAEMON_SCHEMA_REVISION = 16`、`DAEMON_UPDATE_RESTART_FORMAT_VERSION = 1`、
`DAEMON_SCHEMA_ID = "protocol-7-schema-16-1bcb9e7f1a49"`),而且 schema revision
**只在载荷变化时递增,不动 protocol version**——这正是我们缺的那条轴:

G-3 加一个 `checkpoint.saved` 事件、但没人需要它时,正确做法是
`schemaRevision++`,而不是 `PROTOCOL_MINOR++`。后者会让所有 host 进入
「需要重新探测」的状态,前者只影响真正读那个字段的人。

### 关闭条件

1. `EventMeta` 增加 `minSchemaRevision: number`(独立于 `since`),
   或者明确写下 `since` 的语义并让门禁真的读它——**二者选一**。
2. 定义 host 侧的**能力声明**(现在只有 runtime→host 单向),
   让 runtime 知道对面能不能处理某个事件。
3. 至少给 G-1/G-3/G-4/G-6 里的**一条**装上门禁,证明机制可用,
   再推广到其余。
4. drift test 断言:每个 `minSchemaRevision` 大于 1 的事件,
   都能在 `CapabilityRequirement` 里找到对应的 `needs*`。

### 代价

`EventMeta` 加一个字段(1 行 × 30 个事件)+ 一个查表函数 +
一条 `assertSatisfies` 分支。**不大。** 现在不做,第一次 MINOR bump 时
就要在四个独立部署的 host 上做兼容矩阵——那才是大的。

---

## 维护规则

- 新发现一条就加一条,**不要塞进模块注释里**
- 每条必须有 **严重度 / 归属阶段 / 关闭条件**,否则它不是 gap 只是一句抱怨
- 关闭时在条目末尾加 `关闭于:<commit>`,并把结论回写到对应模块的文档注释
- `worker-event-coverage.test.ts` 的 `UNMAPPED` 与本文件互为索引:
  测试保证「没被记录的」会变红,本文件保证「被记录的」不会被忘掉
