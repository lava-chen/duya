# 个人长期 Bot 框架设计

将 Bot 定义为用户长期委托的智能体：有稳定身份、持续责任、受控记忆与行动权限，能够在多次 Run、多个渠道和客户端离线期间推进工作。目标是建立一个清晰的 Bot 领域包，并由现有 Host 统一装配执行。

状态：设计提案，尚未实现。源码核对基线：`270ba52869b6414094e553dd7f9abde5a1e429f7`，2026-10-25。
执行状态只在[迁移计划](../exec-plans/active/2026-10-25-personal-bot-framework.md)维护；[产品依据](../references/personal-agent-products.md)区分官方事实与设计推导。

## 1. 当前问题与决策

目前没有统一的 Bot 领域所有者。底层能力已经存在：协议有 WakeItem，core 有纯队列，Host 有 RunOrchestrator、Bot prompt 与 config-agents，data 有 pending-wakes。跨包分工本身合理，但 Bot 用例仍由 Desktop main 串联，身份写入、唤醒、渠道、prompt 和 UI 之间缺少统一的应用接口。

| 决策 | 理由与代价 |
| --- | --- |
| 目标新增一个 `@duya/bot` 包 | 集中 Bot 领域模型、用例与端口；不把数据库、渠道 SDK、工具实现都搬进去。维护一个公开入口，内部按职责分目录 |
| Host 是唯一运行装配点 | Desktop、TUI、Web 和渠道均调用 Host。Run ID、manifest、worker、审批、取消和终态沿用已有链路 |
| 先在 Host 建立 Bot 服务接缝，再提包 | 622 的依赖测量、Host 层归属和新包反向依赖门禁是提包前置；不靠新增 baseline 消化坏边 |
| 以现有单机单 Host 为第一部署形态 | 保留数据根锁与 SQLite；先完成可靠常驻。远程运行是后续适配器，不先建分布式调度平台 |
| 以用户一个主 Bot 为默认体验 | 可以增设专业 Bot，但创建不要求理解 profile、session、worker 或队列；专业 Bot 是相同模型的实例 |
| 先迁行为，再增强智能 | 第一个迁移切片保持身份、prompt 和工具暴露行为；后台研究、记忆反思与新人格独立验收 |

是否提包有明确判据：只有 Host 中的服务已形成稳定用例、至少一个生产消费点，而且边界测试能拒绝反向依赖，才从 `host/src/bot` 提取。单纯增加 `packages/bot` 不会自动改善架构。

| 候选结构 | 判断 |
| --- | --- |
| 长期仅使用 `host/src/bot` | 可作为过渡；若最终仅剩几个简单 profile 用例可保持此形态。持续责任、注意力与恢复规则扩大后，缺少包级约束易再次耦合 Host I/O |
| 一个窄 `@duya/bot` + Host adapters | 本设计目标；Bot 规则独立测试与演进，底层 Harness 保持通用。以 S0–S2 的真实消费者和闭包证据决定提取时机 |
| 把所有 Bot 相关源码搬入一个大包 | 拒绝；会混合 Electron、数据库、凭据、UI 与模型循环，形成新的双向依赖 |
| 新建 Bot 专用引擎 / 多个基础包 | 拒绝；重复已有 Run / Session / workflow / memory，增加状态 owner 与兼容负担 |

不另建 Bot 专用模型循环、任务 DAG、审批系统、插件格式或记忆引擎。`@duya/agent` 是退役层，不承接新增实现。

## 2. 用户体验与首版范围

创建流程：给 Bot 名称与职责 → 用真实任务开始工作 → 按需连接应用和选择行动边界 → 把稳定做法保存为技能或例行责任。用户可以查看它正在做什么、为何唤醒、用了哪些记忆、下一次何时检查，以及暂停或撤销授权。

首版闭环：用户说“工作日早上整理日程与待办，重要变化提醒我”；Host 保存责任、时区与预算，计划触发后在无 UI 的情况下执行，产出摘要；如果需要对外发送，已有审批链生成可审查请求；客户端重连后能看到同一责任、Run 和投递结果。测试使用夹具账号和本地 provider，不读取个人真实数据。

