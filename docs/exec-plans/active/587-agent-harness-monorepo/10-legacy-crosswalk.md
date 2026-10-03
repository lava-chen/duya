# 旧计划接管、外部依赖与范围裁决

> 旧文件完整保留在history/reference。此表规定新owner；旧checkbox不自动转为当前完成证据。
> `legacy-task-inventory.md`枚举旧计划checkbox，供接管时核对，无独立执行顺序。

## 1. 主计划接管

| 原计划/编号 | 新归属 | 裁决 |
| --- | --- | --- |
| 429 建议1/2 编辑验证与hooks | M5.4、E4.2 | 复用现有bus，失败诊断/阻断；不无条件每edit全typecheck |
| 429 建议3 filecheckpoint/rewind | E4.2、D7.1 | 原已落地声明需复验；保留，不能代替executioncheckpoint |
| 429 建议4沙箱 | C6policy；X3OSbackend | 政策与硬隔离区分，Job不等于FS/network限制 |
| 429 建议5/6模型路由/子agentUI | X2/X4 | 非拆包前置；已有backend接入合同 |
| 550 1a–1d Hbs | M5.3 | 已有render/assets先验；剩余template/cache/parity逐项收口 |
| 550 2a–2e DuyaAgent拆解 | M5.4 | 已有Assembler/Pipeline/Runner/Dispatcher/Finalizer不重复提取；按pure/async拆 |
| 550 3a–3d调度 | M5.4、E4toolmatrix | dependency声明到实际streamingexecutor；samepath别名冲突测试 |
| 583 各ISS | 下节及X轨 | 历史status/PR核对；不继承MERGEABLE为landed |
| 584 PP0/PP1 | G0 | 现有包/gates复核，CIrequired仍须验证 |
| 584 PP2、PP11 | T3.1、M5.2 | wire/内部/storage分层，compatshim；不造泛storage包 |
| 584 PP3 | T3.2–T3.4 | seq/cursor/codec/replay；因果顺序优先 |
| 584 PP4/PP6 | R2、C6 | 接口已存在部分先核对；真实manifest/input/privatecredential |
| 584 PP5/PP7 | R2、T3、D7 | 审批/取消先落；pause/resume仅D7后开放；arbiter以00为准 |
| 584 PP8–PP10 | T3.5、H8 | 三adapter一致性，CLI真实消费 |
| 585 Phase1/2/3 | T3.3/T3.4 | 单seq稀疏durable已定；不另立无seqephemeral方案 |
| 586 P0–P5 | G0/R1确认既有实现 | referenceobserver保留价值，不称完整执行boundary |
| 586 P6 | E4.4 | 真实Electron/provider/存储证据；未跑仍未验收 |
| WorkspacePhase0 0.1–0.5 | 00、C6、migration-map | durableUUID+root、单resolver、creationmatrix、Project兼容 |

## 2. 旧 583 全部聚合 ISS 的归属

每项在G0核对已有PR/源码/测试，已经修复只记录revalidated，不复制实现。53号范围及重复ISS05原文保留，不能以旧P0描述排新工作。

| ISS | 新owner / 检查目标 |
| --- | --- |
| 01 | G0 — mastertrigger、cleanbuild、main/preloadratchet、requiredchecks |
| 02 | M5/C6 — duya-file根与访问策略、实际protocolread路径 |
| 03 | M5/MCPconformance — remoteconnection类型/ledger现状 |
| 04 | R2/M5 — 所有toolinvoke经过同policygate，plan写屏障 |
| 05 | C6/X3 — 插件trust对真实安装/执行能力生效，不能用marketplacelabel冒充签名 |
| 06 | M5 — IPC/preloadchannel合同一致 |
| 07 | M5 — 归一化与policy语义一致且不弱化 |
| 08 | R1/M5 — dbrequesttimercleanup |
| 09 | R2/T3 — legacypermissionmode翻译期限和单事实源 |
| 10 | T3 — stdoutbytes有界且durable不丢 |
| 11 | R2/C6 — ask failclosed、统一审批broker |
| 12 / 12b | R2/M5 — publiccredentialleak/privatesender边界 |
| 13 / 14 | C6/M5 — 创建路径/traversal、shellopenpolicy；已有修复复验 |
| 15 | M5/C6 — webviewattach/frame权限、已有helper复用 |
| 16 | R2/M5 — provider字段投影、renderer日志无secret |
| 17 | X1 — Feishu webhookauth/验签，回归后标完成 |
| 18 | M5/C6 — browserclientorigin/extensionidentity真实授权 |
| 19 | C6 — apps开关真实invokegate |
| 20 | X1 — connectorsecretplatform路径安全 |
| 21 / 22 | M5 — remoteinflight去重、endpointidentity/cachegrant |
| 23 | X1 — Telegramoffset/restart/幂等backlog |
| 24 / 25 / 29 | M5 — channelcensus，dead注册/consumer判定后删 |
| 26 | X4 — Widgetexternalhref安全，UI验证 |
| 27 / 28 | E4/X4 — CodeReview旧scope取消；编辑transcript事务/回填 |
| 30 / 31 | M5/C6 — trustedsender/frames、schema/typedreceipts全域覆盖 |
| 32 / 33 / 34 | M5/X5 — RAG/tier限量、性能与正确性；已实现复验 |
| 35 | C6 — lexical/realpath分层，不能盲合并 |
| 36 | M5.4 — loop拆解、单权限装配、logger |
| 37 / 38 | X6 — 独立website安全头/跳转，需其仓库实施证据 |
| 39 | X6 — 原文证伪条目，不按缺陷实施；重新出现需新证据 |
| 40 | M5/X5 — deadcode逐consumer确认，保留仍LIVE实现 |
| 41 | M5/X4 — ledger/DTO复用；Gitpolling/themeUI专属切片 |
| 42 | M5/X4 — hostdomainhandler拆分；CodeReviewUI单独 |
| 43 | M5.2 — main/preload→renderer契约切边 |
| 44 | X5/C6 — Memory保留策略与Projectscope，非拆包顺手删数据 |
| 45 | X4 — theme/CSS/brandtoken，用户可见验证 |
| 46 | M5/H8 — exports与文档一致，legacy期限 |
| 47 / 48 | M5/X5 — scopedlogger/encoding，不能大面积无证据rewrite |
| 49 | G0/X4/X6 — collection/suppression/测试债；被证伪的deps删除不实施 |
| 50 | R1/C6/X1/X6 — ack后失败receipt、webhookdispatch、vaultcorruption、sitefetch按owner |
| 51 | G0/X5 — buildinfo/cache/仓库卫生，不删用户memory |
| 52 / 53 | G0 — 上游buildfix与main新增错误，核对现状 |

