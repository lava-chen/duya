# 613 — CLI 手动上下文压缩（`/compact`）

> **状态**：Active · **前置调研**：2026-10-18（本文件所有 `file:line` 均在该时刻的 `master` 上核对过）
> **相关**：plan 611（CLI TUI Wave 1，已落地 `4fcedd83`）· plan 610（turn.completed 生产者正在落地期间写本计划）

## 修订说明

本文件是**新计划**，没有原稿。但它是从一个**已被证伪的前稿结论**上长出来的，所以先把这次修订的性质写清楚：

| 前稿断言（2026-10-17，未落文件） | 事实（2026-10-18 实证） | 本计划的处理 |
| --- | --- | --- |
| 「`packages/host` 无 manual compaction 入口，需要从零建」 | worker 进程里有完整的手动压缩实现，含冷启动水合与 busy 门 | 不再重建能力，只补**出口**（D1） |
| 「`(packages/host/src/worker-compaction/engine-sources.ts:129)` 的 `manual` 未覆盖 = 要修」 | 那条记录描述的是 *pre-turn coordinator*，手动压缩**永远不该走它** | 明确**不动**它，并在 D10 里写清为什么「修」它是错的 |
| 「要做会话外执行器」 | 会话外执行器**确实要做**，但它只有 ~150 行：转发一条 IPC 命令 + 等回包 | Phase 1 收缩为一个虚构并用假 WorkerManager 测的转发器 |

计划整体从一个「跨包大重构」降级为「**两个明确的缺口**」：Host 缺一条 HTTP 出口，CLI 缺一条命令注册。

## 一句话目标

让 `duya chat` 里输入 `/compact` 就能压缩当前会话上下文——不新建 run、不调模型回答问题、结果的 Durability 与现有自动压缩完全一致。

## Scope

### In

| 项 | 位置 |
| --- | --- |
| Host 侧会话压缩执行器（`SessionCompactor`） | 新建 `packages/host/src/session-compaction.ts` |
| 一条会话级压缩 HTTP 出口 | `packages/host/src/http-server.ts` |
| 执行器↔服务器的契约类型 | `packages/agent-protocol/src/` |
| `WorkerManager` 多订阅者 fan-out（今天是单槽） | `packages/host/src/worker-manager.ts:73`、`:115` |
| Host HTTP client 方法 | `packages/host/src/http-client.ts` |
| CLI `/compact` 命令 + 压缩后重载 transcript | `packages/cli/src/tui/slash/compact.ts`、`chat.ts` |
| command-catalog 的 `compact` surfaces 扩到 `cli` | `packages/command-catalog/src/index.ts:164-174` |

### Out（**每条都写理由**，不是只列名字）

| 项 | 不做的理由 |
| --- | --- |
| 改 `UNCOVERED_TRIGGERS` 让 `manual` 变成「已覆盖」 | 那条记录的主语是 pre-turn coordinator（`engine-sources.ts:129-132`）。手动压缩**按定义**不在 turn 循环里，服务的对象是另一个完全不同的入口。把它删掉只会让「每个 trigger 由谁服务」这张表失去意义。见 D10。 |
| 让手动压缩产出 `compaction.started/completed/failed` 五个 RunEvent | 那五个帧的生产者 `runCompactionPass`（`agent-runtime/src/engine/compaction.ts:132`）要求一个 `RunEventStorePort`——也就是一个 **run**。手动压缩没有 run，伪造一个等于污染 610 T01 正在收紧的 ledger 不变量（谁发 `turn.completed`）。 |
| 暴露 `strategy` / `maxMessagesToKeep` 参数 | worker 支持（`:3637`），但它们是内部旋钮，用户无从得知取值含义。v1 只透出 `customInstructions`。 |
| Desktop 老链路重构 | `router.ts:2746` 的 `handlePostCompact` 走 lazy-spawn + SSE，工作正常且不在 CLI 关键路径上。本计划不碰它，只把它当**形状参考**（D3）。 |
| 把自动压缩也迁出 turn 循环 | 与本计划正交，且会自动压缩正是 server-side /pre-turn 语义。 |

## 设计决策

### D1 · 压缩在「会话现有的 worker 进程」里执行，复用已存在的 `compact` IPC 命令

