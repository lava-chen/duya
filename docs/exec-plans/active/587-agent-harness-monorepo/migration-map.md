# 迁移映射：文件职责、目标位置与删除条件

> 每行在实施时补具体文件/消费者/commit/测试。当前是目标映射，不是批量mv指令。
> Proposed子目录以职责命名，可复用现有位置；公开边界与验收不得随目录命名改变。

## 1. 目标树

```text
apps/desktop/src/
  contracts/                     # browser-safe Desktop DTO
  main/control-plane/            # services + explicit repository ports
  main/agents/server/            # transport/composition + temporary legacy adapters
  main/db/                       # existing SQLite implementation/migrations
  preload/                       # platform bridge
  renderer/                      # UI
packages/agent-protocol/src/      # wire contracts/codec/version/capability
packages/agent-core/src/          # pure policy/reducers/transforms
packages/agent-runtime/src/
  run/                           # lifecycle/write ordering/coordination
  loop/                          # model stream/turn/finalize
  tools/                         # pipeline/registry/scheduler
  context/                       # loaders and assembly
  ports/                         # IO interfaces
  adapters/                      # reusable capabilities, no Electron
packages/agent/                  # temporary compatibility facade, shrink then delete
packages/{ai,plugin-core,computer,conductor,gateway,voice,cli}/
evals/agent/                     # external consumer of same runtime API
apps/agent-server/               # only when a real second host warrants composition
```

不为了树形对称造agent-tools/memory/storage/shared/ui空包。复用现有provider/插件/电脑能力；host持有平台适配器。

## 2. 旧 agent 全顶层模块

| 当前区域 | 拆分与目标 | 阶段 / port | 旧位置退出条件 |
| --- | --- | --- | --- |
| agent | reducer core；TurnAssembler/Preparer async、StreamRunner/Dispatcher/Finalizer runtime；旧DuyaAgent facade | M5 / model、context、tool、telemetry | 所有真实caller走新runtime，E4matrix通过 |
| process | workerbootstrap/commandsadapter host；通用run execution runtime | R2/M5 / ExecutionChannel | 单dispatch/stop，privateconfig合法，H8删除shim |
| tool | catalogDTO protocol；纯判定core；registry/pipeline/scheduler/subagent runtime；FS/Bash能力adapter | M5 / ToolExecutor、Process、Permission | 工具全consumer/stream执行回归，无deepimport |
| modes | 声明/reducer core；tools/hooks runtime；durableGoal/Research CP | M5/C6 / ModeStateRepository | 生命周期/continuation/snapshot/restart用例 |
| prompts | 纯渲染core；Hbsloader/cacheIO runtimeadapter；assets随bundle | M5 / TemplateLoader | promptparity/cachefixture及packassets |
| compact | transforms/policy core；modelcompression/IO runtime | M5 / model/transcript | compact/上下文预算/历史完整性 |
| context | selection纯算法core；assembly/scan/watch runtime | M5 / ContextLoader | provenance、watch失效、取消清理 |
| session | transcript/context执行接口runtime；durableconversation CP/repository | C6 / TranscriptRepository | multirun session，reopen读回，无主包回flow |
| memory-state | schemaDTO按consumer归属；durablebusiness CP；SQLite迁移host | M5/C6 / MemoryRepository | agent→mainmigration0；Projectscope不变 |
| memory-rollout | append/读回adapter host；runtime使用port；索引CP | C6/D7 / RolloutRepository | 持久化和checkpoint职责明确 |
| message | JSONwire protocol；pureconvert core；storage/ingest host/runtimeport | T3/M5 / codec/transcript | Promise/storage/UI对象不混入protocol |
| hooks | 纯声明core；executor/asyncbus runtime；platformcommandadapter | M5 / HookExecutor | veto、失败诊断、pertool顺序、取消 |
| skills | descriptors可protocol；discovery/load/cache/watch runtimeadapter；安装UIhost | M5 / SkillLoader | root/profile隔离与reloadsnapshot |
| permissions | wire protocol；policy/classifier core；environment/realpath runtime；approval CP | R2/M5/C6 / PermissionBroker | 单deadline/scope、deny0execution、TOCTOU |
| mcp | 公共binding/catalogprotocol；session/transport/invoke runtimeadapter；vault/installhost | M5 / ConnectorInvoker | L1–L9conformance与degraded/reconnect |
| agentsmd | 纯优先级/选择core；FS嵌套加载runtimeadapter | M5/C6 / InstructionLoader | 复用既有loader，source/digest准确 |
| ipc | 公共messages protocol；portbridge host/runtimeadapter | T3/M5 / transport | 三通道实际handshake、schema与auth |
| agent-profile | 纯组合core；产品存储CP；执行参数runtime | M5/C6 / ProfileRepository | profile/mode/permission正交 |
| sandbox | enforcement adapter host/capability；policy core | C6/X3 / SandboxProvider | 能力声明与真实OS隔离一致 |
| wake | trigger/scheduler CP；投递adapterhost；runmailbox runtime | C6/H8 / RunIntent、Mailbox | wake↔automation切边，重复trigger幂等 |
| lifecycle | 纯状态core；cleanup/lease协调runtime/CP | R1/D7 / lifecycle/lease | terminal唯一，timer/process无泄漏 |
| decisions | 纯策略core；跨run durable CP | M5/C6 / decisionports | 状态归属单一、可审计 |
| channels | wireDTOprotocol；外部channelhost；run输入runtime | C6/H8 / Inbound/Delivery | session/channel不混，附件实际投递 |
| security | 纯归一化core；实际path/network/tokenhostadapter | M5/C6 / policy/enforcement | 不弱化分层检查、无credentialleak |
| mentions | pureformatcore；文件/connector解析runtime | M5 / Resolver | 同名附件和引用来源保留 |
| journal | durablelog/checkpointadapter；CP索引 | C6/D7 / JournalRepository | commit/reopen/resumefaultmatrix |
| config | 公共refs/schema按consumer；load/secretprivatehostadapter | R2/C6 / ConfigResolver | 生效配置与manifest一致，无secret公开 |
| observability | wireeventprotocol；runtimeport；loggerbackends host | M5 / Telemetry | trace/run关联、脱敏、noDesktoploggerimport |
| providers | ai复用；runtimefactory/adapter；hostcredentialresolver | R2/M5 / ModelClient | safe retry/fallback，usage真实 |
| queue | 通用执行队列runtime；跨run调度CP | R2/C6 / queue | bytes/concurrencylimit，cancel不饿死 |
| abort | runtime取消token/控制；hostkilladapter | R2/M5 / Cancellation | 有界grace、process树清理 |
| cli | parser/commands/interaction归clihost；旧runtimehelper抽runtime | M5/H8 / RunAPI | agent→cli0，CLI真实执行 |
| utils | 各功能归所属层，纯函数就近；不建立新万能utils | M5 / perconsumer | 无跨层barrel与隐式IO |
| types | 每个export分别wire/internal/storage/UI；保留期限re-export | T3/M5 / contracts | consumer归零才删 |
| constants | 协议词汇protocol；策略core；platformhost | T3/M5 | 不从constants间接导入实现 |
| modules | 若仍为空仅清目录；出现实现按实际职责分类 | M5 | 没有consumer，保持功能证据 |

