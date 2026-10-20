# 权限事实不丢 + 取消有终态 + 门禁覆盖 TUI

> **Status**: 代码已改（worktree `worktree-tui-permission-cancel-fix`），门禁/typecheck 待跑
> **Priority**: P1
> **Created**: 2026-10-20
> **Related**: [610-architecture-series](./610-architecture-series/README.md) §D9 / §D9.7、[611-tui-bugfix-slice](./611-tui-bugfix-slice.md)

---

## 背景

对「本地跑的 TUI 背后整条 agent 链路」做了一次通读，落到五条观察。逐条核到底，
其中三条是**事实性缺陷**，两条是**本来就该这样**。

---

## 一、权限事实：一条事实，沿途丢了三次

### 事实链

```
执行器 (StreamingToolExecutor:1343) 组装 {mode, expiresAt, decisionReason}
  → ports.requestPermission
  → worker 的 options.requestPermission (worker-run-contracts.ts:82)
  → createPermissionHandler (worker-process-entry.ts:1606) ── chat:permission 帧 ──┐
                                                                                 ▼
                                            Host: WorkerPermissionRequests.request()
                                                                                 ▼
                                            permission_requests 表（客户端读回的地方）
```

### 三个丢失点

| # | 位置 | 丢了什么 | 后果 |
|---|---|---|---|
| L1 | `worker-process-entry.ts` `createPermissionHandler` | `decisionReason` | 帧里没有 `reason`，下游读不到 |
| L2 | `run-orchestrator.ts:1976-1977` `#contextFor` | `mode` 写死 `'generic'`、`kind` 写死 `'generic'` | 翻译器优先用 context → 协议事实被常量替换 |
| L3 | `worker-permission-requests.ts` + `PermissionLedger` | `mode` / `expiresAt` / `reason` 没有列 | 读回 ledger 的客户端只能显示通用文案 |

### 为什么「轮询」不是兜底，而是**唯一**通路

这一条本 plan 的第一版判断错了，读码读到更下面才纠正：

- **live SSE 流由 native 通道独占**。run 一旦下发就被标成 native
  （`run-execution.ts:263`），于是 legacy 帧翻译出来的事件**不会**发布到 live 流
  （`run-execution.ts:252`：`if (!this.#nativeRunIds.has(event.runId)) this.#liveRunEvents.publish(event)`，
  注释写明「Legacy frames still feed settlement but must not mint a second live seq」）。
- **引擎不自己铸 `permission.requested`**。`gateRunApproval`
  （`worker-run-composition.ts:206-216`）把引擎自己的 approver 端口丢掉
  （`void askApproval;`），真正的发问在 legacy 执行器那一侧，走的是上面那条
  legacy 帧的路。
- ⇒ **native 通道上没有 `permission.requested` 的生产者；legacy 帧翻译出的事件又不上 live 流。**
  CLI TUI 今天能弹权限框，**全靠那 1 秒轮询**。

SSE 侧的管线其实都齐了（translator 有 `case 'permission'`、`projectHostEvent` 有
`permission.requested`、`TUIApp.showPermission` 已接上 overlay），只是**没有生产者**。
这与 610 §D9.7 的净结论一致 —— 见下面第四节。

### 改动

- **L1**：`chat:permission` 帧补 `reason`（来自执行器的 `decisionReason`）。
- **L2**：翻译器 `translatePermission` 改为**优先取帧上的 `mode`**，
  context 只在帧没带 mode 时兜底。`kind` 维持原样（协议 G-2 禁止从工具名推）。
  —— 这一条现在只影响 run 的**持久转录**（翻译出来的事件进 controller 的 ledger），
  但那里记的也是审计链上的事实，`'generic'` 是错的。
- **L3**：`permission_requests` 加三列（core 迁移 **id 42**，幂等 `ALTER TABLE`），
  协议 `HostPermissionRequest` 加 `mode` / `expiresAt` / `reason`，
  `WorkerPermissionRequests.request()` 把 worker 的原话透传进 record。
- **CLI TUI**：轮询改用真实字段（reason / mode / expiresAt / destructive），
  不再写死文案、不再伪造过期时间。轮询是唯一通路，所以它必须无损。
- **Desktop**：ledger 兜底路径（`packages/ui/src/App.tsx`）改用 record 里的真实
  mode/reason/expiresAt，工具名推断只当旧记录的 fallback。