| 首版必须具备 | 后续扩展 |
| --- | --- |
| 稳定 Bot ID、职责、启停、现有模型配置 | 跨设备 / 远端执行环境 |
| Host 受理用户消息、持久化唤醒、单 Bot 串行控制 | 有资源约束的并行子任务，通过现有 Session / workflow 服务 |
| Desktop 与 TUI 共用接口；一个现有外部渠道贯通 | 更多渠道、语音和专业 Bot 协作 |
| 自有 / 用户 / 项目记忆的访问边界与纠错 | 有预算的记忆反思与技能改进建议 |
| routine、预算、暂停、审批和结果审计 | 更复杂的长期目标规划与进度预测 |

## 3. 概念与状态归属

| 概念 | 含义 | 唯一权威 |
| --- | --- | --- |
| Bot | 长期身份、职责、偏好及关联引用 | Bot 应用服务；身份兼容现有 config/profile 数据 |
| AgentProfile | 一次运行选用的工具与 prompt 配置 | 现有 profile 体系；Bot 引用它，不以它冒充 Bot |
| Responsibility | 用户持续委托的责任，含成功标准、检查规则和预算 | Bot 领域；已有 Goal / Project / routine 以 ID 关联，不复制 Task / Goal 状态机 |
| Session | 对话和上下文容器 | 现有 Session API；一个 Bot 可关联多个 Session |
| Run / attempt | 一次执行及其重试身份 | Host RunOrchestrator / Run 控制面与 Runtime |
| Wake | 待处理的触发事实 | 持久化 Bot inbox；来源映射现有 WakeItem |
| ChannelBinding | 外部会话到 Bot / conversation 的已验证映射 | Host 渠道适配器及其 store |
| Memory | 带来源与作用域的事实和经验 | memory 域；Bot 仅请求检索、纠错、遗忘 |
| Delivery | 一条结果向某个目标投递的义务 | Bot outbox；远端回执是投递证据 |

Bot 生命周期为 `active → paused → active` 或 `active/paused → archived`。暂停时停止新后台触发并显式处理在途 Run；用户仍可查状态、取消和恢复。归档先停触发、撤销渠道与授权，再按保留策略处理数据；改名不换 ID，删除后不复用旧目录。

责任的用户视图可显示 `active / paused / completed / cancelled`；执行进度取自现有 Goal / Task / routine，不能再存一套同义执行状态。Bot 仅新增归属、成功标准、授权引用与检查策略。完成策略显式选择 `evidence_verified` 或 `owner_confirmed`；Run 成功只说明本次执行完成，不证明长期责任达成。`waiting_for_approval` 是当前 Run / 待办的阻塞投影。Bot 的在线、忙碌、等待审批由 Host 查询投影，不持久化第二套“正在运行”真相。

当前 `HostGoalApiV1` 按 Session 取 Goal，而 Bot 生命周期跨 Session。第一版用 ResponsibilityBinding 关联现有目标 Session / Goal / routine，新的上下文 Session 继续引用原目标身份。确需让 Goal 跨 Session 时，走通用 Goal 域的 additive contract 变更，不能在 Bot 包复制 GoalStore 或偷偷改变现有含义。

## 4. 目标模块边界

| 包 | 负责回答的问题 | 不应承担 |
| --- | --- | --- |
| `@duya/bot` | 这个长期角色承担什么、哪些输入应推进它、何时提醒、怎样关联记忆与既有工作 | 模型 / tool 轮次循环、worker、网络、DB、凭据执行 |
| `@duya/host` | 用哪些真实适配器运行这些用例，哪个 Run 已受理，怎样对账生命周期 | 将 Bot 的纯业务规则散落进 HTTP / worker handler |
| `@duya/agent-runtime` | 一次 Run 如何执行、控制、授权、产生事件并等待持久终态 | 用户长期角色、渠道身份、routine 与个人通知偏好 |
| `@duya/agent-core` | 与产品无关的纯 Run 推理及可复用算法 | Bot 资料、渠道、长期责任或个人记忆 I/O |

