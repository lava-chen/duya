# T23 — Desktop 首块接共享 RunSession：链路分析与接缝请求

- 卡片：19-fast-track-queue.md §「T23 Desktop 首块接共享状态」，车道 L-DESKTOP
- 分支：`codex/t23-desktop-shared-run-session`，基线 `19d780a8`（= `origin/master`）
- worktree：`.claude/worktrees/t23-desktop-run-session`
- 状态：**已实现（服务层）· 阻塞于一条接缝 · 未验收**
- 本卡独占：`apps/desktop/src/renderer/**`、`apps/desktop/src/main/ipc/**`、`packages/ui` 共享接线
- 本卡**不改**：`apps/desktop/src/main/agents/**`、`apps/desktop/src/preload/**`、`packages/host/**`、`packages/agent-runtime/**`

---

## 1. Desktop 真实链路（实测 file:line）

### 1.1 发送链（当前 Desktop 走的旧路）

```
renderer composer
  → packages/ui/src/App.tsx:722 enqueueMessage / startStream（legacy 分支）
  → packages/ui/src/lib/stream-session-manager.ts:1990 client.startChat(...)
  → agent server HTTP（apps/desktop/src/main/agents/server/router.ts:1605 handlePostChatSSE）
  → chat:start → worker（fork 子进程）
  → worker stdout 帧 → agent server 转 legacy `chat:*` SSE 事件
  → renderer stream-session-manager 归约
```

### 1.2 记账链（**已经是 Host durable ledger**）

```
worker 事件
  → apps/desktop/src/main/agents/db-bridge.ts:395-400
      case 'run:create' | 'run:append' | 'run:complete' | 'run:get' | 'run:events' | 'run:list-session'
  → getControlPlane().serve(...)（packages/host/src/control-plane-service.ts:306）
  → HostRunApiV1（packages/agent-protocol/src/run-api.ts:100）
  → RunStore（durable）
```

**结论：Desktop 的 run 本来就落在 Host durable ledger 上。** 终态权威性不需要新建机制，
缺的是 **renderer 读得到它** 的通道。

### 1.3 共享状态层（T10 产物，已就位）

- `packages/client-core/src/session/run-session.ts` — `RunSession`：准入/去重/跨 run 隔离/稳定快照
- `packages/ui/src/App.tsx:226-275` — `uiServices.runs.openSession(runId, sessionId, signal)`
- `packages/ui/src/App.tsx:291` — `uiServices.runs.listBySession(sessionId)`
- `packages/ui/src/App.tsx:324` — `uiServices.approvals.listPending(sessionId)`
- `packages/ui/src/App.tsx:378-385` — `uiServices.approvals.resolve(id, decision)`
- `packages/ui/src/App.tsx:683` — `uiServices.runs.start({...})`
- `packages/ui/src/App.tsx:145-151` — `resolveUiServices()`：**有 `electronAPI` 但无适配器 → `return null`**

`packages/ui` 的 Host 路径**已经写好了**，缺的只是「一个真的适配器」。

---

## 2. 本卡已实现（worktree 内）

| 文件 | 行数 | 作用 |
| --- | --- | --- |
| `packages/ui/src/services/sse.ts` | 125 | `SseFrameDecoder`（UTF-8 流式、CRLF 归一化） |
| `packages/ui/src/services/envelope.ts` | 119 | `decodeRunFrame` / `readRunEventEnvelope`（校验 runId/sessionId/seq/timestamp/traceId） |
| `packages/ui/src/services/run-session-stream.ts` | 339 | 传输抽象（`RunStreamOpener` 端口，非 URL）+ resume cursor + 增量 accept + stall watchdog + backoff |
| `packages/ui/src/services/host-api.ts` | 293 | `HostApiBridge` 端口 + `createHostHttpBridge`（bearer + SSE 流） |
| `packages/ui/src/services/ui-run-session.ts` | 201 | 组合层：**自己持有 `RunSession`**，流式与轮询回退投进同一 surface；**终态只报不发明** |
| `packages/ui/src/services/ui-services-factory.ts` | 143 | **由 bridge 构造 `UiServices` 的唯一实现**（Web/Desktop 共用），只映射不裁决 |
| `packages/ui/src/services/ui-services-factory.test.ts` | 137 | 5 条定向用例：字段不发明、迟到的列表被丢弃、已放弃的选择不再发请求、start 输入原样透传、Host 拒绝不被吞 |
| `apps/desktop/src/renderer/lib/desktop-ui-services.ts` | 107 | Desktop 适配器薄壳：只提供端点（`origin` + `token`）与能力报告 |
| `apps/web/src/client/{sse,envelope}.ts` | 改写 | **改为对 `packages/ui/src/services/*` 的 re-export**，消除第二份实现；导出名不变，Web 既有测试零改动通过 |