worker 侧链路**已经完整存在**：

- 命令类型：`agent-protocol/src/worker-protocol.ts:138-141` — `CompactCommand { type: 'compact'; sessionId }`
- worker 分派：`host/src/worker-process-entry.ts:3125-3128` — `case 'compact' → handleCompactMessage(msg)`
- 实现：`:3578-3652`
  - 初始化未完成 → 挂起等到 ready（`:3580-3582`）
  - turn 进行中 → 等 5s，仍忙则回 `compact:error`（`:3589-3605`）
  - **冷 worker 从 DB lazy-load 重建时间线**（`:3611-3626`）
  - `agent.compact({ strategy, maxMessagesToKeep, customInstructions })`（`:3637`）
  - 结果以 `compact:done` / `compact:error` 回主进程（`:3647`、`:3652`）
- 真实执行体：`host/src/worker-session-runtime.ts:2219-2244` — `trigger: options?.trigger ?? 'manual'`，空时间线直接抛错
- **命令通道是通的**：`WorkerManager.sendCommand` 写 stdin（`:570-590`），worker 主循环除了 `process.on('message')` 还 `for await (const msg of options.commands ?? parseStdin())`（`:3673-3685`），两条通道都进同一个 `handleCommand`。

**备选 A — 起一个「零 turn 的 run」**：`StartAgentRunInput.prompt` 是必填非空字符串（`http-server.ts:4540`）且必然走到模型调用；要表达「不做模型的维护动作」得给 run 协议加一个意图位，并把这种伪 run 写进 ledger。**裁定：否决。**

**备选 B — Host 进程内重建 timeline 跑压缩**：等于把 `handleCompactMessage` 的「水合 → 决策 → 执行 → rebase」四步在 Host 重写一遍，顺带绕过 worker 自己的 busy 门。**裁定：否决。**

### D2 · 新增的是「会话级压缩端点」，不是 run 的另一种形态

```
POST /v1/sessions/{sessionId}/compact     SSE 响应
```

这条路没有 `runId`，**不能**挂在 `/v1/agent-runs` 下（该前缀的所有子路径都被理解为 run 生命周期）。
契约仿照既有的可选能力注入：`HostRunExecutionApiV1`（`agent-protocol/src/run-api.ts:271`）以可选字段进入 `http-server.ts:348`，未装配时回 404 `agent_compaction_unavailable`——**「没装配」和「装配了但失败」必须是两个不同答案**。

### D3 · 传输用 SSE + keepalive，不用长轮询

压缩是一次**数分钟**的 LLM 调用。Desktop 的参照实现在 `router.ts:2821` 显式加了 `startSSEKeepAlive`，注释是「上下文压缩是一次长耗时 LLM 调用，同样会出现 >120s 的静默间隙」——这是同一件事在**同一 codebase 里已经踩过的坑**，不是理论风险。
另外既有的两个客户端超时常量都对它错：`REQUEST_TIMEOUT_MS = 5_000`、`RUN_REQUEST_TIMEOUT_MS = 25_000`（`http-client.ts:244-246`）。

**实现要求**：不要写第二个 SSE 解析器。`watchAgentRunEvents`（`http-client.ts:431-447`）已经在 fetch 上手解析 `text/event-stream`；把它抽成一个共享 reader，`compactSession()` 复用它。

**Go / No-Go（Phase 0 末尾裁定）**：真机上一次 `/compact` 能在 5 分钟无字节间隙下活到终帧 → Go。不行 → 兜底：改长 POST + 专用 `COMPACT_TIMEOUT_MS`，并在 UI 上改成 spinner 而非流式。

### D4 · 并发策略：拒绝，不排队

- 该会话有未 settled 的 run → `409 session_busy`。
- 该会话已有一个在飞的压缩 → `409 compact_in_flight`（`Map<SessionId, pending>`）。

理由：worker 自己的门是「等 5s 然后报错」（`:3589-3605`），Host 侧提前拒绝能给一条更精确的话；语义上照搬 Desktop 用 `transitionState(COMPLETING)` 当锁（`router.ts:2769-2777`）的**意图**，但不为此发明状态机。

### D5 · 执行器放在 `session-compaction.ts`，并给 `WorkerManager` 加多订阅 fan-out