上述“区域”包括顶层types/constants文件及目录，口径不用于重复统计LOC。

## 2.1 运行能力闭环：资源、入口与生产验收

本节把“目标归属”与“生产路径已迁移”分开。包边界参考
`E:\cloned-projects\minimax-code\packages` 的实际组织：`agent-core`、
`agent-runtime`、`agent-extension`、`agent-tools`、`local-runtime` 与
`tui` 分别承担核心契约/组装、扩展 SPI、内置适配器、平台工具、本地 Host
和产品 CLI/TUI。该仓库的价值是 owner 分离；目录名或 manifest 存在本身
不证明某项行为在生产入口运行。Duya 继续复用现有 `agent-protocol`、
`agent-core`、`agent-runtime`、`capabilities`、`tooling`、`host`，不为对称
而新建空包，也不把 Minimax 的实现或其包名直接搬入。

| 能力/旧入口 | 新 owner 与切片 | 资源和构建约束 | 必须通过的生产验收 |
| --- | --- | --- | --- |
| 工具定义、校验、授权、调度、执行、progress/result（`packages/agent/src/tool/**`，当前 `StreamingToolExecutor`） | 工具契约在 Protocol；纯策略在 Core；工具 adapter/registry 在 Capabilities/Tooling；取消、审批编排和执行生命周期由 Runtime/Host Run API 持有。2026-10-13 shell 切片：BashTool schema、校验、权限决策、命令规范化、输出裁剪与结果投影已移到 `@duya/capabilities/ShellCommandTool`；Agent 旧路径仅剩组合适配器。shell detector/provider、intelligence、safe-rm、soft-yield、常量也由 capabilities 实现并经兼容 re-export 使用。 | 已检查的底层合同：Protocol 有通用 `ToolUse`/结果事件；Runtime 有 `ToolPort.dispatch/drain/discard/describe` 和 `ProcessScope`，但没有 Host 可实现的 shell managed-task/审批/副作用回执接口。新加的 `ShellCommandRuntimePorts` 是 capability 包本地的临时注入缝，当前只有 Agent `startManagedBash` adapter；它尚未接入 Runtime `ToolPort` 或 Protocol，也不是 Host API。Agent adapter/shims 只是过渡层；最终切换由 Host/Runtime 直接装配 capability，Desktop、CLI、automation 等消费者归零旧 Agent 调用后删除 shim 与 `packages/agent` 旧执行入口。 | 下一片先明确 Runtime `ToolPort` 到 shell lifecycle 的 adapter 合同，再经 Desktop、Host CLI、独立 CLI 验收：未授权时执行次数为 0；执行中取消能终止对应任务/进程树并落 terminal；进度可按 run/tool id 观察与重连；成功/失败结果写入 durable run transcript；失败注入后 receipt 能区分“未派发、已执行但未记账、已记账”，重试不伪称 exactly-once。当前 bundle 构建成功，capability 可通过注入端口真实启动 PowerShell；这不是 Agent managed-process adapter 或 Host Run API 的真实工具轮次证据。断言必须走生产 Run API/worker bridge，而非直接调用 dispatcher fixture。 |
| Prompt、Context、历史压缩与指令组合（`prompts/`、`context/`、`compact/`、`agentsmd/`、`skills/`） | 模板渲染、优先级与选择算法归 Core；文件/模板/缓存/skill loader 归 Runtime adapter；Profile/Mode 等冻结决策进入 RunManifest；Host 组装一份带来源和 revision 的输入快照。 | `.hbs`、skill 文件/脚本和动态模板必须有唯一 AssetResolver；路径来自运行包而非 `packages/agent` 的相对路径。技能与模板版本/缺失状态写入诊断信息；所有入口用同一解析规则。 | 建立 golden parity 用例，锁定组合顺序：基础 system → 用户/项目指令 → profile/mode/channel/wake → skills 与动态 context → 历史/压缩 → tool schema；明确冲突时的优先级。对 Desktop、Host CLI、独立 CLI 逐一验证快照等价（仅声明的平台差异可不同），并验证缺模板/skill 时明确失败或显式降级，不能静默变空 prompt。 |
| 包资源（`packages/agent/skills/.system`、`prompts/assets/**`、脚本、可能的 `modules/**`） | 资源跟随其运行 owner 的发行物；优先由 Host 统一解析和版本化。只有确有独立发布/复用边界时才提取资源包。`modules/` 下 README 先逐份确认是用户加载内容、示例还是历史文档，再决定保留路径和 loader。 | build、CLI bundle、Electron `extraResources/asar`、BashWorker 子入口都纳入资源清单；在打包后检查路径、文件数/摘要和可读权限。开发目录可用不能替代安装包验证。 | 对每种受支持产物执行资源清点与真实加载：Host 源码运行、干净 CLI bundle、真实 Electron packaged app；抽测内置 skill 的入口脚本和 prompt 模板。缺资源要在启动/能力探测阶段给出可诊断错误，不能等到模型轮次才报找不到文件。 |
| Cron、wake、durable intent、重试与恢复（Desktop `AutomationScheduler`、wake dispatch） | Control Plane/Host 是唯一 scheduler 与 intent owner；Desktop 仅作为受管 Host 的 supervisor/UI。intent 持久化、lease/fence、单实例、触发幂等和结果回执都在 Host 边界。 | Host 独立于 Electron 常驻；启动/关闭恢复扫描在 DB ready 后、接受新触发前完成。定时配置、时区/下次触发、retry/backoff 与 outbox 语义要持久化。 | 用真实 Host 进程和数据库覆盖：到期触发、重复触发去重、失败重试、进程崩溃后恢复、两个 Host 争同一 data root 只有一个 owner、取消/关闭竞态、terminal/outbox 对账。Desktop 与 CLI 创建的同一 intent 由同一个 Host 执行；只测 `RunResult` 读取不足以验收 scheduler。 |
| Worker、BashWorker、Browser/Computer 进程及打包 | Host 管 Worker Manager/dispatch/stop；Runtime 管通用轮次、工具与取消合同；平台工具包只提供 capability adapter。每个子进程入口有唯一 owner 和受版本化的 wire protocol。2026-10-13 `bundle:agent` 重建成功，包含 `agent-process-entry.js`、独立 `BashTool/BashWorker.js` 和 prompt assets；这仍是旧 Agent worker bundle，不是 Host worker 退役证据。 | 列出入口、构建命令、产物路径、assets/native dependencies、父子退出码、IPC/SSE handshake；electron-builder 与 CLI bundle 均要检查实际产物。不能用主包 typecheck 代替子入口验证。 | 从真实入口启动各 Worker，执行一个最小真实任务；验证 ready、请求/响应、progress、cancel、异常退出、父进程关闭和重启后清理。packaged Electron 至少完成首次 Host/worker ready 与一轮任务；支持范围要按 OS/capability 明确。 |
| 旧 CLI 和旧包引用（根 `chat-cli`、`packages/agent/bin/duya`、旧 `dist/cli`/`bundle/cli-entry.js`） | 暂设单向兼容转发到 `packages/cli` 的 Host-backed command；不能保留第二套 turn loop。明确废弃版本/消费者扫描、build 脚本和删除条件，入口去留由实际包消费者决定。 | `npm run chat-cli`、bin shim、`duya chat`、`duya serve`、control-plane CLI 各自列明目标；build artifact 和 help/exit code 要与发布包一致。 | 在干净安装/打包环境逐入口执行 help、一次文本任务、一次带工具任务、取消及 session/run 恢复；检查进程树及 DB/run/event 归属。消费者 inventory 归零后才移除旧 bundle 与 `packages/agent` CLI 源码。 |
| Worker DB action 面（旧 `db-client`、Desktop IPC、automation/CLI consumers） | 按领域迁到 Protocol typed command/query → Data store → Host API；Desktop、CLI、automation、worker 都列为真实消费者。拒绝任意 SQL tunnel 和伪同步代理。 | Host 是应用 DB 唯一 owner；跨进程写操作有 command receipt/幂等键，读取有明确 cursor/分页和权限上下文。迁移前后不能双写。 | 对每个领域记录旧 action 数、调用者、Host API、删除的旧边和重启/失败行为。使用真实 bridge+SQLite 验证授权拒绝不落行、成功可读回、重试不重复副作用；全量 consumer inventory 归零后才能删兼容实现。 |