依赖形成两条下向路径：`host → bot → core/protocol` 与 `host → runtime → core/protocol`。Bot 通过注入的 RunPort 请求执行，**不 import agent-runtime**；runtime 也不知道 Bot 存在。S2 初始只依赖确实使用的包，不为了画图增加无用 dependency。

```text
Desktop / TUI / Web / external channel
                 │ authenticated commands / queries
                 ▼
@duya/host  bot/ composition + adapters
     ├── @duya/bot                  domain + application ports
     ├── RunOrchestrator            existing run identity / dispatch
     ├── @duya/data                 transactions / schema / repositories
     ├── @duya/memory               recall / curation / forgetting
     └── capabilities / plugins     existing tools + permission execution
                 │
                 ▼
       @duya/agent-runtime → @duya/agent-core / @duya/ai

Client DTOs and durable wire contracts: @duya/agent-protocol
Client projections: @duya/client-core and @duya/ui
```

目标目录如下；这是所有权划分，只有切片出现真实消费者时才新增文件。

```text
packages/bot/src/
  domain/          identity, responsibility, wake admission, attention policy
  application/     create/update/pause, accept input, dispatch, reconcile
  ports/           narrow repository/run/memory/delivery/clock interfaces
  index.ts         explicit public API
packages/host/src/bot/
  service.ts       composition and lifecycle, no business-rule accumulation
  adapters/        existing run/session/data/memory/channel bindings
```

Bot 用例之间通过明确参数和返回结果组合，不用一个万能 `BotManager`、可变全局 registry 或带任意键的 context。装配在启动时完成；单测显式传入端口。没有第二个独立 `bot-runtime` / `bot-core` / `bot-plugin` 包。

依赖规则：

- `@duya/bot` 仅依赖 `agent-protocol` 和确实复用的纯 `agent-core` 接口；无 Electron、React、SQLite、fs、网络、定时器或 provider SDK。时间与 ID 分配通过端口传入。
- Host 向下依赖 Bot；runtime、core、memory、data 均不反向导入 Bot。data 返回协议 DTO / 持久化结果，由 Host 适配成 Bot repository port，保持 data 的现有依赖边界。
- 客户端只依赖协议与客户端投影，不 import `host/bot` 或 `bot/application`。`agent-protocol` 只放跨边界 DTO / 事件，不放调度实现。
- core 的通用 wake 排序仍可复用。只有明确属于 Bot 的入队资格、责任规则与注意力规则迁入 Bot；不为统一目录搬走非 Bot 共用算法。
- prompt 模板与实际模型输入仍由 Host 既有 prompt 管线装配；Bot 只提供有类型的快照，memory 域提供经作用域过滤的条目。

门禁须覆盖新增包的所有源码导入、子路径和传递闭包，验证 Bot→Host、core/runtime→Bot、UI→Host 的反向边会变红；新包列为 managed，新增违规零容忍。层归属以实际门禁实现为准，不能只改 YAML 声明。

## 5. 用例与端口合同

以下是待落地 API 的语义草案，不是当前已可调用的 SDK。S1 先对照现有 Host DTO 做最小增量，不机械复制名称。

| 应用接口 | 合同 |
| --- | --- |
| `createBot / updateBot / pauseBot / archiveBot` | owner 从可信连接取得；可重试命令带 requestId，写操作带 expectedRevision |
| `acceptInput` | 解析可信目标 binding，校验权限与大小，先落 durable inbox，再返回 accepted + wakeId；相同来源事件返回同一个 receipt |
| `dispatchNext` | 原子认领唤醒与 Bot 控制权，经 RunPort 请求启动，返回 canonical runId 或明确拒绝；客户端不认领执行权 |
| `setResponsibility / setRoutine` | 验证时区、触发规则、预算与授权；修改可读版本号，禁用后已排队工作重新校验 |
| `getBot / getActivity / getResponsibilities` | 只读；读取不触发 Run，不清理队列，不变更租约 |
| `reconcile` | 对账 claim、dispatch receipt、Run 终态与 outbox；只补缺失环节，不盲目重做动作 |

