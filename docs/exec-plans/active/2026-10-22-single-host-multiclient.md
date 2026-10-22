# 让 Desktop 与 TUI 同时运行并共用同一个 Host 与数据库

状态：active · 负责人：本次会话 · 更新：2026-10-22
分支：codex/single-host-multiclient · worktree：E:/Projects/duya/.claude/worktrees/single-host-multiclient · base：4653c2d4 · owner：本次会话

## 目标与边界

桌面端运行期间执行 `npm run dev:tui` 不再因 `DatabaseOwnerLockError` 退出。TUI 附着到 Desktop 已经启动的 Host，两端读写同一份 `~/.duya/duya-main.db` / `duya-core.db`，并且同一 session 的 run 与事件对两个客户端都可见。

允许修改 `packages/agent-protocol`、`packages/host`、`packages/cli` 与 `apps/desktop` 的 Host 组合层。本次不改 `DatabaseOwnerLock` 语义，不做多进程共享 SQLite 写入，不建跨进程事件总线；`memory-state.db` 仍归 Desktop，TUI 不读。

关联：[610 执行队列](610-architecture-series/19-fast-track-queue.md) 的 T20（Host session service）与 T23（Desktop 接共享状态）。本计划只处理 Host 所有权与 attach，不并入 T23 的 UI 状态迁移。

## 验收

1. Desktop 以 `npm run electron:dev` 运行时执行 `npm run dev:tui`：无 `DatabaseOwnerLockError`，TUI 启动行显示附着到 Desktop Host 的 origin，且能列出 Desktop 已有 session。
2. TUI 发起一轮：`POST /v1/agent-runs/start` 被接受，事件流出现 tool/turn 帧；Desktop 同一 session 刷新后内容一致。
3. Desktop 发起一轮：TUI 在查看该 session 时显示新增消息与运行状态，延迟不超过 2 秒；若本期只做手动刷新，必须在接续记录里写明降级范围。
4. 先关闭 Desktop 再启动 TUI：自动回退到自起 ephemeral Host，行为与当前一致。
5. runtime descriptor 的 PID 已死时不 attach，回退本地 Host。
6. 附着目标的 health 声明无执行能力时，TUI 给出可操作错误并退出，不尝试自起 Host 撞锁。
7. 门禁：`npm run typecheck:all`、`npm run architecture:check`、相关 vitest；主进程改动后运行 `npm run electron:build`。

## 进度

- [x] 1. 在 Host 握手中声明执行能力，Host 服务端按已注册 API 推导，旧 Host 缺声明时按不具备处理。
- [x] 2. CLI 新增「发现并附着已有 Host」解析：读 runtime 文件、校验 PID、健康检查、能力检查；`runTuiCommand` 优先 attach，只有无可附着 Host 时才自起。
- [x] 3. Desktop 的 Host HTTP 面获得执行能力：抽取 router 现有的 turn 启动实现为单一入口，实现 `HostRunExecutionApiV1` 并注入 `HostSessionHttpServer`。
- [ ] 4. 同会话并发驱动：确认 Desktop chat lock 与 Host 执行控制器的互斥关系，缺口在 Host 侧补 lock 获取，或在计划里明确拒绝语义。
- [ ] 5. 跨客户端可见性：TUI 查看会话时增量刷新远端 run/消息；ephemeral 事件不可跨进程，按 durable 事件兜底。
- [ ] 6. 测试与验收：协议/CLI/Desktop 单测，人工双端验收，Electron 重建。

## 发现与决策

数据层已经共享，缺的是进程所有权而不是包。Desktop 与 TUI 都通过 `@duya/data` 的 `DatabaseHost` 打开同一对数据库文件（`apps/desktop/src/main/db/database-host.ts:1`、`packages/host/src/local-host.ts:347`）。

Desktop 启动时已经起了一个 Host HTTP 服务，并把 bearer token 写到 `~/.duya/runtime/host-api.json`（`apps/desktop/src/main/index.ts:324-328`、`apps/desktop/src/main/cli/desktop-host-api.ts:310-398`）。所以「Desktop 是 Host、其它界面是客户端」这条链已经存在，只是没接完。

TUI 不读这个 descriptor：`attachedHostFromEnv` 只有 `DUYA_TUI_ATTACH=1` 时才 attach，否则无条件 `startLocalHost({ ephemeral: true })`（`packages/cli/src/tui-command.ts:75-102`），于是成为第二个数据库所有者。普通 CLI 会话路径反而会复用 descriptor（`packages/cli/src/host-session.ts:48-60`），说明复用逻辑已有先例。

