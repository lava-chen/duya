# 多 Session Agent 协调架构研究

查阅日期：2026-11-01。Duya 源码基线：master commit 4f0738bae34777cce45308291f3207f90e6705a1。DeepSeek 原型基线：commit 6337fc823ce20251c8de8085948165c81aaa701e。用途：厘清 Claude Code Projects、DeepSeek Super-agent 与 Duya Bot 的共同模式、不同抽象层级，以及 Duya 可用最小 Bot 架构调整承接的能力。

## 摘要

三者确实收敛到相近的控制结构：一个长期入口维护目标与上下文，协调独立执行 Session，并把输入事件、执行结果和后续反馈连到正确的工作上。但它们不是同一套架构的三个实现，抽象层级也不同。

最容易混淆的是“工作单元”和“执行上下文”：

| 系统 | 长期协调对象 | 持续工作 / 路由对象 | 执行上下文 | 一次执行 |
| --- | --- | --- | --- | --- |
| Claude Code Projects | Project coordinator | Project goal 与 coordinator 管理的 Thread | 每个 Thread 是独立 Claude Code cloud session | Thread 内的一轮或一段执行；公开资料未给出等价于 Duya Run 的内部实体 |
| DeepSeek 原型 | Main Session 负责接单、授权和路由 | Ticket；Assignment 是 Worker 的执行分配 | 每个 Ticket 有自己的 Worker Session 与工作目录 | Assignment / Worker turn |
| Duya 当前实现与设计方向 | Bot 长期身份；Desktop Bot Process 负责协调 | Bot 管理的 Project / Responsibility 与 execution binding（目标模型） | Session Agent 提供的 Session | Host Run API 创建的 Run / attempt |

因此不能把 Claude 的 Thread、DeepSeek 的 Ticket、Duya 的 Run 并列为同一种“工作单元”。跨项目比较时，更清楚的关系是：

    Bot
      └── Project*
            └── Responsibility / Work binding
                  ├── 外部 Thread subscription
                  └── ProjectExecutionBinding*（Agent endpoint + 机器目录）
                        └── Session Agent → Session → Run / attempt

对 Duya 最合适的落点是两种产品 + 一个共享执行层：Desktop 是只面向 Bot / Project 的工作台，由可在本机或云端运行的 Bot Process 持有长期状态；CLI/TUI 是 Session-first 的专业终端；Bot 按 ProjectExecutionBinding 调用不同环境里的 Session Agent。Bot Process 为每次执行选择 Project、机器和目录，并将授权范围内的记忆与任务上下文打包传入 Session。Session 是底层执行工具，不再成为 Desktop 的单独 UI 概念。不需要改造 agent-runtime，也不应复制一套 Goal、Run、审批或调度引擎。

## 范围与证据等级

本报告只依据产品官方说明、DeepSeek 原型源码和 Duya 当前 Git 源码。闭源产品的内部表结构、planner prompt、任务 DAG、租约协议和失败重放方法均不从界面行为反推。

| 来源 | 基线 | 可支持的判断 |
| --- | --- | --- |
| Anthropic 官方 Projects 公告 | 2026-09-17 | Claude Code Projects 对用户公开的目标、Thread、共享记忆、云端执行与整合行为 |
| Anthropic Managed Agents 官方文档 | 2026-11-01 查阅 | 该独立 API 产品中的 coordinator、session thread、状态与事件机制；不能断言 Claude Code Projects 使用同一实现 |
| DeepSeek dsh-superagent-prototype | commit 6337fc8 | 公开研究原型确实实现的 Trigger、Ticket、Assignment、Thread subscription、持久 effects 和 outbox |
| Duya master | commit 4f0738ba | Duya 已有的 Session / Run、Bot Inbox / Dispatcher、计划 621 的 checkout / Session ↔ PR observation 实现，以及 Bot 框架设计提案 |

