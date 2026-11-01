# Bot-first Desktop、Session Agent 能力装配与 Project / VCS 生命周期

状态：backlog（架构决策已采纳，实施排序待执行）· 负责人：Codex / root · 更新：2026-11-01
分支：codex/bot-session-coordination · worktree：/workspace/work/bot-session-coordination · base：4f0738bae34777cce45308291f3207f90e6705a1 · owner：当前会话

## 目标与边界

目标：确立 Duya 的双产品架构并落实 Bot / Project / Session Agent 边界：Desktop 是 Bot / Project / Task-first 工作台，一个 Bot 管多个 Project；用户可从任务详情 Attach 到绑定的 Session，查看具体状态并直接与同一个 Agent 协作，不提供跨项目的全局 Session 工作台。CLI/TUI 是完整 Session-first 工作台；Bot、Desktop、TUI 和 Mini App / IDE 等客户端共用可运行在多种系统 / 机器 / 目录中的 Session Agent 能力。Bot 按 Project 选择执行绑定，并将有 scope 的记忆、上下文和授权传入 Session；Bot 只订阅关键状态，不代理每条用户输入。Project execution binding 继续跟踪 Session / Run、branch、PR 与具体 merge。用户 Attach 时 Bot 暂停该 Session 的新指令调度，但不停止在途工具；退出后对账再恢复。两产品共享 protocol、Host Session / Run API 和 agent-runtime。Bot identity 不绑定 Bot Process 或机器；Session Agent Host 是带 hostId 的执行环境。

本计划落实已采纳的产品架构决策，不代表代码已开始或用户已经承诺本计划所有阶段。实现仍留在 backlog，按发布与稳定性主线排期后再认领为 active。

研究依据：[多 Session Agent 协调架构研究](../../references/agent-coordination-models.md)。
设计合同：[个人长期 Bot 框架](../../design-docs/personal-bot-framework.md)。
上级计划：[个人长期 Bot 框架迁移](../active/2026-10-25-personal-bot-framework.md)。
现有发布计划：[Desktop 与 CLI 独立发布](../active/2026-10-29-product-release-separation.md)。

## 已采纳的产品架构决策

| 决策 | 约束 |
| --- | --- |
| Desktop = Bot-first + task-linked Session Attach | Desktop 管理 Bot、多个 Project、长期责任、记忆、审批与执行结果。具体任务详情可进入绑定 Session 查看状态并直接协作；不提供脱离任务的全局 Session 列表 / 工作台。Bot Process 可本机或云端运行，独立于 UI 生命周期 |
| CLI / TUI = Session-first | 提供完整 Session 工作台，专注即时 Session、Run、工具调用、编程与终端、多模型 / Harness、临时和并行工作；保留本地 standalone 能力。Bot 调用 headless SessionAgentPort，不操作交互式 TUI UI |
| Bot supervision + user direct access | Bot 与用户访问同一个 Session。Desktop / TUI / 插件直接提交有 actor 和来源的 Session input；Bot 通过独立调度通道监督 Run 并订阅关键事件 |
| Session Attach arbitration | 用户进入协作时只暂停 Bot 对此 Session 的新指令派发，已有工具继续运行；Detach 后 Host / Bot reconcile，再恢复调度 |
| Runtime = Shared | Bot 调用 Session Agent 的标准 Host Session / Run API 与 `agent-runtime`；Bot 将按项目选出的记忆、上下文和授权传入 Session，不假设执行端共享 Bot 记忆 |
| Bot identity ≠ Bot Process / Host | `botId` 是逻辑身份；Bot Process 是可本地或云端运行的状态与协调权威；`hostId` 标识 Session Agent 执行环境。一台 Host 可执行多个 Bot 的任务，一个 Bot 可调用多台 Host |
| Project → Session Agent | 一个 Bot 管多个 Project；Project 可配置多个执行绑定，指定 Agent endpoint、机器、repository 和工作目录并启动 / 复用 Session |
| Task → RunManifest | Bot 为每个并行 Task 显式选择模型 / Harness、提示层、Skill / Plugin / MCP / tools、上下文引用、权限上限、预算、执行 Host / workspace 与验收标准；扩展现有不可变 RunManifest，不新建 Session manifest，Session 不隐式继承整台 Host 的能力集 |
| Session → VCS lifecycle | binding 将 Session / Run 与 branch、commit、PR 和具体 merge evidence 关联；Bot 侧订阅后续 PR / Issue 事件并回路由到原工作 |
| 分阶段拆服务与多机 | 先完成 Bot → Project → 上下文注入 → Session Agent → Run → 汇报，再将 Bot Process 脱离 Desktop UI / Electron 生命周期并支持本机或云端部署，最后接入多环境 Agent 网络 |

这两种产品体验不意味着需要立即新增第三种用户工作流。当前 `desktop/v*` 与 `cli/v*` 发布线继续独立；Bot Process 的云端 / headless 部署可能需要 `duya-bot` 安装入口与 `bot/v*` release，但它属于 Desktop Bot 的部署形态，待生命周期和协议边界验证后再决定。Session Agent endpoint 则由 CLI/TUI 产品提供并能运行在不同环境。

边界：

