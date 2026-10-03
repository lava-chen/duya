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

无consumer表、未跑真实caller或“文件已搬”都不等于切片完成。为下一agent记录具体剩余文件，不写“继续重构”。
