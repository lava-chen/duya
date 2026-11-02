# Project-first：产品角色与共享架构

状态：产品方向已采纳，Coordinator 代码待实施 · 2026-11-02。
本决策取代“个人 Bot 统一管理所有 Project”和“先完整发布 CLI 再做 Project”的产品排期。执行见 [Project Coordinator 计划](../exec-plans/active/2026-11-02-project-coordinator.md)。

实施依据已补齐：[官方/逆向调研及工具映射](../references/claude-projects-coordinator.md)与[首版工具、状态和事件合同](project-coordinator-contract.md)。三项总体任务共用该合同，不再各自研究并重建一份 Coordinator 工具面。

## 产品与运行入口是两条轴

| 产品角色 | 目标与持久身份 | 默认能力 |
| --- | --- | --- |
| Project Coordinator（当前重点） | 推进一个 Project；projectId 独立于任何聊天 Session | 项目状态/记忆、工作 Session 管理、用户沟通；无直接设备文件或 Shell 执行工具 |
| Personal Bot（暂缓增强） | 管理个人长期事务；保留既有 botId、记忆和 Routine | 沿用已发布能力；未来按授权联系 Coordinator 或创建非项目 Session |
| 工作 Session | 在指定目录/环境完成具体工作，可独立经 CLI/TUI 使用 | 本轮获准的模型、基础工具、Skill/Plugin/MCP 与上下文 |

Desktop 首要入口为 Project：进入项目即进入项目协调对话，同时可查看和进入工作 Session。Web 复用客户端基础，当前不扩展；CLI/TUI 保留独立 Session 工作台，产品增强与发布排在 Project 首个闭环之后。只补 Coordinator 必需的 Session 正确性，不等待整个 Session 改造完成。

Coordinator 本身也使用普通 Session/Run Runtime 进行模型对话，但角色为协调者；“运行在 Session 中”不授予工作 Session 的设备工具权限。更换协调 Session 不改变 Project 身份、任务和记忆。

工作话题（UI Thread）也不等于 sessionId：首版由 Project Task 及其执行绑定投影，稳定工作身份可关联多次 Session/Run。Claude 博客的 channel/thread/云端/设备子 Session 层次只作参考，Duya 不为此先实现云端双层部署。

## 仓库保持一个 Monorepo

在 master `af4aaede` 核对为 22 个 packages、2 个 apps。不按三个产品复制这些包，也不先做合包/重命名。第一版在既有包内增加职责明确的模块；下面是目标归属，不表示模块已存在。

| 位置 | 职责与依赖约束 |
| --- | --- |
| `packages/host/src/project/`（拟增） | Coordinator 用例、角色装配、项目授权、任务/Session 绑定和反馈对账；调用现有 Runtime、data、memory 适配，不经个人 Bot 身份绕行 |
| `packages/agent-protocol/` | Project/Task/Session 引用、角色及调用合同；仅增加跨边界所需字段，不放调度实现 |
| `packages/agent-runtime/`、`agent-core/` | 共享推理与执行；不导入 Project/Bot 应用服务，不新增 coordinator-runtime |
| `packages/data/` | Project、任务及绑定等规范事实与版本；沿用现有迁移/事务，不另建 Project 数据库 |
| `packages/memory/` + Host 项目适配 | 复用记忆存取/检索/纠错机制；项目授权与上下文装配由 Host 适配，不依赖伪造 botId |
| `packages/capabilities/` | 将窄 Project 管理能力投影到既有 duya_app MCP；复用 Session 工具，不另建注册系统 |
| `packages/ui/`、`client-core/`、`apps/desktop/` | Project 对话、工作列表/Activity、Session 进入与交还；经协议和客户端服务调用 Host |
| `packages/bot/` | 保留个人 Bot 领域，Project Coordinator 不以创建 Bot 为前提 |
| `packages/cli/`、`plugin-core/` | 前者是 Session 客户端；后者保留共享插件定义/解析，安装/凭据/部署和授权归 Host |

先在 Host 形成稳定 Project 应用边界。只有纯业务规则已有真实复用者且依赖门禁能约束时，才评估提取 project 包。现有 agent 退役、Runtime 消息类型迁移和包数整理不作为 Project MVP 前置。

## 长期连续性有三份不同事实