- 调整 Bot 身份关联、Bot inbox 路由、Host Bot Dispatcher 和必要的 Bot DTO / persistence。
- 保留 bot:<id> 作为当前默认协调入口，兼容现有 Bot 输入；Bot 对外以 Bot / Project 状态呈现，不把它做成 Desktop Session 页面。
- 可用窄 ProjectExecutionBinding / ResponsibilityBinding 关联 Bot、Project、Session Agent endpoint、hostId、repository、机器本地工作目录、Session 复用策略、既有 Goal / Routine 引用和 Thread route；另将 Run 对应的 branch / commit / PR / merge fact 持久关联，字段以 S0 接缝检查为准。
- Desktop 是 Bot / Project / Task-first UI；允许 task-linked Session Attach，不提供跨任务的 Session 管理工作台。TUI 是完整 Session 工作台，保留 standalone 本地执行。
- 先在现有 Host 装配中建立 Bot Process 边界，再将其生命周期从 Desktop UI / Electron 窗口与 renderer 中解耦。
- 复用现有 HostSessionApiV1、HostRunExecutionApiV1、durable Run、Inbox、scheduler owner epoch、Outbox、Goal / Routine 和 workspace / checkout 能力。
- 不修改 agent-runtime 的模型循环、Run ledger 或 Session transcript；复用现有不可变 RunManifest、fingerprint、provenance 与 RunStore，增量扩展 typed capability / context fields，不另建 `SessionInvocationManifest` 或 Profile registry。Bot-created Run 显式声明能力来源，不自动继承 Host 全局插件 / Skill / MCP 集合；CLI/TUI standalone 保持当前兼容默认行为。
- RunManifest 组合现有 AgentProfile / model / permission / tool configuration、Project baseline 与 Task-specific overlay；引用以 ID / version / scope 表达，不传插件包或凭据。Host 对能力做 installed ∩ authorized ∩ project policy 校验，工具授权不由 prompt 代替；旧 manifest records 保持可读。
- 多环境阶段只在 Host API / protocol 加窄的认证远程 Session Agent 适配；Bot Process 做单写者权威，Agent Host 本地管理 Runtime、工具和 workspace。
- 保持现有 `desktop/v*` 与 `cli/v*` release。云端 / headless Bot Process 可能使用 `duya-bot` 与 `bot/v*` 部署包；它属于 Desktop Bot 产品，不在当前首批 UI / Project 绑定切片建立。
- Bot 不通过 TUI UI automation 执行；Bot 与 TUI 调用同一 headless Session Agent contract，用户也可从 Desktop / TUI / Plugin 直接连接到同一个 Session。先审计 TUI 当前功能，只有 Bot 长期记忆、Project routing、目标规划、责任调度等控制面逻辑才应迁出。
- Session Agent / TUI 报告结构化 branch / commit / PR facts；Bot / VCS adapter 拥有 PR thread、review、close / merge 生命周期关联。
- 首版不做自动 proactive 任务接单，不要求 Bot 自动拆解所有 Project goal，不提供透明跨 Host Session 迁移。

## 当前 master 已有的 Session / PR 底座

本计划以 `4f0738ba` 为代码基线。PR / merge lifecycle 不从零开始：计划 621 已实现 checkout/worktree 生命周期、Session checkpoint refs、Host integration API、GitHub CLI 只读观察和 SQLite projection/history。

| 当前能力 | 代码接缝 | 对本计划的含义 |
| --- | --- | --- |
| PR 状态与 Session 多对多关联 | `HostIntegrationApiV1`、`IntegrationStore` migrations 43/44 | 扩展现有关联到 Bot / Project / Responsibility / Run / Host；不新建第二套 PR store |
| Session 级显式 PR 同步 | `createIntegrationSync`: Session → cwd → origin → `refs/duya/checkpoint` commit → PR | 作为初始对账实现；新增 Bot Activity 读取 Project 关系，不假设 PR 状态自动实时 |
| GitHub PR 当前状态、head SHA 与状态变化历史 | `scm/observe.ts`、`integration_events` | `merged` 当前只有 PR 状态，`headSha` 是 PR head；还需持久化 merge commit SHA / 时间 / 方法 |
| Session checkout / branch | `checkout-provider.ts`、`session-checkout-service.ts` | 支持传入 branchName，也可能是 detached + checkpoint ref；需把 branch lifecycle 作为独立事实补齐 |
| Session 直接执行 / 观察 | `HostSessionApiV1`、`HostRunExecutionApiV1.startAgentRun`、Desktop stream reattach、TUI mailbox steer | 可复用 Session history / Run / stream；仍缺跨客户端 Attach input contract、actor identity 与 Bot 调度让权 |
| 不可变 Run 配置快照 | `RunManifest`、`buildRunManifest`、`manifestFingerprint`、`RunStore.manifest_json / manifest_hash` | 直接扩展该权威快照；已有 model / provider / profile / permission / modes / tools 与 provenance；补齐 task-scoped plugin / skill / connector / context references |
| 插件绑定的会话上下文 | `PluginAppHost` 将可信 `chatSessionId` 与 freshness token 绑定到沙箱实例 | 可复用宿主绑定与来源校验；尚非 Browser / IDE / Mini App 对 task Session 的直接 Attach |
| TUI `/project` 与 `/pr` | 本机 cwd 选择；Session 关联 PR 读取 / 显式刷新 | `/project` 属于 Session 执行位置；`/pr` 是 Session 诊断。Bot Project Activity 应接管长期 Project PR / merge 视图 |
| Desktop / Web workspace lifecycle 面板 | 计划 621 F，共享 checkout / integration UI | S3 整理为 Project Activity 汇总 + task-linked Session Attach 细节；不删除任务执行所需 Session 状态 |

