# M5 — 按职责提取包，切断 host 反向依赖

前置：G0、T3、E4。Next：**M5.2-S3（CLI contract 拆分，#171 自评 not done）**；其后 M5.3 纯岛四项一项未迁、M5.4 头部迁移（#175 自述"not done"）。完整映射见migration-map；每个切片都有消费者与shim退出条件。
>
> **阶段状态（2026-10-04 对 `55384c55` 核对）**：M5.1 #166、M5.2 #171、M5.3 #173、M5.4 #175、M5.5 #172 **全部合并**，**仍是 In progress**——每个 PR 只交了它那一段，剩余项由交付方自己标出（尤其 #175 的原话是"The headline moves are not done"）。分类记录在 #174 被更正过一次：影子检测器原先只报 `j === i + 1`，规则 14–17 等**非相邻**的遮蔽一直看不见（10 个文件被误分类 `wire`）；修好后实测 6 条（不是预测的 3 条），全部修正，随后 #193 把 inventory 从冻结树改成**属性断言**。

## M5.1 切片清单与循环

> 已合并，PR #166（`c0253805`）。**只交地图与验证器，不搬家。** 分类规则住在 `scripts/architecture/slice-classification.ts`（`RULES` 最具体优先 + `FILE_OVERRIDES`），验证器展开到每个文件并检查每个分类的**计数与路径指纹**，外加死规则检查。

- [x] 当前源码逐文件分类：wire、pure、runtimecoordination、capabilityadapter、CPdurable、host/UI；目录只作inventory，不整体mv。
  **2867 / 3232** 文件已分类，**365** 个未分类**各自带书面理由**，零个无解释。分布：`wire` 55、`pure` 5、`runtime-coordination` 276、`capability-adapter` 1169、`cp-durable` 158、`host-ui` 1204。粒度是**目录规则 + 每文件 override**：维护单位约 60 条规则，被检查的单位是每个文件——分类按代码**做的事**分，不按它当前在哪个包。
- [x] 导出type/value/runtimecallgraph、跨包边和SCC成员，选择本切口真实需要去除的valueedge。不能因为14成员SCC的修改就承诺另一个42成员SCC下降。
  `scripts/architecture/import-graph.mjs` + `slice-cut-list.ts`（对**活的** import 图校验）。切除列表按载荷排序，榜首是 `pkg:agent → electron-main`（15）与 `electron-main → src-renderer`（33）；`NOT_CUT` 记录拒绝承诺的项。
- [ ] 拆混合barrel和隐式singleton，定义窄port：ModelClient、ToolExecutor、ContextLoader、TranscriptRepository、PermissionBroker、Clock、Telemetry、Process/SecretResolver。
  未完成：没有任何一个 M5 切片定义了这组窄 port。#172 建的 `ProcessScope` 是真实 port，但只覆盖 spawn/timer/stream/kill，且只在 `packages/agent` 内部消费。
- [x] 禁止core输入中藏IO函数却宣称纯；需要异步端口的算法/loop放runtime，core只接数据和返回决策。
  **#173（`ae71f629`）把这句话从注释变成门禁**：`architecture-check.mjs` 此前**从不读 `layers:` 块**（grep `layer` 零命中），"core 无 IO"只靠 M5.1 的手写清单——所以那个违规能在树里活过四个切片。新增 `scripts/architecture/layer-purity.ts`（`CORE_MODULES` + `findCorePurityViolations`，`core` 根只允许声明的 carve-out 外无 IO），15/15 测试，突变自证。**`packages/ai` 确实是 `core` 且层名没有被改掉**——实测 `agent-protocol` 与 `agent-core` **不 import** `@duya/ai`，`agent-core.requires: [ai]` 是无功声明；改层名会更糟（等于把一个能 `fetch` 的包靠声明变得从 core 可达然后叫它别的）。carve-out 是 **6** 个文件而非 M5.1 记的 3 个——**是门禁自己找出来的**：`utils/backoff.ts:119`、`utils/idle-timeout.ts:40`、`system-one/client.ts:188`；`system-one/client.ts:166` 与 `api/google-generative-ai.ts:398` 已经证明注入 transport 是可行的，每条 carve-out 的退役条件就是注入 transport/signer/clock port。