设计要点：

- 传输是**端口**（`RunStreamOpener`）不是 URL ⇒ Desktop 与 Web 共用同一套流状态机，差异只在「怎么开流」。
- 终态一律来自 Host durable ledger（`listRuns` 轮询），`getDurableStatus` 只报告、**不发明**状态。
- `RunEventStreamOptions.session?` 让组合层与调用方共享**同一** `RunSession` 投影，避免两份裁决状态。

### 2.1 门禁证据（实测）

| 门禁 | 结果 |
| --- | --- |
| `tsc --noEmit`（根 tsconfig：覆盖 `packages/ui/**` + `apps/desktop/src/renderer/**`） | **0 错误** |
| `npm run -w @duya/web typecheck`（`apps/web`） | **0 错误** |
| `vitest run packages/ui/src/services/ apps/web/tests/client/` | **56/56 通过**（7 文件） |
| `node scripts/architecture/architecture-check.mjs` | **OK — no new boundary violations**（2877 tolerated） |
| `npm run typecheck:all` | ⛔ **环境红，未能跑完**（见下） |

**`typecheck:all` 为什么没跑完**（不是本卡引入的）：

```
[build-packages 10/10] @duya/agent-runtime
src/tools/mcp-executor.ts(5,36): error TS2307:
  Cannot find module '@duya/capabilities/AppServer/app-tool-context'
```

根因是 worktree 的 `node_modules` 是指向**主仓库**的 junction，
`node_modules/@duya/capabilities` ⇒ 主仓库 `packages/capabilities`。
而主检出停在**落后的 `master`（`3c1e26d0`）**，且 `packages/capabilities/` 存在
**另一 session 的未提交改动**（`MM packages/capabilities/package.json`、
`?? packages/capabilities/src/AppServer/`）——主仓库的 `dist/AppServer/`
只有 `in-process-app-server.*`，缺 `app-tool-namespace` 与 `app-tool-context`。
worktree 自己的 `packages/capabilities/dist/AppServer/` 是**齐的**（它构建成功），
但 `packages/agent-runtime` 解析 `@duya/capabilities` 时走的是 junction ⇒ 指向落后的主仓库。

⇒ 与本卡改动无关：本卡只碰 `packages/ui/src/services/**`、
`apps/desktop/src/renderer/lib/**`、`apps/web/src/client/**`，
`packages/agent-runtime` 不导入其中任何一个。
根 `tsc --noEmit`（覆盖本卡全部改动面）为 0 错误，可作为等价信号。

**修掉的真错误**（Web 类型检查抓出，非根 tsc 抓出——两者 `lib` 不同）：

1. `services/index.ts` 导出了并不存在的 `RunEventStreamState`（实际名为 `RunStreamState`）
2. `ui-services-factory.ts` 的第二处 `signal?.aborted === true`：早返回后
   TS 的控制流分析已把它收窄为 `false | undefined`，故第二次比较被判为「不可能」。
   已改为经 `abandoned()` 函数读取——abort 是**运行时事实**，
   类型层面的收窄不该让它变得不可观测。
3. 测试里 `vi.fn(async () => …)` 未声明参数，`mock.calls[0][0]` 取不到元素。