尚未找到 GitHub PR / review / comment webhook 到 Bot Inbox / 对应 Project binding 的路由。`integration_events` 只追加观测到的状态变化，不含 provider event receipt，也不记录 merge SHA。S0 验证现有调用者和迁移兼容后，S4 做 additive 扩展与事件路由。局部 checkout merge outcome 与 GitHub hosted PR merge 是不同事实，分开记录。

当前 Desktop stream reattach 是状态观察 / 恢复路径，TUI busy-turn steer 通过本地 mailbox；`steerAgentRun?` 是 optional protocol port，目前没有 Host HTTP steer endpoint。未发现跨端 participant roster、Session input actor / idempotency、attach lease 或 Bot dispatcher 的 per-Session user-control gate。S0 应以现有 Run / transcript / attachment store 为基础增量补合同，不能再造一套 Session transcript 或 Run ledger。

Duya 已有可审计的本次 Run 快照，但当前 coverage 有缺口：`RunManifest` 可保存 Project / Task、roots / cwd、permission policy、profile / modes / tools、agent selection、budget 和 provenance，并以 fingerprint 写入 RunStore。`StartAgentRunInput` 可 per Run 覆盖 model / provider / effort / permission / profile / modes / tools。`connectorBindings` 在 manifest factory 中固定为空，因为 connector store 尚无 scope 维度；Skills / Plugins / MCP / App 和 ContextEnvelope references / budgets 尚未完整纳入 typed manifest；文件附件已有 typed Run input / attachment reference，mentions 与 display content 等仍有字段通过自由格式 options 传递。部分旧 Worker execution path 构造的 manifest 仍以 synthesized / unsupported 占位 capability fields。S0 要确认 Bot dispatch 走哪条 manifest factory 路径，并核对这些来源的生命周期、全局 / Session / Run scope、权限边界和默认继承行为。

外部架构参考：OpenAI Agents SDK 将 instructions / model / tools 放在 Agent 配置中，把动态依赖作为 Runner context，并由独立 Session 接口持久化跨轮对话；Anthropic Managed Agents 将 Agent、environment 和 Session 分开，创建 Session 时可按需覆盖能力配置，部分 tools / MCP servers 可 Session-local 更新。Managed Agents 当前为 Beta，仅取其职责分层思路。研究记录列出官方链接与具体含义。

## 验收

实现完成时必须满足：

1. Desktop 是 Bot / Project / Task-first UI；用户可从任务详情打开绑定 Session、查看 Run / 工具 / 产物状态并直接协作；不提供脱离任务归属的全局 Session 列表 / 工作台。
2. 一个 Bot 可管理多个 Project；一个 Project 可绑定多个执行位置。每个位置包含 Session Agent endpoint、hostId、repository identity、机器本地工作目录和 Session 复用策略。
3. Bot Process 在派发每个 Run 前，按 Bot / Project / Responsibility scope 组装 ContextEnvelope，带入任务说明、权限、相关记忆与项目上下文；Session Agent 不直接读取 Bot 私有记忆库，Bot 不无筛选地传入全部记忆。
4. Session Agent 是 Bot 和用户共同访问的协作与执行实体。TUI 提供完整 Session 工作台；Desktop task detail 支持 Attach；Bot 使用同一 Host / protocol 的 headless contract，不依赖交互式 TUI UI。用户 Attach 后获得该 Session 的调度权，Bot 暂停新的 Session 指令但不停止在途工具；输入在同一 Session 中按 actor / 顺序持久化，Detach 后 Bot 对账再恢复。
5. Bot 为每个并行 Task 明确填充现有 RunManifest 的配置与来源：model / Harness、prompt/input references、Skill / Plugin / MCP / tool grants、ContextEnvelope refs / budget、permission ceiling、Host / workspace / branch policy、concurrency limit 和 acceptance criteria。未指定 capability 不从全局 Host 环境静默继承；未知或未授权 capability fail closed 并给出原因。
6. 每个 Run 保持现有 manifest JSON / fingerprint / provenance 作为权威快照，并确保新增 capability fields 纳入 fingerprint 和 source attribution。用户 Attach 后可检查本次能力、上下文来源与权限；可从已允许的 Plugin / Skill / App 能力中选工具，并将精确指令及 DOM / 截图 / 文件引用直接送到同一 Session。扩展能力经 Host policy 校验，记录在后续 Run manifest；输入复用同一 Session，不另建 transcript。独立 TUI Session 保留已有 interactive defaults。
7. 实施前审计 CLI/TUI 当前功能；仅将长期记忆、跨 Project 规划、Bot 责任调度和 Bot thread routing 等控制面职责移至 Bot。模型 / provider 选择、工具运行、权限提示和工作目录等必要执行能力不因“纯化”而删除。
8. Session API 尚不成熟的部分由 Host adapter 隔离；Bot 领域不绑定临时 Session API 字段或具体 Runner 实现。
9. CLI/TUI 仍可独立创建、连接、恢复并执行本地 Session，不要求先创建 Bot；完整 Session 工作台和排障由 TUI 提供。
10. 旧 Bot 输入仍运行在原 bot:<id> Session 上；已有 Inbox receipt、Run receipt、channel reply 与 redrive 语义不回归。
11. 没有 route 的新输入回落到 Bot 默认协调入口；有 Thread subscription 的后续消息稳定送到对应 Project / Responsibility 执行绑定。
12. Project execution binding 持久关联 Bot / Project / Responsibility / Run 与 repository、hostId、workingDirectory、sessionId、branch ref、head commit、PR provider / ID / URL 和 VCS state。
13. Session Agent 的事件可标记 branch / commit / PR 创建和运行结果；VCS adapter 可识别 PR 评论、review、关闭与 merge，并路由回原 Project / work binding。
14. PR merge 记录具体 PR、合并方式、merge commit SHA 与时间；保留 PR head SHA 并区分 merge commit SHA。local Git merge 与 hosted PR merge 分别记录，不凭模型文本声称成功。
15. Bot Project Activity 可回答某任务在哪台机器 / 目录执行、创建了哪个 branch / PR、当前 review / merge 状态、最终合入哪个 commit；任务详情同时可 Attach 到相应 Session。
16. Bot Process 生命周期独立于 Desktop 工作台 UI；窗口关闭后接纳的工作继续或以持久可恢复状态等待。本地或云端部署使用相同 Bot 身份与服务合同。
17. Bot 与 Session Agent Host 身份独立：一个 Host 可执行多个 Bot 授权范围内的 Run，一个 Bot 可调用多个 Host；Bot Process 权威维护 Bot / Project / Responsibility / route / context，Agent Host 权威维护本地 workspace 和执行产物。
18. 多环境 Session Agent MVP 使用已认证配对和版本协商，完成两台机器、两个不同目录间一次显式远程 Run，并将 branch / PR 或合并结果回报到 Bot Project Activity；Agent Host 离线或协议不兼容不会被判为成功。
19. 新增验证覆盖多客户端 Attach 同一 Session、actor / 顺序 / 幂等、用户接管暂停 Bot 新输入但不取消在途工具、manifest capability scoping / revision snapshot、Detach / lease crash 恢复、Project 路由、ContextEnvelope scope、工作区隔离、PR thread / merge SHA、Bot Process restart、Agent Host offline 和协议不兼容。