## M5.2 优先切 agent → host / CLI

> 已合并，PR #171（`91f257a9`）——**第一个真正搬代码的切片**。子切片顺序 S1（仅测试、零生产代码）→ S4（机械）→ S2（新边界），每步可独立归因。S3 **not done**。

- [x] agentmemory-state迁移和automationtypes对main的16边逐项解除：schema/configDTO归合法公共层，SQLmigration与scheduleowner归host/CP。
  **实测 15 → 0，不是 16**（本条原写的"16边"以测量值 15 为准）：14 条 migration 边 + 1 条 automation 边。agent 现在拥有它读的 DDL（`packages/agent/src/memory-state/__tests__/schema-ddl.ts` 新增）；14 个文件 / 196 测试通过；删除了 `packages/agent/tests/unit/automationScheduler.test.ts`。闭合被钉住：新增 `CLOSED` 列表，5 个新测试**重新测量** `edgesAfter`。
- [ ] CLIcontract拆纯commanddescriptor/DTO和buildAgentRunner；agent不importCLIservice。CLI消费runtime，不能形成反向。
  **#171 自评 S3 not done。** 阻塞是入口普查的结论而非时间问题：`packages/cli` **根本不启动 agent run**（全是 HTTP CRUD），真正在跑的是 `packages/agent/src/cli/index.ts` 直接构造 `DuyaAgent`——所以"拆 CLI contract"要先有一个共享的 Run API 可拆。**该 Run API 在 H8.1 的 PR #178 里（未合并）**；本条的前置因此是 #178 落地，不是 M5 自己再写一套。
- [ ] main/preload → renderer的DTO/类型分离到Desktopcontracts；有第二包consumer再提稳定shared。providerstore/UIconfig实现保持各自侧。
  未完成：S2 只搬了 2 个文件（`main/ipc/git-types.ts` + `renderer/types/import.ts` → `apps/desktop/src/contracts/`，13 个 consumer、3 个 tsconfig），**`main → renderer` 33 → 32**——按切除列表的载荷这还只是零头。
- [ ] renderer → main逐项审查type/value；publicbridgecontracts同步preload/renderer/main，强schema/sender校验复用已有helper。
  未完成：`renderer → main` 由 **4 → 2**，方向对但未归零。**publicbridge 同步已有一次真实教训**（#182）：`run:create` 的 wire 形状 `{ok, state, runId}` 被中间跳解析成 typed `RunWriteReceipt`（该联合**既无 `ok` 也无 `written`**）再原样返回，于是**每一个** `run:create` 都读成 `unreadable`，worker 起来了却收不到 `chat:start`，整个 Desktop chat turn 被静默丢弃。序列化器现已搬到 `run-receipt.ts:177 writeRunReceiptOnWire`，**与读取方 `run-receipt.ts:358 readRunReceipt` 并排**——边界消费侧此前根本没有办法构造 wire receipt，这正是形状漂移的成因。逐项审查本身尚未做完。
- [x] plugin-core deepimports改公开subpaths，补需要的distbuild/exports；不把所有内置插件实现重新复制。
  16 处 host 相对越界 → 声明的 subpath（`packages/plugin-core/package.json:68-99` 新增 7 条 `exports`），9 个 host 文件 + 3 个测试文件重指。`deep-import` 持平 **25**，`package-boundary-escape` **162 → 146**。内置插件实现未被复制。

验收：这些边在审计中归零；新contracts不含DOM/Electron/凭证/后端service；现实runtimebrowserbundle均可解析。**当前未达成**——`pkg:agent → electron-main` 已归零，但 `main → renderer` 只从 33 到 32、`renderer → main` 从 4 到 2。

## M5.3 提取 core 纯岛

> #173 交付了本阶段所依赖的**门禁**，四项迁移本身**一项未做**。本节保持全开。