> 注：测试放在 `packages/ui/src/services/` 而不是 `apps/desktop/src/renderer/`，因为
> `vitest.config.ts` 的 include 数组**不含** `apps/desktop/src/renderer/**` ——
> 放在那儿会被 `check-test-coverage` 判为「没有运行器收集的孤儿测试」。
> 共享的组合层因此下沉到 `packages/ui`，Desktop 侧只留薄壳。

---

## 3. 阻塞点（逐条证据）

### 3.1 renderer 到 Host HTTP API 不通

| 障碍 | 证据 |
| --- | --- |
| Host 强制 bearer | `packages/host/src/http-server.ts:594-598` |
| Host 拒绝带 `Origin` 的请求 → 浏览器 fetch 必带 Origin | `packages/host/src/http-server.ts:603-604`（403 `origin_not_allowed`） |
| Desktop Host 未注入 `runExecutionApi` → start/cancel 404 | `packages/host/src/http-server.ts:2774,2784,2799`（`agent_run_execution_unavailable`）；`apps/desktop/src/main/cli/desktop-host-api.ts:204-271` 只注入了 `runApi`(259)/`permissionRequestApi`(265)/`toolApprovalApi`(266) |
| port/token 只写文件，preload 不暴露 | `apps/desktop/src/main/cli/desktop-host-api.ts:184,270,274-284` → `<dataRoot>/runtime/host-api.json` |
| BrowserWindow 安全 | `nodeIntegration:false` + `contextIsolation:true` ⇒ renderer 不能自带进程外能力 |

### 3.2 renderer 可达通道全集清点（`apps/desktop/src/preload/index.ts`，共 442 个通道）

- **有**：`db:session:*`（→ `getDesktopHostSessionApi()`，sessions 平面已 Host-backed）、
  `db:permission:create|get|resolve`、`db:toolApproval:get`、
  `agent-server:get-port` / `agent-server:getUrl` / `agent-server:getPort`
- **无**：`db:run:*`、pending approval 列表、run start/cancel、通用 `db:request`

`db-bridge.ts` 的 `run:*` 分支**只**在 agent server 进程内经 `deps.dbRequest` 可达，**没有**暴露成 renderer 可触达的通道。

### 3.3 agent server 不提供 `/v1` 路由

`apps/desktop/src/main/agents/server/router.ts` 无 `/v1/*` 路由，其 SSE 是 worker 的 legacy `chat:*` 帧流，
**不含 `RunEventEnvelope`**。且该文件属 19-plan §3 **公共单写者清单**，本卡不得改。

---

## 4. 接缝请求（给 App 桥接 / Host owner）

### 请求 A（必需）— renderer 读 Host durable ledger + pending approvals

**改哪个函数**：`apps/desktop/src/main/agents/server/router.ts` 新增只读路由（该文件是公共单写者，故走接缝）

**为什么不能放自己车道**：19-plan §3 把它列入公共单写者清单。

**建议形态**（renderer 经 preload 已有的 `agent-server:getUrl` 直连；agent server CORS `*`，无 Origin 拒绝、无 bearer）：

| 路由 | 后端 | 复用 |
| --- | --- | --- |
| `GET /v1/agent-runs?sessionId=` | Host Run API | `deps.dbRequest('run:list-session')`（`db-bridge.ts:400`） |
| `GET /v1/agent-runs/{runId}/events?afterSeq=` | Host Run API | `deps.dbRequest('run:events')`（`db-bridge.ts:399`） |
| `GET /v1/permission-requests?sessionId=` | Host Permission API | `getDesktopHostPermissionRequestApi()`（`desktop-host-api.ts:480`） |

**备选 B**：在 `apps/desktop/src/main/ipc/**`（L-DESKTOP 独占）加 IPC handler，Main 进程内直调
`getDesktopHostRunApi()`（`desktop-host-api.ts:500`）/ `getDesktopHostPermissionRequestApi()`，
再由 **preload owner** 在 `apps/desktop/src/preload/index.ts` 暴露命名空间。
preload 本卡不可改，故仍需接缝。

