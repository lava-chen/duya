# Project Coordinator：项目对话、执行协调与长期记忆

状态：active，核心基础设施实现中 · owner：Codex · 更新：2026-11-02。
实现分支：`codex/project-coordinator` · base：master `af4aaede`。

## 目标与边界

Project Coordinator 是当前产品主线：用户进入项目与项目 Agent 长期对话，由它组织工作 Session，记住项目决定、进度与下一步。Personal Bot 暂缓增强；CLI/TUI 保持独立使用，后续增强/Release 不再排在 Project 前面。只修项目闭环所需的 Session 基础，不先完成全部底层迁移。

本页只保留三个总体任务，每项可整体交给一个 Agent。产品角色、包归属和状态权威以 [Project-first 架构决策](../../design-docs/project-first-architecture.md)为准。实现交接索引见 [Coordinator implementation handoff](../../design-docs/project-coordinator-implementation-handoff.md)。

实施前共同读取：[Claude 官方/逆向调研与工具映射](../../references/claude-projects-coordinator.md) → [首版实施合同](../../design-docs/project-coordinator-contract.md)。工具面、工作身份、事件回路和记忆接缝已给出统一语义；实现者对照现有 DTO 做最小适配并记录裁定，不再各自猜测 Claude 的 63 个工具。

## 开工前已核对的接缝

快照：2026-11-02，master `af4aaede`；#579/#580 均为未合并 PR。本分支集成 #580 的 `session_inputs`/`session_control_leases` 权威及工具授权/子会话恢复修复；#579 的旧 mailbox/Session-extension 回执与租约实现不引入，后续只择取其 Session MCP 表面适配 Host 权威。

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

先与 #579/#580 owner 对齐输入、租约和工具授权实现，统一为一个 Host 权威；按实施合同接 project_* 管理能力及既有 session_*，建立稳定工作身份与 Session/Run 绑定。完成关键结果/阻塞的持久反馈和 Coordinator 唤醒，不停在手工 get 轮询。支持就地回答、复用已有工作与两个隔离任务并行；共享写目录受 Host 串行/ownership 约束。模型、Prompt、工具及上下文按角色/任务装配，不让 Coordinator 的窄白名单误伤工作 Session，也不让间接调用绕过限制。

**交付：**用户给项目任务 → Coordinator 派发工作 Session → 获得真实进度/阻塞/结果并回复；重复输入、取消和重启能按现有 Run/receipt 对账。给出集成 PR、源码归属和用户测试入口。第一版不引入个人 Bot、通用 planner、全自动拆任务或新执行引擎。

## 任务二：完成项目长期状态与记忆连续性

请在任务一稳定的 projectId/Task/Session 合同上，完成项目长期连续性。区分可查询的当前任务/决策/绑定、带来源和版本的项目记忆、既有对话原文；复用 data、memory、transcript，不将全部历史堆成一个 Prompt 或第二份状态库。

按实施合同完成 project_memory_read/update、预算内索引与按需正文、近期消息/工作/Activity 装配，让 Coordinator 和新工作 Session 显式获得项目背景。特别覆盖本机执行，不能假定 Session 自动继承项目记忆。工作产出可形成有来源的记忆候选，用户纠正可更新或废止旧结论。重启 Host、压缩或替换协调对话后，仍能找回未完工作、正确解释当前决定并继续。项目之间及个人 Bot 私有记忆保持作用域边界。

**交付：**重新打开项目或新建协调对话，能根据可追溯记录回答“上次决定了什么、现在做到哪里、下一步是什么”，并继续原工作。任务完成以验收事实判断，Run 结束和模型总结不冒充验收。无需第一版就建设全自动知识提取/反思平台。

## 任务三：完成 Desktop 项目工作台与用户协作

请将上述能力接成 Desktop 的核心使用路径：项目入口、中央 Coordinator 对话、可查看的工作 Session/任务/Activity。复用共享 UI/client-core 和真实 Host API；先用最少界面完成工作，不把个人 Bot 页面改名冒充 Coordinator。

按实施合同展示稳定工作话题及其 Session/Run，区分进行中、需用户输入、待验收与已完成。支持用户进入原工作 Session 查看和直接协作，再回到项目继续协调。只读不取得调度权；接管后 Coordinator 暂缓该 Session 的新指令，在途工具继续，交还后对账恢复，其他任务可继续。审批回答落到实际 Run/请求，主对话一句“可以”不代答另一工作 Session。普通回复使用既有单一消息投影，相同状态由同一服务投影。

**交付：**在真实 Desktop/Host/Worker 链路里完成“项目对话 → 两个工作 Session → 用户介入一个 → 结果回项目 → 重启后继续”。用户负责产品测试，Agent 负责可运行交付、必要构建/门禁、测试步骤及反馈修复；不另扩建测试项目，不把 Web/多机/自动 merge 加进本轮。

## 依赖、验收与后续