今天 `WorkerManager` 的消息处理是**单槽**：字段 `onWorkerMessage`（`:73`）由 `setMessageHandler`（`:115`）赋值，`run-execution.ts:236-240` 是唯一持有者。第二个消费的需求会直接把它的处理器顶掉。

**所以**：新增 `addMessageListener(fn): () => void`，`setMessageHandler` 变成它的薄 wrapper（保持既有调用点不变）。压缩执行器订阅后只认自己 sessionId 的 `compact:done` / `compact:error`。

**为什么这条 request/response 不能走现有 compact 管道**：`#onWorkerMessage`（`run-execution.ts:394-421`）把 `compact:*` 交给 `normalizeWorkerEvent` → `orchestrator.observe(sessionId, ...)`。没有 run 绑定的会话，这些帧被静默丢弃——所以「顺着现有管道就自动能用」是错的假设。

### D6 · 结果契约：对齐后再出门，**不把两个帧的 union 形状泄漏给客户端**

worker 回来的两种帧形状不同（`compact:done` 带 `result` 对象，`compact:error` 带 `message`/`reason`）。对齐为一个：

```ts
export type SessionCompactResult =
  | {
      readonly status: 'ok';
      readonly strategy: string;
      readonly tokensRemoved: number;
      readonly tokensRetained: number;
      readonly removedCount: number;
      readonly messageCount: number;
    }
  | { readonly status: 'error'; readonly code: string; readonly message: string };
```

**关于 token 数**：压后半段的 ctx 百分比刷新**不能指望 run bus**——`handleCompactMessage` 在 `:3646` 调的 `emitLiveUsage` 发的是 `chat:token_usage`，它同样会被 `observe` 丢掉。所以 `/compact` 自己从返回的 `tokensRetained` 报告数字（结合 CLI 已会查的 provider/model capability 表算窗口占比），不依赖总线。

### D7 · CLI UX：**没有反馈就是最大的 bug**

一个跑好几分钟、成功后屏幕上什么都不变的命令，和命令不存在没有区别。规格：

1. `/compact` 立刻打印一行 `Compacting… this can take a minute; no model output will appear until it finishes.`
2. 流式期间每个 `step`/keepalive 不刷屏，只在收到终帧时替换这一行。
3. 成功 → `Compacted: removed N messages, freed ~X tokens, kept ~Y.`（`X`/`Y` 用 `footer.ts` 已有的 `formatTokenCount`）
4. 失败 → `printError(code + message)`，且**不伪装成功**。
5. 成功后**重载 transcript**。

> 重载不能复用 `ctx.actions.adoptSession`——它在 `chat.ts:841` 会打印 `Switched to "..."`，而用户并没有切换会话。新增 `TuiSlashActions.reloadTranscript(sessionId)`。

### D8 · command-catalog：`compact` 的 surfaces 从 `['desktop']` 扩到 `['desktop', 'cli']`

`command-catalog/src/index.ts:167-177` 现在是 `surfaces: ['desktop']`，并且 `tests/catalog.test.ts:81-84` 故意锁死了这个「desktop-only 但 CLI 仍能按名解析」的例外。**只有那一条要改**（`:82` 的 `toEqual(['desktop'])` → `toEqual(['desktop','cli'])`，`:84` 的 `false` → `true`，连同 `:81` 那句已失效的注释）。

> 顺带校正一个容易连带改错的地方：`catalog.test.ts:103-108` 那条 `names).not.toContain('compact')` 断言的是 **`specsForSurface('cli', { hasSession: false })`**——「没有会话时不显示」，而 `compact` 带着 `requiresSession: true`（`:176`）。改完 surfaces 它依然该为绿，**不要动它**。

**备选 — 不动 surfaces**：CLI 依然能跑（`advertisedSpecs` 取的是「catalog 的 cli 视图 ∩ 处理器表」的交集，这个交集只决定**是否展示**，不决定能否解析），但 `/compact` 不会出现在补全弹窗和 `/help` 里。那正是 intersection 规则要防的失败态：**能执行但查不到**。裁定：扩。