| 内容 | 权威与恢复 |
| --- | --- |
| Project State | Host/data 保存目标、当前决策、任务、阻塞、Session/Run 绑定及交付引用；查询当前状态不依赖模型回忆 |
| Project Memory | 项目范围内的结论、约定和纠正，带来源、revision/有效状态；复用 memory 机制，能检索、更新、废止 |
| Conversation History | 沿用 Session/Run transcript；保留协调与工作原文，按需有界读取，不把所有历史拼进每轮 prompt |

任务完成与 Run 终态分别判定。工作 Session 的产出先形成可追溯事实/记忆候选；不能把模型总结或“运行结束”自动提升为已验收任务或当前决定。每次协调/新工作 Run 装配当前项目快照、相关记忆和来源引用；原 manifest 保持冻结。

现有 Task API 按 sessionId 查询，ProjectRow 主要是名称/路径元数据；不能直接宣称已有持久项目任务。实现时先定 Task 的唯一权威及稳定 projectId 关系，再增加最小绑定；更换协调 Session 后仍能找回旧任务，不复制另一份任务状态机。现有项目记忆 reader 通过 Bot membership 和 per-writer shard 加载；第一版补 Host 的项目 scope 适配，不创建一个假 Bot 才能读项目记忆。

## 调度权和工具边界

项目工作 Session 持久绑定唯一协调归属。Host 从可信调用者解析 projectId/角色，校验绑定、版本和当前控制权；不只依据 cwd、Session 血缘或模型自报项目。用户进入只读界面不接管；明确进入协作才取得控制租约，阻止 Coordinator 新指导，在途工具继续；交还后先对账再恢复。未来个人 Bot 对项目提交请求，不绕过 Coordinator 直接指挥同一工作 Session。

首版 Coordinator 只开放三个能力组：项目状态与记忆、工作 Session 生命周期、用户沟通。具体工具名按既有 Host API 和 duya_app contributor 落实，不以模仿外部产品工具数量为目标。任务、记忆和设置变更由窄 Host 服务执行，所以 Coordinator 不需要 Bash/Read/Write/Edit。

最小 project_* 管理面与既有 session_* 的字段、输出和归属见实施合同；直接回复沿用现有 assistant 消息投影。Host 还必须把关键工作结果/阻塞形成持久反馈并唤醒 Coordinator，不能只有 spawn/get 轮询。本地新工作 Run 也显式接收项目上下文与记忆，不依赖目录或个人 Bot 隐式继承。

白名单同时约束模型可见目录和真实执行；tool_invoke、MCP 别名、deferred 工具和恢复后 registry 不得绕过。工作 Session 获得任务自己的能力配置，Coordinator 的窄白名单不能误传成“所有子 Session 都无工具”，子任务也不能超出用户/项目授权。

## 首轮必须裁定的现有分歧

2026-11-02 读取的 #579 head `5057f201` 与 #580 head `88efd64b` 含两种输入实现：

- #579 的 `session-input-service.ts` 以 mailbox 行作为 receipt，租约存 Session extension，Worker 接入；移除同步 MessageSession 路径。
- #580 的 `session-input-api.ts` 使用 data 的 session_inputs/session_control_leases 表，HTTP 当前绑定本机用户；同时修补同步 MessageSession 服务端。

这不是已经证实的主干生产双写，但不能分别合入后让两套事实并存。集成者应先选一个输入/租约权威，MCP、HTTP 和客户端都只适配它；统一 actor 解析、幂等、expected Run/turn、消费回执与租约失效语义。保留 #580 的工具授权/子会话恢复修复与 #579 的 MCP 异步入口，裁定同步旧路径的兼容/退役范围。处理 claim 后崩溃与派发前控制权变化，不能把“有 CAS”当作已证明整个派发原子。

## 成本与暂缓范围

先交付项目对话 → 派发工作 → 结果回项目 → 重启/新协调对话仍记得决定与进度。个人 Bot 主动性、Routine 增强、多 Host、完整插件安装迁移、自动 merge 和包目录重组暂缓。CLI 发布计划保留为独立后续，不成为 Project 开工前置。

本轮已直接核验官方新版 Projects 发布/文档、旧版 Projects 说明、本地 memory 文档及 Aaddrick 逆向原文。官方确认产品分工与长期记忆；63 个工具和内部 channel/thread 结构属于作者当时观察，原文只分类点名 20 个 Coordinator 工具，没有全部 Schema。证据等级、版本差异与 Duya 自己的选择在调研中逐项标明；不宣称复制了私有实现。当前只交付设计与执行计划，未实现 Coordinator。