> 选 A 的理由：改动面最小（只加路由，router 内已有 `deps.dbRequest`），且不新增 preload 通道。

### 请求 B（必需）— 取消动作送达

取消要「只在 Host ledger 确认后显示完成」，因此需要两件事：

1. 读账 → 已在请求 A 内；
2. 取消送达执行中的 worker → Desktop 现有取消是 agent server 侧 `chat:interrupt` 路径，
   **本卡需先确认该路径在 Host 模式下的落点**（候选：请求 A 的路由加 `POST .../cancel`，
   转发到 agent server 的 interrupt 通道）。**此项属实现阶段待定，不在本次请求范围内拍板。**

### 请求 C（可选，若选 B 方案）— Host 侧补 `runExecutionApi`

`apps/desktop/src/main/cli/desktop-host-api.ts:204` 的 `new HostSessionHttpServer({...})` 补
`runExecutionApi`（契约见 `packages/agent-protocol/src/run-api.ts:262`），
使 `POST /v1/agent-runs/start` 与 `POST /v1/agent-runs/{id}/cancel` 不再 404。
**本卡不需要它**——Desktop 的执行发起已由 agent server 闭环（§1.1），Host 只需提供账本读写。
若最终决定让 Desktop 改走 Host 发起执行，则此项升为必需。

---

## 5. 能力保留清单（不能为接适配器静默删除现有功能）

### 5.1 结论先行

**Desktop 旧路径与 Host run 路径不是同一条能力面。**
旧路径（`client.startChat` → agent server → `chat:start`）带 **20+** 个 turn 字段；
Host run 路径（`startAgentRun` → manifest → `buildLegacyRunInput`）**只带 1 个**。

**所以「适配器接上就切生产入口」会静默删功能。** 下面每一行都带 file:line。

### 5.2 两条路径各自读什么（实测）

**旧路径**（`packages/host/src/worker-process-entry.ts` 的 `handleChatStart`）读：

`options.files`(1751-1755) · `options.permissionModeOverride`(1851) ·
`options.titleGenerationModel`(1700) · `options.wakeless`(1691) ·
`options.messages` / `systemPrompt` / `language` / `mentionedSkills` / `mentionedPlugins` /
`mentionedProviders` / `agentProfileId` / `model` / `defaultWorkspaceDirectory` /
`workingDirectory` / `runtimeConfig`（`worker-session-runtime.ts`）

**Host run 路径**（`packages/host/src/worker-run-composition.ts:310-333`）读：

```ts
attachments: { kind: 'inline', value: [] },
options: { permissionMode: facts.permissionMode },
```

**只有 `permissionMode` 一个键，附件是硬空数组。**
`facts.permissionMode` ← `manifest.permissionPolicy.mode`
（`worker-headless-run-host.ts:551`）← `intent.permissionMode ?? 'default'`
（`manifest-factory.ts:204-205`）。

而 `run-execution.ts:340-367` 构造 intent 时**没有设置 `permissionMode`**，也没有设置 `effort`：

| intent 字段 | 来源 | 结果 |
| --- | --- | --- |
| `workingDirectory` | `input.workingDirectory`（343-345） | ✅ |
| `model` / `providerId` / `apiFormat` | `input.*`（346-360） | ✅ |
| `maxTurns` | `input.options.maxTurns`（335-342） | ✅ |
| `agentProfileId` | **`defaults.agentProfileId`**（361-363），**不是** input | ⚠️ 只能取默认值 |
| `permissionMode` | **未设置** | ❌ 恒为 `'default'` |
| `effort` | **未设置** | ❌ 丢失 |
| `modes` / `tools` / `permissionRules` / `hostSwitch` | **未设置** | ❌ 丢失 |

### 5.3 逐字段矩阵（Desktop 旧路径 → Host run 路径）