> ⚠️ 顺带提醒（上一轮踩过）：`slash/__tests__/slash-commands.test.ts` 里有一条**写死的排序命令名清单**，新增命令必须在正确位置补项（按字典序在 `clear`/`cost` 之间）。

### D9 · `/compact [instructions]`：参数转发为 `customInstructions`

- 无参 → `agent.compact({})`（worker 走默认策略）。
- 有参 → `agent.compact({ customInstructions })`。
- `strategy` / `maxMessagesToKeep` **不透出**（见 Scope Out）。

### D10 · **不要**去「修」 `UNCOVERED_TRIGGERS` 里的 `manual`

这条是本计划最容易做反的一件事。`host/src/worker-compaction/engine-sources.ts:129-132` 写的是：

```ts
const UNCOVERED_TRIGGERS: Readonly<Record<string, string>> = {
  model_switch: '...not served by the pre-turn coordinator',
  manual: 'manual compaction is not served by the pre-turn coordinator',
};
```

它回答的问题是「哪些 trigger 不该从这个 Source 进来」，答案是「correctly declined with a named reason」。手动压缩落地之后它**依然不该从这里进来**——走了 `WorkerSession.compact()` 这条完全不同的路。所以 Phase 里**不留任何关于它的任务**；它的存在是对的答案。

## 契约

### HTTP

| Method | Path | 请求体 | 成功响应 |
| --- | --- | --- | --- |
| `POST` | `/v1/sessions/{sessionId}/compact` | `{ "instructions"?: string }` | `200 text/event-stream` |

SSE 帧（沿用 Desktop 的字段名以减少概念数）：

| event | data | 时机 |
| --- | --- | --- |
| `compact:started` | `{ sessionId }` | 命令已投递到 worker |
| `compact:keepalive` | `{ at: number }` | 每 15s（无 intermediate 帧时的心跳） |
| `compact:completed` | `SessionCompactResult`（`status:'ok'`） | 收到 `compact:done` |
| `compact:failed` | `SessionCompactResult`（`status:'error'`） | 收到 `compact:error`，或 worker 不可达 / 超时 |

错误码（JSON body，非 SSE）：

| HTTP | code | 条件 |
| --- | --- | --- |
| 404 | `agent_compaction_unavailable` | 未注入 `sessionCompaction` 能力 |
| 404 | `session_not_found` | 会话不在 Host stores 里 |
| 409 | `session_busy` | 该会话有未 settled 的 run |
| 409 | `compact_in_flight` | 已有一个在飞的压缩 |

### CLI 侧新增表面

```ts
// packages/cli/src/tui/slash/types.ts
export interface TuiSlashActions {
  interrupt: () => void;
  adoptSession: (sessionId: string) => Promise<void>;
  startFreshSession: () => Promise<void>;
  /** Re-read the durable transcript and repaint. No "switched" notice. */
  reloadTranscript: (sessionId: string) => Promise<void>;   // NEW
}
```

```ts
// packages/host/src/http-client.ts
async compactSession(
  sessionId: SessionId,
  options?: { instructions?: string; signal?: AbortSignal },
): AsyncIterable<{ event: string; data: unknown }>;   // NEW — 复用抽出的 SSE reader
```

## Phases

### Phase 0 — 真机探针（Go / No-Go，先不要写任何产品代码）

- [ ] 在真实 `duya chat` 会话里把 worker 放冷（等 idle reap，`worker-manager.ts:649-681`），确认 `spawnWorker(sessionId)` 单独调用后 worker 能起来并且**摘要器能拿到 provider 配置**——这是本计划最大的未知数：`WorkerManager.spawnWorker`（`:230`）签名只有 `sessionId`，不像 Desktop 的 `lazySpawnWorkerForCompact` 会补 `config:provider:get`。
- [ ] 确认 `journal.appendRebase`（`worker-process-entry.ts:1464-1474`）落的东西能被 `GET /v1/sessions/{id}/messages?includeSuperseded=false`（CLI 的 `loadSessionMessages`，`chat.ts:470-482`）读出来。
- [ ] 记录一次手动压缩的真实耗时，作为 D3 keepalive 间隔的依据。

**Go/No-Go**：冷 worker 摘要器拿不到配置 → **立刻降 Scope**：Host 侧检测到无活 worker 时直接 `409 no_live_worker`，要求用户先发一条消息把 worker 带起来；不去补 provider 配置通道（那是另一件事）。