`RunPort` 提供 start / inspect / cancel 并复用 Host 接口。start 必须支持持久 dispatchKey 的幂等受理；cancel 绑定捕获的 runId + attempt，不能取消 Session 中后来的新 Run。接受拒绝时不得产生 worker 执行。

`BotRepositoryPort` 只暴露原子业务操作，如 accept、claim、attachRun、completeInput、enqueueDelivery；禁止提供裸 SQL、通用 db.call 或多个独立 save 拼装事务。`MemoryPort` 接收 owner、bot、project、audience 作用域和预算；`DeliveryPort` 返回明确远端回执或 unknown outcome。端口结果使用具名联合类型，不以 null / 空数组吞掉基础设施失败。

owner 是 Host 从已认证连接与数据根所有权解析出的 principal，首版不为此引入 SaaS 租户系统。Bot admission lease 只协调该 Bot 的控制工作，既有 Run / Session 锁仍是执行权威；不得让两把锁分别批准同一工作。

## 6. 可靠唤醒与唯一执行

生命周期和队列迁出 Desktop main 是此次最重要的生产迁移。保留 user > agent > background 的现有默认顺序，默认一个 Bot 同时只有一个控制 Run。用户消息及时抢占后台任务，后台工作保留可恢复义务；不以跨渠道开多个 Session 绕过 Bot 串行边界。并行计算通过已有子 Session / workflow 分发，结果再形成 wake。

```text
verified input → inbox accepted → claimed → dispatch recorded → Run accepted
                                                        ↓
terminal persisted ← existing Run execution / tool approval
       ↓
input settled + outbox obligation → delivery receipt → client projection
```

inbox 状态为 `pending / claimed / dispatched / settled / dead_letter`。租约到期并不自动证明可重跑：先查询 dispatch 与 Run，再决定继续对账、回到 pending 或进入人工复核。审批等待复用现有审批 ledger，不能通过重新发 wake 执行一次相同工具。

具体不变量：

1. 来源去重键含 owner、bot、source、binding 和 sourceEventId；渠道重投不能覆盖另一个 Bot 的输入。去重保留期至少覆盖来源可重放窗口；过期重放进入明确策略，不无限增长。
2. accepted 只在事务提交后返回。不能在 dequeue 时清掉唯一恢复证据；输入载荷或可重建引用、attempt、dispatchKey、状态和版本均须持久化。
3. 单数据根的 Host 锁仍是第一道保护；inbox claim 与 Bot 控制 lease 使用 ownerEpoch/fence 和 CAS。旧 Host / 旧 worker 回报必须被拒绝。
4. Host 原子绑定 dispatchKey 与 canonical runId，先提交受理再启动 executor；同 key 重试返回原 receipt。Bot 不自行生成 Run ID。**当前 `openRun` 每次 randomUUID，不满足这条合同，必须补接缝与故障测试后才切流。** 若 Run 与 inbox 不同事务域，使用 durable dispatch journal + 幂等 Host receipt 对账，不假装两个写入是原子事务。
5. 在“Run 已受理但调用方未拿到响应”处崩溃，恢复先查 receipt，不能直接调用现有 openRun。Host 恢复能力未实现的 Run 返回 `recovery_required`；不能声称支持任意工具中断续跑。
6. 读取到 durable Run terminal 后，原子落输入结算与 outbox 义务。外部写入遵循已有工具权限、审批与副作用账本；内存队列的去重不提供外部 exactly-once。
7. 队列设置容量、重试次数、截止期、退避和 dead-letter；不丢弃后声称成功。保留优先级，同时以有限后台时间片 / aging 防止长期饥饿；策略变动另测。

远端发送成功但本地未记 receipt 的窗口标记 `unknown`：有平台幂等键则重查 / 重试，没有则展示待核对，不能自动重复发送邮件或消息。内部 inbox 至少一次受理与外部动作执行保证分开声明。

## 7. 长期记忆与上下文连续性