- [ ] 纯message转换、compacttransforms、budget/outcome/permissionreducers、contextselection依次迁入core；真实模型compaction调用留runtime。
  未完成：无切片迁移过这些 reducer。`#175` 抽出的是 `agent/turnShape.ts` 的纯形状推导（留在 `packages/agent` 内），不是迁入 core。
- [ ] prompt渲染/排序/截断归core；Hbsassetloader、目录扫描/watch和现有缓存IO归runtimeadapter。模板bundle/loader路径验证。
  未完成。550 1a–1d 的 Hbs render/assets 仍按 [接管表](10-legacy-crosswalk.md) 归 M5.3，未开始。
- [ ] mode声明/状态reducer归core；mode tools/hooks归runtime，Goal/Researchdurableowner归CP。profile、mode、permission三层正交保持。
  未完成。plan 224 的 `ModeModifier` 注册表与 `applyModes` 仍在原位；`AgentProfile`/`PermissionMode` 的三层正交未被动过（这不算缺陷，只算未迁）。
- [ ] 纯算法复用现有夹具；prompt比较语义及约定newline策略，cache稳定段不漂移，不把CRLF差异当普遍业务变化。
  未完成：没有 core 纯岛可复用夹具。**方法论已在别处确立并可直接复用**——#184 改 20 个文件夹具时"Windows 用 Windows 形式（这样盘符小写化仍被断言）、其它平台用真正的绝对路径并同时作用到种下的值与期望值，使比较保持有意义而非仅仅通过"，以及本计划 `check:encoding` 强制绝对路径测编码，都是同一条纪律。

## M5.4 提取 runtime 循环和工具协调

> 已合并，PR #175（`9045e445`）。**原话："The headline moves are not done and the blockers are precise."**

- [ ] TurnAssembler/TurnPreparer拆数据算法与IO装配；TurnStreamRunner、TurnEventDispatcher、CompactionCoordinator的async部分、SessionFinalizer迁runtime。
  部分：assembler 已拆（纯形状推导进 `agent/turnShape.ts:152-171`，`TurnAssembler.ts:41-55,64-78` 变成 reader；旧代码两个字段都是 `undefined`，新代码是 `'cli'` / `'zh-CN'`）。**StreamRunner / EventDispatcher / CompactionCoordinator / Finalizer 未迁**。
- [x] 实际已有模块先复核，不重写550中已存在的runner。DuyaAgent成为薄兼容facade，行数只作提示；验收是职责/消费者而非强制<100行。
  每个 550 时代的模块**早已在盘上**；#175 扩展 `planExecution` 而非重新推导，9 个既有 orchestrator 测试不动通过。`DuyaAgent` 实测**已是部分 facade**：委派 9 个模块中的 8 个（`TurnAssembler:264`、`runTurnStream:2338`、`CompactionCoordinator:894,2098`、`SessionFinalizer:3151,3295,3322`、`DeadLoopTracker:2484,3210`、`PendingHookMessages:446`、`PermissionsGate:89`、`ToolExecutionPipeline:2036`），仍合法持有 `AgentRuntime` 的读端口。
- [x] pipeline/StreamingToolExecutor统一dependencygraph；read/read并行、samepathwrite串行、明确declaredrequires，rootalias/realpath冲突也串行。
  读写冲突、canonical 路径、对称 unknown、`consumes` 均已修（`DependencyGraphOrchestrator.ts:175-208,229-256`；**17 个新测试中 7 个在改动前的 planner 上失败**）。路径能力是新增的（`canonical-path.ts:1-121`，含盘上一个**真实 junction**），生产 wiring 由 `ToolExecutionPipeline.ts:162-166,176,302-304` 注入真实 realpath canonicaliser。
- [ ] 未声明副作用保守串行；不要按工具名静态表假定安全。重复队列调度/TOOL_BATCH_MAP仅在所有真实调用迁走后删。
  前半已做（对称 unknown 判定），**后半未做**：`TOOL_BATCH_MAP` 与重复队列调度仍在树里，因为真实调用尚未迁完。下一动作：把 M5.4 第一节的迁移做完，再按"所有真实调用已迁走"逐个核销。