**门禁**：`git status --porcelain` 干净（Phase 0 不落代码）。

### Phase 1 — Host 执行器

- [ ] 新建 `packages/host/src/session-compaction.ts`：`SessionCompactor`，端口形状 `{ ensureWorker(sid), sendCommand(sid, cmd), onWorkerMessage(fn) }`——**不直接吃 `WorkerManager`**，为了可测。
- [ ] `worker-manager.ts`：加 `addMessageListener(fn): () => void`；`setMessageHandler` 改为其薄 wrapper，保持 `run-execution.ts:236` 调用点不变。
- [ ] `SessionCompactor.compact(sessionId, opts)`：在飞锁 → ensure worker → `sendCommand` → 等 `compact:done`/`compact:error` → 对齐为 `SessionCompactResult`；**必须带超时**（默认 10 分钟，可配）。
- [ ] worker 未投递成功（`:573` 返回 false）→ 回 `status:'error', code:'worker_unreachable'`，不静默。

**门禁**：`node node_modules/vitest/vitest.mjs run packages/host/tests/session-compaction`
+ `node node_modules/typescript/bin/tsc -p packages/host/tsconfig.json --noEmit`

### Phase 2 — HTTP 出口与装配

- [ ] `packages/agent-protocol/src/`：`HostSessionCompactionApiV1 { compact(input): Promise<SessionCompactResult> }`（与 `HostRunExecutionApiV1` 同处一份，保持 discoverable）。
- [ ] `http-server.ts`：在 `messagesMatch`（`:2102`）之后、`sessionMatch`（`:2169`）**之前**插入 `/^\/v1\/sessions\/([^/]+)\/compact$/`。顺序不能反，否则被通用 session 匹配吃掉。
- [ ] 404/409 三个分支各自的结构化错误；SSE 写出复用 `:2702-2703` 的写法。
- [ ] `local-host.ts`（`:465` 附近有 `resolveWorkerPath`）装配 `SessionCompactor` 并注入 http-server options。

**门禁**：`node node_modules/typescript/bin/tsc -p packages/host/tsconfig.json --noEmit`
+ `node node_modules/typescript/bin/tsc -p packages/agent-protocol/tsconfig.json --noEmit`

### Phase 3 — Host client

- [ ] 把 `watchAgentRunEvents`（`http-client.ts:431-447`）里的 SSE 读盒抽成内部 helper。
- [ ] 新增 `compactSession()`，走共享 reader；**不带 `RUN_REQUEST_TIMEOUT_MS`**（自己管 signal）。

**门禁**：既有 `HostSessionHttpClient` 测试全绿（不新增覆盖即有red之前先跑基线）。

### Phase 4 — `/compact`

- [ ] `command-catalog/src/index.ts:167-177`：`surfaces: ['desktop', 'cli']`。
- [ ] 改 `tests/catalog.test.ts:81-84`：`:82` 的期望值翻成 `['desktop','cli']`，`:84` 的 `false` 翻成 `true`，并删掉 `:81` 那句已失效的注释。**`:103-108` 的 `hasSession:false` 断言保持不动**（D8）。
- [ ] 新建 `packages/cli/src/tui/slash/compact.ts`，group `'Session ops'`。
- [ ] `slash/types.ts` 加 `reloadTranscript`；`chat.ts:978` 附近补实现（`replaceTranscript(await loadSessionMessages(...))`，**不**调 `adoptSession`）。
- [ ] `slash/registry.ts` 展开 `...COMPACT_COMMANDS`。
- [ ] `slash/__tests__/slash-commands.test.ts` 排序清单补 `'compact'`。
- [ ] busy 时拒绝：用 `ctx.busy` 直接拒绝并提示，不要指望服务端 409 是唯一防线。

**门禁**：
```
node node_modules/vitest/vitest.mjs run packages/command-catalog packages/cli/src/tui
node node_modules/typescript/bin/tsc -p packages/cli/tsconfig.json --noEmit
cd packages/command-catalog && node ../../node_modules/typescript/bin/tsc -b
```

### Phase 5 — 真机验收

Phase 0 的探针变成真验收，见下。