| Desktop 旧路径字段 | Host run 路径承载 | 状态 |
| --- | --- | --- |
| `model` | `manifest.agent.model` ← `input.model` | ✅ |
| `providerId` | `manifest.agent.providerId` ← `input.providerId` | ✅ |
| `workingDirectory` | `manifest.cwd` ← `input.workingDirectory` | ✅ |
| `maxTurns` | `manifest.budget.maxTurns` ← `input.options.maxTurns` | ✅ |
| `permissionModeOverride` | `manifest.permissionPolicy.mode` ← `intent.permissionMode` | ❌ **未接线**（恒 `'default'`） |
| `effort` | `manifest.agent.effort` ← `intent.effort` | ❌ **未接线** |
| `agentProfileId` | `manifest.agent.profileId` ← `defaults.agentProfileId` | ⚠️ 只能取默认值，**不能按 turn 覆盖** |
| `files`（附件） | `attachments.value` 恒为 `[]` | ❌ **无通路** |
| `outputStyleConfig` / `displayContent` / `systemPrompt` / `language` | 无 | ❌ 丢失 |
| `mentionedProviders` / `mentionedSkills` / `mentionedPlugins` | 无 | ❌ 丢失 |
| `mode` / `conductorMode` / `conductorCanvasId` | 无 | ❌ 丢失 |
| `titleGenerationModel(+Config)` / `providerConfig` / `securityScanEnabled` | 无 | ❌ 丢失 |
| `maxTokens` | 无 | ❌ 丢失 |
| `defaultWorkspaceDirectory` / `backgroundTaskResume` / `clientMsgId` | 无 | ❌ 丢失 |

`StartAgentRunInput.options`（`agent-protocol/src/run-api.ts:167`）确实是自由字典，
`run-execution.ts:366` 也确实把它整包传进 `intent.options` ——
**但 Host run 路径在 `buildLegacyRunInput` 处只取 `permissionMode` 一个键，其余连同
`intent.options` 一起被丢掉。** 协议能传 ≠ 路径会传。

### 5.4 对本卡的影响

1. `UiStartRunInput` 扩字段**不够**：扩展只让请求带上这些字段，Host run 路径仍然不读。
2. 附件（`files`）在 Host run 路径上**完全没有载体**，
   `worker-headless-run-host.ts` 的注释也写明「a headless host has NO wake source and its
   prompt is a plain string, so no image or document block can reach the turn」。
3. ⇒ **保留 Desktop 现有能力必须由 Host 侧补**，而 `packages/host/**` 是公共单写者文件
   （19-plan §3）⇒ **接缝请求 C**（见 §4）。

---

## 4bis. 接缝请求 C（必需）— Host run 路径的能力保全

**改哪个文件**：`packages/host/src/run-execution.ts`（intent 构造，`:340-367`）、
`packages/host/src/worker-run-composition.ts`（`buildLegacyRunInput`，`:310-333`）、
`packages/host/src/manifest-factory.ts`（intent → manifest，`:200-252`）。

**为什么不能放自己车道**：`packages/host/**` 属 L-HOST / 公共单写者，19-plan §3。

**要什么**（每条都对应 §5.3 的一行 ❌）：

| # | 要求 | 落点 |
| --- | --- | --- |
| C1 | `permissionMode` 能从 start 请求到达 manifest | `run-execution.ts` 填 `intent.permissionMode`（`manifest-factory.ts` 已有该字段） |
| C2 | `effort` 能从 start 请求到达 manifest | `run-execution.ts` 填 `intent.effort`（`manifest-factory.ts:247` 已在读） |
| C3 | `agentProfileId` 能按 turn 覆盖 | `run-execution.ts` 用 `input.options.agentProfileId` 优先于 `defaults` |
| C4 | 附件能到达 turn | `buildLegacyRunInput` 的 `attachments` 不再恒空；需 Host 侧定义承载形态 |
| C5 | `modes` / `tools` / `permissionRules` / `hostSwitch` 能到达 manifest | `run-execution.ts` 填对应 intent 字段（`RunTurnIntent` 已有） |

**验收**：Host 侧一条测试——用 `startAgentRun` 发起带 `permissionMode`/`effort`/`agentProfileId`
的 run，断言产出的 manifest 的 `permissionPolicy.mode` / `agent.effort` / `agent.profileId`
与请求一致；附件另有一条断言其到达 turn 输入。

