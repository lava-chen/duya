# R4：PR 交付与任务内 Session 协作

状态：backlog · 负责人：待认领 · 更新：2026-11-01
规划环境见[总入口](../2026-11-01-bot-session-coordination.md)；实施时为 R4-A/R4-B 分别登记 branch / base / owner / 独占路径。
前置：[R3 绑定与派发](03-bot-coordination.md)；输入/控制合同使用 [R1](01-session-runtime.md)，配置查询使用 [R2](02-capability-context.md)。

## 目标与边界

Desktop 用户从 Project/Task 查看交付进展，进入 Bot 启动的同一个 Session 提局部要求。Bot 汇总 branch、PR、CI、review 与用户反馈，按项目 policy 请求审批或执行有授权的 merge，并保存外部证据。

分为可独立提交的 R4-A（VCS 交付）与 R4-B（界面/Attach），共用 Task/Session/Run binding。protocol、data migration、Host bootstrap 等共享路径按先合同后消费者的顺序合入，不让两条线分别定义状态库。

## R4-A：Branch / PR / 检查 / merge

主要修改 agent-protocol integration DTO、data IntegrationStore、Host integration/SCM adapter、Bot thread routing；Runtime 只报告本地执行事实，不拥有 GitHub IO 或项目 merge 决策。

### A1：事实关联与观察

- [ ] 复用计划 621 的 checkout、checkpoint、HostIntegrationApiV1、IntegrationStore 和 observer；补 Bot/Project/Task/Run/Host 关系。
- [ ] 保存 repository、实际工作目录、branch ref（可为空/detached）、head SHA、PR provider/ID/URL；checkpoint ref 不冒充 branch 名。
- [ ] 本地 Git adapter 对账 branch 创建/切换、commit/local merge；工具或模型文字仅作线索，已观察状态带来源。
- [ ] Hosted adapter 观察 PR/checks/review/comment/close/merge，明确哪些走 webhook、哪些走受限轮询/显式刷新。
- [ ] provider event/receipt 幂等持久化，包含关联 head SHA 与游标；离线或丢事件用 provider reconciliation 补齐。

### A2：反馈回路

- [ ] PR/Issue Thread subscription 关联原 Task/Session；后续评论/检查失败可唤醒负责的工作 Session或协调 Session。
- [ ] 来源身份与授权独立校验；外部评论不能单凭正文扩大工具/merge 权限。
- [ ] 用户接管时反馈先持久接收，Bot 对该 Session 的新指令等待交还；重复 webhook 不重复创建 Run。
- [ ] Task Activity 读取同一 integration projection，区分 Run 完成、等待 review、待合并、merge 已确认和消息已投递。

### A3：merge policy 与结果对账

- [ ] Project policy 提供 observe_only、approval_required、auto_merge；默认 approval_required，记录授权主体/范围/版本。
- [ ] 检查/审批绑定预期 head SHA、目标分支、merge 方法和策略版本；head 更新后重验 checks/review/批准有效性。
- [ ] 通过 provider adapter 携带 expected head 或等价并发前提执行 merge，遵循分支保护；无法保证前提时明确拒绝或要求重读。
- [ ] 保存 provider 给出的 merge 方法、PR head、merge commit SHA/时间及来源；不同 merge 方法的 commit 含义按 provider 对账。
- [ ] 外部调用超时先查询 PR/provider 事实；已合并则补回执，未确认则 unknown，不能盲重试或声称 merge 成功。

## R4-B：Desktop 任务工作台与 Session Attach

主要修改 client-core、ui、Desktop/Web 客户端、Plugin App Host 适配与必要的 TUI 调用；沿用 R1 单一输入/控制权威和 R2 配置查询。

### B1：Bot / Project / Task 主路径

- [ ] 顶层导航和默认视图管理 Bot、Project、Task、审批和 Activity；从任务详情显示 endpoint/Host/cwd、Session、Run 和交付引用。
- [ ] 把既有 Session checkout/integration 数据放到 Project 汇总与任务详情；复用 Host query/sync，不建立平行 Activity 存储。
- [ ] 提供任务内只读状态/历史观察，不因打开面板就抢占 Bot；用户选择“进入协作”后获取控制租约。
- [ ] 显示当前收件人、待处理输入、权限/能力及上下文来源；UI 的成功状态以输入回执为准。