DeepSeek README 明确称仓库为研究原型、非官方通用产品、非生产就绪，并说明公开代码不等同于文章或内部实现；文章中的部分方向不在公开代码内。因此本报告只把代码可见行为记为“已实现”，不把论文描述扩展成源码事实。[DeepSeek README](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/README.md#L1-L9)

## Claude Code Projects：目标驱动的协调产品

Anthropic 官方说明把 Projects 从收集文件和聊天的项目容器改为以目标为入口的协调体验。用户提供目标和仓库或其他上下文；Coordinator 可以建议可立即开展的工作，把请求路由到新建或已有 Thread，协调并行工作、检查结果、汇总交付。用户可在主 Project chat 观察和干预，也可进入 Thread 查看细节。连接仓库时 Thread 可以运行测试并开 PR。[Anthropic Projects 公告](https://claude.com/resources/articles/projects-redesigned)

公告可确认的执行与上下文行为：

- 每个 Thread 都是 Claude Code cloud session，使用自己的分支和仓库副本；Coordinator 组织工作，但重叠代码仍可能产生普通 Git / PR merge conflict。
- Project 的线程共同写入并读取 shared memory；Project library 保存用户加入的文件和 Claude 产生的 artifacts。
- Thread 可以按需再使用 subagents、loops 和 workflows 拆更大的工作。
- 公告称用户离开电脑后任务仍会继续；发布时描述的 Thread 在云端运行，本地执行被列为后续方向。
- 多个 Thread 都是完整 Session，所以公告提醒它们会更快消耗使用额度。

公告没有说明 Coordinator 的内部规划算法：没有公开拆分阈值、DAG 格式、任务依赖调度、线程重试策略、thread-to-goal 数据模型或共享记忆冲突解决方式。可观察到的产品契约是“给目标、可引导并行工作、能汇总”，不是可复制的具体 planner 实现。

Anthropic 的 Managed Agents API 文档另有 Coordinator / Session threads 机制：primary thread 汇总子线程活动，子线程各有隔离上下文和对话历史，线程可被后续调用；Session status 汇总 agent activity。该 API 还公开了线程事件和共享 session budget。这些内容可以帮助理解 Anthropic 如何设计 thread observability，但它是一个单独的 API 产品表面，不能当作 Claude Code Projects 内部实现的证据。[Managed Agents 多 Agent 编排](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration)

## DeepSeek Super-agent：事件驱动的持续工作

DeepSeek 原型以一个 GitHub 仓库为主要范围，能接收 GitHub、可选 Feishu 输入。它的核心不是让人给 Project 写一个长期目标再自动拆成无限任务，而是先处理外部 Trigger：权限与规则判断后，允许的工作形成 Ticket 与 Mandate，再为 Ticket 启动 Worker。

源码行为：

- Engine 将 Trigger、Thread、Decision、Ticket、Assignment 的状态变化放在同步事务边界中；收到 Trigger 会将事件分发给订阅该 Thread 的 Ticket。[Engine](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/core/engine.ts#L20-L55)
- 创建 Ticket 时会记录 Mandate、创建首个 Assignment、订阅相关 Thread，并排入 Worker 启动。[Ticket 创建](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/core/tickets.ts#L32-L55)
- 原型以 ticketId 派生 worker Session ID；Ticket 是工作身份，Session 是执行上下文。[Worker Session 映射](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/executor/dsh.ts#L22-L26)
- 关联 PR / Issue Thread 的后续事件可以通过 subscription 送回 Ticket；工作结束不只取决于 Worker 报告，也可能要等被跟踪 Thread 合并或关闭。
- Assignment 中断恢复会查看最近的 Worker report 与新输入是否已送达，决定恢复原 Session 还是重新开始执行。[Assignment 恢复](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/core/assignments.ts#L78-L92)
- SQLite effects queue 在业务事务中登记外部副作用，启动后按限制执行并重试；Outbox 将回复保存为 receipts 后再按序发送。[Durable effects](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/effects.ts#L43-L65) [Outbox](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/outbox.ts#L17-L51)

这让 DeepSeek 在“某个 Issue / PR 后来有新消息时，谁继续负责”这类问题上有清晰模型。它的强项是事件归属、Ticket 生命周期与可靠恢复；公开原型并不等于通用 Project planner，也不表示所有长期主动任务已实现。

## Duya 当前能力与缺口

### Session 已经是可调用的 Host 能力

Duya 的 Host Session API 已能创建、查询、列举、更新、归档 Session；Run Execution API 按 sessionId 启动 Run，并提供取消、事件观察等执行边界。[HostSessionApiV1](../../packages/agent-protocol/src/session-api.ts#L450) [StartAgentRunInput / HostRunExecutionApiV1](../../packages/agent-protocol/src/run-api.ts#L165)

这符合“Session Agent 是底层能力、Bot 可以调用”的方向。当前 Host API 已提供部分创建和执行接口，但 Session 能力尚不成熟，Bot 应通过窄 Host adapter 调用，而不是 import agent-runtime 或在 Bot 包内部运行模型循环。Session 是执行上下文；一次 Run 是对该 Session 的一次调用。Session 不必知道它归属哪个 Bot、Project、渠道或长期责任。

Duya 现有可靠执行基础也足以避免重造：Durable Run 记录 attempt epoch 和终态；Bot Inbox 有去重与 claim；Bot Outbox 记录投递责任及 uncertain outcome。后续架构应在 Bot 控制面关联这些权威，不另建 Effects / Outbox / Run ledger。

### Session 与 GitHub PR 已有一段生命周期底座

最新 `master` 已合入 621 工作区生命周期计划中的 Git / PR 基础设施，新的 Bot 设计应扩展它，而不是重新起一套 PR store：

| 已有实现 | 当前能回答什么 | 不能据此推断什么 |
| --- | --- | --- |
| `HostIntegrationApiV1` 与 Host integration routes | 查询某 Session 最近观察到的 PR；显式刷新其工作目录关联的 PR；记录 Session ↔ PR 多对多关联 | 还没有 Bot / Project / Responsibility / Run / Host 的完整归属链，也不是 Bot thread subscription |
| `createIntegrationSync` + GitHub `gh` observer | 沿 Session → cwd → origin → checkpoint commit refs → GitHub PR 对账；识别 draft、CI、review、merged / closed 状态 | 当前是显式刷新流程；未发现 GitHub PR 评论 / review webhook 被接进负责该工作的 Bot / Session 路由 |
| `IntegrationStore` migration 43 / 44 | SQLite 保存 PR 最近一次观察和状态变化历史；`unknown` 保留错误原因，不伪装成 `open` | 不是完整 provider event ledger；`integration_events` 记录状态变化，不记录 PR 生命周期的全部原始事件 |
| Workspace / checkout provider | 可为 Session 创建独立 worktree；支持传入 branchName，也可使用 detached checkout，并为 detached commit 写 checkpoint refs | branch 不是每个 Session 都有的稳定身份；当前 PR 匹配依赖 checkpoint commit，不构成完整 branch lifecycle feed |

现有 integration 记录的 `headSha` 是 PR head SHA；observer 没有请求或保存 merge commit SHA、合并时间和合并方法。因而它能显示“上次观察时 PR 状态为 merged”，尚不能回答“具体以哪个 merge commit、何时、以何种方式合入”。本机 checkout 的 base sync / merge outcome 也应与 GitHub 上 PR merge 分开建模。

代码证据：[integration wire contract](../../packages/agent-protocol/src/integration-api.ts)、[Host integration API](../../packages/host/src/integration-api.ts)、[Session 级 GitHub sync](../../packages/host/src/scm/sync.ts)、[GitHub PR observer](../../packages/host/src/scm/observe.ts)、[SQLite projection 与状态历史](../../packages/data/src/integration-store.ts)、[checkout provider](../../packages/host/src/workspace/checkout-provider.ts)、[计划 621](../exec-plans/active/621-coding-workspace-lifecycle-harness.md)。

当前 TUI 也已带有 `/project`（选择本机 Session 工作目录）和 `/pr`（显示 / 刷新关联当前 Session 的 PR）命令。前者是 Session 执行位置选择，不等同于 Bot 长期管理的 Project；后者是 Session 级 PR 诊断界面。Desktop / Web 当前还通过 621 的共享 workspace lifecycle 面板展示 Session 关联的 Checkout / Integration。这些现状要进入产品边界迁移清单：Bot 的 Project Activity 应成为长期 PR / merge 状态的权威入口；TUI 是否保留 `/pr` 作为临时诊断命令，应在 Bot Activity 覆盖相同事实后决定，不能让两处 UI 各自形成状态和事件路由。

### 当前是双发布线，但 Bot Process 还未脱离 Desktop UI 生命周期

当前 master 已有 Desktop 与 CLI/TUI 独立发布：Desktop 使用 `desktop/v*`，CLI 使用 `cli/v*`。CLI 打包脚本将 `packages/cli/bundle/cli.cjs`、`packages/host/bundle`、Node Runtime 和运行依赖放在同一个自包含发行包中；CLI 入口也会调用 `startLocalHost`。所以 CLI 当前不是纯客户端，保留本地独立 Session 执行符合 Session-first 产品目标。[发布计划](../exec-plans/active/2026-10-29-product-release-separation.md) [Release workflow](../../.github/workflows/release-cli.yml) [CLI 打包脚本](../../scripts/package-cli-release.mjs) [CLI 入口](../../packages/cli/src/index.ts)

源码里已经有 Bot 领域包与 Host API 能力，但当前设计提案仍以 Host 装配为主，还没有可脱离 Desktop UI / Electron 生命周期、可本机后台或云端部署的 Bot Process，也没有多环境 Session Agent 注册与远程 Run 协议。因此产品发布分线不能被误读成协调进程与执行环境已经解耦。

### 当前 Bot 路由仍是一 Bot 一默认 Session

最新 master 的 Bot Dispatcher 按 Bot ID 检查忙闲，并把当前 Bot 的一轮输入串行调度到 bot:<botId> Session；Local Host 的 resolveInput 也固定返回该 Session。[bot-dispatcher.ts](../../packages/host/src/bot-dispatcher.ts#L114) [local-host.ts](../../packages/host/src/local-host.ts#L742)

这使现有系统可以可靠地串行处理同一个 Bot 的多次唤醒，但没有表达“某个 Project 在另一台机器的某个目录启动 Session”或“外部 Thread 的后续消息直达对应 Project / 执行绑定”。Worker Session Registry 的流式和完成状态又是 Host 进程内运行态，不应单独充当持久任务状态。[WorkerSessionRegistry](../../packages/host/src/worker-session-registry.ts#L79)

现有 Bot 领域包主要提供 Bot 身份应用服务；调度仍属于 Host。个人长期 Bot 设计提案已将 Bot、Responsibility、Session、Run、Wake、ChannelBinding、Memory、Delivery 分开，且明确一个 Bot 可关联多个 Session；Responsibility 应引用既有 Goal / Project / Routine，不复制其状态机。[Bot 框架设计提案](../design-docs/personal-bot-framework.md#3-概念与状态归属) 这与本次建议方向一致，但不表示多 Session 路由已实现。

### Session 隔离不自动等于工作区隔离

独立 Session 只保证独立上下文，不自动保证不同工作目录、Git 分支或代码冲突隔离。Claude 公告中的每 Thread branch / repo copy 和 DeepSeek 每 Ticket worker directory 是额外执行环境保证。Duya 并行写同一仓库前应复用现有 workspace / checkout 能力；不能建立隔离时，Bot 对同一工作区应串行派发。

Session 的“纯度”应按职责核查，而不是先验认定 TUI 已经混杂或把 Session 简化成只剩一个启动按钮。Session Agent 的可调用合同负责创建 / 复用上下文、启动和控制 Run、执行工具并报告可验证的运行事实；TUI 是人直接操作这套能力的交互面。Bot 长期记忆、跨 Project 规划、责任调度、外部事件订阅和 Project 级 PR / merge 归属应由 Bot / Host 控制面持有。保留或迁移 `/project`、`/pr` 等现有交互时，按这条边界做逐项审计。

## Duya 产品与部署架构决策

用户侧应形成两个不同产品，不是同一聊天页面换一个外壳：

| 产品 / 层 | 主要场景 | 用户管理或操作的对象 |
| --- | --- | --- |
| Duya Desktop — Bot-first | Bot-only 工作台：由本机或云端 Bot Process 管理持续委托、后台推进和跨项目状态；不提供 Session UI | Bot 身份与角色、多个 Project、长期责任、记忆与知识、调度、待审批行动、branch / PR / merge 的项目级进度 |
| Duya CLI / TUI — Session-first | 直接操作简洁的 Session Agent 执行能力，执行具体任务；Bot 调用其 headless SessionAgentPort | Session / Run、编程和终端、工具事件、多模型 / Harness、临时任务与并行工作 |
| Bot Process | Desktop Bot 的运行实例：保存 Bot 权威状态、协调责任和任务、路由事件并调用 Session Agent；需独立于工作台窗口运行 | botId、policy、责任绑定、线程订阅、Session / Run 分配 |
| Session Agent / Host | 在本机、不同操作系统、容器或云 VM 执行已授权的 Session / Run，返回结构化执行与 Git 事实 | agent endpoint、hostId、工具与 Runtime、凭据引用、workspace、branch / commit / PR refs、执行产物 |

目标关系：

    Desktop Workbench UI ───── Bot Process（本机或云端）
                                      │
                         Session Agent protocol / API
                         ┌────────────┴────────────┐
                本机 Session Agent       远端 Session Agent
                Runtime + Worker         Runtime + Worker
                workspace                workspace

    CLI / TUI ────────────────┘
    （直接调用本地或远端 Session Agent）

Bot / Project execution binding → Session Agent endpoint + hostId + workingDirectory → Session / Run → repository branch / commit → PR → exact merge evidence

Bot 是逻辑身份，Bot Process 是它的运行实例和权威状态持有者，但身份不绑定某个进程或主机。Desktop Bot Process 可部署在用户本机或云端；关闭工作台 UI 不应终止 Bot。Bot 调用 Duya Session Agent 产品创建或执行 Session；Agent 可部署在不同 OS、容器、云 VM 或本机。一个 Agent Host 可为多个 Bot 执行授权的 Run，一个 Bot 可调用多个 Agent Host。`sessionId` 标识通用可调用上下文，可由 TUI 独立创建，也可由 Bot 为责任创建或复用；同一活动 Session 同一时间由一个 Host 执行。`runId` 表示该 Session 上的一次执行。

Desktop 是纯 Bot / Project UI，不提供 Session 列表、Session 对话或单独的 Session 管理页面；它只呈现 Bot 需要的项目级状态、审批和交付结果。CLI/TUI 继续承担 Session 专业交互，不需要复制 Bot 的长期目标、记忆与调度 UI。Bot Process、TUI 和各类 Session Agent 共用 `agent-protocol`、Host Session / Run contract 与 `agent-runtime`，通过调用关系互通，不能为 Desktop 单独做另一套模型循环。

**分阶段执行：** 第一阶段先重构 Desktop 顶层导航和核心流程，交付“创建 Bot → 委托责任 → Bot 调用 Session Agent → 后台执行 → 汇报结果”；同步保持 TUI 本地 standalone Session 能力，并让它更专注于即时执行。第二阶段把 Bot Process 从 Desktop UI / Electron 窗口生命周期抽出，支持本机后台或云端常驻，做到关闭工作台后 Bot 仍能推进或保留待恢复任务。第三阶段才支持各种环境的 Session Agent endpoint 注册、一次性配对与远程 Run。

**发行策略：** 已有 `desktop/v*` 和 `cli/v*` 发布线继续各自独立。云端 / headless Bot Process 可能需要 `duya-bot` 部署入口和 `bot/v*` 服务发行包；它属于 Desktop Bot 产品的部署形态，而非第三种用户工作流。CLI / TUI 的 Session Agent 能力则支持本机和未来远程 endpoint。是否新增服务包和独立版本线，在 Bot Process 生命周期与 Agent protocol 稳定后决定。协议兼容版本单独于二进制版本协商。多环境 Agent 注册与配对不纳入首个 UI / Bot 工作流切片。

**项目执行与 VCS 生命周期：** execution binding 不只是 sessionId，而是 Bot / Project / Responsibility / runId 到 repo identity、机器目录、Session、branch ref、head commit、PR provider / ID / URL 和合并事实的持久关联。Session Agent 可报告运行期间创建的 branch / commit / PR；Git adapter 观察本地 ref，GitHub 等 provider adapter 接收 PR 评论 / merged webhook 或轮询。Bot 将这些有来源、可去重的事实呈现为 Project Activity，并把后续 PR 评论送回原责任 / 执行绑定。完成合并时记录具体 PR、合并方式和 merge commit SHA / 时间，同时保留 PR head SHA；不只依赖 Agent 自述“已合并”，也不把 VCS 状态并入 Session 的状态枚举。

**Session 能力边界：** 当前 Session API 尚不成熟，Bot→Session 通过 Host adapter 隔离。TUI 与 Bot 调用相同的 Session Agent 能力，TUI 负责交互式执行体验，Bot 只调用 headless contract。若审计发现 TUI 内有长期记忆、跨项目规划或 Bot 调度等控制面逻辑，应移到 Bot；不要为了纯化去掉工具、provider / model 或权限执行等基础能力。

**多机边界：** 初期一个 Bot Process 单写者，Session Agent Host 以短时配对凭证注册后建立持久双向认证加密连接。Tailscale / WireGuard 可以先提供网络可达性，应用仍必须验证节点身份、Bot 授权、版本兼容和带 fencing 的 Run mandate。Agent Host 保存本机 workspace 和 artifacts；Bot Process 保存用户可见的 Bot / Responsibility / route 权威和 Run 投影。第一版不承诺主机间迁移活动 Session、多写者 Coordinator 或透明 HA。节点离线时保留事实并等待 / 有策略地重派，不将未知副作用结果标为成功。

## 给 Duya 的推荐目标模型

Bot 是长期身份、默认策略、记忆范围和协调入口，不是 Session，也不直接承载每项工作的 transcript。一个 Bot 管理多个 Project；ProjectExecutionBinding 将既有 Project / Responsibility 映射到 Session Agent endpoint、hostId、机器本地目录和 Session 复用策略。Session 是可调用的底层执行能力。每次调用前由 Bot 按 Bot / Project / Responsibility scope 检索记忆并打包 ContextEnvelope；Session Agent 不直接读取 Bot 记忆库或假定跨 Session 自动共享。Session API 当前还不成熟，所以通过 Host adapter 隔离演进中的字段和调用语义。

推荐关系：

| 实体 | 职责 | 不负责 |
| --- | --- | --- |
| Bot | 稳定身份、全局策略、默认协调入口、授权范围 | 每项任务的执行上下文、模型循环 |
| Project | Bot 管理的长期工作空间；优先引用现有 Project ID | 复制第二套项目和文件管理模型 |
| ProjectExecutionBinding | Project / Responsibility 到 Agent endpoint、hostId、目录、Session policy 的执行映射 | 承担 Bot 长期目标状态或记忆管理 |
| Responsibility / Work binding | 关联既有 Goal / Routine / 外部任务；保存 Thread route 与执行归属 | 复制已有 Goal 状态机、拥有 Run 执行过程 |
| Session Agent / Session | 在给定执行目录消费 ContextEnvelope、运行工具、返回事件和结果 | Bot 身份、Bot memory I/O、Project 长期状态、Desktop UI |
| Run | 一次 Session 调用及其 attempt、事件和终态 | 长期责任是否已完成 |
| Inbox / subscription / Outbox | 事件去重、路由证据和外部投递 | 规划目标的语义解释 |

默认路由保持兼容：未关联工作的 Bot 输入继续交给当前 bot:<id> 协调入口。已关联 Thread 的消息先查订阅，路由到 Project / Responsibility，再选择对应的 Agent endpoint 和机器目录。Bot Process 将项目记忆、相关资料、任务和权限作为有 scope 的 ContextEnvelope 传给 Session Agent，通过 adapter 使用现有 Session API 创建或恢复执行上下文；当前阶段只需支持明确的 ProjectExecutionBinding，不建通用 DAG。

状态分层：

- Bot 的 active / paused 是 Bot 控制策略。
- Session 的 idle / busy 是 Host 根据活动 Run 推导的运行视图。
- Run 使用现有 durable Run 状态。
- Responsibility 状态引用现有 Goal / Routine / 外部任务进度；只有缺少权威对象时，才补最小的归属信息。
- Inbox 与 Outbox 使用各自既有的投递状态。

避免把这些状态压成 Session 上一个大 enum。用户看到的“工作中、等人、等外部反馈、完成”应由 Bot Activity 查询聚合，不再写一份同义状态表。

## 最小改动顺序

1. 核对 Bot / Project、Session Agent、CLI/TUI 与 VCS 的当前合同；特别检查 TUI 是否已有超出 Session 执行边界的 Bot 控制逻辑，以及可获取的 branch / PR / merge 事实。
2. 建立 Bot → Project → execution binding → Session / Run 持久关联，包括 Agent endpoint、hostId、repository 与 machine-local workingDirectory；调用前按 scope 传入 ContextEnvelope。
3. 将 Desktop 固定为 Bot-only / Project-centric UI，不提供 Session 页面；TUI 收敛为 Session Agent 薄交互面，确属 Bot 控制面的逻辑迁到 Bot。
4. 按 Project execution binding 路由外部输入；保持同一 Session 串行，按 workspace / checkout 隔离开启并行；Thread 订阅关联到原工作。
5. 先追踪 branch / commit，再关联 PR thread、review、closed 和 merge 事件；Project Activity 可指明具体 PR、merge 方法及 merge commit。
6. 将 Bot Process 生命周期从 Desktop UI / Electron 分离，支持本机后台和云端部署，可靠恢复 Inbox、Run、VCS event receipt 与 Outbox。
7. 最后接入不同环境的 Session Agent Host 配对和远程 Run；首个多机验收同时验证两个目录中的 branch / PR / merge 对账。

实现边界与[Bot 框架设计提案](../design-docs/personal-bot-framework.md)、[Bot-first Desktop / Project / Session Agent 协调计划](../exec-plans/backlog/2026-11-01-bot-session-coordination.md)配套。实施前还需核对 inbox claim 事务、Project / workspace binding、Session Agent API adapter 和已有 Goal / Routine 跨 Session 约束。

## 已确认与待研究

### 已确认

- Claude Projects 的公开产品行为确实支持 Project coordinator 管理多个独立 Thread，Thread 对应云端 Claude Code Session，并共享 Project memory。
- DeepSeek 公开原型中的 Ticket 是持续工作归属，Worker Session 是执行上下文；Thread subscription 是持久路由关系。
- Duya 已提供 Session / Run 调用面，主要缺口是 Bot 与多 Session 的持久关联和路由。
- Duya 已有 `desktop/v*` / `cli/v*` 发布分线；CLI 包含 Host Worker 与 Node Runtime。Bot Process 本地 / 云端持久部署、Session Agent 多环境 endpoint、`duya-bot` 部署入口和多机协议尚未实现。
- Duya 个性化 Bot 设计提案已有责任绑定思路；产品决策明确为 Desktop 纯 Bot / Project UI、CLI/TUI Session-first、Runtime shared、Bot identity 不属于单一进程或主机。一个 Bot 管多个 Project，Project 绑定不同 Agent / 机器 / 目录，Bot 在调用前传入有 scope 的记忆与上下文。Session 保持低层可调用能力，TUI 仅作薄交互面，API 不成熟处经 adapter 隔离。Project execution binding 进一步记录 repo / branch / PR / merge 关系，使 Bot 能收到反馈并确认某次具体合并。

### 开始实现前仍要核实

- Bot Inbox claim 需要怎样携带 targetSessionId 才能保证 claim 与 dispatch receipt 仍可事务对账。
- 当前 Session 创建路径如何承接 workspaceId、checkout / worktree，以何种方式安全支持并行改仓库。
- 哪些已存在的 Goal / Routine 可以原 ID 跨 Session 关联；哪些仍是 session-scoped。
- Bot 责任的完成条件应引用现有结果，还是只保留 owner / mandate / route；不在本计划先建立通用 Goal DAG。
- @duya/bot 是继续保持窄的身份与责任规则包，还是多 Session dispatch 规则仍由 Host 组合。该判断应由真实消费者和依赖闭包决定。
