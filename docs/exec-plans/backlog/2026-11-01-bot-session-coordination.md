# Bot-first Desktop、Session-first CLI/TUI 与多环境 Session Agent

状态：backlog（架构决策已采纳，实施排序待执行）· 负责人：Codex / root · 更新：2026-11-01
分支：codex/bot-session-coordination · worktree：/workspace/work/bot-session-coordination · base：4f0738bae34777cce45308291f3207f90e6705a1 · owner：当前会话

## 目标与边界

目标：确立 Duya 的双产品架构，并渐进落实清晰的 Bot / Session Agent 边界：Desktop 是 Bot-first 产品，包含可在本机或云端运行的 Bot Process 与工作台 UI；CLI/TUI 是 Session-first Session Agent 产品，可在不同操作系统、容器、云 VM 或本机环境运行。Bot 调用 Session Agent 来执行工作，二者复用同一套 protocol、Host Session / Run API 与 agent-runtime。Bot 身份不绑定 Bot Process 或某台主机；Session Agent Host 是带 hostId 的执行环境。没有显式责任路由时继续使用现有 Bot 默认 Session。

本计划落实已采纳的产品架构决策，不代表代码已开始或用户已经承诺本计划所有阶段。实现仍留在 backlog，按发布与稳定性主线排期后再认领为 active。

研究依据：[多 Session Agent 协调架构研究](../../references/agent-coordination-models.md)。
设计合同：[个人长期 Bot 框架](../../design-docs/personal-bot-framework.md)。
上级计划：[个人长期 Bot 框架迁移](../active/2026-10-25-personal-bot-framework.md)。
现有发布计划：[Desktop 与 CLI 独立发布](../active/2026-10-29-product-release-separation.md)。

## 已采纳的产品架构决策

| 决策 | 约束 |
| --- | --- |
| Desktop = Bot-first | Desktop 只做 Bot UI。一个 Bot 管理多个 Project、长期责任、记忆、审批与执行结果；不提供独立 Session 列表或 Session 对话页面。Bot Process 可本机或云端运行，独立于 UI 生命周期 |
| CLI / TUI = Session-first | 专注即时 Session、Run、工具调用、编程与终端、多模型 / Harness、临时和并行工作；作为底层 Session Agent 的专业终端，保留本地 standalone 能力 |
| Runtime = Shared | Bot 调用 Session Agent 的标准 Host Session / Run API 与 `agent-runtime`；Bot 将按项目选出的记忆、上下文和授权传入 Session，不假设执行端共享 Bot 记忆 |
| Bot identity ≠ Bot Process / Host | `botId` 是逻辑身份；Bot Process 是可本地或云端运行的状态与协调权威；`hostId` 标识 Session Agent 执行环境。一台 Host 可执行多个 Bot 的任务，一个 Bot 可调用多台 Host |
| Project → Session Agent | 一个 Bot 管多个 Project；Project 可配置多个执行绑定，指定 Agent endpoint、机器和工作目录并启动 / 复用 Session |
| 分阶段拆服务与多机 | 先完成 Bot → Project → 上下文注入 → Session Agent → Run → 汇报，再将 Bot Process 脱离 Desktop UI / Electron 生命周期并支持本机或云端部署，最后接入多环境 Agent 网络 |

这两种产品体验不意味着需要立即新增第三种用户工作流。当前 `desktop/v*` 与 `cli/v*` 发布线继续独立；Bot Process 的云端 / headless 部署可能需要 `duya-bot` 安装入口与 `bot/v*` release，但它属于 Desktop Bot 的部署形态，待生命周期和协议边界验证后再决定。Session Agent endpoint 则由 CLI/TUI 产品提供并能运行在不同环境。

边界：