- [ ] registry/snapshot/skills/MCP是runtimecoordination/adapter；公共catalogDTO协议化；同轮snapshot一致，lazyreload/reconnect有版本与失效测试。
  未完成：无切片做公共 catalog DTO 协议化或 snapshot 失效测试。#192 修的是 registry 的 owner 守卫（`registry.ts:379` 只拒 `non-mcp`，拼错的 bucket 名会让移除**静默地什么都不做**）——那是一个真实缺陷修复，不是本条的迁移。
- [ ] hooks失败诊断回灌及PreToolUse阻断保留；不要在每次edit无条件跑完整typecheck，项目级验证hook依配置且有取消/timeout。
  未完成。无切片动过 hook 执行器。[接管表](10-legacy-crosswalk.md) 把 429 建议1/2 判给 M5.4 + E4.2，`legacy-task-inventory.md` 的相关行仍为原 unchecked/inherited。

## M5.5 Host adapter 和治理债

> 已合并，PR #172（`7d4d1884`）。顺序是 port 先行（它单独会失败），再一个 consumer 一步；两个测试在切片中途抓到真 bug（`exited` 从未挂到返回的句柄上；abort 路径绕过 scope 并在单测里调用了真实的 `killProcessTree`）。

- [ ] ProcessScope封装spawn/timer/streams/kill清理；BashWorker、workerpool、CLI适配复用，rawspawn审计新增规则先验证真实consumer。
  部分：port 已建（`agent-runtime/src/process/process-scope.ts:1`、`src/index.ts:169`，10 个测试，改动前 exit 1 因为模块不存在）；managed bash 已通过 scope 拥有它的子进程（`managed-bash.ts:112,130,225,233`，4 个测试，原码 4/4 失败、改后 4/4 通过）；第四份 `taskkill` 副本收敛到共享且有测试的 `killProcessTree`（`WorkerPool.ts:690`，`processTreeKill.test.ts` 13 个）。**CLI 适配未复用**（CLI 侧 Run API 尚不存在，见 M5.2-S3）。
- [ ] DesktopSQLite/files/logger/privateconfig实现留host，runtime用port；大ipc/db handler按domain拆并复用trustedSender/schema。
  未完成，无切片做 ipc/db handler 的按 domain 拆分。**已发生的相关变化属 C6.1**（#169）：trusted-sender 判定从 repository adapter 里被拆出来（它此前一路可达 `window-manager` → `electron`，使该判定从 Control Plane 不可达），repository 的连接访问器改为注入。#169 明确"`run-store.ts` 什么都没搬"——经 port 到达而非重定位，理由是 R1.3 刚硬化过它，一次约 670 行的移动买到的是边界而不是事实。
- [ ] M5涉及区域内处理583的重复归一化、失败receipt、死导出、乱码/console债；pathcontainment保持词法决策与realpath执行两层，不简单合并五处为一个弱检查。
  部分：`WorkerPool` 的 **19** 处裸 `console.*` 变成结构化 logger，**19 → 0**（实测）；死导出 `ScopedProcessLike` 已删，0 引用残留。**583 的重复归一化未处理**。**path containment 的两层保持未被破坏**——#175 新增的 `canonical-path.ts` 同时提供 realpath 与词法 canonicaliser并由 pipeline 注入，没有把两者合并成一个弱检查。
- [ ] conductor保留UI/domain包；旧buildhack已移除的事项只验收，不另重复改。ReactUI循环不作为runtime切片前置。
  未完成：conductor 包未动（也未被本计划破坏）。#143 移除的 build hack 属 G0.2-B（`electron:dev`/`electron:build`/`electron:preview` 里临时拼装的 `build:voice`/`build:gateway`/`build:computer-use`），顺序改由 `scripts/build-packages.mjs` 的 `BUILD_ORDER` 单一事实源承担；这是 G0 的验收，不在本条重复做。

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