## 实施切片草稿

以下切片先建立 Bot / Project / Session Agent 绑定和上下文传递，再纳入 Git / PR lifecycle，最后扩展 Bot Process 部署与远程执行环境；如调用闭包显示需要改通用 Session / Run 契约，先停下并给出最小 additive 方案，不扩大到另建 Runtime。

### S0 — 当前实现、能力配置与事务边界再核实

- [ ] 查清 Inbox entry 是否保存渠道 Thread identity，claim 是否允许按 route / Session 粒度，以及 lookupReceipt 如何与 target Session 关联。
- [ ] 追踪 Host Session create / run start / workspace checkout 到实际 worker；证明独立 Session 是否真的隔离可写工作区。
- [ ] 清点 Session / Run 能力组装：CoreSession 字段与 Host defaults、Agent Profile、Prompt System、MCP / App Connection、Skills / Plugins、context loaders、permissions；标记每项的权威数据源、scope、生命周期、是否默认全局注入和可否 Run-level override。
- [ ] 核实现有 Task / Goal / Project 能否表达项目拆分、依赖和 Session binding；优先复用已有任务状态和 ID，仅新增缺失的执行关系，不复制通用 DAG 或另建状态机。
- [ ] 核对现有 canonical `buildRunManifest` / `RunManifest` / fingerprint / provenance / `RunStore` 在 Bot dispatch 路径的真实覆盖；检查旧 Worker path synthesized manifest 对 bot runs 的影响，确认旧 record / resume 兼容策略。
- [ ] 将可用 TUI 默认工具组合保留为兼容的 standalone defaults；明确 Bot invocation 的未指定项是否为空、继承 Project baseline 或显式请求，不让 Host 全局环境静默扩大权限。
- [ ] 参照 OpenAI Agents SDK 的 Agent / Run context / Session 边界与 Anthropic Managed Agents 的 Agent / environment / Session overrides，提出对现有 RunManifest 的最小 additive field set 和 scope 校验方案；记录 beta / provider-specific 限制，不另建并行 manifest/API。
- [ ] 核对现有 ResponsibilityBinding、Goal、Routine、SessionSpawn 和 channel thread DTO 的真实消费者；不重复现有数据结构。
- [ ] 以 plan 621 为现有底座清点 HostIntegrationApiV1 / IntegrationStore / integration sync 的生产消费者、状态语义和迁移；确认如何把当前 Session ↔ PR 关联补到 Project / Responsibility / Run / Host。
- [ ] 映射 Desktop 当前 Bot、Project、Session、Run 和后台任务界面；区分 Project Activity 汇总与任务详情的 Session Attach 状态 / 输入界面，不保留跨任务全局 Session 工作台。
- [ ] 核对 CLI/TUI 本地 Host 启动 / 停止路径、Desktop Electron 生命周期、数据根锁和现有发布线，为 Bot Process extraction 画边界。
- [ ] 审计 Session TUI 当前功能归属；现已确认 `/project` 选择本机 Session cwd、`/pr` 读取 / 显式刷新当前 Session 的 PR。区分必要执行功能与 Bot 控制面职责，不把现有命令本身直接判为“杂质”。
- [ ] 核对 Git worktree / checkpoint ref、branch、PR observer 与 merge 数据；标出已有字段和缺失的 branch event、PR comment route、merge SHA / method / time。验证 generic webhook 是否已有可复用接缝，但不能假定它已与 PR lifecycle 集成。
- [ ] 输出最小合同 diff、UI 接缝、进程生命周期、迁移策略和受影响文件范围，再开始代码切片。

