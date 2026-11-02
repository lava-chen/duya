# Project Coordinator：项目对话、执行协调与长期记忆

状态：active，产品代码待认领 · owner：Codex root（本轮设计）· 更新：2026-11-02。
设计分支：`codex/project-first-plan` · worktree：`/workspace/work/project-first-plan` · base：master `af4aaede`。

## 目标与边界

Project Coordinator 是当前产品主线：用户进入项目与项目 Agent 长期对话，由它组织工作 Session，记住项目决定、进度与下一步。Personal Bot 暂缓增强；CLI/TUI 保持独立使用，后续增强/Release 不再排在 Project 前面。只修项目闭环所需的 Session 基础，不先完成全部底层迁移。

本页只保留三个总体任务，每项可整体交给一个 Agent。产品角色、包归属和状态权威以 [Project-first 架构决策](../../design-docs/project-first-architecture.md)为准。本轮只落文档；下面的实现均未完成，不以设计写入代表产品已具备。

## 开工前已核对的接缝

快照：2026-11-02，master `af4aaede`；接手时核对最新 PR，勿使用旧状态头。

| 现状 | 实施影响 |
| --- | --- |
| #573/#574/#577/#578 已合并协议、Session 服务、统一启动入口与引擎核心迁移 | 复用这些基础，不再派任务重复搬迁 |
| [#579](https://github.com/lava-chen/duya/pull/579) Draft：Session MCP；[#580](https://github.com/lava-chen/duya/pull/580) Open：工具 allow/deny、子代理恢复及持久输入 | 两者都修改输入/租约与消息路径；先统一权威服务，再供 Coordinator 和用户共用，不能只按 PR 号顺序盲合 |
| #579 用 mailbox/Session extension；#580 用 session_inputs/session_control_leases；同步 MessageSession 一退一补 | 差异证据与集成约束在架构决策“首轮必须裁定”节；任务一负责收口，不新增第三套 |
| `packages/data/src/project-store.ts` 只有项目元数据；`packages/host/src/task-api.ts` 任务按 Session 组织 | 定义稳定项目任务/执行绑定，不能把当前协调 Session 变成项目身份或唯一任务容器 |
| `packages/host/src/worker-prompts/bot/memory/tierReader.ts` 的项目记忆依赖 Bot membership/shard | 复用底层记忆机制，增加项目 scope 接入；Coordinator 不依赖个人 Bot 才有记忆 |
| [#566](https://github.com/lava-chen/duya/pull/566) 是尚未合并的 UI mock harness | 可评估复用来验证布局；真实 Host/Session 接线不由 mock 结果代替 |

## 任务一：完成 Coordinator 与工作 Session 的项目闭环

请基于最新主干和上述架构决策，完成可运行的 Project Coordinator：每个项目有可恢复/可替换的协调对话，使用共享 Runtime、独立角色与严格工具白名单；通过项目管理和 Session 管理能力推进任务，设备操作交给工作 Session。

先与 #579/#580 owner 对齐输入、租约和工具授权实现，统一为一个 Host 权威，再接项目/任务/工作 Session 的持久绑定、派发、观察和结果反馈。支持单项目两个独立任务在隔离目录执行；共享写目录受 Host 串行/ownership 约束。模型、Prompt、工具及上下文按角色/任务装配，不让 Coordinator 的禁用执行工具限制误伤工作 Session，也不让间接调用绕过限制。

**交付：**用户给项目任务 → Coordinator 派发工作 Session → 获得真实进度/阻塞/结果并回复；重复输入、取消和重启能按现有 Run/receipt 对账。给出集成 PR、源码归属和用户测试入口。第一版不引入个人 Bot、通用 planner、全自动拆任务或新执行引擎。

## 任务二：完成项目长期状态与记忆连续性

请在任务一稳定的 projectId/Task/Session 合同上，完成项目长期连续性。区分可查询的当前任务/决策/绑定、带来源和版本的项目记忆、既有对话原文；复用 data、memory、transcript，不将全部历史堆成一个 Prompt 或第二份状态库。

让 Coordinator 和新工作 Session 获得与任务相关的当前项目背景；工作产出可形成有来源的记忆候选，用户纠正可更新或废止旧结论。重启 Host、压缩或替换协调对话后，仍能找回未完工作、正确解释当前决定并继续。项目之间及个人 Bot 私有记忆保持作用域边界。

**交付：**重新打开项目或新建协调对话，能根据可追溯记录回答“上次决定了什么、现在做到哪里、下一步是什么”，并继续原工作。任务完成以验收事实判断，Run 结束和模型总结不冒充验收。无需第一版就建设全自动知识提取/反思平台。

## 任务三：完成 Desktop 项目工作台与用户协作

请将上述能力接成 Desktop 的核心使用路径：项目入口、中央 Coordinator 对话、可查看的工作 Session/任务/Activity。复用共享 UI/client-core 和真实 Host API；先用最少界面完成工作，不把个人 Bot 页面改名冒充 Coordinator。

支持用户从项目进入原工作 Session查看和直接协作，再回到项目继续协调。只读不取得调度权；接管后 Coordinator 暂缓该 Session 的新指令，在途工具继续，交还后对账恢复，其他任务可继续。相同状态由同一服务投影，避免 UI 另存一份项目进度。

**交付：**在真实 Desktop/Host/Worker 链路里完成“项目对话 → 两个工作 Session → 用户介入一个 → 结果回项目 → 重启后继续”。用户负责产品测试，Agent 负责可运行交付、必要构建/门禁、测试步骤及反馈修复；不另扩建测试项目，不把 Web/多机/自动 merge 加进本轮。

## 依赖、验收与后续

任务一先冻结共享合同并交可运行路径；任务二、三可据该合同准备，最终在同一集成版本完成上述场景。若仍是一个 Agent 接续，按一 → 二 → 三推进。共享 protocol、data migration 和 Host bootstrap 只有一个集成 owner，其他 Agent 独立 worktree，先对齐再修改。

- [ ] 一：项目协调与 Session 派发/反馈已实现；唯一输入/租约权威和工具限制已接通。
- [ ] 二：项目状态/记忆/历史分工落地；换协调对话与重启后能继续。
- [ ] 三：Desktop 实际产品流程可交用户验收；通过范围与未通过反馈分别记录。

个人 Bot 工具集和主动性暂缓。原 [#562](https://github.com/lava-chen/duya/pull/562) 只保留 CLI 独立收尾交付，不再作为总体架构入口；旧 Bot-first 文档不覆盖本决策，集成 #562 时必须保留此优先级。Project 首个闭环完成后再排 Session 增强/CLI Release 和后续 Bot。

## 本轮证据与接续

已读用户讨论全文；只读核对主干 Project/Task/记忆/包依赖及 #579 `5057f201`、#580 `88efd64b`。本轮设计 owner 独占本计划、新架构决策与相关导航/旧设计提示；未改产品代码、DB、授权配置或发布状态，产品测试沿用用户负责的安排。

managed worktree/context 工具未提供，使用 Git linked worktree 和版本化计划对账。Linux 上 7 份文档的 UTF-8、178 条链接目标与 Git 可见性、git diff --check 通过；无新增断链，旧索引 1 条缺失目标保留。未运行产品测试；PR 保留待 review/集成。下一动作：认领任务一，从 #579/#580 的单一输入/租约权威与 Coordinator 角色接线开始，不再先扩张个人 Bot 工具集。
