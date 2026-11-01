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

对 Duya 最合适的落点是两种产品 + 一个共享执行层：Desktop 是 Bot / Project / Task 工作台，由可在本机或云端运行的 Bot Process 持有长期状态；任务详情可 Attach 到具体 Session；CLI/TUI 是 Session-first 的专业终端；Bot 按 ProjectExecutionBinding 调用不同环境里的 Session Agent。Bot Process 为每个子任务选择 Project、机器和目录，并将授权范围内的能力与上下文打包传入 Session。Session 不是 Desktop 的顶层导航对象，却是用户始终可直达的执行实体。不需要改造 agent-runtime，也不应复制一套 Goal、Run、审批或调度引擎。

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

### Session 可以由用户直接使用，但还没有跨客户端 Attach 合同

当前已经有若干可复用的直达路径：Host 可按 `sessionId` 启动 Run；Session API 可读消息 / timeline；Desktop 的 `stream-session-manager` 能重新附着到已有运行流，TUI 也有运行中输入的 mailbox / steer 行为。[HostRunExecutionApiV1](../../packages/agent-protocol/src/run-api.ts#L352) [HostSessionApiV1](../../packages/agent-protocol/src/session-api.ts#L450) [Desktop stream attach](../../packages/ui/src/lib/stream-session-manager.ts#L2361) [TUI input / steer](../../packages/cli/src/chat.ts#L938)

这些能力说明 Session 不必只能经 Bot 代理，但当前仍是各客户端自己的执行 / 展示路径。协议没有统一的跨客户端参加者、消息 actor、attach / release 与 Bot 调度让权合同；`steerAgentRun` 在协议中是 optional port，当前 Host HTTP server 没有对应的通用 steer route。Plugin App Host 把由可信宿主选定的 chatSessionId 和 freshness token 绑在沙箱实例上，但 App 本身看不到 sessionId；这给出了安全宿主上下文的基础，尚不是可从任务 Attach 并直接送用户指令的协议。[PluginAppHost](../../packages/ui/src/components/plugin-apps/PluginAppHost.tsx)

因此目标不是把 TUI 当作被 Bot 自动化的进程，也不是新造第二份 transcript：给同一 Session 增加受认证的 Session Attach / input endpoint 与来源标记；所有输入进入该 Session 的有序输入路径，已有 Run 和事件存储保持权威。Attach 期间只暂停 Bot 对该 Session 的新指令派发，不杀掉已经运行的工具；人类退出后，Bot 对账再恢复调度。当前尚未发现这一 per-Session 控制门或跨端协作 lease 已实现。

### Session Agent 当前是否偏重

结论是：相对“Session 是被调用的通用执行能力，Bot 为每个任务组装能力”的目标，当前 Duya Session 确实偏厚；但更准确的问题是执行配置和 Host 默认耦合，尚非重复造了一个 Run 引擎。

代码已经把可调用的 Session API、Run API 与 Runtime 拆开，但能力清单还不是单一的每次调用配置：Session 持久行带有 working directory、model、provider、permission mode 和 agentProfileId；创建时缺少 model/provider 会继承 Host 默认值。[Session store](../../packages/data/src/session-store.ts#L18) [Host Session creation defaults](../../packages/host/src/session-api.ts#L444) Runtime 构造工具时默认取长期 MCP registry 和缓存 App Connection descriptors，再按 Agent Profile allow/deny 过滤，并注入 `tool_catalog` / `tool_invoke`。[Tool resolution](../../packages/agent/src/agent/session/agent-shell.ts#L99) Prompt 构造也会采用默认 Prompt Profile，并组合 MCP 能力目录、项目 AGENTS.md 和 Agent Profile 内容。[Prompt assembly](../../packages/agent/src/agent/session/agent-shell.ts#L192) Skills 由 Worker 从 Host / 项目 / plugin 路径发现并装载，再用全局启用覆盖过滤。[Skill loading](../../packages/host/src/worker-process-entry.ts#L1360)

Run 级配置已经有重要的持久化底座，不能再另造一套 Session manifest：`RunManifest` 是不可变的配置快照，包含 Project / Task、roots / cwd、permission policy、profiles / modes / tools 能力清单、connector bindings、agent selection、budget 与 provenance；Control Plane 对它 fingerprint，Run store 将 JSON 与 hash 一并保存，恢复时可校验。[RunManifest](../../packages/agent-protocol/src/manifest.ts#L139) [Manifest factory](../../packages/host/src/manifest-factory.ts#L171) [Run store](../../packages/data/src/run-store.ts#L61) `StartAgentRunInput` 已有每 Run model / provider / effort / permission / AgentProfile / modes / tools typed overrides。[Run API](../../packages/agent-protocol/src/run-api.ts#L164) 注意，manifest 中的 capability list 是可用能力快照，不等于授权本身；具体授权仍由 permission policy、profile 与 Host policy 共同决定。

仍缺的是任务级插件 / Skill / MCP / App 能力和 ContextEnvelope references / budget 的统一描述；目前 `connectorBindings` 在 manifest factory 中固定为空，因为 connector store 没有 scope 维度。文件附件已有 typed Run input / attachment reference；mentions、display content 等仍有字段通过自由格式 options 传递，Bot 的结构化页面上下文引用也未统一纳入 manifest。[Connector bindings](../../packages/host/src/manifest-factory.ts#L228) [Run API attachments](../../packages/agent-protocol/src/run-api.ts#L213) 旧 Worker 执行路径也存在 synthesized / unsupported 的占位 manifest，Bot dispatch 是否走 canonical factory 要在 S0 证实。[Legacy manifest](../../packages/host/src/worker-run-composition.ts#L372) 因此计划应增量扩展现有 RunManifest（必要时按 protocol 兼容规则升级 manifest schema），用它记录 per-Task 能力和上下文来源，而不是增加 `SessionInvocationManifestV1` 平行类型；完整 prompt 与历史仍走现有 RunInput / Session transcript 路径，secret 保留在 Host。

| 实体 | 建议边界 |
| --- | --- |
| Bot / Project | 目标、记忆检索、任务拆解和轻量依赖、优先级、每个 task 的能力选择、并发限制、PR / merge policy |
| Session | Transcript、执行 Host / workspace 绑定、当前参与者输入、Run / artifacts 关联；Desktop 仅从任务进入它 |
| Run invocation | 模型 / Harness、提示层、选定 Skill / Plugin / MCP / tools、ContextEnvelope 引用和预算、权限上限、验收规则、输出约定 |
| Host / Runtime | 将能力引用解析为本机已安装实现，保管凭据，执行实际授权检查，启动 Worker 并写回结构化事件 |

RunManifest 增量字段应表达“这次 Task 请求哪些能力、引用的来源 / scope / 版本、为什么需要”，而不是上传插件包或凭据；Host 对能力做 `requested ∩ installed ∩ authorized ∩ project policy` 校验，对缺失项清楚报错。TUI 独立使用时保持兼容的交互默认；Bot-created Session 则显式设置本次 profile / capability，不能悄悄继承 Host 全局插件 / Skill / MCP 列表。Run store 已保存 manifest fingerprint；新增字段应加入同一个 fingerprint / provenance 模型，供 Desktop Attach 显示和故障复现。用户可在 Attach 面板从当前 manifest 允许的 Plugin / Skill / App 能力中选定一个，再连同自然语言指令、DOM / 截图 / 文件引用直接送给同一 Session；如需扩权，Host 先校验并通过下一次 Run 的 manifest 明确记录。

这种分层可从成熟 SDK 中得到启发。OpenAI Agents SDK 把 Agent 的 instructions / model / tools 与 Run 的 context injection 分开，并让 Session 负责跨轮持久化对话；这表明“长期对话状态”不必等同“能力包”。Anthropic Managed Agents 将 versioned Agent config、执行 environment 与有对话历史的 Session 分离，并支持在创建 Session 时覆盖 model、system、tools、MCP servers 与 skills。该 Managed Agents API 当前标注 Beta；这里只借鉴分层与可覆盖配置的做法，不复制供应商 API 或执行状态机。[OpenAI Agents guide](https://openai.github.io/openai-agents-js/guides/agents/) [OpenAI Sessions guide](https://openai.github.io/openai-agents-js/guides/sessions/) [Anthropic Agent setup](https://platform.claude.com/docs/en/managed-agents/agent-setup) [Anthropic Session operations](https://platform.claude.com/docs/en/managed-agents/session-operations)

对新项目并行工作的具体流程是：Bot 和用户先形成 Project brief 与可检查的目标；Bot 把目标分解为小批 Task 和必要依赖，为每个 ready Task 组装 RunManifest capability overlay（可复用 AgentProfile 作基线），并选择上下文引用、Host / workspace、branch policy 与验收标准；Host 为每个任务解析 manifest 并在独立 checkout / branch 执行；Bot 汇总 Run 事件、CI、PR review 与用户反馈，再按 Project merge policy 继续委派或请求审批。能力组合应由声明式 ID / 版本引用驱动，提示词不能授予未授权的工具；资源不足或缺少能力时，不要降级到当前 Host 的更宽权限默认值。

当前需要演进的是 Session / Run 装配合同、Profile 解析和可观察性，不是删除 TUI，也不是另造一个 agent-runtime。无 Bot 的 TUI 本地 Session 仍需要顺手的默认 Profile；Bot 调用则必须显式、可重放、按 task 作用域隔离。

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
| Duya Desktop — Bot-first | Bot / Project / Task 工作台；在任务详情可查看绑定 Session 并 Attach 直接协作，不提供跨项目全局 Session 工作台 | Bot 身份、多个 Project、长期责任、记忆、调度、审批、项目 Activity、task-linked Session Attach |
| Duya CLI / TUI — Session-first | 完整 Session 工作台，直接创建 / 恢复 / 监督 Session 并与 Agent 协作 | Session / Run、编程和终端、工具事件、多模型 / Harness、临时任务与并行工作 |
| Browser / IDE / Mini App | 使用统一 Attach 协议把当前页面 / 元素 / 文件引用和具体指令送给已绑定的 Session | 带权限的 Session input、结构化 UI / IDE context 和附件引用 |
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

Desktop 保持 Bot-first，但不能把用户隔离在 Session 之外：任务详情要能查看绑定 Session 的执行状态并直接发送 Session 输入，不提供无任务上下文的全局 Session 工作台。CLI/TUI 保留完整 Session 工作台。Bot Process、Desktop Attach、TUI 与各类 Session Agent 共用 `agent-protocol`、Host Session / Run contract 与 `agent-runtime`；人类直达的输入写入同一个 Session transcript / input queue，Bot 只发送协调指令并订阅关键事件，不代理每句话。

推荐显式路由，而不依赖模型猜收件人：Bot 面板中的输入发给 Bot；具体任务的 Session Attach / TUI 输入发给该 Session。改一个按钮间距、当前 PR 的具体修复和选中元素的反馈发给 Session；改变项目目标、优先级、跨项目工作安排、预算 / 授权或持久规则发给 Bot。两类同时相关时，向 Session 发送后可显式“同步给 Bot”。

用户 Attach 获取的是短时、可恢复的指令调度权。正在运行的工具调用继续执行；Bot 暂停向该 Session 发新指令，但仍可观察进度。Detach 后 Host / Bot 先重读 Run 和 Session 事件，核对用户改动与待处理工作，再恢复自动协调。Session Attach 使用经过认证的 Host / session capability；裸 `sessionId` 不是访问凭证。插件只能提交授权范围内的输入、附件和 UI context reference，不能因此读取完整 transcript 或取得任意工具权限。

**分阶段执行：** 第一阶段交付“Bot 管理 Project → Bot 创建 Session → 用户从任务进入 Session Attach → 用户可直接协作，Bot 订阅进度并汇报”；并定义清晰的 Bot / Session 输入目标。第二阶段补齐 attach lease、输入排序、Bot 调度让权与退出后对账，再把 Bot Process 从 Desktop UI / Electron 生命周期抽出。第三阶段才支持不同环境 Session Agent endpoint 注册、一次性配对与远程 Run。

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

1. 核对 Bot / Project、Session Agent、CLI/TUI、Desktop stream attach、插件上下文与 VCS 的当前合同；审计 TUI 功能归属，并盘点直接输入与观察已具备的路径。
2. 建立 Bot → Project → execution binding → Session / Run 持久关联，包括 Agent endpoint、hostId、repository 与 machine-local workingDirectory；调用前按 scope 传入 ContextEnvelope。
3. Desktop 保持 Bot / Project / Task 主导航，并在 task detail 允许查看和 Attach 对应 Session；TUI 成为完整 Session 工作台。
4. 建立跨端 Session Attach input protocol 与控制门：分清 Bot / Session recipient，user takeover 暂缓 Bot 指令但不停止现有工具；Detach 后对账再恢复。
5. 按 Project execution binding 路由外部输入；保持同一 Session 输入有序；workspace / checkout 隔离后才并行；Thread 订阅关联到原工作。
6. 复用并扩展 621 的 integration 能力，追踪 branch / commit / PR thread / review / exact merge；Project Activity 可指明 merge method 与 merge commit。
7. 将 Bot Process 生命周期从 Desktop UI / Electron 分离，支持本机后台和云端部署，可靠恢复 Inbox、Run、VCS event receipt 与 Outbox。
8. 最后接入不同环境的 Session Agent Host 配对和远程 Run；首个多机验收同时验证两个目录中的 branch / PR / merge 对账。

实现边界与[Bot 框架设计提案](../design-docs/personal-bot-framework.md)、[Bot-first Desktop / Project / Session Agent 协调计划](../exec-plans/backlog/2026-11-01-bot-session-coordination.md)配套。实施前还需核对 inbox claim 事务、Project / workspace binding、Session Agent API adapter 和已有 Goal / Routine 跨 Session 约束。

## 已确认与待研究

### 已确认

- Claude Projects 的公开产品行为确实支持 Project coordinator 管理多个独立 Thread，Thread 对应云端 Claude Code Session，并共享 Project memory。
- DeepSeek 公开原型中的 Ticket 是持续工作归属，Worker Session 是执行上下文；Thread subscription 是持久路由关系。
- Duya 已提供 Session / Run 调用面，并有 Desktop live stream reattach 与 TUI 运行中输入能力；主要缺口是 Bot 与多 Session 的持久关联，以及跨客户端 Session Attach 与“用户接管 / Bot 暂缓调度”合同。
- Duya 已有 `desktop/v*` / `cli/v*` 发布分线；CLI 包含 Host Worker 与 Node Runtime。Bot Process 本地 / 云端持久部署、Session Agent 多环境 endpoint、`duya-bot` 部署入口和多机协议尚未实现。
- Duya 个性化 Bot 设计提案已有责任绑定思路；架构更新明确 Desktop Bot / Project / Task-first、任务内 Session Attach、TUI 完整 Session 工作台、Runtime shared、Bot identity 不属于单一进程或主机。一个 Bot 管多个 Project，Project 绑定不同 Agent / 机器 / 目录，Bot 调用前传入 scope 上下文；用户和 Bot 可直接访问同一 Session。Session 的控制门暂停 Bot 新指令，不停正在运行的工具。Project execution binding 复用 621 的 PR 关联，再补 Bot/Project 归属、PR 评论路由及 merge SHA / 时间 / 方法。

### 开始实现前仍要核实

- Bot Inbox claim 需要怎样携带 targetSessionId 才能保证 claim 与 dispatch receipt 仍可事务对账。
- 当前 Session 创建路径如何承接 workspaceId、checkout / worktree，以何种方式安全支持并行改仓库。
- 哪些已存在的 Goal / Routine 可以原 ID 跨 Session 关联；哪些仍是 session-scoped。
- Bot 责任的完成条件应引用现有结果，还是只保留 owner / mandate / route；不在本计划先建立通用 Goal DAG。
- @duya/bot 是继续保持窄的身份与责任规则包，还是多 Session dispatch 规则仍由 Host 组合。该判断应由真实消费者和依赖闭包决定。
