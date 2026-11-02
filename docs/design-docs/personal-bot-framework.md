# 个人长期 Bot 框架设计

> 2026-11-02：本文关于 Bot 统管 Project、Bot-first Desktop 和先做个人 Bot 的产品假设已被 [Project-first 决策/计划 #581](https://github.com/lava-chen/duya/pull/581)替代。本文保留为个人 Bot 的历史设计及基础实现参考，不再作为当前产品架构入口；Project Coordinator 独立于 Personal Bot。

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
| Desktop 与 CLI/TUI 是两个不同产品 | Desktop 以 Bot 工作台为中心；CLI/TUI 以即时 Session 执行为中心；共享 Host Session / Run 能力与 agent-runtime / protocol |
| Bot 身份不属于进程或主机 | `botId` 是逻辑身份；可本地或云端运行的 Bot Process 持有权威状态；Session Agent Host 有独立 `hostId` 与工作区；Bot 可跨 Host 调度，Host 也可服务多个 Bot |
| Bot Process 按阶段脱离 Desktop UI | 先完成 Bot 管理多个 Project、注入上下文并调用 Session Agent 的闭环，再支持本机后台 / 云端常驻，之后才加入远程 Agent 网络；不新建执行 Runtime |
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
| Project | Bot 管理的长期工作空间 / 主题；优先引用现有 Project ID，不复制项目存储 | 现有 Project 域；Bot 保存关联与策略 |
| Responsibility | 用户持续委托的责任，含成功标准、检查规则和预算 | Bot 领域；已有 Goal / routine 以 ID 关联，不复制 Task / Goal 状态机 |
| ProjectExecutionBinding | Project 到 Session Agent endpoint、机器和工作目录的执行绑定 | Bot / Host 的持久协调数据；目标机验证本地路径和权限 |
| Session | Session Agent 提供的协作与执行上下文；Desktop 可从任务打开这个 Session，但不提供全局 Session 工作台 | Session Agent API；Bot 与用户都可作为输入方 |
| Run / attempt | 一次执行及其重试身份 | Host RunOrchestrator / Run 控制面与 Runtime |
| Wake | 待处理的触发事实 | 持久化 Bot inbox；来源映射现有 WakeItem |
| ChannelBinding | 外部会话到 Bot / conversation 的已验证映射 | Host 渠道适配器及其 store |
| Memory | 带来源与作用域的事实和经验 | memory 域；Bot 仅请求检索、纠错、遗忘 |
| Delivery | 一条结果向某个目标投递的义务 | Bot outbox；远端回执是投递证据 |

Bot 生命周期为 `active → paused → active` 或 `active/paused → archived`。暂停时停止新后台触发并显式处理在途 Run；用户仍可查状态、取消和恢复。归档先停触发、撤销渠道与授权，再按保留策略处理数据；改名不换 ID，删除后不复用旧目录。

责任的用户视图可显示 `active / paused / completed / cancelled`；执行进度取自现有 Goal / Task / routine，不能再存一套同义执行状态。Bot 仅新增归属、成功标准、授权引用与检查策略。完成策略显式选择 `evidence_verified` 或 `owner_confirmed`；Run 成功只说明本次执行完成，不证明长期责任达成。`waiting_for_approval` 是当前 Run / 待办的阻塞投影。Bot 的在线、忙碌、等待审批由 Host 查询投影，不持久化第二套“正在运行”真相。

当前 `HostGoalApiV1` 按 Session 取 Goal，而 Bot 生命周期跨 Session。第一版用 ResponsibilityBinding 关联现有目标 Session / Goal / routine，新的上下文 Session 继续引用原目标身份。确需让 Goal 跨 Session 时，走通用 Goal 域的 additive contract 变更，不能在 Bot 包复制 GoalStore 或偷偷改变现有含义。

### 3.1 Bot、Project 与 Session Agent 的关系（2026-11-01 提案补充）

一个 Bot 管理多个 Project；每个 Project 可关联多个 Session 执行目标。目标由 Agent endpoint / Host、机器上的工作目录和 Session 复用策略组成，因此同一 Bot 能在不同机器的不同目录启动工作。Project 和 Responsibility 沿用现有领域 ID；新建的只是薄的 ProjectExecutionBinding / responsibility route，不再复制第二套项目或任务状态机。

    Bot (botId)
    ├── Project*（优先引用现有 Project）
    │   ├── Responsibility* / existing Goal or Routine reference
    │   └── ProjectExecutionBinding*
    │       ├── Agent endpoint / hostId / machine-local workingDirectory
    │       └── SessionRunBinding* → Run*
    │           └── VCS refs: repository, branch, commit, PR, merge
    └── bot-level policy / memory scope / default coordination context

Session 是独立的协作与执行实体，不属于 Bot 私有；用户和 Bot 可以访问同一个 Session。Desktop 仍以 Bot、Project、责任和结果为主，不提供脱离任务归属的全局 Session 列表 / 工作台；但用户可从任务详情进入绑定 Session，查看实时状态并直接协作。TUI 提供完整 Session 工作台。Bot 可为一个 Project 建立多个执行绑定，外部 Thread 订阅可以路由到对应 Project / Responsibility；没有明确目标的消息回落到 Bot 的默认协调入口。

Bot Process 负责选择 Project 和 execution binding，按权限与预算为当前 Run 组装 typed ContextEnvelope，再调用 Session Agent。Envelope 可包括当前任务与验收标准、Bot 角色策略、Project 摘要、按作用域检索出的记忆、必要历史引用和可用工具权限；Session Agent 不直接读取 Bot 私有记忆数据库，也不假定多个 Session 自动共享上下文。注入内容应有来源、scope 和预算，避免把 Bot 全量记忆无筛选地复制到每次 Run。

目标形态是让 Session Agent 通用、可移植：它接受一次明确的 Run 配置，运行工具并返回事件、结果、终态及可验证的 Git / PR 引用；Bot 负责长期身份、记忆检索、授权、Project 路由、任务状态和结果整合。当前已有不可变、带 provenance / fingerprint 的 RunManifest，但所覆盖的 capability 与上下文来源仍不完整，能力还分散于 Host 默认值、Session 字段、Agent Profile、Prompt System、全局连接器和自由格式 Run options 中，详见 §3.1.2。完整 Session 行为在现有 agent-runtime 内实现；Bot 通过 protocol 定义的窄 Session 调用合同工作，由 Host 装配本机 Runtime 或后续远端适配，详见 §3.1.3。Session Agent 是能力名称，不另建 package。

TUI 应是同一 Session Agent 能力的完整专业工作台，不混入 Bot 的长期记忆、跨 Project 规划、责任调度、Thread 路由或跨 Session 状态。当前已确认 `/project` 用于选择本机 Session 工作目录，`/pr` 用于读取 / 显式刷新当前 Session 关联的 PR；前者是执行输入，后者是 Session 级诊断，本身并不能证明 TUI 混入了 Bot 控制面。实施前仍需把 CLI/TUI 所有页面与 command 按所有权审计；若存在 Bot 长期规划 / 状态 / 路由职责，就移至 Bot。模型 / provider 选择、工具执行、权限提示、Session 上下文、工作目录和直接控制当前 Run 仍是 Session 工作台所需功能。Bot 调用稳定的 headless SessionAgentPort / Host API，不驱动交互式 TUI UI。Bot Project Activity 覆盖 PR lifecycle 后，再决定 TUI `/pr` 收敛为只读诊断或移除重复的项目级管理呈现。

执行绑定还要关联 VCS 生命周期，而不只保存 sessionId：将 Project / Responsibility / `runId` 与 repository identity、working directory、branch ref、head commit、PR provider / ID / URL、PR 状态、merge commit / 时间持久关联。现有 621 已提供 HostIntegrationApiV1、Session ↔ PR 多对多链接、基于 checkpoint commit 的 PR 匹配、显式 GitHub 刷新和 PR 状态历史；应直接扩展这条底座。当前 PR projection 记录 `headSha` 和 `merged` 状态，但没有 merge commit SHA / 时间 / 方法，也没有 Bot / Project / Run 关联或 PR 评论回路由。Session Agent 在运行时报告新建或切换的 branch、commit 和创建 PR 等事实；GitHub 等 VCS adapter 接收 PR 评论、关闭和 merge 事件，并按持久关联送回负责的 Bot / Project / work binding。合并必须落到具体 PR 与 merge commit（区分普通 merge、squash merge、rebase merge；source head 与 merge commit 不混为同一 SHA）。本机 git observation 与远端 PR webhook / poll 是两个来源，事件都需去重和记录来源，不能仅凭模型文本声称“已合并”。当前 worktree 可使用命名 branch，也可 detached；checkpoint ref 不能被误当作 branch 名。

Bot 的 Project Activity 汇总 branch、PR review / merge 与最终交付状态；当前 Desktop / Web 已有 621 的 Session checkout / integration UI，应整理到任务详情：Project Activity 展示汇总，Session Attach 展示该任务关联 Session 的执行状态并允许直接协作。两者复用 Host 查询与刷新能力，不建立重复状态源。PR / Issue 后续评论根据 VCS thread subscription 关联到原 Project execution binding，再由 Bot 决定是否唤醒同一个 Session Agent / Session。

### 3.1.1 Session Attach：Bot 监督与用户直连双通道

Bot 是长期负责人，Session 是可被 Bot 与用户共同访问的执行实体。Bot 创建或复用 Session 并订阅其重要状态；用户可从 Bot 的任务卡片进入同一个 Session，直接发送补充要求、观察 Run、工具结果和产物。Desktop 提供任务上下文里的 Attach 面板；TUI 提供完整 Session 工作台；浏览器插件、IDE 插件和 Mini App 经同一 Host / protocol 绑定目标 Session。Bot 不代理每条人类输入，也不需要先理解局部 DOM / 截图细节。

```text
用户 ── Desktop 任务详情 / Session Attach ─┐
用户 ── CLI / TUI Session 工作台 ─────────┼── Session collaboration API → 同一 Session / Run
插件 / IDE ── scoped Session input ────────┘                    │
                                                                  ├── Session transcript / tools / artifacts
Bot Process ── mandate / Run dispatch ──────────────────────────┤
Bot Process ←── progress / blocked / decision / result / VCS events┘
```

输入目标必须在 UI 中清楚可见，而不是交给模型猜：Bot 主面板的 composer 默认发给 Bot；任务卡片中的“进入 Session 协作”显示具体 Session、Host、工作目录后，composer 默认发给该 Session；TUI 默认发给当前 Session；插件只能向 launch 时由可信宿主绑定的 Session 发结构化输入。具体实现要求、当前代码 / 页面细节、选中元素的修改意见发给 Session；目标、优先级、跨 Project 任务、预算、授权和“以后都按此规则”发给 Bot。请求同时影响实现和长期责任时，可直接发 Session 并选择“同步给 Bot”，通过事件 / 摘要告知 Bot；不能默默代用户改收件人。

用户 Attach 不等于停止正在运行的工具。它取得一个持久、可恢复的**指令调度权**：同一 Session 的 Bot 自动输入暂缓，用户输入进入 Session 的有序输入路径；已经开始的 Run / tool invocation 按现有执行规则继续。Host 将 actor、来源 App、request id、Session / Run、顺序和附件 / UI 上下文引用一起记录。Desktop Attach 可显示本次 Run 的 capability manifest，并提供只从已授权 Skill / Plugin / App 能力集合中选择操作的入口；用户从 Mini App / 浏览器选中元素后发送“此处间距缩小”时，插件把结构化元素引用与具体要求直接送给 Session。插件只能补充输入或请求已授权能力，不能替 Session 增加 Host 权限；新增 capability 需由 Host policy 校验并形成清楚可见的新 revision。若当前 Runner 不能安全 steer，就排到当前 Run 的下一个输入边界，不能丢失或假报已送达。

Bot 在用户接管期间保持观察，但不再向这个 Session 派发新的指导、重试或中断命令。用户显式“交还给 Bot”后，Bot 先对账 Run 终态、最新 Session 事件、用户输入和待处理任务，再恢复协调；不能盲目重发接管前的命令。崩溃恢复使用可过期的 attach lease / 心跳与状态 revision，重复 attach / release 按 request id 幂等。`sessionId` 是实体标识，不是授权凭证；每个客户端仍需通过用户身份、Host 身份和 Session capability 授权。插件只获得目标 Session 的窄输入 / 附件权限，不得因 Attach 获得任意 transcript 或工具权限。

同一 Session 同时只能由一个 Session Agent Host 执行。会话历史、Agent endpoint、工作目录和 artifacts 必须绑定到具体执行环境；跨机器恢复需要明确的 transcript snapshot / workspace transfer 合同，不能只复制 sessionId。不同 Session 若访问同一个可写目录，仍默认串行；并行写入要先为 Project 的不同执行目标配置隔离目录 / checkout。

Bot Activity 汇总 Project / Responsibility、当前 Run、待审批、外部反馈和投递事实。Session busy 从现有 Run 派生，Run terminal 不代表 Project 或 Responsibility 完成。Desktop 从任务进入 Session Attach，显示有限的 Session / Run 状态并提供直接协作；跨 Session 发现、完整执行控制与专业排障仍由 TUI 承担。

### 3.1.2 Session 当前实现的厚度与目标调用配置

按目标架构衡量，当前 Session Agent 仍有偏厚的默认装配，但不缺少 Run 级状态基础，也不需要重写 Session / Run 引擎。Duya 已有不可变的 `RunManifest`：记录 Project / Task、cwd / roots、权限策略、profile / mode / tool 能力快照、model / provider、budget 与配置来源 provenance；Host 构造后计算 fingerprint，Run store 原样保存 manifest JSON 与 hash，供幂等和恢复校验。[RunManifest](../../packages/agent-protocol/src/manifest.ts#L139) [Manifest factory](../../packages/host/src/manifest-factory.ts#L171) [Run store](../../packages/data/src/run-store.ts#L61) `StartAgentRunInput` 也已有每 Run model / provider / effort / permission / profile / mode / tools 的 typed overrides。[Run API](../../packages/agent-protocol/src/run-api.ts#L164)

缺口是当前 manifest 尚未表达任务实际使用的 Skill / Plugin / MCP / App 能力与上下文来源；`connectorBindings` 当前始终为空，因为 Host connector store 还没有可支撑该绑定的 scope。文件附件已有 typed Run input / attachment reference；mentions、display content 等仍有字段通过自由格式 `options` 传递，Bot ContextEnvelope 的完整来源 / budget 尚未形成同一事实快照。[Connector binding assembly](../../packages/host/src/manifest-factory.ts#L228) [Run API attachments](../../packages/agent-protocol/src/run-api.ts#L213) 旧 Worker 执行路径还存在全部 capability 以 synthesized / unsupported 写入的 legacy manifest，Bot 路由要确认走的是 canonical manifest factory。[Legacy manifest path](../../packages/host/src/worker-run-composition.ts#L372) Session 持久行仍保存工作目录、默认 model / provider、permission mode、Agent Profile；新 Session 缺少 model / provider 时会从 Host 配置补默认值。每轮又从长期 MCP registry、缓存的 App Connection 描述、默认 Prompt Profile、项目 `AGENTS.md`、Agent Profile 和技能目录组装运行环境。

这会让 Bot 创建的 Session 隐式继承执行 Host 上的用户能力和默认上下文；而多任务并行时，每个 Session 实际需要按任务装配不同模型、提示、Skill、Plugin、MCP / App 工具、上下文和权限。需要区分：Session transcript、Host / workspace 绑定、Run 与事件历史是必要的执行基础；Bot 长期记忆、Project 目标、任务拆解与跨任务 PR 决策属于 Bot 控制面；Prompt / tools / skills / plugins / context 的“本次可用集合”应成为显式 Run invocation，而不是 Session 的隐式全局属性。

| 层 | 应持有 | 不应隐式承担 |
| --- | --- | --- |
| Bot / Project | 长期目标、责任、项目记忆索引、规划与任务依赖、并发和 merge policy | Session transcript、Runner 状态、工具实现 |
| Session | 稳定身份、对话 / 参与者输入、Host 与 workspace 绑定、Run / artifact 关联 | Bot 的长期目标、跨 Project 记忆、随 Host 漂移的工具集合 |
| RunManifest（现有，待扩展） | 本次模型 / Harness、Prompt layers、Skill / Plugin / MCP / 工具授权、上下文引用与 token budget、权限上限、任务验收标准及来源；保留既有不可变 fingerprint / provenance | 隐式读取整个 Host 的用户能力或 Bot 全量记忆 |
| Agent Runtime | 通用 Session 服务、按显式配置装配本轮输入、模型/工具循环和事件 | 直接读取 Bot 私有状态或导入 Host 的具体 IO 实现 |
| Host | 解析和授权 capability references、冻结 manifest、注入模型/存储/工具/工作区/进程适配 | 另写一套通用 Session 调度、让 prompt 充当授权边界 |

建议直接增量扩展现有 `RunManifest`，不新建 `SessionInvocationManifest` 或 Profile registry。Bot 通过 `StartAgentRunInput` 显式提交已有 Project / Task / AgentProfile / model / permission / tool 字段，再逐步为缺失项添加 typed references：context source refs / budget、prompt profile/version、skills、plugin / MCP / App connector bindings、验收与输出约定。能力来源沿用 manifest provenance，新增 schema 时遵循现有 hash 与旧版本兼容规则。Host 解析这些 references 到本机已有实现，使用 `requested ∩ installed ∩ authorized ∩ project policy` 校验；凭据保留在 Host vault / provider 配置，不在 manifest 中传输。缺少 scope 维度的连接器存储先补最小 scope binding，不能用 `options` bag 假装权限可审计。

独立使用的 CLI / TUI 保留当前便捷的模型、常用工具与本机配置，作为显式的 interactive defaults；Bot 启动任务时显式传入 Project + Task 范围的 Run 配置，未指定能力不因同机安装而自动继承用户插件、技能或连接器。Bot-created Session 被用户 Attach 后，显示当次 Run manifest 中的 profile、工具和上下文来源；用户在插件中提出的局部指令进入同一 Session，临时新增能力仍需 Host policy 校验，不能绕开 manifest 授权。

同一 Session 后续 Run 可在显式配置下沿用上一能力集合，或按新任务生成新的 RunManifest；默认不可默默切换能力。现有 Run store 已保存 manifest JSON / fingerprint；扩展后让同一 fingerprint 覆盖 capability refs、source versions 与有效授权快照，供 Attach 用户理解当前 Agent 能做什么、失败时复现其行为。无需把编译后的全部 system prompt 或 Bot 私有记忆复制进 Session row；持久保存可审计引用、prompt/input revision 和足够的执行快照即可。

这与成熟 SDK 的常见分层一致：OpenAI Agents SDK 将 Agent 的 instructions / model / tools、每次 Runner 调用的 dependency-injection context、以及单独持久化对话历史的 Session 分开；Anthropic Managed Agents 将 Agent 配置（model、system、tools、MCP servers、skills）与承载环境和对话历史的 Session 分开，允许创建 Session 时做 session-specific override，并支持部分工具配置在 Session 内更新。后者目前标为 Beta，适合作为边界参考，不应直接照搬其 API 或假定其生命周期保证适用于 Duya。[OpenAI Agents / Context](https://openai.github.io/openai-agents-js/guides/agents/) [OpenAI Sessions](https://openai.github.io/openai-agents-js/guides/sessions/) [Anthropic Agent setup](https://platform.claude.com/docs/en/managed-agents/agent-setup) [Anthropic Session operations](https://platform.claude.com/docs/en/managed-agents/session-operations)

因此结论是：相对“Bot 组合能力、Session 被调用”的形态，Duya 当前 Session 还有偏厚的 Host 默认装配，但 RunManifest / fingerprint / provenance 这条基础已经存在。Plugin / Skill / MCP / context refs 增量纳入现有 RunManifest；通用 Session 管理与装配行为迁入现有 agent-runtime，Host 注入 IO 与可信准入。Bot 对每个 Task 明确传入配置，既有本地 TUI 保留有来源的默认配置。

### 3.1.3 包边界与实施次序（已采纳，尚未实现）

完整 Session 能力使用现有 agent-runtime，在包内建立 session / assembly / engine 边界。session 负责跨 Run 的历史恢复、输入次序、控制权与通用调用协调；assembly 组合显式配置与已准入资源；engine 沿用现有 RunEngine、工具流水线、预算、取消、压缩和事件语义。现有 RunSession 是每 Run ledger/settlement 实体，不能直接替代持久对话 Session。

Host 注入存储、模型、工具/插件解析、工作区、进程和网络适配，继续负责认证授权、runId、manifest 冻结与既有 durable barrier 的可信入口。Runtime 通过窄端口使用这些机制，不反向导入 Host/data/ai/bot/Electron。将 WorkerSession 全文件搬进 Runtime 会带入 Bot prompt、memory 和配置依赖；应逐依赖拆开、逐调用方迁移。

Bot 可建模为长期身份/项目任务状态、一个协调 Session 和多个工作 Session。协调与工作复用同一 Runtime；协调 Session 可重建，Bot 身份与任务关系独立持久化。bot 包保持纯领域/应用规则，只依赖 protocol，通过端口请求执行；Host 装配 Bot 与 Runtime，不要求 bot 包直接 import Runtime。

实施合同与逐包地图维护在[计划系列 00](../exec-plans/backlog/bot-session-runtime/00-package-and-protocol-contracts.md)。四个本机交付模块为 R1 Session Runtime → R2 能力/上下文 → R3 项目并行协调 → R4 PR 交付与任务 Attach；R5 后台常驻/多机在本机交付后推进。既有模型循环、Run ledger、transcript 和 PR store 复用原权威，迁移引入的缺口使用 additive contract。

### 3.2 产品、Bot Process 与 Session Agent 的边界（2026-11-01 架构决策）

本设计采用两个面向用户的产品形态。Desktop 是 Bot-first 工作台，围绕 Bot 和其多个 Project 工作，并允许从任务详情 Attach 到相关 Session；不提供跨项目的 Session 列表或与任务无关的 Session 工作台。Bot Process 可部署在用户本机或云端，独立于 Desktop UI 生命周期。CLI / TUI 是 Session-first 专业终端；底层 Session Agent 可在不同系统、目录和机器上运行，Bot 与用户客户端通过统一协议访问它。

| 层 | 用户与职责 | 主要对象 |
| --- | --- | --- |
| Duya Desktop（Bot-first） | 管理 Bot、Projects、长期目标 / 责任、记忆、自动化、审批、节点状态与结果；从具体任务查看 Session 状态并 Attach 直接协作，不提供全局 Session 工作台 | botId、Project、Responsibility、Task Activity、task-linked Session Attach |
| Duya CLI / TUI（Session-first） | 完整 Session 工作台：创建 / 连接 / 恢复 Session，直接与 Agent 协作，监督 Run；支持编程 / 终端、多模型 / Harness、临时任务与并行工作 | sessionId、runId、工具事件、workspace |
| Bot Process | Bot 的持久协调进程，可本机或云端运行；持有长期状态，选择 Project / Agent endpoint，组装上下文并调用 Session Agent | botId、policy、project binding、context envelope、任务路由 |
| Duya Session Agent | 提供底层 Session / Run 能力，可部署在不同 OS、容器、云 VM 或本地机器，被 Bot 或 TUI 调用；返回结构化执行与 Git 活动事实 | agent endpoint、hostId、Session / Run、机器本地工作区 |

目标形态如下。第一阶段 Bot Process 仍可由当前 Host 装配并与本机 Desktop 同机；第二阶段它脱离 Electron UI 生命周期，支持本机后台或云端部署；第三阶段 Session Agent endpoints 扩展到不同机器和目录。当前 master 尚没有云端 Bot Process 和跨机 Session Agent 协议。

    Desktop Bot UI ───────── Bot Process（本机或云端）
                                  │ 管理 botId / projects / memory / policy
                                  │ 选择并打包当前 Run 的上下文
                                  ▼
                         Session Agent protocol
                         ┌────────────┴────────────┐
                Host A / 项目目录 A       Host B / 项目目录 B
                Session Agent            Session Agent
                Session → Run            Session → Run

    CLI / TUI ────────────── Session Agent
    （直接使用底层执行能力）

Desktop UI、Bot Process、CLI/TUI 与 Session Agent 共用版本化 agent-protocol、Host Session / Run contract 和 agent-runtime；不复制 Bot 专属模型循环。Session Agent 的 headless Host API 是 Bot 调用的执行单位；TUI 是人直接操作同一能力的专业工作台；Desktop 通过 task binding 附加到这个 Session。Session API 还不成熟，Bot→Session 与客户端 Attach 之间保留适配层和版本化协议。Session Agent / Host 报告本地 checkout、branch（若存在）、commit 和运行结果；独立的 VCS provider adapter 观察 PR / review / merge。Bot 域把这些有来源的事实关联到 Project / Responsibility / Run，并负责长期状态投影和后续事件路由。

状态与身份分层：

- `botId` 是逻辑 Bot 身份；Bot Process 是当前持有 Bot 长期状态和协调权威的运行实例。进程重启、换主机或从本地迁往云端不改变 botId。
- `projectId` 引用 Bot 管理的项目；`ProjectExecutionBinding` 将项目和责任映射到 agent endpoint / hostId / 工作目录 / Session 复用策略。
- `hostId` 标识承载 Session Agent 的机器或隔离执行环境。一台 Host 可为多个 Bot 执行授权任务，一个 Bot 可使用多台 Host。
- `sessionId` 是执行环境提供的协作上下文 ID；Bot 可创建或复用，Desktop 在任务详情显示其状态并允许 Attach，不提供全局 Session 工作台。
- `runId` 标识一次执行。Bot Process 权威维护任务归属、记忆和 ContextEnvelope；执行 Host 持有本地 transcript、工作目录和 artifacts。用户和 Bot 都可向同一 Session 发送有 actor identity 的输入；Bot 订阅关键状态。Desktop 同时显示项目级汇总和任务关联 Session 的协作面板。
- Desktop UI 关闭不应终止已接纳工作；TUI 保留独立 Session Agent 的本地执行能力。

现有发布流程已经区分 `desktop/v*` 与 `cli/v*`。当前 CLI 包含 Host Worker 与 Node Runtime，可本地独立执行；Session Agent 跨机器运行仍需新增部署 / 连接合同。[Desktop / CLI 发布计划](../exec-plans/active/2026-10-29-product-release-separation.md) [CLI 打包脚本](../../scripts/package-cli-release.mjs) 云端 / headless Bot Process 可能需要 `duya-bot` 部署包与 `bot/v*` 发布线；这属于 Bot 产品的部署形态，不是第三种用户工作流。协议兼容版本与 Desktop、CLI、Bot Process 的二进制版本分开协商。

**复用当前 PR lifecycle 实现：** 621 计划已提供 HostIntegrationApiV1、Session ↔ PR 多对多关联、显式 GitHub sync、SQLite 最新观察与状态迁移历史，以及基于 checkpoint commit 的 PR 匹配。新 Bot 层从这些能力构建 Project Activity 和 binding；不再写一个第二套 PR observer / PR 状态库。当前 projection 只有 PR head SHA 和 `merged` 状态，没有 merge commit SHA、时间、方式，也没有 Bot / Project / Responsibility / Run 归属或评论事件回路由。`unknown` 与观察错误继续作为正式状态，禁止推测合并成功。

**Session TUI 的职责核查：** 当前 CLI/TUI 含 `/project` 本机工作目录选择和 `/pr` Session 关联 PR 读取 / 刷新。前者是运行 Session 所需的 cwd 输入，不等同于长期 Bot Project 管理；后者可作为 Session 诊断，但长期 PR / review / merge 状态与评论回路由应由 Bot Project Activity 持有。R1.0 需把现有 TUI command / 页面逐项归类：保留执行必需的 provider / model、工具、权限、cwd、Session / Run 控制；将 Bot 长期记忆、跨 Project 规划、责任调度、订阅路由和项目级状态管理迁至 Bot。Bot Activity 补齐后再决定 `/pr` 只保留诊断或移除重复呈现，不让 TUI 另建状态源。

多环境接入阶段通过短时一次性配对凭证注册 Session Agent Host，随后节点建立持久双向认证加密连接。Tailscale / WireGuard 可先提供网络可达性；应用层仍需验证 Host 身份、Bot / Project 授权范围、协议兼容、ContextEnvelope scope 和 Run mandate / fencing。节点离线时 Bot Process 保留任务与事实，按策略等待或重新分配；未知的外部副作用结果不能标记为成功。首版不承诺活动 Session 跨机器透明迁移、多写者 Bot Process 或 HA。

落地顺序：① 在现有 agent-runtime 建立统一 Session 服务与输入/控制合同，Host 注入适配。② 扩展既有 RunManifest，完成任务能力/上下文隔离。③ Bot 建立 Project/Task/Session 绑定并在隔离工作区受限并行。④ Desktop 接入任务 Attach，同时补 PR/CI/review/merge 交付闭环。⑤ 将 Bot Process 从 UI 生命周期抽开，再接多机配对和远程 Run。详细依赖、迁移与验收以计划系列为准。

不同 Session 只有在工作目录或 checkout 已隔离时才允许并行写同一仓库；不同上下文本身不构成文件隔离。没有隔离环境时 Host 按共享 workspace 串行调度。

实现计划见[Bot-first Desktop / Project / Session Agent 协调计划](../exec-plans/backlog/2026-11-01-bot-session-coordination.md)，证据见[多 Session Agent 协调架构研究](../references/agent-coordination-models.md)。这是设计提案，不表示上述多 Session route 已落地。

## 4. 目标模块边界

| 包 | 负责回答的问题 | 不应承担 |
| --- | --- | --- |
| `@duya/bot` | 这个长期角色承担什么、管理哪些 Project / Responsibility、怎样选上下文、路由事件并关联 Session / Git / PR / merge 事实 | 模型 / tool 轮次循环、worker、网络、DB、凭据执行与 VCS provider I/O |
| `@duya/host` | 用哪些真实适配器运行这些用例，哪个 Run 已受理，怎样对账 Session / VCS 生命周期 | 将 Bot 规则散落进 HTTP / worker handler 或 provider SDK |
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
  ports/           narrow repository/run/session/memory/VCS/delivery/clock interfaces
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
| `getBot / getProjectActivity / getResponsibilities` | 只读；呈现 Project、Run、branch、PR、merge 和交付摘要，并给任务详情提供对应 Session Attach 引用；不提供全局 Session 管理 UI，也不触发 Run |
| `bindExecutionTarget` | 绑定 Project 到授权 Agent endpoint、hostId、repository 和工作目录；变更有 revision，可审计并撤销 |
| `attachSession / sendSessionInput / releaseSessionControl` | 认证并解析任务绑定到确切 Host / Session；Attach 获取可恢复的 user-control lease；输入携带 actor、来源 App、requestId、Run / turn、附件与 UI context reference，幂等写入同一 Session；不能 steer 时进入安全队列；release 后触发 Bot reconcile |
| `handleVcsEvent` | 验证 provider event / receipt，将 branch、PR、review、close / merge 事实关联到 Project / Responsibility / Run；幂等更新 Activity，必要时产生新的 wake |
| `reconcile` | 对账 claim、dispatch receipt、Run 终态与 outbox；只补缺失环节，不盲目重做动作 |

`RunPort` 提供 start / inspect / cancel 并复用 Host 接口。start 必须支持持久 dispatchKey 的幂等受理；cancel 绑定捕获的 runId + attempt，不能取消 Session 中后来的新 Run。接受拒绝时不得产生 worker 执行。

Session control lease 只门控 Bot 的新 Session 输入 / 指令，不替代 Run / Host 执行锁，也不停止运行中的工具。用户 lease 生效时 Bot 仍可读事件并更新项目摘要，但将待发 Bot 指令保留在 durable queue；release / lease recovery 后先 reconcile 现有 Run 和 transcript，再决定丢弃、合并或发送新的指令。Session 输入按 Host 级单一顺序与幂等键持久化，避免 TUI、Desktop、插件和 Bot 各自形成一条 transcript。

`BotRepositoryPort` 只暴露原子业务操作，如 accept、claim、attachRun、completeInput、enqueueDelivery；禁止提供裸 SQL、通用 db.call 或多个独立 save 拼装事务。`MemoryPort` 接收 owner、bot、project、audience 作用域和预算；`VcsPort` 以结构化 repository / branch / PR / merge ref 和事件 receipt 返回可验证事实；`DeliveryPort` 返回明确远端回执或 unknown outcome。端口结果使用具名联合类型，不以 null / 空数组吞掉基础设施失败。

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