Desktop 的 Host 目前是纯账本：组合时只注入了 `runApi`，没有 `runExecutionApi`（`apps/desktop/src/main/cli/desktop-host-api.ts:369`）。HTTP 路由在缺少执行面时返回 `agent_run_execution_unavailable`（`packages/host/src/http-server.ts:2792-2815`）。执行控制器只在 `startLocalHost` 收到 `workerPath` 时装配（`packages/host/src/local-host.ts:480-563`）。Desktop 的真实 turn 执行在它自己的 Agent Server，入口是 `router.ts` 的 `deps.runOrchestrator.openRun`（`apps/desktop/src/main/agents/server/router.ts:1392-1420`，实例在 `apps/desktop/src/main/agents/server/index.ts:352`）。

事件可见性分两层：durable 事件由 DB 轮询游标读取（`packages/host/src/run-api.ts:187-215`），跨进程可用；ephemeral 事件只存在于执行进程的内存通道，SSE 在 live 流关闭后才补 durable（`packages/host/src/http-server.ts:2926-2952`）。因此两个客户端能看到彼此落库的事件，但看不到对方在执行进程里的 ephemeral 帧。

同会话互斥尚未闭合：Desktop router 在开跑前获取 chat lock 并镜像到 DB（`apps/desktop/src/main/agents/server/chat-runtime-lock.ts:63-82`），Host 的 `HostRunExecutionController` 没有引用 lock（`packages/host/src/run-execution.ts`）。步骤 4 必须先定这一条，否则两端同时驱动同一 session 时只有 run fence 兜底。

步骤 1 的实现改了原计划：不新增 `HostHealthV1` 字段，改为复用已有的握手 `provides`（`HostHandshakeV1`）。`/healthz` 已经为每个缺失名字生成 `unsupported` 原因（`packages/host/src/http-server.ts:455-468`），而且客户端有 `handshake()` 读取它（`packages/host/src/http-client.ts:377-381`）。新增名字只需在 `HOST_CAPABILITIES` 加一条、在 `registeredHostCapabilities` 里按 `runExecutionApi` 是否存在推导。旧 Host 不广播该名字，客户端按不具备处理，语义与原计划一致。

步骤 2 的范围：`attachedHostFromRuntime` 读 descriptor 并复用 `readLocalHostRuntime` 的 PID 校验；`discoveredHostRefusal` 用 `handshake(CLI_HOST_DECLARATION)` 判执行能力并给出带 PID 的可操作文本。两处刻意不做的事：显式 `DUYA_TUI_ATTACH=1` 路径不探测能力，因为那是测试与运维覆盖，要求能力会让指向 stub Host 的 PTY 验收无法工作；descriptor 损坏时只警告并回退自起，因为半写入文件不是「有 Host 在跑」的证据，真被占用时 owner 锁错误会带 PID。发现到的 Host 与本进程无关，`close()` 永远 no-op，只有自起的那一个会关闭。

拒绝的方案：删除或放宽 `DatabaseOwnerLock`。它保护的是迁移执行、WAL checkpoint 调度、run/worker 归属与进程内事件主干（`packages/data/src/database-owner-lock.ts:37-114`）；两个所有者会得到两条互不可见的事件总线，且迁移可能并发执行。

执行面采用委托而不是第二套控制器：把 Desktop router 中的 turn 启动实现抽成单一入口，供 router 与新的 `HostRunExecutionApiV1` 适配器共用，避免同一 Electron 主进程出现两套 worker manager 竞争同一 session。若抽取成本过高，备选是给 Desktop 的 `HostSessionHttpServer` 传 `workerPath` 让 Host 执行，但必须在计划中记录双 worker 风险，且只允许不同 session 并发。

步骤 3 的落地结果与计划不同的一点：不需要「抽取」一个新入口，`POST /sessions/:id/chat` 本身就是那个入口，而且它已经在 SSE 头写出之前 `await openRun`（`apps/desktop/src/main/agents/server/router.ts:1350-1392`、`1670-1690`）。适配器直接当这个入口的客户端，因此没有第二套 orchestrator，也没有重复的 worker manager。

新增了一个只读路由 `GET /sessions/:id/active-run`（`apps/desktop/src/main/agents/server/router.ts:3466-3478`）。原因是协议要求 `StartAgentRunResult.accepted` 立即带 run id，而现有两条路都拿不到：`run-result` 会等运行结束，SSE 体里只有 worker 帧、没有 ack。`runForSession` 是 orchestrator 已有的绑定，所以该路由不加状态。

取消走 `DELETE /sessions/:id/chat`，与桌面端停止按钮同一入口。run 到 session 的映射读 run 账本，查不到就拒绝并说明原因，不猜 session。

