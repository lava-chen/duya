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
- [x] 二：项目状态/记忆/历史分工落地；换协调对话与重启后能继续（Host/Data/API 与按需上下文读取已实现；完整注入与 Desktop 交互归任务三后续）。
- [x] 三（Desktop 项目工作台切片，已接线可验收）：统一项目状态读取、协调对话、工作 Session/任务/进度、只读查看、用户接管与交还；「结果回项目」的活动流与 Coordinator 唤醒由 #585 补齐。
- [ ] 三：完整产品流程交用户验收（含 Task 显式验收、记忆候选确认/纠正）；通过范围与未通过反馈分别记录。

个人 Bot 工具集和主动性暂缓。原 [#562](https://github.com/lava-chen/duya/pull/562) 只保留 CLI 独立收尾交付，不再作为总体架构入口；旧 Bot-first 文档不覆盖本决策，集成 #562 时必须保留此优先级。Project 首个闭环完成后再排 Session 增强/CLI Release 和后续 Bot。

## 任务三切片：Desktop 项目工作台（2026-11-02）

分支 `codex/project-first-desktop`，base `codex/project-tools`（#587 head；当前栈为 #583 ← #585 ← #586 ← #587），worktree `.claude/worktrees/project-first-desktop`。原始切片基于 #582（`3d714eba`）；2026-11-02 先 rebase 到 `codex/coordinator-seam` `f1d81f61`，2026-11-03 再 rebase 到项目工具切片（见文末「#584 二次 rebase」）。

#582 已交付 Coordinator 侧：受限协调对话、派发时创建规范 Task 并绑定工作 Session。本切片补上**桌面端的项目工作台**——把这些关系变成用户能看见、能进入、能接管的东西。

**已接线（真实数据，无 mock）**

| 能力 | 位置 |
| --- | --- |
| 统一项目状态 | `HostProjectApiV1.getProjectState` → `GET /v1/projects/:id/state`；项目、协调 Session、任务、工作 Session 一次读出 |
| 协调对话 | `projects:coordinator:ensure`：经 Host Session API 建 Session 并绑定 `coordinator_session_id`；失效绑定会被替换 |
| 工作 Session 进度 | `projects:workSessionStatus`：读 Agent Server 的 `/sessions/:id/status`（运行中/空闲/完成/出错） |
| 用户接管与交还 | `session:control:lease:*` → #580 的 `session_control_leases`；租约由 Host 持有，界面只是询问 |
| 接管真的拦得住 | Desktop Agent Server 的 interagent router 读租约：用户持有时，协调对话对该 Session 的新指令被拒（`control_lease_held`，并写明持有人），在途工具继续 |
| Desktop 界面 | `ProjectWorkspaceView`（中间协调对话 + 右侧任务/工作 Session/进度）、`ProjectSessionBanner`（只读/接管/交还/返回项目）、`ProjectsView` 的「进入项目」入口 |

**未在本切片内**

- 「结果回项目」的活动流与 Coordinator 唤醒：工作 Session 跑完的结果目前仍在 Session 管理面里，没有回到项目视图。这是本切片之后最直接的下一步。
- Task 的显式验收/完成对账、项目记忆 scope（任务二）、Web/多机/自动 merge。

**下一步**：补活动流与唤醒后，工作 Session 的完成状态可以自己出现在项目里，用户不必手动刷新。

### Desktop 项目工作台切片验证（2026-11-02）

Owner：当前 Codex；worktree `E:\Projects\duya\.claude\worktrees\project-first-desktop`；分支 `codex/project-first-desktop`；base `origin/codex/project-coordinator` = `3d714eba`（#582 head，已 rebase 到该 head）；提交 `99cbd01e`；交付 PR [#584](https://github.com/lava-chen/duya/pull/584)（OPEN / MERGEABLE / CLEAN，base = `codex/project-coordinator`，**#582 必须先落地**）。

环境：Windows 11、Node `v24.16.0`、git `2.50.0`；`NODE_OPTIONS=--max-old-space-size=12288`；依赖为共享 junction，只在 worktree 内编辑与构建。

- `npm run typecheck:all` 退出 0（含 22 个包构建、protocol/client-core/core/workflow/runtime/web/electron/cli/voice/evals 全量类型门禁；Electron 门禁报告「no new type errors (178 known across 101 key(s))」，既有 baseline 未增加）。
- `npm run architecture:check` 退出 0：3051 项全部落在既有 baseline，「OK — no new boundary violations」。
- `npm run bundle:verify` 退出 0：`0/1029 bundle inputs changed`，FRESH。Worker bundle 已从本检出重建并与源码同一提交。
- 全量 `npx vitest run --maxWorkers=2`：**1347 个测试文件通过 / 3 跳过，14728 个用例通过 / 30 跳过**，退出 0，耗时 637.71s。
- `npm run electron:build` 退出 0：「Electron build complete」，原生模块（better-sqlite3 / bindings / file-uri-to-path / node-pty）已拷入产物；main/preload/renderer 产物来自本检出。

  这条门禁在本机曾连续失败多次（Go 的 `runtime: cannot allocate memory` 与 V8 的 `Zone Allocation failed`）。根因是**V8 与 esbuild 的 Go 堆在抢同一份提交额度**：只给 V8 调 `--max-old-space-size` 无效，因为 esbuild 的 Go 运行时仍申请不到内存。可用的组合是给 V8 足量堆、同时压住 Go 堆：

  ```
  NODE_OPTIONS=--max-old-space-size=6144 GOMEMLIMIT=900MiB GOGC=30 npm run electron:build
  ```

  `NODE_OPTIONS` 对 V8 有效，`GOMEMLIMIT`/`GOGC` 对 esbuild 的 Go 运行时有效；两者分开调不会有这个组合。

过程中的一次真实失败与修复：rebase 到 #582 新 head 后，链接表新增 `ON DELETE CASCADE`（任务行删除时绑定随之删除），本切片原先「任务行没了仍报绑定」的断言不再成立。已改为两个用例——新库级联后项目不再列出该任务；旧库（无该外键）仍如实报出 `status: 'unknown'`。Host 侧保留 `unknown` 分支并在注释里写明它只对早于该外键的数据库可达。

未验证：产品真机体验（进入项目、接管、交还、返回项目）由用户验收；「结果回项目」的活动流与唤醒尚未实现。

接续：分支与 worktree 保留（PR 未集成，按仓库规则不回收）。**门禁已全绿**（typecheck:all / architecture:check / bundle:verify / 全量 vitest / electron:build 全部退出 0）。堆叠 PR 拿不到 CI（仓库 workflow 只监听 base=`master`），门禁以本节记录为准。下一条动作：#582 落地后把本 PR 的 base 改到 `master` 并触发一次 CI，再补「结果回项目」的活动流与 Coordinator 唤醒。

### PR #584 集成就绪（2026-11-02）

#582 已合入 master（merge commit `04f7645f`，远端分支已删），PR [#584](https://github.com/lava-chen/duya/pull/584) 的 base 随之改为 `master`。本分支的 base `3d714eba` 已是新 master 的祖先，`git diff origin/master...HEAD` 恰好是本切片的 37 个文件 —— 不需要再 rebase。

CI 首次真正跑起来（base 是 `master` 才会触发），在提交 `ea36480e` 上全绿：architecture 1m48s（含 bundle:verify）、build 3m25s、test 11m29s、typecheck 7m44s、test scope 13s，全部 pass，`mergeStateStatus: CLEAN`。

因此本切片的两道人工关卡——统一状态读取、接管/交还的真实拦截——既有本地门禁（14728 个用例）也有 CI 复核。产品真机验收仍由用户负责。

### #584 依赖重整（2026-11-02）

Owner：当前 Codex；独立 worktree：`E:\Projects\duya\.claude\worktrees\project-first-desktop`；分支：`codex/project-first-desktop`；rebase base：`codex/coordinator-seam` `f1d81f61`（#586 head）。本轮把 #584 从「直接基于 #582、等待 master」改为显式依赖完整栈：#583（项目记忆/连续性）→ #585（Run 结果回传）→ #586（Coordinator 领域收敛）→ #584（Desktop 工作台）。

过程与修复：

- `git rebase f1d81f61` 后逐个解决冲突：`project-api.ts` 保留连续性 API 与项目状态投影/工作 Session 归并；`agent-protocol/projects.ts` 与 `http-client.ts` 同时保留连续性方法和 `getProjectState`；`desktop-host-api.ts` 合并 `createHostTaskApi` 的项目参数、`createHostProjectApi` 的 Session scope 与 `sessionInputApi`；`packages/host/package.json` 同时保留 `project-run-settlement`、`project/*` 与 `session-input-api` 导出；docs 合并栈内新证据。
- 原 #584 head 的 `project-coordinator-implementation-handoff.md` 自带未解决的冲突标记（此前 rebase 遗留）。本轮按当前事实重写「Remaining integration」：Task 显式验收和记忆候选确认仍待完成；Desktop 工作台、结果回项目、Coordinator 领域收敛标记为已完成。
- 合并后发现连续性路由的 `(continuity|context|state)` 正则先拦截了 `GET /projects/:id/state` 并返回 405。修复为在同一路由块内处理 GET 读取，删除重复的 `stateMatch` 分支；`project-state-http` 的缺项目读取用例恢复通过。

验证环境：Windows、Node `v24.18.0`；未修改共享检出。

- 相关 17 个测试文件 140 项通过：Host `project-state-http`、`project-api-http`、`project-run-settlement`、`project-work-session-continuity`、`project-dispatch`、`project-domain-boundary`、`project-prompt`、worker profiles、`session-service`、`session-entry-guards`、`local-host`；Desktop `interagent-router`、`project-workspace-handlers`、`desktop-session-management`；UI `ProjectWorkPanel`、`project-workspace-store`、`nav-history-store`。
- `npm run build:packages`、`npm run typecheck:all`、`npm run architecture:check`、`npm run bundle:worker`、`NODE_USE_ENV_PROXY=1 NODE_OPTIONS=--max-old-space-size=8192 npm run electron:build` 均退出 0；架构门禁 3081 项全部 tolerated，无新增违规。
- rebase 后代码提交 `806dce4e`，路由修复提交 `fd44beca`；提交后重跑 `npm run bundle:verify` 应为 FRESH，重建的 `packages/host/bundle` 随修复提交入库。

已知边界：PR base 非 `master`，仓库 CI 不会触发（`test.yml` 仅监听 base=`master`）；本栈的验证以本节命令结果为准。集成顺序必须为 #583 → #585 → #586 → #584，任一 PR 未合入前 #584 不单独合并。产品真机验收仍由用户负责。

下一动作：把 #584 的 base 改为 `codex/coordinator-seam`，以 `--force-with-lease` 推送本节提交；栈稳定后再统一改 base 到 `master` 触发 CI。

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

### CI 门禁修复（2026-11-03）

Owner：当前 Codex；worktree：`E:\Projects\duya\.claude\worktrees\project-run-feedback`；分支：`codex/project-run-feedback`；base：`master`（#583 已以 `bae0896e` 合入）。首个 CI run（41572058161）的 `test` 报 4 个失败文件，其中 3 个是 rebase 后才暴露的全局门禁，1 个是既有慢测试超时。

- `slice-classification`：`apps/desktop/src/main/projects/run-feedback.ts` 未被分类。新增该前缀到 `cp-durable`（Desktop 侧的结算胶水，写 durable activity 与唯一协调邮箱行），并按规则重录 `RULE_TABLE_FINGERPRINT`（仅此一条规则移动），提交 `dfab3147`。
- `package-boundary`：`@duya/memory` 新增私有模块 `project-continuity` 未在断言列表中，补入，提交 `06643bbf`。
- `13-citation-drift`：rebase 使 `router.ts` 整体后移 19 行，5 处引用失准；只改行号，锚点文本不变，提交 `bc67ea21`。
- `PanelMoreMenu`：第 4 个等待 `listSurfaces` 的用例漏了 `SLOW_CATALOGUE_TIMEOUT_MS`，CI 在 30 s 默认值上超时；补同一截止时间，断言不变，提交 `4fb3f608`。
- 引用改动落在 worker bundle 输入闭包内，重建并提交 `be463e55`；`npm run bundle:verify` 随后 FRESH 0/1050。

验证环境：Windows、Node `v24.16.0`，在本 worktree 执行。`npm run typecheck:all` 退出 0（Electron 门禁 178 项既有错误、无新增）；`npm run architecture:check` 退出 0（3073 项容忍，无新增违规）；三个门禁测试分别 30/6/5 项通过；`PanelMoreMenu` 7 项通过（158 s）。工作区干净，5 个提交待推送。

下一动作：推送本分支触发 CI；CI 绿后按仓库交付规则以 merge commit 合入 `master`，再把下一层 PR 的 base 改到 `master`、重新触发并验证。

### Coordinator 领域收敛切片（2026-11-02）

Owner：当前 Codex；独立 worktree：`E:\Projects\duya\.claude\worktrees\coordinator-seam`；分支：`codex/coordinator-seam`；base：`codex/project-run-feedback` `91db906e`（#585 head）。本切片只冻结 Coordinator 的产品身份、派发规则和提示词归属，不重构全仓、不改 Runner/协议、不扩张 UI。

已实现：`packages/host/src/project/identity.ts` 单点定义协调者 profile id、工作 Session profile、工具白名单、Task 字段上限、身份提示与 `isProjectCoordinatorProfile`；`packages/host/src/project/dispatch.ts` 以 `ProjectDispatchPort` 收敛派发规则（两段式：`planDispatch` 只读校验角色/Task/项目绑定，`createTask` 在 workspace 校验后落库），并提供归属授权 `authorizesWorkSession`、可管理 Session 列表 `listWorkSessionIds`、工作角色映射 `workSessionProfileId`。通用 `session-service.ts` 只依赖端口，不再出现 `project-coordinator`/`code-expert`/`projectCoordination` 字面量（新增源码边界测试守住）；`local-host.ts` 与 Desktop `desktop-session-management.ts` 都装配真实端口；`db-bridge.ts` 改用身份谓词。协调者 profile 改用身份常量，并新增独立 `project` 提示系统（`configs/project.ts` + `assets/project/delegation.hbs`、`reporting.hbs`），不再回落 `general`；身份文本仍由运行时以 `host:identity` 前置，提示系统只负责派发/汇报契约。`@duya/host/package.json` 增加 `./project/*` 子路径导出。

已知边界：`project-api.ts` 的 HTTP Task 管理、项目上下文装配与结果对账仍在各自模块，留给后续切片；本切片未改 #583 的记忆链路，也未合并任何 PR；`#585` 与本 PR 均保持 Draft，真机验收由用户负责。

验证环境：Windows、Node `v24.18.0`；未修改共享检出。

- 相关 Host/Desktop 7 个测试文件 67 项通过：`project-dispatch`（9）、`project-domain-boundary`（1）、`project-prompt`（2）、`worker-profiles/types`、`project-work-session-continuity`、Desktop `desktop-session-management`（5）、session/project 回归（`session-service`、`session-entry-guards`、`local-host`、`project-api-http`、`project-run-settlement`）。
- `npm run build:packages`、`npm run typecheck:all`、`npm run architecture:check`、`npm run bundle:worker`、`npm run check:packaged-artifacts:bundle`、`NODE_USE_ENV_PROXY=1 NODE_OPTIONS=--max-old-space-size=8192 npm run electron:build` 均退出 0；Electron 类型门禁 178 项既有错误仍在 baseline，架构门禁 3069 项 tolerated，无新增违规。
- 提交后重跑 `npm run bundle:verify` 应为 FRESH（1053 项输入）；重建的 `packages/host/bundle` 随本提交入库。

交付：代码提交 `f1d81f61` 推送到 `codex/coordinator-seam`，并以 `codex/project-run-feedback` 为 base 开 stacked Draft PR [#586](https://github.com/lava-chen/duya/pull/586)；`bundle:verify` 提交后为 FRESH（0/1053）。PR base 非 `master`，仓库 CI 不会触发（`test.yml` 仅监听 base=`master`），验证以本节记录为准，不合并。

下一动作：统一重整 #583/#584 依赖（已把 #584 rebase 到本切片 head 并改 base 到 `codex/coordinator-seam`，见该计划）；栈稳定后再把项目上下文装配、HTTP Task 管理与结果对账并入领域层，并统一改 base 到 `master` 触发 CI。个人 Bot 增强和独立 CLI Release 仍按本计划暂缓。

### Coordinator 项目工具与提示词系统切片（2026-11-03）

Owner：当前 Codex；独立 worktree：`E:\Projects\duya\.claude\worktrees\project-tools`；分支：`codex/project-tools`；base：`codex/coordinator-seam` `c809ad69`（#586 head）；代码提交：`eedab8b0`。本切片补齐 Coordinator 真正可用的项目操作面，并把上下文装配、结果对账与提示词收进领域层；不改 Runner/协议、不扩张 UI、不合并。

已实现：`packages/capabilities/src/project/` 新增 `project` 工具（`get` / `context` / `update_state` / `record_decision` / `record_memory`），Host `packages/host/src/project/tool-service.ts` 从受信 caller 的 Coordinator 绑定解析项目，写操作以调用 Session 为 provenance，拒绝 `accepted` / `active` 等用户专属状态（`user_action_required`）与陈旧 revision（`revision_conflict`）。`project:tool` 经 standalone Host 的 worker DB bridge 和 Desktop `dispatchDbAction` 两个拓扑接通；Desktop 把 `project:tool`、`session:spawn*` 纳入 transport attempt 关联，caller 只取 `trustedAttempt` 或 transport 注册的 Session，不接受 worker payload 自报。`project-api.ts` 的预算上下文装配拆到 `project/context.ts`，Run 结果对账迁入 `project/reconciliation.ts` 并由 `./project/*` 导出。提示词侧 `configs/project.ts` 改为自包含组合（identity → system → operation → delegation → reporting → finalAnswer），新增 `project/identity.hbs`、`project/operation.hbs`；`AgentProfile.suppressIdentityBlock` 让运行时不再为 Coordinator 前置通用身份块；profile 白名单新增 `project`。

已知边界：Task 显式验收 UI、记忆候选审阅/纠正 UI 与“每次 Run 自动注入会话范围上下文”仍未实现；`project` 工具只服务当前绑定 Coordinator，其他 Session 被拒绝；栈 PR 的 base 非 `master`，仓库 CI 不触发（`test.yml` 仅监听 base=`master`），验证以本节记录为准；不合并。

验证环境：Windows、Node `v24.18.0`；未修改共享检出。

- 相关 27 个测试文件 173 项通过（project Host 全套、worker-prompts/profiles、local-host、session、Desktop project tool/trusted-attempt/session management）；worker DB bridge 13 个文件 65 项通过。
- `npm run typecheck:all`、`npm run architecture:check` 退出 0；架构门禁 3083 项 tolerated，无新增违规。
- 提交 `eedab8b0` 后 `npm run bundle:verify` 退出 0，1059 项输入全部 FRESH。
- `npm run electron:build` 单次执行未返回 0：首次 Vite 阶段 V8 zone OOM，重试在 rendering chunks 阶段报 Rollup `Cannot set property code`；随后 `npx vite build`（2m8s）、`node scripts/build-electron.mjs`、`node scripts/build-recorder-worker.mjs` 分别退出 0。重建期间 `bundle:worker` 产生的 bundle 字节差异和 `inline-content.ts` 行尾噪声已还原，bundle 输入仍 FRESH；该构建步骤的稳定性沿用仓库既有非确定性说明，不视为本切片代码失败。

交付：代码提交 `eedab8b0` 推送到 `codex/project-tools`，以 `codex/coordinator-seam` 为 base 开 stacked Draft PR；不合并。

下一动作：栈稳定后再统一改 base 到 `master` 触发 CI。仍不合并，等待用户授权。个人 Bot 增强和独立 CLI Release 仍按本计划暂缓。

### #584 二次 rebase 到项目工具切片（2026-11-03）

Owner：当前 Codex；独立 worktree：`E:\Projects\duya\.claude\worktrees\project-first-desktop`；分支：`codex/project-first-desktop`；新 base：`codex/project-tools` `a1e971b9`（#587 head）。把 Desktop 工作台从旧 seam head `f1d81f61` 整体 rebase 到项目工具切片，使 #584 同时获得 `c809ad69` 的 seam 记录、项目工具、上下文/对账领域化与独立提示词系统；上节「#584 依赖重整」记录的 base 与导出结论由本节取代。

冲突处理：`desktop-host-api.ts` 同时保留 `getDesktopProjectToolService` 与 `getDesktopHostSessionInputApi`；`local-host.ts` 复用单一 `projectApi` 实例并把 #584 的 `{ sessions, spawnEdges }` scope 传入构造；`packages/host/package.json` 保留 `./project/*` 与 `./session-input-api`，不恢复已迁入 `./project/*` 的 `./project-run-settlement`；生成 bundle 先取被应用提交的版本，rebase 完成后从合并源码重建（`a75feaae`）。

验证环境：Windows、Node `v24.18.0`；未修改共享检出。

- `npm run build:packages`：22 个包通过；首次在 `@duya/web` 写文件时报 Windows `UNKNOWN: unknown error, write`，重跑通过。
- `npm run typecheck:all` 退出 0；`npm run architecture:check` 退出 0（3095 项 tolerated，无新增违规）。
- 相关 32 个测试文件 239 项通过：项目 Host 全套（含 `project-state-http`）、worker-prompts/profiles、local-host/session、Desktop project tool/trusted-attempt/interagent/session management/workspace handlers、UI project workspace。
- `npm run bundle:verify` 退出 0：提交 `a75feaae` 后 0/1059 输入变化，FRESH。
- `npm run electron:build` 单次执行仍未返回 0：使用 `NODE_OPTIONS=--max-old-space-size=6144 GOMEMLIMIT=900MiB GOGC=30` 时，renderer 的 V8 worker 在 rendering chunks 阶段仍 OOM；随后 `NODE_OPTIONS=--max-old-space-size=8192 npx vite build`（1m47s）、`node scripts/build-electron.mjs`、`node scripts/build-recorder-worker.mjs` 分别退出 0，原生模块已拷入产物。bundle 已还原，输入保持 FRESH。

交付：`codex/project-first-desktop` 以 `--force-with-lease=13277f3e` 推送到 `19f36ced`；PR [#584](https://github.com/lava-chen/duya/pull/584) base 已改为 `codex/project-tools`（head `19f36ced`，Draft）；不合并。

下一动作：栈稳定后把整个栈统一改 base 到 `master` 触发 CI；仍等待用户授权后再合并。

### 栈 rebase 到最新 master 并准备集成（2026-11-03）

Owner：当前 Codex；各层沿用原有 worktree（`project-memory-continuity` / `project-run-feedback` / `coordinator-seam` / `project-tools` / `project-first-desktop`）。原因：`origin/master` 已从 `04f7645f` 前进到 `203d7d51`（20 个提交），#583 相对最新 master 显示 `CONFLICTING`，栈无法直接触发 master CI。

逐层用 `git rebase --onto` 重放，旧 head → 新 head：

- #583 `27a4a5a8` → `8d9f20d9`
- #585 `91db906e` → `2c394c50`
- #586 `c809ad69` → `75ca66e3`
- #587 `a1e971b9` → `aa99361a`
- #584 `1af340bc` → `b83b2acb`

冲突处理：`docs/exec-plans/README.md` 保留 master 新增的 TUI 行与新版 Coordinator 行；五层 bundle 冲突先取被重放提交的生成物，rebase 完成后从合并源码统一重建并单独提交；`apps/desktop/src/main/index.ts` 两侧改动区域不同，自动合并。`inline-content.ts` 的换行符 churn 每次构建后回退，不进入提交。

验证环境：Windows、Node `v24.18.0`；各层在自身 worktree 执行。本轮未重跑本地 `electron:build`（上一轮已在本栈旧 base 上分步构建通过）；最终栈的 Electron 构建交由 master PR CI 的 `build` job 验收。

- #583：`build:packages` 22 个通过；`typecheck:all` 退出 0；`architecture:check` 退出 0（3066 tolerated）；5 个相关测试文件 37 项通过；`bundle:verify` FRESH 0/1049。
- #585：`architecture:check` 退出 0（3073）；2 个测试文件 22 项通过；bundle FRESH 0/1050。
- #586：`architecture:check` 退出 0（3075）；4 个测试文件 22 项通过；bundle FRESH 0/1053。
- #587：`build:packages` 22 个通过；`architecture:check` 退出 0（3089）；9 个测试文件 62 项通过；bundle FRESH 0/1059。
- #584（完整栈）：`build:packages` 22 个通过；`typecheck:all` 退出 0；`architecture:check` 退出 0（3101 tolerated，无新增）；21 个相关测试文件 176 项通过；bundle FRESH 0/1059（`b83b2acb`）。

交付：五个分支分别以 `--force-with-lease` 推送；PR #583/#585/#586/#587/#584 仍为 Draft 栈。下一步：统一把 base 改到 `master` 触发 CI，CI 绿后按序以 merge commit 集成。

### 按序集成与二次 rebase（2026-11-03）

- #583 合入 `bae0896e`。#585 首个 master CI（41572058161）暴露三个全局门禁和一处慢测试超时，修复见上节；重跑 CI 41578794840 全绿后，head `23571bae` 合入 `af7c3b17`。
- 期间 master 连续前进（#589 `76343778`、#591 `8160f321`、直接提交 `dbffec07`），#585 两次以 `git rebase --onto origin/master` 重放并逐轮重建 bundle（`2de26c5c`、`23571bae`）。bundle 冲突只取生成物，最终一律从重放后的源码重建；`inline-content.ts` 的换行符 churn 每次构建后回退。
- #586 以 `--onto origin/master 2c394c50` 只重放自身提交，恢复被冲突覆盖的 CI 门禁记录，bundle 重建 `adf0456d`；CI 41580340985 全绿，合入 `550b664b`。
- #587 改 base 到 master 后以 `--onto origin/master adf0456d` 重放；CI 41581566287 因 `router.ts` 再后移 16 行触发 citation drift，补齐 5 处 router 引用和 `legacy/sse-event.ts` 锚点（`18787728`），bundle 重建 `92dad124`；CI 41583140279 全绿，合入 `a2675e4a`。
- #584 改 base 到 master 后以 `--onto origin/master 92dad124` 重放（无冲突），bundle 重建 `1cb857e6`，`bundle:verify` FRESH 0/1059；完整门禁交由本 PR 的 master CI 验收。

验证环境：Windows、Node `v24.16.0`。每次合并前确认最新 head 的 architecture / build / typecheck / test / test scope 全绿；本地每层 `bundle:verify` 均为 FRESH。

下一动作：#584 CI 绿后合并；随后在 master 上重跑类型与架构门禁、相关测试，记录最终 SHA，并回收各 worktree。