### S1 — Task 计划、ProjectExecutionBinding 与能力装配

- [ ] 在 Bot-owned 数据 / protocol 层建立最小关联：ownerId、botId、projectId、可选 responsibilityId、agentEndpointId / hostId、repository identity、workingDirectory、sessionId / reuse policy 与 source-thread route。
- [ ] 新建项目时由 Bot / 用户共同形成 Project brief；先复用现有 Task / Responsibility 数据表达子任务和必要依赖。Planner 输出范围小、可审查的 task set；不需要通用 DAG 时不引入 DAG service。
- [ ] 扩展现有 `RunManifest` 与 `StartAgentRunInput` 的类型化配置，优先复用 `AgentProfileId`、model/provider、permission rules、modes / tools 与 `ConnectorBinding`；仅增加目前无法表达的 Plugin / Skill / scoped connector / ContextEnvelope source reference / acceptance fields，并按协议兼容要求升级 manifest schema。
- [ ] Host 在原 manifest factory 中解析 Task references 到当前已安装的 capability implementations；有效集合受 installed capabilities、caller grants 和 Project policy 交集约束。插件包和密钥不通过 manifest 传输；未装、未授权或过期引用显式失败，不静默 fallback 到更宽的 Host defaults。
- [ ] 复用 RunStore 的 manifest JSON / fingerprint / provenance / input hash；新 capability fields 必须参与 hash 并标记真实 source / version。Context 通过可审计 references 与现有 RunInput / Session transcript 路径传递；不把 Bot 私有 memory 全量复制到 Session，也不把所有内容重新塞入自由 options bag。
- [ ] 保证 bot:<id> 是 default route；旧数据无迁移时行为不变。
- [ ] 建立或更新 route 时验证 Session 属于预期 owner / Bot，并验证来源 binding；不从模型提供的自由文本直接建立受信 route。
- [ ] Bot Inbox accept / dispatch 能解析已存在 route，并保留 durable dedup / receipt；若 route 在 claim 前变化，定义确定的快照版本或在 claim 时原子重验。
- [ ] 只加入 relation / route 状态，不增加第二份 Goal / Run / delivery status。

### S2 — Session-aware dispatch 与限制

- [ ] 对每个 ready Task 分别选择 Session profile / overlay 与 ContextEnvelope；多任务不要把一个子任务的计划、memory scope 或自由权限继承给其他 Session。
- [ ] 按 target Session 检查忙闲，保持同 Session 串行；不同 Session 在工作区隔离下可并发。
- [ ] 为 Bot 保留小而明确的 maxConcurrency；全 Bot 限制和 per Session 锁不可互相冒充。
- [ ] claim 与 Run dispatch receipt 维持幂等；Run start 结果丢失时通过现有 receipt reconciliation 判定，不能仅靠重新启动。
- [ ] 对共享 checkout / 同一工作目录使用 serial lane；有隔离 checkout 时才放开多个写 Worker。
- [ ] 保持 legacy / host scheduler ownership epoch、preemption、redrive 和 terminal settlement 逻辑。

### S3 — Desktop Bot-first Task Attach 与 Session TUI purification

- [ ] Desktop 主导航聚焦 Bot、Project、Responsibility、Project Activity、审批与节点状态；在具体任务详情可查看绑定 Session / Run 并进入 Attach，禁止无任务上下文的全局 Session 工作台。
- [ ] 将 621 已有的 Session checkout / integration 数据整理到 Project Activity 汇总与 task-linked Session Attach 细节；复用 Host query / sync contract，不丢弃现有用户可见能力。
- [ ] 完成可用闭环：创建 / 选择 Bot → 管理多个 Project → 设置执行 endpoint / 工作目录 → 委托 Responsibility → Bot 按 scope 组装 ContextEnvelope → Bot 创建或复用 Session → 用户可 Attach 同一 Session 直接补充要求 / 检查结果 → Run 后台执行 → Bot 汇报结果。
- [ ] 根据 S0 审计纯化 CLI/TUI：保留执行所需 provider / model、工具、权限与工作目录；若现有路径混入 Bot 长期记忆、跨 Project 规划或责任调度，将它们移入 Bot，而不是删除必要执行能力。
- [ ] TUI 主路径是完整 Session 工作台，支持启动 / 接入 / 恢复 Session、Run 执行与 Harness / tool；保持无 Bot 的 local standalone Session。`/project` 只代表本机执行目录，不能复用为 Bot Project UI。Bot 调用 headless SessionAgentPort，不自动化操作 TUI UI。
- [ ] Task detail 显示此次 Run 的 profile / revision、有效模型、工具 / Skill / Plugin / MCP 能力、上下文来源和权限摘要；Attach 期间展示与 Bot Dispatcher 同一套 Session state，不新建交互副本。
- [ ] 在 task-linked Attach 内让用户选择当前 manifest 已授权的具体 Mini App / Plugin 能力，并把其结构化页面元素 / 截图 / DOM context 与自然语言要求作为 actor-scoped Session input 直达 Runner；插件自身不能越权注入工具。新增 capability 需 Host policy 授权并可审计。
- [ ] 定义 Host / protocol Session Attach：Session target 需解析 bot/project/task/run/host/session binding；desktop、TUI、Mini App / IDE plugin 通过同一 input contract 直接提交 actor-scoped 消息 / attachment / UI context reference。
- [ ] 持久化每 Session user-control lease / revision；用户 Attach 时 Bot Dispatcher 不向该 Session 派发新指令，已有工具继续；输入进入单一有序路径。Detach / lease crash 后对账 Run、transcript、未处理输入再决定恢复或人工处理。
- [ ] UI 显示明确 Recipient：Bot 面板默认 Bot，Session Attach 和 TUI 默认当前 Session；细节实现 / 选中元素反馈发 Session，项目目标 / 优先级 / 授权 / 长期规则发 Bot；混合意图由用户选择是否同时同步 Bot。
- [ ] Bot Project Activity 成为 Project / Responsibility 级 PR / review / merge 状态的主要入口；评估 `/pr` 是否在迁移完成后收敛为只读 Session 诊断或移除重复的管理呈现。
- [ ] 对 Bot adapter 与 TUI 共用 Host Session / Run API 做契约检查；不同调用方不得各自复制 Run 控制或执行状态机。