### B2：直接输入、Plugin 与交还

- [ ] “进入协作”后 composer 发给同一 Session，Bot 面板 composer 发给 Bot；任务细节与项目长期决定的路由清楚可见。
- [ ] Plugin/Mini App/浏览器/IDE 经受信 binding 提交结构化元素、截图、DOM/文件 refs 和文字，默认不获得额外 transcript 或工具权限。
- [ ] Attach 选择的 Skill/Plugin 能力受当前有效授权约束；新增能力进入后续 Run 准入，不能仅靠 mention 提升权限。
- [ ] 输入经 R1 服务排序/排队/steer；不能 steer 时显示 queued；“交还 Bot”触发对账后恢复，不重发接管前旧指导。
- [ ] 处理多客户端竞争、lease expiry、离线重连、任务 archive/route 变化；控制权变化显示明确结果。

### B3：TUI 与真实产品收口

- [ ] TUI 保留完整独立 Session 工作台并调用同一服务，复用 history、model/provider、工具、权限与目录操作。
- [ ] 审计后仅迁出 Bot 长期责任/记忆/跨项目调度；/project 的本地执行位置和 /pr 的 Session 诊断按真实语义处理。
- [ ] 验证 Desktop/Web 适配，UI 查询和 Runtime/Host 投影一致；没有 Task 绑定的既有 Session 仍可由 TUI 访问，不能丢弃历史。
- [ ] 改 Electron main/preload 或打包入口时按指南重建；真实浏览器链路验证发送、工具、审批、断线恢复和控制权。

## 验收矩阵

| 场景 | 预期 |
| --- | --- |
| Shell 创建分支/PR | adapter 验证后关联正确 Task/Session/Run，保留来源；detached 状态如实显示 |
| 评论/CI 事件重复或乱序 | 同一输入只处理一次，按 head/revision 对账，反馈回原任务 |
| 用户审批后 head 变化 | 原审批/检查不能直接用于新 head；重新验证后才能 merge |
| merge 响应丢失 | 从 provider 补回执并保存 merge evidence，unknown 不误报完成 |
| 打开任务详情 | 能读进度/历史/配置，不自动暂停 Bot |
| 进入协作并选 Plugin 改间距 | DOM/截图引用与指令进入原 Session，Bot 暂缓新指令，真实工具继续 |
| 两个客户端争用 | 一个明确的控制 lease/revision，另一方得冲突或只读结果 |
| 交还、掉线或 lease 到期 | 对账用户输入与 Run 后恢复，没有重复旧命令 |
| 收件人不同 | 项目目标发 Bot，当前实现要求发 Session；显式同步不会默默改目标 |
| 项目最终交付 | 能从 Task 找到 Host/cwd、branch/PR、checks/review 和具体 merge commit |

## 验证、迁移与回退

VCS 先用确定性 adapter 场景验证幂等与过期 head，再在受控仓库进行真实 PR/CI/review/授权 merge 与对账。Desktop 使用真实 Host/Worker 的浏览器路径；mock adapter 不能代表外部交付验收。记录缺凭据、平台 skip 和未完成的用户操作。

现有 integration 回归起点与 Electron 真实链路命令如下；新增 Task Attach 场景需要浏览器实跑：

    npx vitest run packages/host/tests/integration-api.test.ts packages/host/tests/checkout-integration-http.test.ts
    npm run electron:build
    npm run test:e2e:turn

UI 渐进替换旧入口，复用原 Session ID 和 projection。默认 merge policy 需审批；新自动合并路径可停用，已观察 PR/merge 事实仍保留。Attach 回退为只读时，持久输入和用户控制状态必须先完成交还/对账。

## 进度、验证与接续

- [ ] A1/A2：关联、观察与反馈。
- [ ] A3：受当前 head 约束的 merge。
- [ ] B1/B2：任务内 Attach 与 Plugin 输入。
- [ ] B3：三端接线与真实产品验收。

本模块未实施，未运行产品测试。下一步：R3 binding 冻结后，先提交共享 integration/Attach query DTO，再分别推进 VCS adapter 与 Task detail；G1–G5 场景全通过后本机版本才完成。
