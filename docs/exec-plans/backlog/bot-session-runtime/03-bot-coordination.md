# R3：Bot 项目与多 Session 协调

> 已被 [Project Coordinator #581](https://github.com/lava-chen/duya/pull/581)替代：Project 有自己的 Coordinator，不再由一个个人 Bot 统一管理多个 Project。本文保留任务/执行绑定和恢复的设计参考，不按以下旧产品假设直接派工。

状态：backlog · 负责人：待认领 · 更新：2026-11-01
规划环境见[总入口](../2026-11-01-bot-session-coordination.md)；实施时登记 branch / base / owner / 独占路径。
前置：[R1 Session 服务](01-session-runtime.md)、[R2 显式配置](02-capability-context.md)。后续：[R4](04-delivery-and-attach.md)。

## 目标与边界

一个 Bot 管理多个 Project；用户确认项目 brief 后，Bot 创建一批有范围、依赖和验收标准的 Task，为每个 ready Task 组装能力并分配隔离的工作 Session。协调 Session 与工作 Session 使用相同 Runtime，引擎不承担跨项目调度。

Bot 身份、Project/Task、权限、记忆索引和执行绑定独立持久化。协调 Session 历史丢失或重建后可从这些事实恢复；协调模型的聊天记录不承担唯一任务账本。

优先复用既有 Task/Goal/Responsibility/SessionSpawn。仅增加缺失关系和状态转换规则，依据实际消费者决定放入既有哪一对象，不先建通用 planner/DAG 或另一份 Task 状态机。

## Package 与权威

| 位置 | 工作 |
| --- | --- |
| bot/domain、application、ports | 项目/任务归属、ready 选择、依赖/完成规则、控制权让步与 Session 调用端口；保持零 IO、只依赖 protocol |
| host/bot、bot-dispatcher、scheduler | 真实调度、Context/memory 准备、Inbox claim/Run receipt/Outbox 接线 |
| agent-protocol | 执行绑定、任务调度请求/结果、来源 Thread 与可审计配置引用 |
| data | 复用现有 Task/Project 与 Bot inbox；增加 relation/route/dispatch snapshot 的缺失字段 |
| host/workspace、既有 integration | 提供隔离目录/checkout、repository/branch 事实；本模块不实现 VCS merge |

bot 包不直接 import Runtime。Host 将 Runtime Session API 装配成 Bot 端口；Bot 根据任务状态决定调用，模型思考仍在协调 Session 中运行。

## PR 切片与进度

### R3.1：项目 brief、任务与执行绑定

- [ ] 核实既有任务实体，冻结每个状态/ID 的 authority；Task 引用验收条件、依赖、优先级与 capability/context 配置。
- [ ] 将用户确认的 Project brief 持久化并给版本；Bot 先输出小批可审查任务与必要依赖，支持修改/取消，不要求每个请求自动拆成多 Agent。
- [ ] 建立最小 Project/Task execution binding：owner/bot/project/task、endpoint/host、repository、workspace/cwd、sessionId、Session 复用策略与 source thread。
- [ ] 一个 Task 关联多次 Run；互不相关任务默认不同 Session，复用条件明确。不要把 sessionId 当作全局任务 ID。
- [ ] 保留 bot:<id> 协调默认入口和旧渠道输入，只有持久绑定确认后才路由到工作 Session。

### R3.2：受限并行与精确派发

- [ ] Bot 协调 Session 获得窄管理工具：列任务、创建/查询绑定、派发/查询 Session、请求审批；每次调用经 Host 授权。
- [ ] 结合任务依赖、用户接管状态、Session busy、Host 资源与 Bot concurrency limit 选择 ready 工作。
- [ ] 写任务先取得隔离 checkout/branch 与 ownership；共享可写目录使用同一 serial lane，不能只按 sessionId 加锁。
- [ ] 任务输入在 claim 中保存 target Session、binding revision、配置引用与 Run dispatch receipt；dispatch 前原子重验控制租约和 route。
- [ ] 调度结果丢失时使用原 requestId/receipt 查询已创建 Run；旧 scheduler owner epoch、fence、redrive 和 terminal settlement 保持一致。
- [ ] 组合父任务授权上限、Project policy 与 Task 配置，子任务不能因新建 Session 获得更大权限。

### R3.3：反馈、完成与恢复

- [ ] Session 的进度/阻塞/结果按任务关联进入 Bot Activity；协调 Session 被唤醒处理关键事件，不转发所有 token。
- [ ] Run 完成只结算执行事实；Task 是否满足验收、是否等待 review/merge、消息是否 delivered 分别判定。
- [ ] 用户介入工作 Session 时 Bot 暂停该 Session 的新指导、重试和中断；release 后读取用户输入、Run、待处理事件再决定下一步。
- [ ] Bot 协调 Session 重建/压缩或 Host 重启后，按任务、claim、receipt、Run 和 Outbox 对账，保留未知事实。
- [ ] 任务取消/依赖失败/route 撤销有明确级联范围；不取消无关任务或盲重派已开始工作。

## 验收

| 场景 | 预期 |
| --- | --- |
| 一个 Bot、两个 Project | 任务、记忆、工具配置和执行绑定可区分，无跨项目隐式注入 |
| 一个项目两个独立 Task | 两个 Session/checkout 并行，受 Host/Bot 并发限制 |
| 同目录两个写任务 | 第二个等待或明确拒绝，不同时覆盖代码 |
| 有依赖的任务 | 依赖满足后才启动；失败后按项目规则阻塞/重规划 |
| Task 多次反馈 | 后续 Run 仍关联原任务与 Session，PR 归属保持稳定 |
| 用户接管其中一个 Session | 另一个任务可继续；被接管任务不收到新的 Bot 指令 |
| claim 后绑定/租约变化 | 旧 revision 派发被拒或对账，不能送到错误 Session |
| 启动成功但 receipt 响应丢失 | 原 Run 被找到，不新增重复执行 |
| 协调 Session 更换或 Bot 重启 | botId/项目/任务关系保留，既有 Run 继续被跟踪 |
| 旧 Bot 用户 | 未绑定消息仍使用 bot:<id>，Inbox/Outbox 语义不回归 |

## 验证、迁移与回退

纯规则通过 bot 包端口测试验证；Host 用现有 bot-dispatcher、Inbox/scheduler/receipt、Session delegation、workspace ownership 测试验证真实接线，再完成双 Worker 的本机并行场景和重启对账。

已有回归起点如下；增加的新任务规则/并发场景与受影响生产调用者一并执行：

    npx vitest run packages/bot/tests
    npx vitest run packages/host/tests/bot-dispatcher.test.ts packages/host/tests/session-delegation-authority.test.ts packages/host/tests/workspace/session-checkout-service.test.ts

关系字段采用 additive migration。回退时暂停新的多 Session 调度，已有任务绑定和 Run 继续可查询；协调入口回到旧默认 Session，但不能把在途工作重发到该入口。

## 验证记录与接续

本模块未实施，未运行产品测试。具体任务 authority 与 schema 由 R3.1 根据当前代码冻结。

下一步：R1/R2 完成后提交既有任务实体与 execution binding diff，先实现两个手动确认任务的闭环，再启用协调 Session 的受限拆分工具。