| PowerShell tool specialization and security (`packages/agent/src/tool/PowerShellTool/**`) | `@duya/capabilities` owns the PowerShell specialization and its safety/read-only policy. The zero-argument Agent adapter still injects `startManagedBash`, output directory, and Git reminder; `builtin.ts` remains its production registration. Host/Runtime must later provide the process lifecycle and register the capability directly before deleting the adapter. | Build order is Protocol/AI dependencies → Capabilities → Agent; Desktop and CLI artifacts must resolve the public capability export. Windows shell discovery and PowerShell availability are explicit platform dependencies. | A real `pwsh` command returned version `7.6.5` both through an injected capability port and the built Agent adapter. Still required: Host Run API execution on Windows with safe output, approval/rejection before start, process-tree cancellation, progress/output delivery, and durable result. These smokes do not prove Host ownership. |
| Computer Use tool contract and execution (`packages/agent/src/tool/OSTool/**`, Desktop `computer-use` IPC) | `@duya/agent-protocol` now owns the shared action names, wire channel constants, error codes, and request/result envelopes; Agent and Desktop Main consume that contract. The executor, exposure policy, approval lifecycle, and OS bridge remain in Agent/Desktop. Runtime/Host must own registration, invocation, cancellation, and durable results before the Agent executor can be retired. | Build Protocol before Agent and Desktop. Keep platform executor/native resources in the supported OS package; Electron packaging must preserve the OS bridge and approval transport. | From Desktop and Host-connected CLI, invoke through the real catalog and run transport: verify exposure/filtering, user approval and rejection, a real OS action/readback, cancellation, progress, result persistence, and packaged resource resolution. Protocol type sharing alone is not production execution migration. |