- 调整 Bot 身份关联、Bot inbox 路由、Host Bot Dispatcher 和必要的 Bot DTO / persistence。
- 保留 bot:<id> 作为默认协调 Session，兼容现有 Bot 输入。
- 可用一个窄 ProjectExecutionBinding / ResponsibilityBinding 关联 Bot、Project、Session Agent endpoint、hostId、机器本地工作目录、Session 复用策略、既有 Goal / Routine 引用和 Thread route；名字及字段以 S0 接缝检查为准。
- Desktop 是 Bot-only UI；在 Bot / Project Activity 展示状态和交付结果，不新增 Session 列表或 Session 对话 UI。TUI 聚焦 Session-first，保留 standalone 本地执行。
- 先在现有 Host 装配中建立 Bot Process 边界，再将其生命周期从 Desktop UI / Electron 窗口与 renderer 中解耦。
- 复用现有 HostSessionApiV1、HostRunExecutionApiV1、durable Run、Inbox、scheduler owner epoch、Outbox、Goal / Routine 和 workspace / checkout 能力。
- 不修改 agent-runtime 的模型循环、Run ledger、Session transcript、provider 或通用 Session API 语义；发现现有 API 无法满足时另行裁决 additive contract。
- 多环境阶段只在 Host API / protocol 加窄的认证远程 Session Agent 适配；Bot Process 做单写者权威，Agent Host 本地管理 Runtime、工具和 workspace。
- 保持现有 `desktop/v*` 与 `cli/v*` release。云端 / headless Bot Process 可能使用 `duya-bot` 与 `bot/v*` 部署包；它属于 Desktop Bot 产品，不在当前首批 UI / Project 绑定切片建立。
- 不建立 Bot 专属执行引擎、第二套 Task / Goal / Run 状态机、通用 DAG、Effects Queue、Outbox、审批或记忆系统。
- 首版不做自动 proactive 任务接单，不要求 Bot 自动拆解所有 Project goal，不提供透明跨 Host Session 迁移。

## 验收

实现完成时必须满足：

1. Desktop 只提供 Bot-centric UI。用户通过 Bot 管理多个 Project、长期责任、审批和结果；没有独立 Session 列表、Session 工作台或 Session 对话页面。
2. 一个 Bot 可管理多个 Project；一个 Project 可绑定多个执行位置。每个位置包含 Session Agent endpoint、hostId、机器本地工作目录和 Session 复用策略。
3. Bot Process 在派发每个 Run 前，按 Bot / Project / Responsibility scope 组装 ContextEnvelope，至少能带入任务说明、权限、相关记忆与项目上下文；不让 Session Agent 直接读取 Bot 私有记忆库，也不无筛选地传入全部 Bot 记忆。
4. Session Agent 保持低层、可调用的执行能力，提供创建 / 复用 Session、启动 / 观察 / 取消 Run 的适配接口；Session API 尚不成熟的部分由 Host adapter 隔离，Bot 领域不绑定临时 API 细节。
5. CLI/TUI 仍可独立创建并执行本地 Session，不要求先创建 Bot；Session 调试和执行过程归 CLI/TUI 的专业交互。
6. 旧 Bot 输入仍运行在原 bot:<id> Session 上；已有 Inbox receipt、Run receipt、channel reply 与 redrive 语义不回归。
7. 没有 route 的新输入回落到 Bot 默认协调入口；有 Thread subscription 的后续消息稳定送到对应 Project / Responsibility 执行绑定。
8. 同一 Session 同一时间最多一个受控 Bot Run；不同 Session 可并行，但仅在工作区隔离确认或执行只读工作时打开并行。共享写目录默认串行。
9. Bot 级并发上限与现有 scheduler owner / epoch 协调；重启后不会启动同一 Inbox item 的第二个 Run。
10. Bot Process 生命周期独立于 Desktop 工作台 UI；窗口关闭后接纳的工作继续或以持久可恢复状态等待。本地或云端部署使用相同 Bot 身份与服务合同。
11. Bot 与 Session Agent Host 身份独立：一个 Host 可执行多个 Bot 授权范围内的 Run，一个 Bot 可调用多个 Host；Bot Process 权威维护 Bot / Project / Responsibility / route / context，Agent Host 权威维护本地 workspace 和执行产物。
12. 多环境 Session Agent MVP 使用已认证配对和版本协商，完成两台机器、两个不同目录间一次显式远程 Run；状态、事件、终态和结果回到 Bot 的 Project Activity；Agent Host 离线或协议不兼容不会被判为成功。
13. 活动 Session 有明确 Host / workspace affinity；不同 Host 不共享或迁移 transcript / workspace，除非另有经验证的同步和迁移合同。
14. 新增测试覆盖 Project 路由、上下文 scope、默认 route、指定 route、同 Session 串行、隔离 Session 并行、越权 route 拒绝、Bot Process restart、Agent Host offline、协议版本不兼容和投递失败恢复。