### S4 — Branch / PR / merge lifecycle binding

- [ ] 为 ProjectExecutionBinding 关联 repository identity、checkout / workingDirectory、Session / Run 和可复用的 branch policy。
- [ ] 复用 `HostIntegrationApiV1`、`createIntegrationSync`、GitHub observer 与 `IntegrationStore`；以 additive schema / DTO 把既有 Session ↔ PR 观测关联到 Bot / Project / Responsibility / Run / Host。
- [ ] Session Agent / Host 以结构化事件报告 branch 创建 / 切换、commit SHA 与 PR 创建结果；事件关联到责任和 runId。明确 detached checkpoint refs 与实际 branch ref 的不同语义。
- [ ] 实现 Git 本地观察 adapter，识别 branch / commit / local merge；将本地 merge 与 hosted PR merge 区分记录。
- [ ] 在现有 GitHub 只读 observer / 显式刷新之外，增加 PR opened / updated / review / comment / closed / merged 的 provider event 或受限轮询入口；按 provider event ID 幂等落账，向现有 `integration_events` 历史补充所需的 event receipt / lifecycle 字段。
- [ ] merged 事件保存具体 PR、合并方法、PR head SHA、merge commit SHA 和时间；若 API 不提供可靠证据，状态保留 unknown / needs reconciliation。
- [ ] 将 PR / Issue 后续评论按 subscription 回路由至原 Project / Responsibility binding；Bot 决定是否唤醒原 Session Agent。
- [ ] 为每个 Project 定义 merge policy：`observe_only`、`approval_required` 或满足明确 checks / review / branch 条件后才 `auto_merge`；默认需用户审批。Bot 把证据与决策原因写入 Activity，通过 VCS provider adapter 幂等调用 merge，不凭模型自然语言自证完成。
- [ ] Project Activity 展示项目级 branch / PR / merge 摘要；任务详情的 Session Attach 读取同一 Host projection，不创建 VCS 平行责任状态机或重复 Session 状态库。

### S5 — Bot Process 脱离 Desktop UI 生命周期

- [ ] 将 Bot Process 用例与存储访问从 Desktop 窗口 / renderer 生命周期中抽开；第一步仍可由现有 Host 进程装配。
- [ ] 建立 Desktop Workbench UI 与 Bot Process 的客户端边界，UI 关闭不取消持久接纳的责任或 Run。
- [ ] 为 Bot Process 定义启动、单实例、优雅关闭、升级、数据根锁与崩溃恢复；支持本机后台和云端部署，保持 Inbox / Run / Outbox 的 durable reconciliation。
- [ ] 核对 CLI/TUI standalone Session Agent 是否继续复用现有 Host service，避免和本机 Bot Process 抢同一数据根或重复 worker ownership。
- [ ] 如果云端 / headless Bot Process 确需独立安装，提交 Bot 部署包 / `bot/v*` 发布提案；该发行物仍属于 Desktop Bot 产品，不能在服务生命周期、版本兼容和升级路径未经验证前承诺稳定 API。

### S6 — 多环境 Session Agent protocol 与远程 Run MVP

- [ ] 明确 `botId`、`projectId`、`hostId`、`sessionId`、`runId`、ContextEnvelope 的版本化 Host / protocol DTO 和状态所有权；协议版本协商独立于 Desktop、CLI、Bot Process 二进制版本。
- [ ] Session Agent Host 通过短时一次性配对凭证注册，换取持久设备身份；连接双向认证加密，授权限制到 Bot / capability / Run mandate。
- [ ] 增加 Session Agent Host 心跳 / capability / 资源信息、Run lease 或 fencing token、事件序号、幂等结果提交和 offline / unknown 状态恢复。
- [ ] 先支持一个 Bot Process、两台机器与不同项目目录、一个逻辑 Bot 上的一次明确远程 Run；验证执行结果和状态回到 Bot Project Activity。
- [ ] 可以先依赖 Tailscale / WireGuard 提供节点网络可达性；应用层仍需认证，不开放未认证公网 Worker 端口。
- [ ] 第一版不迁移活动 Session、不做多写者 Bot Process、不做透明故障转移；workspace 与 artifacts 由执行 Host 本地持有。