### 2.1.1 工具实现迁出与授权边界（2026-10-13）

本轮把 18 个具体工具实现单元迁到 @duya/capabilities：Files、Bash、
PowerShell、Todo、MemoryWrite、WriteStage1Policy、AskUserQuestion、Brief、
Module、ImageGenerate、Vision、ReactToMessage、SendArtifact。旧 Agent 路径
保留 adapter/re-export。Capabilities 是当前实现的暂存边界，不是最终工具
架构边界；其通用 ToolContext、权限策略以及交互状态仍待按职责拆分。

| 切片 | 当前生产路径与限制 | 下一步验收 |
| --- | --- | --- |
| 18 个工具实现 | Desktop worker 仍通过 Agent builtin registry 注册；Agent registry、tool exposure、profile/mode filter、permission pipeline 均未切换。CLI 的 Host-backed 与 legacy 入口需逐一核实。Module 的 README 与生成器已随 capabilities build。 | Desktop worker、Host CLI、legacy CLI 分别从真实入口跑工具调用；校验 schema/name/exposure、授权、取消、progress、结果持久化与打包资源。当前没有 Host Run API 的真实模型工具轮次。SendArtifact 仍只返回 MEDIA: 文本，未找到生产 media-result consumer，不能算附件实际投递。 |
| 授权与提问状态 | Host/Core 持有授权规则和决定权；Runtime 对最终参数与调用身份授权一次，并把绑定本次调用的结果交给 ToolPort/executor。AskUserQuestion 通过独立 InteractionPort 管理等待/回答，不能把回答映射成 permission grant。 | 首先修复 ApprovalPort 与旧 executor 重复检查导致的一次性批准重复消费；验证参数或执行环境变化后重新授权、ask/deny/cancel/timeout，以及只执行一次和审计/结果落盘。此跨层切片尚未实施。 |

