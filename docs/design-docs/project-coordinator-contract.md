# Project Coordinator 首版实施合同

状态：设计合同，代码待实施 · 2026-11-02。上位决策：[Project-first](project-first-architecture.md)；外部依据与 20 个已公开工具：[Claude Projects 调研](../references/claude-projects-coordinator.md)；执行：[三个总体任务](../exec-plans/active/2026-11-02-project-coordinator.md)。

此合同冻结首版语义与最小调用面，供三个实现 Agent 共用。下列 project_* 是拟议 duya_app contributor 工具，不宣称仓库已有；session_* 复用 #579，任务一适配现有 DTO 后在本页记录最终签名。避免分别新造 Thread、Task、输入或消息系统。

## 1. 角色和持久对象

- Project 保存稳定 projectId、goal、instructions、配置 revision、当前协调 Session 引用及绑定 revision；字段在既有 Project 数据/迁移中增量扩展。无需创建个人 Bot。
- 工作话题（UI Thread）首版是既有项目 Task 及其执行绑定的投影，Task 的规范状态只保存一份。稳定 taskId 与 projectId 关联；一个 Task 可经历多个 Session/Run，绑定保留历史并明确当前执行目标，不能以 sessionId 充当工作身份。
- Task 的未开始/进行中/受阻/待验收/已完成/取消由既有状态扩展或有类型投影表达，开工先记录映射；Run 的 running/terminal、Session busy、审批等待及 PR 观察保持各自权威。不为 UI 另存一个平行状态机。
- Coordinator Session 可压缩、重启或替换。Host 按 projectId 恢复任务、工作绑定和事件游标；旧协调者携带过期 binding revision 的派发必须拒绝。
- 可信调用上下文含 principal、projectId、role、sessionId/runId/attempt、协调绑定 revision。Host 生成并校验，模型参数不能自报 actor、扩大 scope 或冒充用户；需要新增 wire 字段时保持 additive，不复用假 botId 获权。

## 2. 最小工具面与字段

所有 schema 拒绝未知字段。读操作分页/限量，返回来源/版本；写操作带 requestId 与对象的 expectedRevision（新建按唯一请求键处理）。projectId 默认由可信上下文绑定；跨项目目标必须经明确 Host 授权。冲突返回具体原因及当前 revision，不重试覆盖用户变更。

| 工具/调用面 | 首版输入与输出语义 | 实现归属 |
| --- | --- | --- |
| project_get | 可选 section；返回项目 goal/instructions、配置 revision、任务摘要、工作绑定、阻塞、交付引用及 observedAt/source；不启动 Run | Host 项目应用服务，复用 Project/Task/Integration 查询 |
| project_settings_update | requestId、expectedRevision、typed patch（goal/instructions/角色模型/工作默认配置）；返回新 revision；实际新增能力仍须后续 Run 准入 | Host；扩展现有 Project API，MCP 只投影 |
| project_task_list | 可选 status、cursor、limit；返回稳定 taskId、当前/历史执行引用与各状态，不返回全量 transcript | Host/Data 项目 Task 适配 |
| project_task_update | create/update/resolve/reopen 的严格 discriminated union；含 requestId、taskId（新建可省略）、expectedRevision、范围/依赖/验收/结果引用；resolve 须有验收依据，Run 结束不自动 resolve | 复用既有 Task 权威，新增 projectId 关联与最小操作 |
| project_activity_list | afterCursor、limit；返回带 eventId、source、taskId/sessionId/runId 的持久项目事件与 nextCursor；读取不重复触发执行 | Host 项目查询；复用既有 Run/输入事件并补缺失的项目关联 |
| project_memory_read | query 或 key/ref、cursor、limit；先返回预算内索引/片段、revision、source refs，正文按需读取 | Host 项目 scope + memory，Coordinator 无需 Read 文件工具 |
| project_memory_update | requestId、expectedRevision、op=candidate/upsert/retire、key、内容、来源引用；返回生效/候选状态与新 revision；退役影响后续索引/召回 | 复用 memory 存取/纠错/遗忘适配，原始对话继续由 transcript 保存 |
| session_spawn / get / read / rename | 复用 Session MCP；项目派发额外关联 taskId、目标 Host/cwd/隔离 checkout、任务配置和绑定 revision；Host 校验项目归属，不只靠 children/workspace | 已有 Session 服务 + Project binding 适配 |
| session_send / status | 复用异步输入与 receipt；含 requestId、expectedRunId/expectedTurnId（适用时）及当前控制 revision；status 明确区分输入回执与执行结果，get 查询 Run | #579/#580 统一后的一个 Host 输入服务 |
| session_cancel / control | 取消捕获的目标 Run；用户接管/交还使用同一 Host lease 服务。模型自身不能代用户取得 user-control 或回答审批 | 已有执行控制、可信客户端与 Host 授权适配 |
| 普通回复 / 用户问题 | 沿用现有 assistant 消息投影与 AskUserQuestion/审批交互，消息有稳定 ID 与收件目标；不新增 post_message + assistant 双重投递 | 共享 UI/现有会话通道；移除对 Bot send_message/outbox 的必需依赖 |