### S7 — 状态投影与恢复验收

- [ ] Bot Activity 投影关联的 Responsibility、Session、当前 Run、pending input 与 outbox receipt。
- [ ] 清楚区分 run completed、责任 completed 和 delivery delivered；unknown 不映射为成功。
- [ ] Bot Process restart、Agent Host offline、route 删除、session archive 和 Bot pause 时对账 pending inbox 与在途 Run。
- [ ] 验证 Bot / Project Activity 与 task-linked Session Attach 对本地和远程 Session Agent 展示一致，branch / PR / merge 状态可从来源事件重建；Agent 离线和未知终态清晰呈现，不建立全局 Session 工作台或第三种 Activity 状态存储。

## 非目标

- 不复制 Claude Projects 的 planner、shared memory 或 Git 分支冲突处理；只借鉴清晰的 Coordinator / Thread / Session 关系。
- 不复制 DeepSeek 的 DSH / tmux executor；继续使用 Duya Host / Runtime。
- 不自动把所有用户要求拆成多 Agent DAG；先支持有明确责任和 route 的 Session 调用。
- 不把 Session.status 改成 Bot / Goal / Run 的合成状态 enum。
- 不将多个 Session 等同于多个隔离工作区。没有 workspace isolation 时不开放并行写代码。
- 不因“Session 要轻”而删除当前 TUI 的有用功能或把 Host capability registry 全部搬进 Bot；保留兼容 standalone default profile，以可见 manifest 控制 Bot-created Run 的具体能力集合。
- 不用 system prompt 代替 capability 授权；不在 RunManifest / RunInput 中传 plugin binaries、provider secrets 或无来源的完整 memory dump。
- 不改变 @duya/bot 包边界；是否迁入纯路由规则看 dependency closure 和实际生产消费者。
- 不把 Bot 身份绑定到 Desktop、某个 process 或单个 Host；不承诺 coordinator 多主、活动 Session 跨机迁移和远端 workspace 自动同步。
- 不把 `duya-bot` 作为第三种用户工作流；它可以是 Desktop Bot Process 的云端 / headless 部署入口，发行时机待服务拆分后另行决策。
- 不让 TUI 演变为 Bot 运营控制台；Desktop 保持任务上下文中的 Session Attach，完整 Session 工作台与排障归 CLI/TUI。
- 不把 GitHub / VCS provider I/O 塞进 Session runtime；由 Host adapter 验证并持久化 branch / PR / merge 事实。Session Agent 报告执行事实，不拥有 Project 生命周期。

## 风险与回退

| 风险 | 应对 |
| --- | --- |
| 默认 route 漂移导致旧 Bot transcript 分叉 | 所有未绑定输入继续落到既有 bot:<id>，新增绑定采用明确 ID；可撤销具体 route |
| Session 上下文串入无关责任 | 每个互不相关的 work binding 使用独立 Session；不要把任务摘要写到共享 Bot Session 中假装归属 |
| Session 分离但文件目录共享，代码互相覆盖 | workspace / checkout isolation 是开启并行写入的硬门槛；否则 per workspace concurrency=1 |
| Inbox claim 后 target Session 改变 | 在 claim / receipt 上保存目标 Session 快照，或将 route revision 纳入 compare-and-set |
| Run 结束被错误解释为任务结束 | Activity 从原始 Run、Goal / Routine、线程订阅和 delivery 事实投影；completion policy 保持独立 |
| 新 route 重试导致副作用重复 | 继续复用 Bot Inbox receipt、Run receipt / epoch 和 Outbox unknown recovery；不盲重放 |
| Desktop UI 退出意外终止 Bot 工作 | Bot Process 持有 worker / scheduler lifecycle；Workbench UI 仅作管理 client；进程提取完成前明确为阶段限制 |
| 一个逻辑 Bot 的状态在多个 Agent Host 分叉 | Bot Process 做单写者权威，Agent Host 仅执行 fenced mandates 并回传带序号的事实；冲突 / 过期结果拒绝 |
| Session Agent 切 Host 后缺 transcript 或文件产物 | ProjectExecutionBinding 固定 Agent Host 与工作目录；不支持仅按 sessionId 透明迁移，除非另行定义并验证 snapshot / workspace 转移协议 |
| PR webhook 重放或 merge evidence 丢失 | 按 provider event ID / PR ID / merge SHA 幂等落账；缺证据时显示 unknown 并从 provider reconciliation 恢复，不推断成功 |
| Bot、Host 与产品版本更新不同步 | `agent-protocol` 提供最低 / 最高支持版本和 feature negotiation；发布线版本不直接当成协议版本 |
| 配对凭证泄露导致未授权计算节点 | 配对码短时单次使用，注册后换发设备凭证并可撤销；每个 Host 的 Bot / capability 授权单独检查 |

## 进度