**不回退方案**：若 C1–C5 不做，T23 只能切「不带附件、不带权限模式覆盖、不带 effort、
不带 agent profile」的 Desktop —— 那是**删功能**，不是接共享状态。故 **C1–C3 是 T23 上线的硬前置**。

---

## 6. 验收路径（必须走真实 Desktop 入口）

1. 两轮发送：含工具审批、工具结果回到下一次 provider 请求
2. 刷新 / 重连后无重复助手消息，工具状态正确
3. 取消只在 Host ledger 确认后显示完成
4. 慢历史恢复与快速发送不覆盖新 run
5. 覆盖 failed / cancelled、切换会话、迟到响应
6. 定向测试 + `npm run typecheck:all` + `npm run architecture:check`
7. 涉及模块入口时 `npm run electron:build` + Playwright 驱动真实 Electron
8. 记录既有失败 file/test/signature，不用旧基线掩盖新增回归

既有基线（2026-10-20 实测）：`npm test` 红（CI 64 文件 / Windows 45）；
`typecheck:all` 绿（需先 `build:packages`）；`architecture:check` 绿（2826 tolerated）。

---

## 7. 未覆盖 / 风险

### 7.1 硬阻塞（不解决就不能切生产入口）

| # | 阻塞 | 归属 | 后果 |
| --- | --- | --- | --- |
| A | renderer 读不到 Host durable ledger | App 桥接 / router owner | 没有真实 run ⇒ 无验收证据 |
| B | 取消动作在 Host 模式下的落点未定 | App 桥接 / router owner | 取消无法只在 ledger 确认后显示完成 |
| C1 | `permissionMode` 未从 start 请求到达 manifest | **L-HOST**（`packages/host/**`） | 用户选的权限模式**静默失效** |
| C2 | `effort` 未从 start 请求到达 manifest | L-HOST | 思考档位**静默失效** |
| C3 | `agentProfileId` 只能取默认值 | L-HOST | 无法按 turn 选 profile |
| C4 | 附件在 Host run 路径无载体（`attachments.value` 恒空） | L-HOST | **附件功能整体消失** |
| C5 | `modes` / `tools` / `permissionRules` / `hostSwitch` 未接线 | L-HOST | 模式/工具/规则丢失 |

C1–C4 是**删功能**，不是接共享状态。**T23 的「保留现有能力」这一条无法在 Desktop 侧单独完成。**

### 7.2 本卡已做但未验证到底

- §5.3 矩阵已逐行实测到 file:line，但**没有真实 run 走一遍**证明「丢失」发生在用户面前
  （真实 run 需要 A 先落地）。
- `apps/web/src/client/{sse,envelope}.ts` **已收敛**为对 `packages/ui/src/services/*` 的 re-export
  （两者原本逐字节相同，导出名不变，Web 既有 51 条测试零改动通过）。
- `apps/web/src/client/run-stream.ts` **仍是第二份实现**：本卡的 `run-session-stream.ts`
  把传输从 URL 改成了**端口**（`RunStreamOpener`），签名不同，不能直接 re-export。
  收敛需要改 Web 的 `RunEventStream` 调用点与其测试
  （`apps/web/tests/client/run-stream.test.ts` 13 条），属**跨车道**改动 ——
  `apps/web/src/client/**` 归属未在 19-plan §3 列明，**先确认归属再动**。

### 7.3 纪律

- 旧 `subscribeSession` / `startStream` 路径与 Host 路径**不可同时运行**（两份裁决状态）——
  切换必须一次性，且放在 A + C1–C4 落地并验证之后。
- `packages/ui/src/App.tsx:150` 的 `return null` 行为保留：没有适配器时 Desktop 仍渲染空白，
  这是现状，不在本卡改动范围内。
- `apps/desktop/src/renderer/main.tsx` **未改**（未调用 `configureUiServices`）——
  符合「适配完整并验证后，再切换对应生产入口」。