不把“长期”解释成无限长聊天记录。Session 可以换代和压缩，Bot ID、责任与显式记忆保持稳定。

| 信息 | 处理方式 |
| --- | --- |
| Bot 自有经验与角色偏好 | own scope，保留写入来源、revision 和更新时刻 |
| 用户明确共享的偏好 | user scope；跨 Bot 读取需授权，不能默认扫描全部用户 shard |
| 项目背景 | project scope；每次召回检查当前 membership，撤销后立即失效 |
| 未完成委托 | 查询责任 / Task / Goal 的现有权威 store；不靠摘要记住待办 |
| 敏感或易变事实 | 带 provenance、有效期和敏感级别；关键决策回查来源 |

检索必须在读取条目前完成访问过滤，不能靠 prompt 提醒模型不要泄漏。跨 Bot / 群聊共享只传递授权的摘要与引用；channel sender 不能因“能和 Bot 说话”自动取得所有 user memory。

prompt 使用现有 619 的稳定 system / 动态 context 分离，输出 typed BotContextSnapshot（bot revision、policy revision、memory references、responsibilities、channels、capabilities）。身份与撤权变更立即影响授权；缓存冻结不得延迟权限撤销。保留 content hash + summaryEpoch 语义，待快照对比后再改缓存。

纠错与遗忘提供显式操作：撤销原条目、过滤索引与缓存、阻止从旧摘要重新提取被遗忘事实，必要时重建受影响摘要；备份与历史审计的保留范围向用户说明。routine / 学习任务只产生有来源的记忆候选；不会自行增加工具权限或修改系统规则。

`BOT_BASIC_SYSTEM_PROMPT` 是否恢复属于人格变更，与目录迁移分开。当前 `renderSections` 明确 `includeBasic:false`；保留行为、采集快照后再由独立切片评估，不能根据框架注释推定已经注入。

## 8. 自主性、能力与注意力

自主性通过 scope 明确的策略表达，不用一个全局 `autonomous=true`。至少区分“后台发现与建议”“用户委托的执行”“需审批的动作”，并限制数据、目标、预算、时效和工具能力。最终授权继续落在现有 runtime / capabilities 执行边界，Bot 的决定只是请求。

后台发现默认只读；预算包括每日模型额度、最大单次时长、触发频率、并发子任务数与通知额度。预算从已有 Run / 子 Run 用量结算；预留消耗用 CAS，避免并发超支；没有明确价格的 provider 不虚构金额，用 token / turn / time 限额。超额暂停并告知原因。

注意力规则区分 `silent / digest / notify / approval`，以用户时区、安静时段、事件重要性和冷却窗口决策。紧急豁免必须由用户策略指定；无新信息的定时检查不重复通知。暂停责任立即停新触发；到执行前再次检查当前授权和 routine revision。

渠道来源只是数据。创建、改权限和审批只接受已认证 owner / 授权审批者，外部邮件正文或 bot DM 不能提升为用户指令。应用凭据留在现有 vault / connector adapter；提示词、记忆、事件与日志只持 credential reference。

“暂停 Bot”返回分项 receipt：停止新自动触发、当前控制 Run 的取消结果、已委派子任务的停止结果、仍需对账的外部动作。若选择保留子任务，必须在查询结果中明确；不能用 paused 标签遮住仍运行的委派任务。断开 app 与遗忘已取得数据是两个独立操作。Shell 与浏览器等宽能力按现有 sandbox / permission 能力声明，不因有 Bot policy 就声称已经达到 Muse 式完整网络隔离。

## 9. 扩展机制

扩展使用已有插件 / capability 体系；Bot 定义窄的输入与贡献接口，由 Host 显式装配。业务规则不散落为 `if platform === ...` 或 `if botId === ...`。