## 实施切片草稿

以下切片先建立 Bot / Project / Session Agent 绑定和上下文传递，再按产品 UI、Bot Process 生命周期和远程执行环境逐层扩展；如调用闭包显示需要改通用 Session / Run 契约，先停下并给出最小 additive 方案，不扩大到另建 Runtime。

### S0 — 当前实现与事务边界再核实

- [ ] 查清 Inbox entry 是否保存渠道 Thread identity，claim 是否允许按 route / Session 粒度，以及 lookupReceipt 如何与 target Session 关联。
- [ ] 追踪 Host Session create / run start / workspace checkout 到实际 worker；证明独立 Session 是否真的隔离可写工作区。
- [ ] 核对现有 ResponsibilityBinding、Goal、Routine、SessionSpawn 和 channel thread DTO 的真实消费者；不重复现有数据结构。
- [ ] 映射 Desktop 当前 Bot、Project、Session、Run 和后台任务界面；确定纯 Bot UI 要呈现的项目级状态与结果 API，不保留独立 Session UI。
- [ ] 核对 CLI 本地 Host 启动 / 停止路径、Desktop Electron 生命周期、数据根锁和现有发布线，为 service extraction 画依赖边界。
- [ ] 输出最小合同 diff、UI 接缝、进程生命周期、迁移策略和受影响文件范围，再开始代码切片。

### S1 — BotSessionBinding 与事件路由

- [ ] 在 Bot-owned 数据 / 协议层建立最小关联：ownerId、botId、projectId、可选 responsibilityId、agentEndpointId / hostId、workingDirectory、sessionId / reuse policy 与 source-thread route。
- [ ] 保证 bot:<id> 是 default route；旧数据无迁移时行为不变。
- [ ] 建立或更新 route 时验证 Session 属于预期 owner / Bot，并验证来源 binding；不从模型提供的自由文本直接建立受信 route。
- [ ] Bot Inbox accept / dispatch 能解析已存在 route，并保留 durable dedup / receipt；若 route 在 claim 前变化，定义确定的快照版本或在 claim 时原子重验。
- [ ] 只加入 relation / route 状态，不增加第二份 Goal / Run / delivery status。

### S2 — Session-aware dispatch 与限制

- [ ] 按 target Session 检查忙闲，保持同 Session 串行；不同 Session 在工作区隔离下可并发。
- [ ] 为 Bot 保留小而明确的 maxConcurrency；全 Bot 限制和 per Session 锁不可互相冒充。
- [ ] claim 与 Run dispatch receipt 维持幂等；Run start 结果丢失时通过现有 receipt reconciliation 判定，不能仅靠重新启动。
- [ ] 对共享 checkout / 同一工作目录使用 serial lane；有隔离 checkout 时才放开多个写 Worker。
- [ ] 保持 legacy / host scheduler ownership epoch、preemption、redrive 和 terminal settlement 逻辑。

### S3 — Desktop Bot-only UI 与 TUI Session-first