一个已知边界：`agent_run_execution` 的广播只看执行 API 是否注册，不看 Agent Server 当时是否存活。Agent Server 未起时 `startAgentRun` 会返回 `refused_dispatch_failed`（`the agent server is not running`），而不是让附着方以为能跑。Desktop 启动时该子进程会随之启动，所以正常路径不命中。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| 4653c2d4 / 仅新增本计划 | Windows / Node 24 | 只读调研，未运行门禁 | 未验证 | — |
| 4653c2d4 + 步骤 1 工作区改动 | Windows / Node 24.16 / vitest 3.2.4 | `npx vitest run` 4 个能力测试文件 | 0；4 文件 36 用例通过 | `host-capabilities` 14、`capability-directions` 13、`health-capabilities` 2、`capability-degradation` 7 |
| 同上 | 同上 | `npm run build:packages` | 0；构建 22 个包 | worktree 无 dist，先构建才能解析 `@duya/*` |
| 同上 | 同上 | `npm run -w @duya/agent-protocol typecheck`、`-w @duya/host`、`-w @duya/cli` | 0 / 0 / 0 | — |
| 4653c2d4 + 步骤 2 工作区改动 | Windows / Node 24.16 / vitest 3.2.4 | `npx vitest run packages/cli/src/__tests__` | 0；6 文件 35 用例通过 | 含新 discovery 7 例，环境未设 `DUYA_DATA_ROOT` |
| 同上 | 同上 | `npx vitest run packages/host/tests/health-capabilities.test.ts` | 0；2 用例 | handshake 现显式传 `HostDeclaration` |
| 同上 | 同上 | `npm run -w @duya/host typecheck`、`-w @duya/cli typecheck` | 0 / 0 | — |
| 同上 | 同上 | `npm run architecture:check` | 0；无新增越界 | 有 1 条 baseline 指纹不再触发，未重录 |
| 4653c2d4 + 步骤 3 工作区改动 | Windows / Node 24.16 / vitest 3.2.4 | `npx vitest run apps/desktop/src/main/cli/__tests__` | 0；3 文件 25 用例通过 | 新增适配器 10 例 |
| 同上 | 同上 | `npm run -w @duya/desktop typecheck:main` | 2；仅既有 baseline 错误 | 本次两个新文件与 `active-run` 路由零错误；`router.ts` 两处报错在 1940/3618，均属既有代码 |
| 同上 | 同上 | `npm run architecture:check` | 0；无新增越界 | 同一条未触发基线，未重录 |
| 同上 | 同上 | `npm run electron:build` | 未运行 | 留到 PR 前与人工双端验收一起做 |

## 接续 / 结果

步骤 1 已完成并提交：`HOST_CAPABILITIES` 新增 `agent_run_execution`（owner `host-local`），
`registeredHostCapabilities` 只在 `runExecutionApi` 存在时广播；协议与 CLI 的钉死计数同步到 23，
方向表补齐一行，新增 `packages/host/tests/health-capabilities.test.ts` 覆盖「有执行 API 才广播」与
「纯账本 Host 缺席并给出原因」。

步骤 2 已完成并提交：`duya tui` 现在先 `attachedHostFromRuntime()`，descriptor 不存在、PID 已死或
文件损坏才自起 ephemeral Host；发现到 Host 后先握手，`agent_run_execution` 缺席或 HTTP 不可达时
打印带 PID 与 `DUYA_DATA_ROOT` 建议的错误并以 1 退出。显式 `DUYA_TUI_ATTACH=1` 语义不变。
测试覆盖 discovery 的四个分支与拒绝文本，CLI 单测 35 例全绿。

步骤 3 已完成并提交：新增 `apps/desktop/src/main/cli/desktop-run-execution-api.ts`，把
`startAgentRun` 转发到 Agent Server 的 `POST /sessions/:id/chat`（SSE，后台排空，不转发帧），
把 `cancelAgentRun` 转发到 `DELETE /sessions/:id/chat`；run id 取自新增的同步只读路由
`GET /sessions/:id/active-run`。Desktop 的 `HostSessionHttpServer` 已注入该 API，`/healthz`
因此开始广播 `agent_run_execution`。适配器 10 例单测覆盖请求形状、拒绝路径与取消。
未跑 `npm run typecheck:all`、`npm run electron:build`（留到 PR 前统一跑）。
回收：不适用，PR 未创建。
下一步：步骤 4 的同会话互斥。router 里的 `acquireChatLock` 是 `void ...catch(() => {})`（
`apps/desktop/src/main/agents/server/router.ts:1336`），失败被吞掉；TUI 经 Host 走同一入口，所以
两端同时驱动同一 session 时目前只有 run fence 兜底。要么把 lock 失败变成显式 409，要么在
Host 适配器先查 active-run 并拒绝。