| 扩展 | 接口职责 | 新增时应改什么 |
| --- | --- | --- |
| WakeSource | 校验并规范化输入、定义去重与重放语义 | 一个来源 adapter + schema + conformance tests |
| ChannelAdapter | 身份映射、附件边界、发送与回执查询 | 渠道适配器；不改领域调度或 Run 引擎 |
| Capability / Skill | 使用既有工具协议、权限、版本与插件信任 | 插件 / capability 配置；不复制注册系统 |
| ContextContribution | 有 schema、预算、来源的上下文快照 | Host prompt adapter；不能提供越权回调 |
| AttentionPolicy | 决定何时提醒，输入为纯事实 | 一个纯策略模块及场景测试 |

注册时验证唯一 ID、版本、依赖、schema 与所需能力；未提供实现的能力不得宣称可用。首个适配器是生产路径，第二个不同平台证明接口可扩展；不为尚不存在的扩展点写空 plugin SDK。

## 10. 数据、迁移与部署

保留现有 `~/.duya` 数据根、Bot slug、`bot:<id>` Session 映射和记忆目录。profile.json 仍是运行时显示身份源，config.toml 为声明与种子；SQLite agent_profiles 作为执行 profile，不强行合为一个表。Bot 服务对外给出一个规范视图，明确字段来源与写入 owner。

新增长期责任元数据与 inbox/outbox 必须走 data 现有迁移注册；不新增 Bot 专用数据库。源码 `createCoreDataStores` 已将 RunStore、GoalStore 与 PendingWakeStore 装在同一 core DB；新 inbox / dispatch receipt 优先加入该事务域。仍需验证经过 Host 控制面时的事务 / 崩溃窗口，不能仅因同库就声称原子派发。Bot 权限与责任引用已有 Goal / Project / routine，不复制它们的完整记录。

身份写入统一经 Host；迁移前先做 Desktop / standalone writer 对账与串行 / revision 控制。`profile.json` 与 TOML 的原子 rename 各自不能保证跨文件事务，创建需 durable intent、可修复的分步状态和故障注入。用户手改 TOML 是配置导入事件，校验后形成 revision，不能绕过权限规则。

新表 additive expand，保留旧 pending_wakes 导入映射；旧主键 `(kind, work_id)` 不够表达新去重作用域，回填需检查冲突并报告，不覆盖。迁移 dry-run 输出待导入 / 冲突 / 不可重建项目，先备份测试副本再 apply。没有完整 payload 的旧标记进入待核对，不生成假的用户消息。

运行模式明确区分 client-scoped 与 resident。现有 client lease 在最后客户端离开后可使 Host 退出；Bot 首版采用显式 resident Host，启动 / 停止 / 健康与恢复可查询。客户端关闭只断开观察，不取消其已受理责任。机器关机、休眠或网络离线期间不能承诺执行；恢复按每条 routine 的 skip / latest / bounded-catch-up 策略处理，不补跑所有历史定时。

## 11. 可观察性与完成标准

关联链统一为 ownerId → botId → responsibilityId / wakeId → dispatchKey → runId / attempt → deliveryId。Run 事件沿用现有 seq 权威，Bot 活动流有自己的持久游标，明确不是 Run seq；客户端按游标重放而非重新触发动作。

暴露排队年龄、受理到执行耗时、恢复次数、dead-letter、unknown delivery、通知数量、预算余额和 memory provenance。日志只记 ID、状态与错误码；内容按既有 transcript / prompt ledger 的保留规则存储。

完成需证明：无 UI 触发可执行、重复输入只产生一个受理身份、在受理 / Run 启动 / 终态 / 外部发送四处故障后仍可对账、过期 fence 被拒、跨 Bot / 项目 / 渠道不泄漏、多个客户端看到一致结果、旧 Desktop 调度消费者归零。具名验证与分阶段回退见迁移计划。

首个贯通渠道选现有 Telegram：已有 offset、connector、ack-redrive 夹具可复用，使用本地 transport 替身验证故障窗口；第二个以 Feishu 验证 adapter 无平台特判。真实账号冒烟在测试账号具备时补跑，不用夹具通过冒充真实外网发送。

未决实施选项为身份跨文件 journal 的具体结构与 Run / inbox 事务接缝；由 S1 / S3 探针裁决。它们不改变上述所有权与合同，未验证前不切生产路径。