### 2.1.2 跨入口验收门

一个切片只有同时满足以下条件才可标记为“生产迁移完成”：

1. 迁移前后入口与依赖边可重算；旧生产调用已删除或被登记为明确的单向兼容 shim。
2. 测试经过 Host 公共 API 和真实 transport/worker/存储接缝；直接调用内部 executor 的测试只算单元证据。
3. Desktop、Host-connected CLI、standalone CLI 各自有可重复 smoke 记录，说明其执行器、runId、事件/结果和持久层 owner；未支持的 provider/OS/capability 明确标记 unsupported。
4. 资源/构建类切片增加干净 bundle 与 packaged artifact 检查；Electron renderer/IPC 行为在真实 Electron 中验证。
5. 记录命令、OS、HEAD/工作树状态、退出码、日志/产物位置和限制。取消、跳过、fixture-only、typecheck 通过均不算运行验收。

Canvas/Conductor 不在本节迁移范围；它们只在其他模块引用时作为消费者，不因此改变 owner 或验收范围。

## 3. Desktop main / preload / renderer

| 当前区域 | 保留的 host 职责 | 应提取 / 阶段 |
| --- | --- | --- |
| agents | 启动/workerpool、HTTP/SSE/IPCcomposition | runloop runtime；CPcontrol R2/M5/C6 |
| control-plane | Desktopcomposition与repositoryadapter | 纯services无Electron；第二consumer需提包H8 |
| automation / wake | cron/platformtrigger、delivery | intent/scheduler/Goal/Taskowner C6/H8 |
| channels / gateway / messaging | 外部platformadapter、连接与真实media发送 | sharedinput/receipt与CPdispatch；附件身份E4/C6 |
| db / memory / memory-state / project-database | SQLite连接/migrations、文件存储 | schemaDTO、业务services和repositoryport M5/C6 |
| ipc | sender/auth/contextBridge transport | browser-safecontracts+domainservices M5；不删活着channel |
| core | 窗口/app生命周期、Electron资源 | name含core不等于agent-core；纯业务按consumer提取 |
| config / plugins / skills / services / import | 安装、账户、配置、vault、导入 | 执行loader/invokeradapter M5；duplicateowner禁止 |
| cli / conductor | Desktop交互入口/平台bridge | 公共runtime消费H8；conductorUI保留现包 |
| logging / lib / types / utils | logger/平台helper | DTOcontracts/纯domainport；逐项不整目录搬 |
| preload | 安全桥、安全origin与窄权限 | DTO契约同步，不importrenderer实现 |
| renderer | 状态投影/组件/交互 | main引用的类型分离，runtruth在CP；UIPlaywright |

## 4. 每切片完成记录

模板：`sliceId → oldFiles → newPublicEntry → callers → removedEdges → shim/release → tests/artifacts → commit/PR → merged/runtimeVerified → remaining`。

**本表不承载逐切片完成记录。** 记录实际在两处：切片级证据按阶段写进各 `0x-*.md` 阶段文件，commit/PR/命令退出码/能力边界/下一任务写进[执行日志](11-execution-log.md)。M5.1 的**机器可检**分类与切除列表不在本目录：`scripts/architecture/{slice-classification,slice-cut-list,import-graph}.ts` 加 `docs/architecture/m5-1-slice-inventory.md`（#166 起，随后由 #174 更正、#193 改为属性断言）。

无consumer表、未跑真实caller或“文件已搬”都不等于切片完成。为下一agent记录具体剩余文件，不写“继续重构”。