- [ ] Desktop 只呈现 Bot、Project、Responsibility、项目 Activity、审批与节点状态；不增加 Session 列表、Session 对话或独立 Session 管理页面。
- [ ] 完成可用闭环：创建 / 选择 Bot → 管理多个 Project → 设置各项目执行 endpoint / 工作目录 → 委托 Responsibility → Bot 按 scope 选取记忆和上下文并组装 ContextEnvelope → Bot 通过 Session Agent adapter 创建或复用 Session → Run 后台执行 → Project Activity 汇报结果。
- [ ] TUI 主路径专注创建或接入 Session、执行过程和 Harness / tool 选择；保持无 Bot 的 local standalone Session。Session 低层控制体验由 TUI 承担，不复制到 Desktop。
- [ ] 对 Bot adapter 与 TUI 共用 Host Session / Run API 做契约检查；不同调用方不得各自复制 Run 控制或执行状态机。

### S4 — Bot Process 脱离 Desktop UI 生命周期

- [ ] 将 Bot Process 用例与存储访问从 Desktop 窗口 / renderer 生命周期中抽开；第一步仍可由现有 Host 进程装配。
- [ ] 建立 Desktop Workbench UI 与 Bot Process 的客户端边界，UI 关闭不取消持久接纳的责任或 Run。
- [ ] 为 Bot Process 定义启动、单实例、优雅关闭、升级、数据根锁与崩溃恢复；支持本机后台和云端部署，保持 Inbox / Run / Outbox 的 durable reconciliation。
- [ ] 核对 CLI/TUI standalone Session Agent 是否继续复用现有 Host service，避免和本机 Bot Process 抢同一数据根或重复 worker ownership。
- [ ] 如果云端 / headless Bot Process 确需独立安装，提交 Bot 部署包 / `bot/v*` 发布提案；该发行物仍属于 Desktop Bot 产品，不能在服务生命周期、版本兼容和升级路径未经验证前承诺稳定 API。

### S5 — 多环境 Session Agent protocol 与远程 Run MVP

- [ ] 明确 `botId`、`projectId`、`hostId`、`sessionId`、`runId`、ContextEnvelope 的版本化 Host / protocol DTO 和状态所有权；协议版本协商独立于 Desktop、CLI、Bot Process 二进制版本。
- [ ] Session Agent Host 通过短时一次性配对凭证注册，换取持久设备身份；连接双向认证加密，授权限制到 Bot / capability / Run mandate。
- [ ] 增加 Session Agent Host 心跳 / capability / 资源信息、Run lease 或 fencing token、事件序号、幂等结果提交和 offline / unknown 状态恢复。
- [ ] 先支持一个 Bot Process、两台机器与不同项目目录、一个逻辑 Bot 上的一次明确远程 Run；验证执行结果和状态回到 Bot Project Activity。
- [ ] 可以先依赖 Tailscale / WireGuard 提供节点网络可达性；应用层仍需认证，不开放未认证公网 Worker 端口。
- [ ] 第一版不迁移活动 Session、不做多写者 Bot Process、不做透明故障转移；workspace 与 artifacts 由执行 Host 本地持有。

### S6 — 状态投影与恢复验收

- [ ] Bot Activity 投影关联的 Responsibility、Session、当前 Run、pending input 与 outbox receipt。
- [ ] 清楚区分 run completed、责任 completed 和 delivery delivered；unknown 不映射为成功。
- [ ] Bot Process restart、Agent Host offline、route 删除、session archive 和 Bot pause 时对账 pending inbox 与在途 Run。
- [ ] 验证 Bot / Project Activity 对本地和远程 Session Agent 展示一致，Agent 离线和未知终态清晰呈现；不暴露独立 Session UI，也不建立第三种 Activity 状态存储。

## 非目标