- **附带**：`worker-headless-run-host.ts:794` 的 `expiresInMs` 把 `startedAt` 加进了
  duration —— headless 的权限过期时间落在 2084 年，等于永不过期。改为纯 duration。

---

## 二、取消：两段式是对的，但终态没回来

两段式（先断 SSE 读取、再让 Host 停 worker、最后确认）**站得住**：
`run-orchestrator.ts:1445` 的 `cancelRun` 在返回前已经 `#finish()` 把 run 落成
durable terminal，所以 TUI 取消后再查状态是「确认」而不是「竞态重试」。

缺的是**终态本身**：

- `cancelAgentRun` 只回 `{requested, runId}`，TUI 得多发一次 `getAgentRun`，
  而且失败时只能抛一句「Host has not confirmed」。
- TUI 在 `interrupt()` 里先 `activeStream.abort()`，于是**永远看不到**
  `run.completed/cancelled` 的终态原因 —— 用户只看到「Cancelling run…」。

### 改动

- `CancelAgentRunResult` 加 `terminal?: RunTerminalState`；
  Host 的 `cancelAgentRun` 把它带回来（`run-execution.ts`）。
- CLI TUI 优先用随应答回来的 terminal，缺了才回退到 `getAgentRun`；
  确认后把终态打出来（cancelled / failed + error code）。

---

## 三、门禁：分层是对的，但覆盖面只有一个入口

`scripts/architecture/client-closure-gate.mjs` 的 `CLIENT_ENTRIES` 只有
`packages/client-core/src/index.ts` 和 `packages/cli/src/chat.ts`。
**TUI 这个客户端面没有被量过** —— 将来谁在 `packages/cli/src/tui/` 里拉一次 runtime，
门禁不会报。

### 改动

- `CLIENT_ENTRIES` 加 `packages/cli/src/tui/index.ts`。
- 门禁自测同步：`reports` 列表断言、`CLIENT_ENTRIES` 列表断言，
  并补一条「新入口必须真的被量到」的断言（防「什么都没扫到」的假绿）。

---

## 四、610 §D9.7 的裁决：结论对，理由要换

§D9.7 的净结论「`permission.requested` 在生产里没有任何生产者」—— **对**。
但它给的三条证据里，证据一（`gateRunApproval` 丢端口）不足以支撑它，
因为**真正让结论成立的是另一条**：

> live 流由 native 通道独占（`#nativeRunIds` 守卫），而引擎不铸这个事件。

所以「无生产者」的准确表述是：

- **native 通道**：引擎不铸 → 无生产者。
- **legacy 通道**：翻译器能铸，但翻译出来的事件**不上 live 流**
  （只进持久转录、供结算用）→ 也不构成客户端可见的生产者。

**本 plan 没有改这个结论，也没有去动它** —— 那是 610 的口径题
（引擎该不该发 `permission.requested`、策略拒绝该用哪个事件），需要人拍板。
本 plan 做的是：**在只有轮询这一条通路的前提下，把轮询变成无损的。**

---

## 五、不动的两条

- **凭据只读 `~/.duya/config.toml` + `secrets.json`**：桌面端
  `apps/desktop/src/main/config/migrate.ts:139-143` 写的正是同一套 flat-dotted
  `providers.<id>.apiKey`，两端共用 `~/.duya`，**不存在分叉**。
- **`DUYA_TUI_ATTACH=1`**：测试钩子，行为正确（attach 时不关别人的 Host）。

---

## 验收

```bash
npm run typecheck:all
npx vitest run packages/host/tests/run-execution.test.ts
npx vitest run packages/host/tests/worker-permission-requests.test.ts
npx vitest run packages/agent-runtime/test/translator-projector.test.ts
npx vitest run scripts/architecture/client-closure-gate.test.ts
node scripts/architecture/client-closure-gate.mjs
```

## 未做

- 轮询**没有删**，也没有降级为「兜底」：今天它是唯一通路。
  要让它变成兜底，得先让 native 通道铸出 `permission.requested`（610 的题）。
- `blockedPath` 没有进 record：worker 帧里根本没有这个字段。
- Desktop 侧自己的 `permission-coordinator` 是另一条通道，未在本 plan 范围内。