任务一先冻结共享合同并交可运行路径；任务二、三可据该合同准备，最终在同一集成版本完成上述场景。若仍是一个 Agent 接续，按一 → 二 → 三推进。共享 protocol、data migration 和 Host bootstrap 只有一个集成 owner，其他 Agent 独立 worktree，先对齐再修改。

- [ ] 一：项目协调与 Session 派发/反馈已实现；唯一输入/租约权威和工具限制已接通。
- [x] 二：项目状态/记忆/历史分工落地；换协调对话与重启后能继续（Host/Data/API 与新 Worker 上下文装配已实现；Desktop 展示操作属于任务三）。
- [ ] 三：Desktop 实际产品流程可交用户验收；通过范围与未通过反馈分别记录。

个人 Bot 工具集和主动性暂缓。原 [#562](https://github.com/lava-chen/duya/pull/562) 只保留 CLI 独立收尾交付，不再作为总体架构入口；旧 Bot-first 文档不覆盖本决策，集成 #562 时必须保留此优先级。Project 首个闭环完成后再排 Session 增强/CLI Release 和后续 Bot。

## 本轮证据与接续

### PR #582 review 修复（2026-11-02）

Owner：当前 Codex；独立 worktree：`/workspace/work/review-582`；分支：`codex/fix-pr-582`；修复 base：`caa1f9f3`。共享 workspace 工具不可用，已按 Git/PR 对账；不修改其他检出。

1. 验证最新提交中的迁移编号和 bundle 修复，并补已有数据库升级回归。
2. 将 Desktop Session 管理接入共享 Host 派工服务，统一 Task 绑定、工作角色和启动结果。
3. 修复派工失败后的 Task 状态，运行相关回归、类型/架构门禁和 Electron 构建，再更新原 PR。

已实现：保留 `caa1f9f3` 的 61–63 迁移，新增 v48/v50 升级、重启和外键删除回归；Desktop Coordinator 的六项 Session 管理动作经受信 caller 接共享 Host 服务，规范 Task 绑定在启动前落库，工作 Run 显式传递 `code-expert`；Task 仅在 Run 启动成功后进入 `in_progress`。普通 Desktop Session 的原通知路径保留。Host 服务增加正式子路径导出；Worker bundle 已从本检出重建。

验证环境：Linux、Node `24.19.0`，base `caa1f9f3` 加本节修复路径；本地第三方依赖只读复用，Electron/SQLite 使用独立副本，未修改共享检出。

- 相关 13 个测试文件共 142 项通过：Host Session/Project/input API，CoreDataHost 升级，Desktop DB bridge/执行适配器，ProjectStore/ProjectService，Run/Workspace migration rehearsal。
- `npm run typecheck:all`、`npm run architecture:check`、`NODE_USE_ENV_PROXY=1 npm run electron:build`、`npm run check:packaged-artifacts:bundle` 均退出 0；Electron 类型门禁无新增错误，178 项既有错误仍在 baseline。
- 非生成文件 `git diff --check` 通过；生成 bundle 保留原提示词模板中的 Markdown 行尾空格，未手工修改生成内容。代码提交 `8aa55c1c` 后 `npm run bundle:verify` 退出 0，1029 项输入全部 FRESH，工作区干净。

交付：代码提交 `8aa55c1c` 和本节验证记录推送到原 PR #582；远端 CI 待该 head 完成。原 PR 保持 Draft，不合并；产品真机验收由用户负责。本轮未实现项目记忆、Task/activity UI 或显式任务验收。

本轮从 master `af4aaede` 开始实现：集成 #580 PR head（`7bea4bd1`），添加项目协调 Session 与 Project/Task/工作 Session 的 Core DB 关系及 Host HTTP API。现有 `TaskStore` 仍为任务内容/状态唯一权威，`project_task_sessions` 仅持有关系；Session 工具的 Coordinator 派发由 Host 从受信 caller Session 解析 Project、创建规范 Task 并绑定工作 Session。输入/回执/控制租约采用 #580 的两张表；没有 #579 的并行 receipt/lease 写路径。隐藏 Coordinator profile 由 Host 强制 `session`/`todo` 白名单；子 Session 切换到 `code-expert`，不继承管理限制。项目新对话绑定/复用协调 Session。项目记忆 scope、Task/activity 工作台与显式验收/完成对账仍待完成。

下一动作：接入项目记忆 scope 和 Task/activity UI，并实现基于可审阅结果的显式 Task 完成/验收；Run 终态不可自动冒充 Task 完成。个人 Bot 增强和独立 CLI Release 仍按本计划暂缓。

### 调研补充（2026-11-02）

调研补充（2026-11-02）：已直接阅读官方新版 Projects/发布、旧版 Projects 区分、本地记忆文档及逆向原文，新增来源分级、20 个已点名工具、Duya 首版工具字段/状态/反馈/记忆合同；它们是执行依据，不是 Coordinator 已实现的证据。7 份调研变更文档的 UTF-8、98 条链接目标/Git 可见性及 diff 检查通过，20 个工具名逐项在下载原文中核对；未运行产品测试。下载与原始摘录留 ignored docs-local，版本化文档不依赖本机资料。

managed worktree/context 工具未提供，使用 Git linked worktree 和版本化计划对账。首次设计提交 c886184e 在 Linux 上检查 7 份文档的 UTF-8、178 条链接目标/Git 可见性和 git diff --check；无新增断链，旧索引 1 条缺失目标保留。后续调研检查范围见上段。PR 保留待 review/集成。下一动作：认领任务一，按首版实施合同收敛 #579/#580 的单一输入/租约权威并接通 Coordinator，不再重复探索外部工具清单或先扩张个人 Bot 工具集。
### 连续性切片（2026-11-02）

2026-11-02 连续性切片（基于任务一 HostProjectApiV1）新增 Core DB 的版本化项目状态、决策、记忆候选/历史、Task 验收记录与 Activity；Host 提供分页快照、历史查询和预算受限上下文接口，并在项目 Session 的新 Worker 初始化时装配当前记录。当前 Task 状态仍只来自既有 TaskStore，删除 Coordinator Session 时会保留项目绑定 Task；Transcript 只由 MessageLog 提供引用。候选不会注入 Coordinator；只有用户确认的记忆和决策进入上下文。

下一动作：任务三接入 Project continuity HTTP/Host client 接口，展示 Task/Activity/transcript refs，提供 Task 验收与记忆候选确认/纠正操作，并覆盖失败 child start 对账。个人 Bot 增强和独立 CLI Release 仍按本计划暂缓。

### 运行结果自动回传切片（2026-11-02）

Owner：当前 Codex；独立 worktree：`E:\Projects\duya\.claude\worktrees\project-run-feedback`；分支：`codex/project-run-feedback`；base：`codex/project-memory-continuity` `27a4a5a8`（#583 head）；代码提交：`dd7a095d`。本切片只补 #584 已承认的缺口：工作 Session 完成后，结果自动进入 Project Activity 并唤醒 Coordinator，不扩张 UI，也不自动验收 Task。

已实现：共享 `packages/host/src/project-run-settlement.ts` 把 Run 终态写成唯一 `run.terminal` Activity（迁移 65 的 `(project_id, source_id)` 局部唯一索引 + `appendActivityOnce`），并按 `clientMsgId = project-run-terminal:<runId>` 向协调 Session 落一条 durable `background_notification`；Activity 已存在但通知缺失时仍补写。独立 Host 由 `HostRunExecutionControllerOptions.onRunSettled` 直接结算；Desktop 由 Agent Server 在终态 durable 后经 IPC 通知 Main，Main 复用 `mail:created` 与 `wake.idleDispatch` 两条既有唤醒路径。启动时两端都做幂等对账：每个工作 Session 只补最近 72 小时内最新终态 Run，跳过已验收/已驳回 Task，且只有真正补写记录或通知才计为恢复。通知摘要取最近 24 个 `assistant.text_block`，总长上限 4000 字符；失败使用 `error_json`；`budget_exhausted`/`cancelled` 明确说明。通知正文明确 Task 尚未验收，Run 终态不改变 acceptance。

已知边界：渲染层无监听时（启动对账早于窗口）通知保持 pending，由 Coordinator 下一轮领取；独立 Host 没有 idle dispatcher，同样下一轮领取；两者都依赖已落库的通知，不丢结果。

验证环境：Windows、Node `v24.16.0`；未修改共享检出。

- 相关 8 个测试文件 65 项通过：`project-run-settlement`（11，含真实迁移重放与幂等）、`project-store`（11）、`local-host`、`project-api-http`、`project-work-session-continuity`、`run-execution`、`run-execution-turn-contract`、`session-service`。
- `npm run typecheck:all`、`npm run architecture:check`、`npm run electron:build`、`npm run check:packaged-artifacts:bundle` 均退出 0；架构门禁无新增违规。首次 Electron 构建与测试并发时 V8 OOM，单独重跑退出 0。
- 提交 `dd7a095d` 后 `npm run bundle:verify` 退出 0，1050 项输入全部 FRESH，工作区干净。`git diff --check` 仅剩两类已知例外：仓库本就以 CRLF 入库的 `agent-server-lifecycle.ts`，以及生成 bundle 中原样保留的模板空白。
- `git show --stat dd7a095d`：14 文件，+1203/−193；含重建的 `packages/host/bundle`。

下一动作：推送 `codex/project-run-feedback` 并以 `codex/project-memory-continuity` 为 base 开 stacked PR，不合并。之后先做 Coordinator 领域收敛（`packages/host/src/project/`：profile/policy、Task→Session 派发端口、上下文装配、结果对账；独立 project prompt 目录），让通用 `session-service` 不再判断具体产品身份；再统一重整 #583/#584 依赖。个人 Bot 增强和独立 CLI Release 仍按本计划暂缓。