## 3. 旧 M/C 编号统一

| 来源 | 新任务 |
| --- | --- |
| 06 M0/05治理、M0.5 | G0 |
| 06 M1 plugin-core | M5.2 |
| 06 M2 protocol | T3.1 |
| 06 M3 shared/mainrenderer | M5.2，按真实多consumer选择contracts/shared |
| 06 M4 conductorhack | G0验证已有移除；剩余valueedge M5.5 |
| 06 M5 / C1.1–C1.7 | M5逐切片；不要求无关16SCC先归零，不保证disjointSCC联动 |
| 06 M6 evals | E4提前到大规模提取前 |
| 06 M7 appsdesktop | G0验已有落地，不重搬 |
| 06 M8 ProcessScope | M5.5 |
| 07 M0–M11 | 584 PP对应本表，不作为第二套顺序 |
| RFC Workspace/CP/Run/checkpoint/multi-host | C6/R2/D7/H8，00合同覆盖旧冲突 |
| 11 G8/G9及控制census | T3.2/T3.3，schema/since必须实际生效 |

## 4. 保留的独立功能计划：消费合同，不复制责任

技术债接管：TD0/1/5/6/7/8归G0（可信resolver、typegate、clean与跨平台集合）；TD2归M5.2；TD3归M5.5进程适配说明；TD4归M5切片分类；TD9的AGENTS加载路径收敛归G0先核对、M5/C6修实现并由E4覆盖。历史leaf断言的错误含义不继承。

| 计划 | 对接阶段 / 限制 |
| --- | --- |
| 419 permissionbus | R2/C6；riskTier与MCPregistration接同broker，保留专属任务 |
| 443 searchhardening、448 freshness | M5/E4toolmatrix；spawn/abort/freshness实现仍原owner |
| 451 providerwrappers | R2/H8ModelClientadapter；新provider不混入迁移PR |
| 452/455/460 connectors、580 MCP | M5/C6；强制L1–L9conformance，安装/授权独立 |
| 473及Bot依赖族 | C6/H8；统一RunIntent/Goal/Task，BotUX功能另排 |
| 496 worktree | H8subagentisolation；Git实现与cleanup原planowner |
| 525/534 ProjectDB、536context | C6硬协调；525destructiveapply需rehearsal且不能竞争schema |
| 560 workflow | H8；agentnode遵守Go/No-Go现有决定，workflowID不混 |
| 582 archive、521lifecycle | R1/C6/D7的cleanup与retention接口；归档不擅删活跃run |
| 573browser/576CUA | M5能力adapter；保持平台能力/实际验证，不阻塞纯core迁移 |
| 581A/B链合并、484ACK/resume | D7/H8接口约束；没有已批准实施不借本计划扩大范围 |

非架构功能仍在项目Active表，优先级不由本次整合擅自删除。架构主线只保留587一行；历史已接管plans不留Active副入口。

## 5. 不继承的旧要求

不用旧“无main类型门禁/CI不触发master”事实；不用Job等于FS沙箱；不把allow_for_session当进程授权；不把Promise/存储模型搬protocol；不照搬“durable必须抢在先前delta前面”；不要求所有SCC先消失；不将任意audit改动的baseline整批重写当修复；不以gitrevert承诺schema/副作用回滚。

原文完整保留用于解释变化，新任务的验收以阶段文件与00为准。