项目产物/PR 首版由 project_get 或项目详情聚合查询返回已有引用，附原 Session/Run 与观察时间；无需先建设完整 Library。未观察到 PR 结果时保持 unknown，不合成 merged。fork/search 等额外 Session 工具可复用，但不因 #579 注册了它们就全部授给 Coordinator。

Coordinator 默认只允许上述管理能力及必要的用户问题工具，无设备 Bash/Read/Write/Edit 或通用插件执行。registry、真实执行器、deferred/MCP 别名与 tool_invoke 都执行同一限制。工作 Session 独立按任务准入 requested ∩ installed ∩ authorized ∩ policy；空与缺省不同，当前 Run 的配置不静默变更。上下文中的“同时最多 N 个”只是偏好；Host 的并发/预算上限需实际执行。

## 3. 派发、反馈、接管和恢复

1. 用户输入持久受理，Coordinator 可以直接回答、为已有 Task 补充指导或创建新 Task；不强制每条消息启动工作。
2. 派发先落 Task→Session/Run 的绑定与可幂等查询的 operation/dispatch 引用，再通过现有 Session 准入执行；Host 分配 Run ID、冻结 manifest，同目录写入遵循 checkout ownership/串行约束。
3. Host 持久接收工作反馈，按 source event/Run terminal 去重并关联原 Task。终态、阻塞、需用户输入及关键结果进入项目 Activity；形成持久 Coordinator 唤醒义务，协调者退出/重启时可对账补送，不转发每个 token。模型私有文本不是唯一完成事件。
4. Coordinator 被唤醒后先查当前 Task/Run/审批事实，再汇总给用户或决定后续；结果报告携带来源与产物引用。报告来自 peer，不等于用户扩大权限或完成验收。
5. 打开工作详情默认只读；用户明确进入协作才取得 lease。Coordinator 可观察，但暂停该目标的新输入；已执行工具继续，其他 Task 可继续。交还或 lease 到期后先对账用户输入/Run/待发消息，拒绝旧 revision 的指导。
6. claim 后崩溃、派发结果丢失、事件重复或旧协调者回报都按同一输入/receipt/Run/binding 权威恢复；无法确定时显示 queued/unknown/recovery_required，不另开重复执行。

子任务请求带来源用户指令与 Coordinator brief 的不同 provenance，沿现有受信结构传输；用户文本/网页/记忆不因出现 XML 标签获得 principal 身份。审批必须落到真实审批 ledger/Run，主对话一句“可以”不自动回答另一工作 Session 的待审批请求。

## 4. 项目上下文与记忆

每个协调 Run 装配：可信角色与范围、当前项目 goal/instructions revision、近期项目消息/Activity、任务摘要与待处理事件、预算内记忆索引及相关来源。每个工作 Run 另带当前 Task brief、用户原始要求、目录/checkout、获准能力与相关项目记忆。索引和全文有明确预算与截断回执，详细历史按需读取，不假设继承全部对话。

通过 Host 把项目记忆显式注入本地工作 Session；不能依赖现有 Bot membership，也不能假定 cwd 相同就自动共享。纠正/废止会刷新索引和后续装配；在途 Run 保留原快照，后续纠正作为新输入处理。用户决定与可验证工作状态分别落各自权威，记忆候选不冒充验收事实。索引可以使用既有 memory 表/文件后端；不强制复制 Claude 的 MEMORY.md 路径或本地 200 行限制。

## 5. 交付分工与判据

任务一负责本合同的 Project/Task/binding、角色白名单、MCP 管理面、反馈唤醒及统一 Session 输入；提供任务二/三可用的协议和最小适配。任务二在 memory_read/update 与 context 接缝中实现长期状态/记忆连续性，任务三消费同一 query/input/control，不重复实现领域规则。

必须交付的场景：就地回答不 spawn；两个 Task 分别执行且结果回项目；用户接管一个不影响另一个；更换协调 Session/重启后任务与记忆可恢复；重复输入不重复执行；越权/旧 revision 明确拒绝；本地新工作得到明确项目背景；Run 结束但待验收的 Task 保持待验收。产品测试由用户执行，Agent 提供可运行版本和步骤，必要构建/CI 门禁仍按仓库规则。

首版不要求云端 Thread→本地 RC 双层部署、所有 63 个工具、完整 Library、复杂 widget、历史聊天导入、Routine、自动 merge 或项目 pause/archive/delete 的全套语义。三项总体任务的边界保持不变，只把实现依据与最小合同补齐。