## Verification

| # | 断言 | 怎么验 |
| --- | --- | --- |
| V1 | `/compact` 之后 transcript 里出现摘要，且被折叠的历史不再以原始消息出现 | 真机：`duya chat` 累积 >30 条消息 → `/compact` → 看 transcript 重载结果 |
| V2 | （**这条是本计划的存在理由，必须验**）压缩后的会话**下一轮还能继续说**，模型能引用压缩前的事实 | 压缩后接着问一个只有历史里有的细节 |
| V3 | 没有任何 `run` 被创建、没有 `turn.completed` 被发射 | 压完查 `GET /v1/agent-runs?sessionId=…` 的数量与压前一致 |
| V4 | busy 时被拒，且 UI 给出明确提示 | 长 turn 流式期间输入 `/compact` |
| V5 | 压缩失败（`strategy:'none'`，时间线为空）时，**不伪装成功** | 全新会话立刻 `/compact` —— worker 会抛 `Compaction failed: conversation is empty`（`worker-session-runtime.ts:2220-2222`），UI 必须把它报出来 |
| V6 | -unit 层：执行器在 worker 拒收 / 超时 / worker 中途 exit 三种情况下都能正常返回 `status:'error'`，不挂住请求 | `packages/host/tests/session-compaction/` |
| V7 | `UNCOVERED_TRIGGERS.manual` 仍在原位（`git diff` 无该行改动） | `git diff -- packages/host/src/worker-compaction/engine-sources.ts` |
| V8 | 新增 Files 不破坏架构门禁 | `npm run architecture:ipc-census`（本计划不新增 IPC 通道，应无变化） |

## 依赖与序号

- **编号 613**：`ls docs/exec-plans/active/` 现存最大为 **612**（`612-rollout-recovery-hardening.md`）。注意 611 发生过抢号（`611-tui-bugfix-slice` / `611-tui-foundation-slice` / `611-tui-ux-overhaul` 三个文件同号），本计划不复用，也不用 611。
- **前置**：无硬依赖。但建议避开 610 T01（`turn.completed` 生产者）在同一共享检出上并行的窗口——两者都会碰 `run-execution.ts` / `worker-manager.ts` 附近的热点。
- **索引**：`docs/exec-plans/README.md` 的表格已在 `tui-ux-overhaul`（第 408 行）之后补一行。

## 风险

| # | 风险 | 处置 |
| --- | --- | --- |
| R1 | **冷 worker 的摘要器拿不到 provider 配置**（Phase 0 的主要探测目标） | Phase 0 的 Go/No-Go 兜底：无活 worker 时 409 `no_live_worker`，不补配置通道 |
| R2 | `MessageCompactionController` 在 `worker-session-runtime.ts:1067-1070` 构造时**没有传 `onCompacted`**，所以 `message-compaction-controller.ts:401` 的回调是空转；Durability 实际靠 `journal.appendRebase`（`worker-process-entry.ts:1464`） | V1 专门验这层。若 rebase 不足以让 `includeSuperseded:false` 的读路径正确折叠 → 单开一个 follow-up 补 `onCompacted`，**不顺手塞进本计划**（那是 Durability 语义，与本计划的「补出口」正交） |
| R3 | SSE 在 >5 分钟场景下的稳定性（D3） | keepalive 15s + Phase 0 实测；兜底改长 POST |
| R4 | Phase 2 的路由顺序：插在 `sessionMatch`（`:2169`）之后会被静默吃掉 | 插在 `messagesMatch`（`:2102`）之后；V8 之外补一条针对该路径的集成断言 |

## 待裁定

1. **busy 时的策略**：拒绝（推荐，D4）还是「排队，等当前 turn 结束后自动执行」？后者体验更顺，但需要 Host 记住意图并在 settle 时触发，多一条状态。
2. **冷 worker 行为**：Phase 0 之后按 R1 兜底（推荐，保守）还是补一条 provider 配置通道把它做成完整能力（多一个包的工作量）？
3. **`/compact` 是否允许在压 plat 空会话时的 `strategy:'none'` 报成功**？我倾向 **V5 那样报错**——「什么都没做」和「做了且成功」必须可区分，但这会让「新会话里手滑按到」多一条红字。