- [x] 基于 Duya master 4f0738ba 核对 Session / Run API、Bot Dispatcher、BotSession 固定映射与现有 Bot 设计提案。
- [x] 核对 plan 621 已实现的 checkout / checkpoint / Session ↔ PR / GitHub observation 代码；确认当前 projection 未保存 merge SHA、时间、方式，且未找到 PR comment 到 Bot 的订阅路由。
- [x] 核对 TUI 已有 `/project` 本机 cwd 与 `/pr` Session PR 诊断命令，以及 Desktop / Web 的 621 workspace lifecycle 面板。
- [x] 查阅 Claude Projects 官方产品说明与 DeepSeek 原型的 README、Engine、Ticket、Assignment、Effects、Outbox。
- [x] 写研究报告与本计划草稿，明确公开事实和设计推断。
- [x] 用户确认 Desktop Bot / Project / Task-first 并支持 task-linked Session Attach、CLI/TUI Session-first、Runtime shared、Bot identity 独立于 Bot Process / Host，并补充 Project 多执行位置、Bot 上下文注入和 branch / PR / merge 生命周期绑定。
- [x] 用户补充 Bot supervision + user direct access：同一 Session 可由 Bot 与用户共同访问；接管仅暂停 Bot 新指令，让在途工具继续；Mini App / IDE 可经统一 Attach input protocol 直达 Session。
- [x] 用户补充多任务调用模型：Bot 与用户先讨论 Project 目标，再把工作分成并行 Task / Session；每个 Session 按任务自由组合可用能力，并由 Bot 跟踪多分支、PR、检查与 merge 决策。
- [x] 初步核对 Session 能力装配：Session row 保存模型 / provider / permission / profile / 工作目录；master 已有不可变 RunManifest、fingerprint、provenance 与 RunStore snapshot，但 connectorBindings 为空，Skill / Plugin / MCP / context refs 与 options bag 尚未统一覆盖。
- [x] 初步查阅 OpenAI Agents SDK 与 Anthropic Managed Agents 官方 Agent / Session / configuration 文档，确认可借鉴 Agent config、Run context、Session history、per-session capability override 分层；Anthropic Managed Agents 仍处于 Beta。
- [ ] S0 实施前代码接缝与数据迁移核对。
- [ ] S1–S7 分阶段实现与逐片验收。

## 发现与决策

- Session 与 Run API 已是可调用的 Host 执行表面；本计划不动通用执行层。
- 相对目标形态，当前 Session 偏重于 Host-local defaults 与分散的 profile / prompt / plugin / skill / tool 组装；无需重写 Runtime 或新增平行 manifest，直接增量扩展已有 RunManifest / provenance / fingerprint，并复用 RunStore。
- “默认空”指没有隐式继承不相关的 Project / Bot / Host capabilities；仍需可用的基础 runtime、稳定 transcript、Host workspace resolver 和安全的权限缺省。TUI 的默认 profile 可以包含通用能力，Bot-created Run 则显式选择最小所需能力。
- 项目并行工作使用 Project brief → existing Task / Responsibility → per-task RunManifest overlay → isolated branch / workspace → PR / CI / review event → policy-based merge / approval 的闭环；只增加必要的依赖关系和执行绑定，不先造通用 planner / DAG engine。
- 当前 Bot Dispatcher 对一个 Bot 只使用固定 bot:<id> Session，且按 Bot busy guard 串行。这是增加 Bot 多 Session 的直接接缝。
- Claude Thread 是执行 Session，DeepSeek Ticket 是长期工作实体。Duya 应分别建模责任关联、Session 和 Run。
- 现有设计提案已明确一 Bot 可关联多 Session，并避免复制 Goal / Task 状态机；本计划是实现接续，不应替代上级框架迁移。
- 独立 Session 本身不提供文件隔离，不能仅凭 sessionId 不同就宣称安全并行。
- 当前 Desktop 与 CLI/TUI 只有两条已存在的独立发布线；CLI 包含本地 Host Worker 与 Node Runtime。
- Bot Process 脱离 Desktop UI 的常驻生命周期、Session Agent Host 配对与远程 Run 协议仍是架构目标，不是 master 已有能力；云端 / headless 部署包是否使用 `duya-bot` / `bot/v*` 在 S4 再作决定。
- Desktop / TUI 的产品边界先于多环境执行网络：先明确 Bot / Session 分工和 TUI 纯度，再建立 Project→Run→PR→merge 可追踪链，之后拆 Bot Process 生命周期并接入远程 Session Agent。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| base 4f0738ba；文档草稿 | Linux worktree / Codex | Duya 源码核对、外部一手资料核对、文档相对链接检查、git diff --check | 测试未运行；文档检查结果在本次交付摘要记录 | 仅研究与计划文件，无产品代码修改 |

## 接续 / 结果

当前成果：基于 master 4f0738ba 的研究报告、个人 Bot 设计补充与 backlog 实施草稿已写入独立 worktree；未实现代码、未迁移用户数据、未改变生产 Bot 路由。

下一步从 S0 开始：核对 Bot 当前 RunManifest 路径、Task / Session 能力装配和 Inbox claim / receipt，给出最小现有 RunManifest additive field set、ProjectExecutionBinding、SQLite / Host API diff；保持旧 TUI / Run manifest 行为可恢复；先做可审查的小批 Task 并行闭环，不扩展成通用 planner / DAG。