- 不复制 Claude Projects 的 planner、shared memory 或 Git 分支冲突处理；只借鉴清晰的 Coordinator / Thread / Session 关系。
- 不复制 DeepSeek 的 DSH / tmux executor；继续使用 Duya Host / Runtime。
- 不自动把所有用户要求拆成多 Agent DAG；先支持有明确责任和 route 的 Session 调用。
- 不把 Session.status 改成 Bot / Goal / Run 的合成状态 enum。
- 不将多个 Session 等同于多个隔离工作区。没有 workspace isolation 时不开放并行写代码。
- 不改变 @duya/bot 包边界；是否迁入纯路由规则看 dependency closure 和实际生产消费者。
- 不把 Bot 身份绑定到 Desktop、某个 process 或单个 Host；不承诺 coordinator 多主、活动 Session 跨机迁移和远端 workspace 自动同步。
- 不把 `duya-bot` 作为第三种用户工作流；它可以是 Desktop Bot Process 的云端 / headless 部署入口，发行时机待服务拆分后另行决策。
- 不让 TUI 演变为 Bot 运营控制台；Desktop 不提供 Session 层的用户界面，Session 控制与排障留给 CLI/TUI。

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
| Bot、Host 与产品版本更新不同步 | `agent-protocol` 提供最低 / 最高支持版本和 feature negotiation；发布线版本不直接当成协议版本 |
| 配对凭证泄露导致未授权计算节点 | 配对码短时单次使用，注册后换发设备凭证并可撤销；每个 Host 的 Bot / capability 授权单独检查 |

## 进度

- [x] 基于 Duya master 4f0738ba 核对 Session / Run API、Bot Dispatcher、BotSession 固定映射与现有 Bot 设计提案。
- [x] 查阅 Claude Projects 官方产品说明与 DeepSeek 原型的 README、Engine、Ticket、Assignment、Effects、Outbox。
- [x] 写研究报告与本计划草稿，明确公开事实和设计推断。
- [x] 用户确认 Desktop Bot-only / Project-centric、CLI/TUI Session-first、Runtime shared、Bot identity 独立于 Bot Process / Host，并补充 Project 多执行位置与 Bot 上下文注入边界。
- [ ] S0 实施前代码接缝与数据迁移核对。
- [ ] S1–S6 分阶段实现与逐片验收。

## 发现与决策

- Session 与 Run API 已是可调用的 Host 执行表面；本计划不动通用执行层。
- 当前 Bot Dispatcher 对一个 Bot 只使用固定 bot:<id> Session，且按 Bot busy guard 串行。这是增加 Bot 多 Session 的直接接缝。
- Claude Thread 是执行 Session，DeepSeek Ticket 是长期工作实体。Duya 应分别建模责任关联、Session 和 Run。
- 现有设计提案已明确一 Bot 可关联多 Session，并避免复制 Goal / Task 状态机；本计划是实现接续，不应替代上级框架迁移。
- 独立 Session 本身不提供文件隔离，不能仅凭 sessionId 不同就宣称安全并行。
- 当前 Desktop 与 CLI/TUI 只有两条已存在的独立发布线；CLI 包含本地 Host Worker 与 Node Runtime。
- Bot Process 脱离 Desktop UI 的常驻生命周期、Session Agent Host 配对与远程 Run 协议仍是架构目标，不是 master 已有能力；云端 / headless 部署包是否使用 `duya-bot` / `bot/v*` 在 S4 再作决定。
- Desktop / TUI 的产品边界先于多环境执行网络：先建立清楚的主工作流，再拆 Bot Process 生命周期，最后接 Session Agent network，避免把跨机复杂度引入产品入口调整。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| base 4f0738ba；文档草稿 | Linux worktree / Codex | Duya 源码核对、外部一手资料核对、文档相对链接检查、git diff --check | 测试未运行；文档检查结果在本次交付摘要记录 | 仅研究与计划文件，无产品代码修改 |

## 接续 / 结果

当前成果：基于 master 4f0738ba 的研究报告、个人 Bot 设计补充与 backlog 实施草稿已写入独立 worktree；未实现代码、未迁移用户数据、未改变生产 Bot 路由。

下一步从 S0 开始：核对 Inbox claim / receipt、ProjectExecutionBinding 与 Session Agent adapter 合同，给出最小 DTO / SQLite / Host API diff；不得直接扩展成通用任务 DAG。
