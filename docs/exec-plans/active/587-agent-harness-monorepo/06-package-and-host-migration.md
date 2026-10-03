# M5 — 按职责提取包，切断 host 反向依赖

前置：G0、T3、E4。Next：M5.1。完整映射见migration-map；每个切片都有消费者与shim退出条件。

## M5.1 切片清单与循环

- [ ] 当前源码逐文件分类：wire、pure、runtimecoordination、capabilityadapter、CPdurable、host/UI；目录只作inventory，不整体mv。
- [ ] 导出type/value/runtimecallgraph、跨包边和SCC成员，选择本切口真实需要去除的valueedge。不能因为14成员SCC的修改就承诺另一个42成员SCC下降。
- [ ] 拆混合barrel和隐式singleton，定义窄port：ModelClient、ToolExecutor、ContextLoader、TranscriptRepository、PermissionBroker、Clock、Telemetry、Process/SecretResolver。
- [ ] 禁止core输入中藏IO函数却宣称纯；需要异步端口的算法/loop放runtime，core只接数据和返回决策。

## M5.2 优先切 agent → host / CLI

- [ ] agentmemory-state迁移和automationtypes对main的16边逐项解除：schema/configDTO归合法公共层，SQLmigration与scheduleowner归host/CP。
- [ ] CLIcontract拆纯commanddescriptor/DTO和buildAgentRunner；agent不importCLIservice。CLI消费runtime，不能形成反向。
- [ ] main/preload → renderer的DTO/类型分离到Desktopcontracts；有第二包consumer再提稳定shared。providerstore/UIconfig实现保持各自侧。
- [ ] renderer → main逐项审查type/value；publicbridgecontracts同步preload/renderer/main，强schema/sender校验复用已有helper。
- [ ] plugin-core deepimports改公开subpaths，补需要的distbuild/exports；不把所有内置插件实现重新复制。

验收：这些边在审计中归零；新contracts不含DOM/Electron/凭证/后端service；现实runtimebrowserbundle均可解析。

## M5.3 提取 core 纯岛

- [ ] 纯message转换、compacttransforms、budget/outcome/permissionreducers、contextselection依次迁入core；真实模型compaction调用留runtime。
- [ ] prompt渲染/排序/截断归core；Hbsassetloader、目录扫描/watch和现有缓存IO归runtimeadapter。模板bundle/loader路径验证。
- [ ] mode声明/状态reducer归core；mode tools/hooks归runtime，Goal/Researchdurableowner归CP。profile、mode、permission三层正交保持。
- [ ] 纯算法复用现有夹具；prompt比较语义及约定newline策略，cache稳定段不漂移，不把CRLF差异当普遍业务变化。

## M5.4 提取 runtime 循环和工具协调

- [ ] TurnAssembler/TurnPreparer拆数据算法与IO装配；TurnStreamRunner、TurnEventDispatcher、CompactionCoordinator的async部分、SessionFinalizer迁runtime。
- [ ] 实际已有模块先复核，不重写550中已存在的runner。DuyaAgent成为薄兼容facade，行数只作提示；验收是职责/消费者而非强制<100行。
- [ ] pipeline/StreamingToolExecutor统一dependencygraph；read/read并行、samepathwrite串行、明确declaredrequires，rootalias/realpath冲突也串行。
- [ ] 未声明副作用保守串行；不要按工具名静态表假定安全。重复队列调度/TOOL_BATCH_MAP仅在所有真实调用迁走后删。
- [ ] registry/snapshot/skills/MCP是runtimecoordination/adapter；公共catalogDTO协议化；同轮snapshot一致，lazyreload/reconnect有版本与失效测试。
- [ ] hooks失败诊断回灌及PreToolUse阻断保留；不要在每次edit无条件跑完整typecheck，项目级验证hook依配置且有取消/timeout。

## M5.5 Host adapter 和治理债

- [ ] ProcessScope封装spawn/timer/streams/kill清理；BashWorker、workerpool、CLI适配复用，rawspawn审计新增规则先验证真实consumer。
- [ ] DesktopSQLite/files/logger/privateconfig实现留host，runtime用port；大ipc/db handler按domain拆并复用trustedSender/schema。
- [ ] M5涉及区域内处理583的重复归一化、失败receipt、死导出、乱码/console债；pathcontainment保持词法决策与realpath执行两层，不简单合并五处为一个弱检查。
- [ ] conductor保留UI/domain包；旧buildhack已移除的事项只验收，不另重复改。ReactUI循环不作为runtime切片前置。

## 每个切片的固定步骤

1. 旧位置提取函数/port，保持行为，测试真实caller。
2. 消除反向边，用现有hostadapter注入。
3. 移到新包公开入口；旧shim只有re-export/adapter，登记consumer数和退出任务。
4. 更新build/exports/types/assets/architecturepolicy；clean验证解析来自本checkout。
5. E4相关case+定向原测试，main/IPC/Electron实际触达；检查没有新增valuecycle。
6. 所有consumer归零后删shim，更新migration-map完成证据。

## PR 与出口

推荐每主题一个小PR：host/CLI切边 → puremessage/compact → promptrender → permission/mode reducers → loopcoordination → tool/scheduler → context/skills/MCP → hostadaptercleanup。

每PRtypecheckall/architecture和E4selectedsuite；resolver变更selftest；lazyboundaryelectronbuild+packsmoke。全量testsetdiff不扩大混改。rollback使用旧facade与featureflag；不要删除可读schema或盲目batchrewrite全部mainimports。

出口：core没有直接或通过输入能力进行的IO，runtime独立于Desktop，旧agent只剩有期限兼容入口；host反向边与目标slicevaluecycle归零，现有行为基准通过。
