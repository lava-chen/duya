# Claude Projects：Coordinator 调研与 Duya 映射

查阅：2026-11-02。直接读取以下原文；研究对象为新版 Claude Code Projects，不将旧 Chat/Cowork 的项目文件夹机制与新版混用。原始网页留在 ignored 的 docs-local，本文是可供其他 Agent 使用的结论与来源。

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
