# 包边界与协议合同

状态：历史目标合同；产品角色与优先级以 [Project-first #581](https://github.com/lava-chen/duya/pull/581)为准 · 更新：2026-11-02
规划 owner / worktree / base 与实施状态见[总入口](../2026-11-01-bot-session-coordination.md)。模块执行前登记自己的分支与路径归属。

## 目标与边界

完整 Session 能力在现有 agent-runtime 内实现。Session Agent 是产品能力名称；本系列不建立 session-agent package，也不复活待退役的 agent package。Host 提供可信接入和 IO 适配；Bot 通过协议端口管理 Session。

本合同保留共享 Runtime/Host/协议的历史推导，不再定义产品角色的唯一目标边界。Bot 管理 Project 的假设已被 #581 替代；具体字段名、可选性和 schema 按新调用者冻结，以下拟议接口不是当前已实现 API。

## Package 改动地图

| Package / 路径 | 目标改动 | 实施模块 |
| --- | --- | --- |
| agent-protocol | 从既有 Session/Run API 组合窄调用面；补结构化输入、控制租约、能力请求/解析结果和上下文引用 | R1、R2；Bot/VCS DTO 随 R3/R4 |
| agent-core | 只承接确实被多方复用的纯校验/计算；Run 终态、预算规则沿用既有实现 | R1/R2 按需 |
| agent-runtime | 在 session / assembly 中实现通用 Session 行为；复用 engine、工具流水线、压缩和事件 | R1、R2 |
| host | 注入存储、模型、工作区、能力解析、授权、进程与网络；将既有 Session API/Worker 入口转发到 Runtime | R1、R2 |
| bot | 增加项目/任务协调的纯规则与应用用例，定义 Session 调用端口；保持只依赖 protocol、零 IO | R3 |
| host/bot 及 bot-dispatcher | 将协调规则接到 Inbox、scheduler、Context provider、Session 服务和 Outbox | R3 |
| data | 复用 Session/Run/transcript/manifest/PR；按缺口增加绑定、持久输入回执、控制租约和 VCS 事实字段 | R1、R3、R4 |
| ai | 继续实现模型访问；由 Host 绑定为 Runtime ModelPort，不让 Runtime 导入模型 SDK | R1/R2 接线 |
| capabilities | 复用工具实现/策略；按有效 Run 配置提供工具实例和描述 | R2 |
| plugin-core / connectors | 复用声明、版本、信任与解析；补 scoped connector reference 的最小支持 | R2 |
| memory | Bot 侧按 scope 检索记忆；Runtime 只接收可审计上下文或引用解析端口 | R2、R3 |
| client-core | 复用事件 reducer；增加输入回执、控制状态和任务内 Session 展示所需投影 | R4 |
| cli | Session-first；启动/恢复/输入/权限操作接统一服务，保留 standalone 默认配置 | R1、R2、R4 |
| ui / apps/desktop / apps/web | 共享 Task Attach 组件与客户端适配；Desktop 导航围绕 Bot/Project/Task | R4；进程解耦 R5 |
| gateway | 继续提供渠道来源；受信线程信息由 Host 路由到 Bot 或任务 Session | R3/R4 接线 |
| workflow | 复用已有任务/依赖能力；仅在调用闭包证明适用时接入，不新造第二套 DAG | R3 |
| sandbox / computer-use | 作为已授权工具的执行适配，按任务选择；不进入 Bot 协调规则 | R2 按需 |
| command-catalog / input-completion | 保留命令元数据/补全；必要时增加 Attach 命令投影，行为调用统一 Session 服务 | R4 按需 |
| agent | 保持 legacy shim；本系列不新增实现，退役按既有门禁单独完成 | 独立既有计划 |

未列出的基础包不因本次分层而强制迁移。依赖/exports/Worker bundle 只在消费路径真实变化的切片更新。

## Runtime 内部与 Host 的交界

目标目录是包内边界，可按实际文件规模细化：

    agent-runtime/src/
      session/    服务、输入调度、控制权、历史恢复协调
      assembly/   根据显式 Run 配置组合提示、上下文和能力
      engine/     既有模型/工具循环

沿用已有 RunController、RunPersistence、RunEnginePorts 等端口。只为尚未表达的职责补最小端口：

| 端口职责 | Runtime 使用方式 | Host 适配器提供什么 |
| --- | --- | --- |
| Session/history/input persistence | 读取状态、原子接收输入、恢复已接纳工作 | 现有 data / transcript / mailbox / receipt 的持久化操作 |
| Run admission | 请求启动一次 Run，接收接受/拒绝与冻结 manifest | 认证身份、权限校验、runId、canonical manifest、持久 receipt |
| Capability/context resolution | 按已授权引用组装本轮内容，校验版本与 digest | 已安装工具、Skill/Plugin/MCP、模型端口、上下文资源 |
| Workspace/execution | 验证绑定位置，调起或取消实际执行 | checkout fence、工作区 owner、Worker process/transport |

端口按现有合同复用，不把整套 Host service object 注入 Runtime。Runtime 不导入 Host、data、ai、Bot 私有存储或 Electron；真正 IO 的实现由 Host 装配。

## 状态权威与单写者

| 事实 | 权威 | 迁移约束 |
| --- | --- | --- |
| Bot 身份、项目任务关系、协调策略 | Bot 用例 + Host 持久适配 | 协调 Session 重建不改变 botId 或任务归属 |
| Session 身份、历史、Run 关联 | 既有 Session/transcript store；Runtime 负责通用操作次序 | 复用原 ID，不新建平行 transcript |
| 输入顺序与回执 | 通过 Runtime 服务使用的持久 input authority | 先核对 mailbox 是否满足；确有缺口才补 additive store |
| 用户控制租约 | 每 Session 持久 revision/lease，经统一准入原子校验 | 与 Worker 执行租约分开；过期不盲目恢复旧 Bot 指令 |
| Run 身份、manifest、准入 receipt | Host 可信 admission/control-plane | Runtime 不自行扩大配置后声称通过旧 fingerprint |
| Run 事件与终态 | 既有 ledger/controller/RunStore durable barrier | Runtime Session 层不新增 seq、终态或完成计数器 |
| Worker PID、退出、传输 | Host process supervisor | WorkerSessionRegistry 的进程状态不搬成任务完成状态 |
| 工作区 ownership/revision | 既有 checkout/执行位置适配器 | 不同 sessionId 不证明工作区隔离 |
| PR/CI/review/merge | 既有 integration projection + provider evidence | 本地 merge、PR head、hosted merge commit 分别记录 |

现有 RunSession 是每 Run 实体，新增 session/ 服务是跨 Run 的对话执行服务，名称和文档必须区分。Session busy 从活动 Run 派生，Task 完成从验收/交付事实判断，Outbox delivered 仍是独立事实。

## Protocol 的最小增量

### P1：组合窄调用面

从 HostSessionApiV1、HostRunExecutionApiV1、Run event query 等既有接口组合 RuntimeSessionApi 的窄视图。名称拟议，不复制全部 Host 管理 API。创建、读历史、执行、取消、观察和输入均有明确返回类型。

Host HTTP、Worker dispatch、Bot 和 TUI 适配到同一个服务。现有方法名/路由保持兼容；迁移期的旧入口只转发，不另启一条循环。

### P2：结构化 Session 输入

输入表达 sessionId、requestId、预期 Run/turn、文字、既有 attachments、context references，以及 steer / enqueue / interrupt 的用户意图。actor/source 从认证客户端、Bot mandate 或受信 Plugin binding 派生，不能信任模型/插件提交的自由 actor 字段。

回执区分 persisted / queued / delivered / consumed / rejected 等实际可证明阶段；最终枚举在 R1.0 对齐既有 receipt。输入使用自己的持久序号/游标，不挪用 Run seq，也不创建第二份 transcript。

无法 steer 的 Runner 在安全输入边界排队并如实回执；中断沿用 cancel 语义，再决定后续输入是否另起 Run。订阅和状态查询可从断点恢复。

### P3：控制租约

查看状态只读；开始协作获取每 Session 指令调度租约，携带 expected revision、requestId 和 expiry。所有 Bot 新输入在真正 dispatch 前重验租约，不能仅靠 UI 显示或 dispatcher 的非原子 busy check。

release/过期后先读取最新 Run、输入回执和 transcript，再恢复协调。控制租约不转移工具权限、工作区 owner 或 Worker execution fence。

### P4：Run 配置请求与解析结果

StartAgentRunInput 扩展 typed capability/context references；RunManifest 保存实际解析的快照与来源。区分请求、requiredCapabilities、能力库存快照和有效权限，不重定义现有 tools 字段为授权白名单。

引用至少能够表达 kind、稳定 ID、scope、版本/digest 或可审计 source revision。Prompt layer、ContextEnvelope、Skill、Plugin/MCP/App connector 只传必要内容或 references；凭据留在执行 Host。

必需能力不可用时拒绝，明确可选能力不可用时报告降级；不能因为 installed 列表存在就扩大授权。变更记录加入现有 provenance、fingerprint 和 input digest。

### P5：项目执行与 VCS 关联

R3 只新增现有 Project/Task 到 hostId、endpoint、workspace/cwd、sessionId、Run 和 source thread 的缺失关系。R4 扩展既有 integration DTO 保存 branch/PR/check/review/merge 事实；这些关系可被 Runtime 输入引用，但规划/merge 决策不进入引擎。

## 兼容与版本规则

- 未携带新配置的既有 TUI/客户端沿用兼容 defaults；显式空集合与省略分别表达禁用和既有默认，不以空数组真假值推断。
- Bot-created Run 使用项目基线与任务覆盖后的显式配置，未知 scope/必需能力拒绝；继承来源写入快照。
- manifest v1 的旧 JSON/hash 原样可验证。新增必填字段或语义变化前设计版本 reader；无论采用 additive v1 还是新版本，禁止反序列化时补字段再覆盖历史 fingerprint。
- 初始 manifest 不可变。工具或权限的实时变更须沿现有控制路径验证并落可审计事件/revision；能力扩张默认在下一 Run 重新准入，不能静默修改当前 manifest。
- 本地与远程调用使用同一 DTO；feature negotiation 在 R5 明确。不承诺任意第三方 Harness 无损共享 transcript 或执行状态。

## 进度与验收

- [x] 记录不新增 package、Runtime 承接 Session、Bot 管理层和 Host 适配层的目标。
- [x] R1.0 输出生产调用者/状态单写者清单与最小 DTO diff（[审计](r1-0-audit.md)，基线 master `95c30f58`）。
- [ ] R2.1 冻结能力字段、缺省/空值语义与 manifest 兼容样例。
- [ ] 每模块真实调用通过后更新当前架构文档与门禁，不用新增 baseline 隐藏反向依赖。

本页是设计合同，无代码实施验证。具体测试、迁移与接续分别记录在 R1–R5。
