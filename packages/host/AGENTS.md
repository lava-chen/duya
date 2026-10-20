# @duya/host

> 与 Electron 无关的产品 Host。**运行链的绝大多数排障都在这里**。

## 1. 负责 / 不负责

负责：
- manifest 冻结与指纹 `buildRunManifest`（`packages/host/src/manifest-factory.ts:171`，深冻结 `:269`，指纹 `:270`）
- `RunOrchestrator`（`packages/host/src/run-orchestrator.ts:289`）、`createWorkerExecutionChannel`（`:2586`）
- worker 生命周期 `WorkerManager`（`packages/host/src/worker-manager.ts:68`，fork `:248`，interrupt `:491`）、`WorkerSession`（`packages/host/src/worker-session-runtime.ts:135`）、`startWorkerProcess`（`packages/host/src/worker-process-entry.ts:3833`）
- 工具装配 `ToolRegistry`（`packages/host/src/worker-tool-registry.ts:33`）、`createBuiltinRegistry`（`packages/host/src/worker-tools/builtin.ts:50`）
- 控制面动作 `run:create` / `run:append` / `run:complete` / `run:get` / `run:events`（`packages/host/src/run-control-plane.ts:159`，分发 `:369`）、`RunRepository` 端口（`packages/host/src/repository-port.ts:133`）
- HTTP 服务（`packages/host/src/http-server.ts`、`startLocalHost` `packages/host/src/local-host.ts:345`）、run 事件主干（`packages/host/src/run-event-spine.ts:89`）
- **模式注册表在这里**：`packages/host/src/worker-modes/modifiers/registry.ts:163`

不负责：
- Electron 主进程与渲染进程 → `apps/desktop`
- 事件 / 信封 / manifest 的线上形状 → `@duya/agent-protocol`（`packages/agent-protocol/src/index.ts:25`）
- 运行引擎与 seq 铸造 → `@duya/agent-runtime`（`packages/agent-runtime/src/events/event-emitter.ts:297`）
- DB schema 与存储实现 → `@duya/data`
- LLM 客户端 → `@duya/ai`

## 2. 关键文件

| 文件 | 作用 |
| --- | --- |
| `packages/host/src/manifest-factory.ts:171` | 组装 manifest。**故意不在 runtime 组装**：自选输入又自证指纹等于没有指纹（`:5`）；`providerId ?? 'env'` 会被标成 SYNTHESISED（`:246`） |
| `packages/host/src/run-orchestrator.ts:637` | `openRun`——run 身份在这里铸造：`randomUUID()`（`:638`）；5 个拒绝阶段各自返回 `{accepted:false, stage}` |
| `packages/host/src/worker-process-entry.ts:3833` | worker 命令循环入口（文件 3837 行）；另有 `DUYA_AGENT_ROLE === 'workflow-runtime'` 子模式（`:3712`） |
| `packages/host/src/worker-transport.ts:92` | NDJSON over 子进程 stdout/stdin；`:104` 解析；背压队列上限 2000 帧 / 4 MB（`:14`） |
| `packages/host/src/run-control-plane.ts:159` | 控制面动作工厂；`run:append` 的 fence 检查在 `:241`，`run:complete` 的在 `:294` |
| `packages/host/src/worker-db-bridge.ts:1` | worker 的 `db:request` 由 Host 派发；**未实现的域必须快速失败**（`:14`），静默空结果会伪装成"没数据" |

## 3. 排障入口

| 症状 | 先看这里 | 为什么 |
| --- | --- | --- |
| run 起不来 / 回合无错挂起 | `packages/host/src/run-orchestrator.ts:637` | `openRun` 返回 `{accepted:false, stage}`，stage 就是拒绝点 |
| worker 根本没起来 / 启动即崩 | `packages/host/src/worker-manager.ts:236` | 入口路径不存在时直接抛（路径由调用方解析：`apps/desktop/src/main/agents/server/worker-manager.ts:16`、`packages/cli/src/worker-path.ts:5`）；崩溃日志落在 `%TMP%/duya-agent-crash/`（`packages/host/src/worker-process-entry.ts:3781`），退出分类在 `packages/host/src/worker-manager.ts:292` |
| worker 拒绝这一轮 | `packages/host/src/worker-process-entry.ts:1757` | 调 `verifyRunManifestBinding`（`packages/agent-core/src/run-manifest-verification.ts:249`），返回 `input_binding_mismatch` 或 catalog skew |
| 终止事件永不落地 | `packages/host/src/run-orchestrator.ts:1259` | `#finish` 收尾；`:1368` 的 `#releaseTerminalToConsumers` 放行被扣住的终止 |
| 权限弹窗卡住 | `packages/host/src/worker-process-entry.ts:1606` | 300 s 超时在 `:1628`；pending 表按 `sessionId::id` 存（`:593`） |
| 工具对模型不可见 | `packages/host/src/worker-session-runtime.ts:1506` | 日志 `N/M tools visible after visibility filter` |
| 取消没反应 | `packages/host/src/run-orchestrator.ts:1428` | → `packages/agent-runtime/src/controller.ts:983` → `packages/host/src/worker-manager.ts:491`（先优雅后 SIGKILL）。worker 不存在时返回 `disposition:'unavailable'`（`:2616`），不是假成功 |
| DB 写入被拒 / run 行卡在 `terminal=NULL` | `packages/host/src/run-control-plane.ts:241` | fence 拒绝（orchestrator 侧处理在 `packages/host/src/run-orchestrator.ts:592`）； stranded 行由 `#closeAbandonedRun` 关闭（`packages/host/src/run-orchestrator.ts:903`） |

## 4. 边界约束

- 架构层 `host`（`architecture-policy.yaml:119`），模块 `duya-host` `managed: true`（`:225`）。
- **run 身份在 Host 铸造**（`packages/host/src/run-orchestrator.ts:638`），manifest 由 Host 组装（`packages/host/src/manifest-factory.ts:1`）。这不是风格问题：换地方组装就让指纹自证。
- `packages/host/src/run-orchestrator.ts:2045`、`:2071`、`:2079` 处的 `packages/agent/src/...` 字符串是**元数据**，指适配器，不指 owner。
