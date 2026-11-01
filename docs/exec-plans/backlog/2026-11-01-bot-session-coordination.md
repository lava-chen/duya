# Bot / Session Runtime 实施计划总入口

状态：backlog（计划体系已建立，产品代码尚未实施）· 负责人：Codex / root · 更新：2026-11-01
规划分支：codex/bot-session-coordination · worktree：/workspace/work/bot-session-coordination
代码基线：4f0738bae34777cce45308291f3207f90e6705a1 · 规划起点：f5986ace · owner：当前会话
交付：[Draft PR #562](https://github.com/lava-chen/duya/pull/562)

## 目标与边界

用户与 Bot 确认项目目标后，Bot 拆分一批有验收标准的 Task，为每个 Task 选择模型、提示、Skill、Plugin、工具、上下文和权限，在隔离工作区中启动或复用 Session。用户能进入同一个 Session 提具体要求；Bot 跟踪 branch、PR、CI、review 和 merge，持续协调项目。

采用现有 agent-runtime 作为完整 Session Runtime 的实现包，在包内建立 session / assembly / engine 边界。Session Agent 是可调用能力的产品称呼，不建立 session-agent package。Bot 是长期状态、协调 Session 和工作 Session 管理层；协调与工作复用同一执行引擎。Host 注入真实模型、存储、连接器、凭据、工作区和进程适配器。

本次交付是完整实施计划与设计同步。R1–R5 的代码实施分别认领；批准本计划不代表运行时迁移、发布或 PR 合并已经发生。

关联：[设计](../../design-docs/personal-bot-framework.md) · [研究依据](../../references/agent-coordination-models.md) · [既有 Bot 框架](../active/2026-10-25-personal-bot-framework.md)

## 如何使用本计划

先读 [00：包边界与协议合同](bot-session-runtime/00-package-and-protocol-contracts.md)，再执行当前 ready 模块。模块文件维护自己的实施进度和验证证据；本入口维护依赖、交付门槛和跨模块决策。

| 模块 | 任务与交付物 | 前置 | 状态 |
| --- | --- | --- | --- |
| R1 | [Session Runtime 与 Host 收敛](bot-session-runtime/01-session-runtime.md)：一个可注入依赖的 Session 服务和统一输入控制 | 00 合同；先完成 R1.0 调用链审计 | 待实施 |
| R2 | [能力与上下文装配](bot-session-runtime/02-capability-context.md)：每 Run 显式配置、可审计 manifest、作用域隔离 | R1.0 冻结调用合同；接入依赖 R1 | 待实施 |
| R3 | [Bot 项目与多 Session 协调](bot-session-runtime/03-bot-coordination.md)：项目 brief、任务绑定、隔离并行与恢复 | R1、R2 | 待实施 |
| R4 | [PR 交付与任务内 Session 协作](bot-session-runtime/04-delivery-and-attach.md)：VCS 事实、merge policy、Desktop Attach / Plugin 输入 | R3；R4-A 与 R4-B 可分别推进 | 待实施 |
| R5 | [后台常驻与多机执行](bot-session-runtime/05-resident-and-remote.md)：UI 生命周期解耦、配对、远程 Run | R1–R4 本机交付门通过 | 后续阶段 |

顺序为 R1 → R2 → R3 → R4。R2 的协议设计可在 R1.0 后提前进行，但只在 R1 的服务入口接入；R4-A 的 VCS 与 R4-B 的 UI 可分别实现，共享文件按合同指定一个 owner。R5 不阻塞首轮本机产品交付。

每个大模块拆成文件内标注的少量 PR 切片。每片结束记录已实现、已验证、已合并的范围，保持可运行的生产入口，避免最后集中接线。

## 已采纳的决定

| 决定 | 实施约束 |
| --- | --- |
| Desktop = Bot / Project / Task-first | 从任务详情查看并 Attach 对应 Session；TUI 提供完整独立 Session 工作台 |
| Runtime = 完整 Session 能力 | 增量迁入通用 Session 行为，保留已有 RunEngine、RunController、ledger 和终态持久化语义 |
| Host = 资源适配与可信入口 | 负责认证、授权、manifest 冻结、数据/模型/工具/进程/网络适配；通用 Session 决策由 Runtime 统一实现 |
| Bot = 长期协调与 Session 管理 | 一个协调 Session 加若干工作 Session；botId、项目和任务独立持久化，协调 Session 可恢复或替换 |
| Protocol = 统一调用合同 | Bot 只依赖协议和端口；Host 装配 Bot 与 Runtime，保持 bot → protocol、host → bot/runtime 的方向 |
| RunManifest = 既有运行快照 | 扩展现有 StartAgentRunInput / RunManifest / provenance / fingerprint / RunStore；能力清单、必需能力与授权分别表达 |
| Task / Session / Run 分开 | 一个 Task 可以多次 Run；并行写任务使用隔离 checkout；Run 结束不直接代表 Task 或 Project 完成 |
| 用户与 Bot 直连同一 Session | 查看状态无需接管；开始协作取得指令调度租约，Bot 暂缓新输入，在途工具继续 |
| merge = 有来源的交付事实 | 默认需要用户审批；授权自动合并时检查当前 head、CI、review、分支规则，并保存 provider evidence |

包级职责、字段兼容和状态单写者只在 [00 合同](bot-session-runtime/00-package-and-protocol-contracts.md) 维护。其他模块引用它，避免各自定义另一套 Session API。

## 现有代码基线与需要核实的接缝

2026-11-01 核对 origin/master 为 4f0738ba。以下是调查结果，不等于迁移已经完成：

| 已有实现 | 复用方式 / 当前缺口 |
| --- | --- |
| agent-runtime 的 RunEngineImpl、RunController、RunSession、事件与压缩流水线 | 保持运行语义；现有 RunSession 是每 Run ledger/settlement 实体，不把它直接当作持久对话 Session |
| Host 的 WorkerSession、worker-engine-driver、worker-session-history | 通用 Session 行为迁入 Runtime；Bot prompt、全局配置、DB 和模型客户端依赖先通过端口断开 |
| HostSessionApiV1、HostRunExecutionApiV1 | 组成窄 Session 调用面；复用既有 DTO、历史、Run ledger 和存储 |
| RunManifest、buildRunManifest、RunStore manifest_json / manifest_hash | 已有不可变配置快照与 provenance；connectorBindings 当前为空，任务能力与上下文引用尚未完整表达 |
| StartAgentRunInput 的 typed overrides 和 attachments | model/provider/profile/permission/modes/tools 与文件附件已存在；mentions/display 等仍有 options 字段 |
| Bot Dispatcher 的 bot:<id> Session 映射与 busy guard | 保留旧默认路由；增加任务 Session 绑定和 per Session / workspace 调度，避免只按 Bot 串行 |
| Desktop stream reattach 与 TUI mailbox steer | 已有观察/局部输入路径；尚缺跨客户端 actor、持久输入回执、user-control lease 和统一 Host 输入入口 |
| 621 的 checkout、checkpoint、HostIntegrationApiV1、IntegrationStore | 复用 PR 关联和观测；补归属、CI/review 路由与 merge SHA/方法/时间，不另建 PR store |
| clientScoped Host 的客户端租约 | R5 核对窗口关闭与 durable Bot 工作的生命周期，不能把最后一个 UI 离开当成 Bot 完成 |

R1.0 必须确认当前 Bot dispatch 是否经过 canonical manifest factory，以及旧 synthesized manifest 路径的真实消费者；不从旧注释推断当前执行归属。

## 交付门与验收

| 门槛 | 必须证明的结果 | 责任模块 |
| --- | --- | --- |
| G1：统一 Session | 无 Bot 的调用方通过 Runtime Session 服务创建、执行、读取、取消和恢复；真实 Worker 路径经过新入口 | R1 |
| G2：任务配置隔离 | 两个 Session 使用不同能力和上下文；显式空与缺省可区分；必需能力缺失明确拒绝；manifest 可校验并兼容旧记录 | R2 |
| G3：项目并行 | 一个 Bot 按 Task 选择两个隔离 checkout 和 Session，并发执行；同目录写任务串行；重试不重复创建 Run | R3 |
| G4：直接协作 | Desktop 从任务进入同一 Session；Plugin 发送结构化引用；用户接管暂缓 Bot 新输入，交还后对账恢复 | R1、R4-B |
| G5：PR 交付 | Project 可追踪 branch/PR/CI/review；反馈回到原任务；合并检查当前 head 并记录可验证 merge evidence | R4-A |
| G6：后台与多机 | UI 关闭后工作可继续或持久等待；远程断连不误报成功；同一 Bot 可调用两台 Host 的不同目录 | R5 |

首轮产品交付为 G1–G5：用户与 Bot 讨论项目 → 两个任务独立装配能力 → 两个 worktree / branch 并行 → 用户直接修改其中一个任务要求 → Bot 汇总 PR 和检查结果 → 用户审批后确认 merge。缺凭据或外部服务时记录该门未完成，不能用 mock 成功替代真实集成。

代码片验证遵循根规则：相关纯规则/合同/真实 Worker 测试，typecheck:all、architecture:check；改打包边界时做构建，UI 变更走真实浏览器路径。本轮仅修改文档，执行编码、链接、可见性和 diff 检查，不把未来场景标为已通过。

## 跨模块兼容与回退

- 每片先保留稳定 API，再逐调用方迁入新服务；已迁移调用方只有一条实际执行路径，旧入口转发而不再独立调度。
- Session/Run/transcript/PR 表继续使用原 ID。新关系、输入回执、租约和 VCS 字段采用 additive migration，旧记录可读；具体表名和 migration 编号以开工时 schema 为准。
- 现有 Run fingerprint 保持可验证；manifest 扩展遵循版本化 reader 和 canonical hash 规则，不读取后重写历史 hash。
- 回退优先关闭新的 Bot 多 Session 派发、保留已创建 Task/Session/Run 供查询与对账；同一 Session 有在途 Run 时不得切换到另一执行 owner。
- 窗口、网络、调度租约、Worker 和输入回执故障按各模块矩阵对账。unknown 保留为 unknown；外部 merge/投递结果不通过盲重试确认。
- 一台 Host 的多个 Bot 共用执行资源约束；同一 Session 单一执行 owner。同一工作区的不同 Session 也受到写入隔离约束。

## 与既有计划的关系

| 既有计划 | 本计划的接续点 |
| --- | --- |
| [个人 Bot 框架](../active/2026-10-25-personal-bot-framework.md) | 保留身份、Inbox/Outbox、owner epoch、receipt 与恢复语义；扩展项目和任务关联 |
| [621 工作区生命周期](../active/621-coding-workspace-lifecycle-harness.md) | 复用 checkout/branch/checkpoint/integration，增量补 Bot 归属与 merge 事实 |
| [620 Session 记录](../active/620-session-record-architecture.md) | 沿用历史与投影权威，不复制 transcript |
| [622 Runtime 纯净度](../active/622-agent-platform-convergence/06-runtime-purity.md) | 共享依赖审计；本轮只消除迁入 Session 代码引入的反向依赖，其他历史纯净度独立排期 |
| [工具与 Harness 收敛](../active/2026-10-31-tool-surface-and-harness-convergence.md) | 复用能力目录/调用/信任机制，不新增插件注册系统 |
| [独立发布](../active/2026-10-29-product-release-separation.md) | 保持 CLI/Desktop 既有发布线；R5 再决定 headless Bot 部署入口 |

旧单页 S0–S7 的工作已归入 R1.0（审计）、R1（Session/输入）、R2（配置）、R3（绑定/派发）、R4（UI/VCS）和 R5（常驻/多机）。本页及链接模块是后续执行入口，不继续按旧 S 编号派工。

## 进度

- [x] 核对代码基线、既有发布/Session/Run/Bot/VCS 能力。
- [x] 建立研究报告、产品架构设计和 Draft PR #562。
- [x] 用户确认复用 agent-runtime 承接完整 Session 能力，Bot 为长期协调与 Session 管理层。
- [x] 将单页草稿整理为总入口、包/协议合同和五个实施模块。
- [ ] R1：Session Runtime 与 Host 收敛。
- [ ] R2：能力与上下文装配。
- [ ] R3：Bot 项目与并行 Session。
- [ ] R4：PR 交付与任务 Attach。
- [ ] R5：后台常驻与远程执行。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 结果 | 证据 |
| --- | --- | --- | --- | --- |
| 4f0738ba 代码；f5986ace 既有文档 | Linux / 独立 worktree | 源码与既有计划核对、origin/master 查询 | 当前代码基线未变化 | Run/Session/manifest/Bot/VCS 调查见研究报告 |
| f5986ace + 本次 13 个 Markdown 文件 | Linux / 独立 worktree | Python UTF-8/相对链接/可见性/测试命令路径/模块结构检查 | 通过；检查 254 个相对链接，0 新增失效链接，2 个既有目录问题 | 6 个新合同/模块卡，5 个实施模块均有依赖/验收/回退/接续 |
| 本次文档变更 | Linux / 独立 worktree | git diff --check | 通过 | 无产品代码或 schema 改动，未运行产品测试 |
| 本次已采纳架构决定 | Notion Project State | 追加包边界、R1–R5 顺序与未实施状态 | 成功，无警告 | 不替代本系列代码进度 |

既有目录问题在 f5986ace 基线可复现：exec-plans/README.md 指向缺失的 active/2026-10-24-dynamic-workflow-package.md；catalog.md 指向空文件 backlog/309-button-unification.md。本系列没有新增这些问题，保留其既有任务归属。

## 接续 / 结果

当前为规划交付，R1–R5 均未实现。规划 owner 使用上述独立 worktree；执行模块时登记自己的分支/base/owner/独占路径，共享 protocol/data/Host bootstrap 文件先协调归属。Workspace context 工具在本环境不可用，已通过版本化计划、Git worktree 和 PR 对账。

本次外部交付沿用 Draft PR #562；未授权合并，保留分支与 worktree。Notion Project State 仅同步已采纳的架构决定，不代替本系列实施状态。

下一步：认领 R1.0，追踪 Session create → manifest/admission → Worker → RunEngine → durable terminal 的生产调用链，给出单写者与字段兼容表，然后提交第一片 additive protocol / Runtime ports diff。
