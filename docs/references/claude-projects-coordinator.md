# Claude Projects：Coordinator 调研与 Duya 映射

查阅：2026-11-02。直接读取以下原文；研究对象为新版 Claude Code Projects，不将旧 Chat/Cowork 的项目文件夹机制与新版混用。原始网页留在 ignored 的 docs-local，本文是可供其他 Agent 使用的结论与来源。

2026-11-06 的复核与一手使用反馈见本文末尾；工具到提示词的实际闭环及 Duya 接口缺口见 [提示词系统 §12](../design-docs/project-coordinator-prompts.md#12-工具与提示词闭环2026-11-06-补充)。早期逆向工具名不得作为当前调用合同。

## 来源与证据等级

| 标识 | 原文与范围 |
| --- | --- |
| O1 官方发布 | [Projects redesigned: from folder to conversation](https://claude.com/resources/articles/projects-redesigned)，2026-09-17；产品方向与最初发布能力 |
| O2 官方当前文档 | [Let Claude coordinate ongoing work with Projects](https://code.claude.com/docs/en/claude-projects)，本轮读取其 `.md` 正文；组织、运行、记忆、权限和配置语义 |
| O3 官方旧/新版区分 | [What are projects?](https://support.claude.com/en/articles/9517075-what-are-projects)；说明新版滚动开放，旧版知识库/项目说明不能直接代表 Coordinator 实现 |
| O4 官方本地记忆 | [How Claude remembers your project](https://code.claude.com/docs/en/memory)；本地 auto memory，与 Projects 共享记忆有不同作用域 |
| R1 第三方逆向 | Aaddrick Williams，[How Claude Code's Projects Beta Works Under the Hood](https://aaddrick.com/blog/claude-code-projects-beta-under-the-hood)，2026-10-05；作者账号、Desktop 2.9939.4 Linux、当日 Web 与运行日志观察，不是公开 API 合同 |

下面 O 表示官方文档；R 表示作者当时观察；D 表示本项目选择。R1 披露了 AI 辅助分析且区分部分推测；本文只采用原文明确证据，不把内部字段、工具总数或其 prompt 当作规范。

## 已核验机制及影响

| 机制 | 原文依据 | 对 Duya 的约束/选择 |
| --- | --- | --- |
| 协调与执行分工 | O1/O2：项目长程对话负责路由，工作 Thread 独立上下文并报告；简单问题可直接回答，跟进可复用已有 Thread | D：Coordinator 不是每收到一句话就 spawn；Project 管理与执行分离，共用 Runtime |
| Thread 身份 | O2 用产品语言称 Thread 是独立 Session；R1 明确 Thread 是 channel 中的根消息及 bound_sessions，另有云端/设备子 Session | D：持久工作身份独立于 sessionId；首版复用 Project Task + binding 投影为 Thread，不复制 Claude channel/cmsg 表或强建云端父子两层 |
| 工具范围 | R1：63 个 Coordinator 工具来自 hearthbot、claude-code-remote、GitHub，0 个 device tools；O2 当前另明确项目主对话没有账户 connectors | D：限制真实设备/插件执行，提供窄管理工具；不将“0 device tools”写成官方证明的“0 工具”，也不把十月账号的 GitHub 工具当作永久合同 |
| 结果回传 | O2：Coordinator 看到 Thread 报告而非每一步；R1：wake/relay 区分用户与 peer，设备子 Session 经 send_message 向 @parent 报告 | D：必须有持久反馈/唤醒闭环，不能只有 spawn/get 轮询；peer 指令不提升用户授权 |
| 用户可见消息 | R1 的云端角色只经 hearthbot 消息工具投递，普通文本不展示；设备子 Session 的报告也有固定路径 | D：Duya 首版继续现有 assistant 消息投影，选定唯一可见投递路径；不因模仿内部实现而再建 Bot outbox/消息系统 |
| 长期上下文 | O2：Coordinator 使用近期消息、近期 Threads 和项目记忆，非完整历史；云端工作启动读取 MEMORY.md 索引，主题文件按需读取 | D：任务当前事实、长期记忆、历史原文分工；每轮显式装配快照、相关记忆与引用 |
| 本地执行的例外 | O2：Remote Control 工作收到项目说明，但不会自动加载项目记忆文件；O4：本地 auto memory 不跨机器/云端共享 | D：本机 Session 也由 Host 显式传入项目 context，不能凭目录相同或新建 Session 宣称已继承；本地索引的 200 行/25KB 不是官方 Projects 限额 |
| 能力来源与版本 | O2：项目 Plugins/环境/说明变更作用于新工作；云端不自动加载本机或仓库中所有 Skill/MCP/settings | D：Plugin Installation 与 Binding 分开，每 Run 准入并冻结；Coordinator 管理配置不等于拥有插件执行权限 |
| 任务/工作进度 | R1：当时 Thread 状态与自由文本 checklist 分离，另一个 project tasks reader 被禁用；O2 当前 Overview 又有 review/landing 等分组 | D：不把 Claude checklist 当 Task 数据模型；Run 终态、用户等待、Task 验收和 PR 观察分别投影 |
| 并发与审批 | O2：记忆中“最多两个 Thread”是行为偏好，不是系统硬上限；主对话说可以不等于回答工作 Thread 的审批 | D：Host 硬并发与控制租约执行，审批绑定实际请求/Run；偏好与安全/资源约束分开 |
| 版本差异 | R1 未确认项目 pause 是否中断在途工作；O2 当前明确 pause 会中断会话与 Threads，archive 也停止相应工作 | D：不能沿用旧推测或照抄生命周期；首版接管仅挡新指导、在途工具继续，完整项目 pause/archive/delete 单独定义后再暴露 |

## R1 明确点名的 20 个 Coordinator 工具

原文 “The Coordinator” 节按四类列出下表。它没有公布全部 63 项名称及完整 JSON Schema；下表也不是这次独立抓取到的私有 MCP schema。

| 组 | 明确名称 | Duya 首版映射 |
| --- | --- | --- |
| 用户交互（4） | post_message、ask_decision、post_widget、update_status_page | 现有 assistant 投影 + AskUserQuestion/审批组件 + project_get 状态；复杂 widget 后续 |
| Thread 生命周期（6） | start_thread_session、start_folder_thread、start_rc_session、message_thread、rename_thread、set_thread_resolved | 既有 Session MCP + Host 工作绑定；首版本地目标即可，Task 另做 resolve/reopen，不能用 cancel 代替完成 |
| 项目读取（5） | fetch_thread、fetch_project_timeline、list_project_artifacts、list_project_prs、summarize_recent_sessions | session_get/read、project_activity_list、project_get 的交付引用及有来源摘要；PR 复用现有 integration 观察 |
| 记忆/配置（5） | read_memory、update_memory、get_project_settings、update_project_settings、propose_project_setup | project_memory_read/update、project_get/settings_update；设置建议首版通过普通对话，复杂安装/配置卡后续 |

R1 还点名 list_devices、no_reply_needed，以及 Thread 的 reply/update_status、设备子 Session 的 send_message。它们的角色与层次不同，不把这些附加名称硬凑成“完整 Coordinator 清单”。reactions、chat import 是原文提到的能力类别，没有完整名称/Schema；不补写猜测名称。

## Duya 接口复用与新增边界

| Duya 当前证据 | 复用与缺失 |
| --- | --- |
| packages/host/src/project-api.ts、agent-protocol/src/projects.ts | 已有项目 CRUD；缺协调绑定、goal/instructions 的版本及运行设置合同 |
| packages/host/src/task-api.ts、data/src/project-store.ts | 已有任务/项目存储；Task 按 Session 组织，需稳定 projectId 归属与工作 Session 绑定 |
| #579 的 capabilities/src/session-app-tools.ts、host/src/session-service.ts | Session MCP 基础已实现于分支；children/workspace 权限与 parent lineage 不足以单独承担长期 Project 授权，需 Project binding 适配 |
| packages/host/src/worker-prompts/bot/memory/tierReader.ts | 可复用读取/遗忘等机制；需无个人 Bot 身份的项目 scope 服务 |
| packages/host/src/integration-api.ts、agent-protocol/src/integration-api.ts | 复用 PR/Session 关联与 observedAt/unknown；首版列交付引用，不增自动 merge/第二观察器 |
| #579 与 #580 | 先统一输入、receipt、lease 权威；工具可调用不代表已有项目反馈、恢复、用户控制闭环 |

具体首版工具、字段、状态与事件合同见 [Coordinator 实施合同](../design-docs/project-coordinator-contract.md)。实施 Agent 从合同接线；遇到 API 形状冲突在同一合同记录裁定，不再各自推测 Claude 的工具。

## 研究边界

已直接查阅 O1/O2/O3/O4 与 R1，未登录作者账号、未导出 Claude 私有 MCP schema、未独立复现其设备行为。官方当前文档优先解释产品现状；R1 用于理解当时的内部接缝，Duya 的实现选择明确标 D。官方 Projects 仍在 beta，未来更新需重新核对；不以参考资料证明 Duya 代码已落地。

## 2026-11-06：一手体验、技术解析与工具闭环复核

本轮直接读取 O2 的 `.md` 正文（HTTP 200，62,960 字符），原始材料留在 ignored research 目录。正文区分项目主对话、执行 Thread、本机运行和审批；主对话的 connectors 不能从执行 Thread 反推。未登录产品，未抓取私有工具 schema，也没有发现可据此比较 Duya/Projects 成功率的受控测评。

### 新增阅读与证据等级

| 来源/日期 | 性质与实际阅读内容 | 对 Duya 的设计影响；不是外部产品的通用结论 |
| --- | --- | --- |
| O2，复核 11-06，[官方 Projects 文档](https://code.claude.com/docs/en/claude-projects) | 当前产品合同；区分指令、记忆、执行环境、项目与 Thread 控制；说明主对话只见报告，审批在实际 Thread | 设备/环境能力按执行位置装配；读状态、给指令、审批和停止要分别验证，不能从一句对话推导所有副作用 |
| R1，10-05，[Aaddrick 内部拆解](https://aaddrick.com/blog/claude-code-projects-beta-under-the-hood) | 作者客户端/日志逆向；本轮重读工具、session-context 与报告路径 | 工具目录、输入封装和可见消息投递共同决定角色；工具数和名称只是当时快照 |
| U1，10-14，[Tim Cakir 的实际使用](https://weekly.aioperator.com/p/claude-code-projects) | 作者在自己与客户开发项目中试用；边界清楚的代码仓库体验较好，跨文件夹业务工作仍需检查 | 派发前核对资料和工作位置，不能在缺上下文时继续扩散任务；个人体验不等于统计质量证明 |
| U2，10-14，[のさ：Projects beta 体验](https://zenn.dev/nossa/articles/ac57ee10ff0368) | Muntin 项目一手体验；认可任务安排和 Overview；不满意输入等待、权限介入、外部评审迁移和可见性 | 让状态可解释，保留用户直接进入工作的入口；主动协调不能代替真实权限回答或假称预防所有分支冲突 |
| U3，10-08，[Alva：非编程项目实测](https://www.getseenplaybook.com/blog/claude-projects-update) | 作者在招募规划测试项目中更新 tracker、保存项目指令、把追问续接到已有 Thread | Coordinator 适用面包含文档/数据工作。需要成果引用、同任务续接和明确的项目配置写能力，不限于代码派工 |
| U4，10-14，[Alva：迁移记录](https://www.getseenplaybook.com/blog/move-to-new-claude-projects) | 自己账号升级的图文记录；核对文件、instructions、memory 的迁移 | 项目配置/资料继承要有可观察回执；本文不据此推导任意旧会话会自动继承所有本机设置 |
| A1，09-19，[Automater 的 abort ownership 技术解析](https://automater.ai/intel/claude-code-projects-cloud-coordinator/) | 基于官方资料的作者分析；讨论停止粒度、执行归属与副作用残留，不是独立重现或性能测评 | 为 cancel 请求、Run 终态、子工作和已产生 PR/文件分别定义验收，不能把取消回执当回滚证明 |
| B1，09-30，[用户反馈 #98355](https://github.com/anthropics/claude-code/issues/98355) | 报告协调者不及时汇报、问题上抛不合理、todo 状态过期；11-04 有附议。未独立复现 | 需要中途阻塞/待输入事件，不能只在终态唤醒；从同一事实投影进度，减少用户主动追问 |
| B2，10-02，[用户报告 #99091](https://github.com/anthropics/claude-code/issues/99091) | 作者报告 Thread 卡住和后台任务挂起。其频率属于个人样本，不引用为产品故障率 | 识别 running、waiting、stale/unknown，提供精确停止/恢复目标，不按 spinner 猜工作健康 |
| B3，10-21，[工具丢失报告 #104059](https://github.com/anthropics/claude-code/issues/104059) | 作者比较 Coordinator recycle 前后工具列表；报告决策卡/widget 缺失及部分工具重命名，另有用户附议 | 恢复后重新装配并核验真实目录；不把旧 prompt 中的工具名当当前能力 |
| B4，10-18，[指令送达报告 #103294](https://github.com/anthropics/claude-code/issues/103294) | 作者报告项目指令间歇缺失、记忆索引未含新文件；issue 仍标有 `invalid`，作者补充其为新版 Projects。没有官方根因确认 | 当作反例 fixture：新 worker 的上下文版本/送达与来源可核验，不宣称是已确认产品缺陷 |
| B5，10-11，[本机指令截断报告 #101398](https://github.com/anthropics/claude-code/issues/101398) | 作者按末尾 marker 和 UTF-8 字节做复现，版本 2.1.295；11-02 加 Desktop 标签。未独立复现 | 多字节、长指令、本机/云端不同路径都要验收；长度与截断回执由真实发送内容计算 |

### 筛选与结论边界

- 排除把旧 Chat Projects 作为测试对象的文章；例如 [AI Alleyway](https://aialleyway.com/claude-projects/) 自己明确新版 Code Projects 未测试，不能用其中容量/记忆测量评价 Coordinator。
- 从资讯摘要追到 Zenn 原作者后，只使用原文。把通用多代理论文的并发数字套到 Projects 的文章不作为本产品性能证据。
- 这组材料足以形成行为和故障场景，不能证明某套私有系统提示词、工具数量或修复状态永久有效。
- 共同的产品问题是任务路由、共享资料、可见进度、真实停止、审批归属和恢复后能力。Duya 的对照要以这些闭环验收，不以“也有三个工具组”判定功能相同。

本轮 Duya 源码核对固定在设计分支 `185a13eb` / 624 base `54dde175`。已找到的工具限制与 todo 存储冲突风险属于本项目自己的证据，详见设计 §12；没有运行 Claude 的上述缺陷复现，也没有在用户真实数据库执行破坏性验证。
