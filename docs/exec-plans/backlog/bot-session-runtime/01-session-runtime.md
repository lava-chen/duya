# R1：完整 Session Runtime 与 Host 收敛

状态：backlog · 负责人：待认领 · 更新：2026-11-01
规划 base / worktree 见[总入口](../2026-11-01-bot-session-coordination.md)；实施时在此登记 branch / base / owner / 独占路径。
前置：[00 合同](00-package-and-protocol-contracts.md)。后续：[R2](02-capability-context.md)、[R3](03-bot-coordination.md)。

## 目标与边界

Bot、TUI 和 Desktop 使用同一 Session 服务进行创建、历史恢复、Run 执行、输入、观察和取消。通用行为位于 agent-runtime/src/session；Host 提供存储、可信准入、Worker 和网络适配。保留已有引擎与 durable terminal 语义。

本模块先完成本机服务，不新增 package。跨进程 Worker 支持通过端口进入服务；不要求为抽取而改成所有会话同进程执行。

## 当前接缝与归属

| 当前路径 | 处理 |
| --- | --- |
| host/src/worker-session-runtime.ts | 先拆依赖；通用 Session 状态和 Run 装配行为迁入 Runtime，Bot/配置/IO 通过端口注入 |
| host/src/worker-session-history.ts、worker-session/persistence.ts | 抽取历史恢复的操作次序；具体 DB/transcript/文件操作保持 Host/data 适配 |
| host/src/worker-engine-driver.ts、worker-run-session-port.ts | 迁入通用 Session→Engine 的桥接与必要类型；移除 Host 私有实现类型后再迁文件 |
| host/src/worker-session-assembly-ports.ts | 复用现有端口，按最小缺口细化；不直接注入整个 Host |
| host/src/session-api.ts、local-session-api.ts、session-service.ts | 兼容 façade/适配；已有 child session 服务复用新的通用入口 |
| host/src/run-orchestrator.ts、run-control-plane.ts、manifest-factory.ts | 先保留可信准入、receipt、事件持久化与终态 barrier；以窄 admission 端口接 Runtime |
| host/src/worker-manager.ts、worker-process-entry.ts、worker-transport.ts | 保留进程/传输；提取命令处理中的通用 Session handler 后由现入口调用 |
| host/src/worker-session-registry.ts | 保留进程观察/故障投影；Session busy 读取活动 Run，避免双写生命周期 |
| agent-runtime/src/run-session.ts、controller.ts、engine/* | 复用既有 Run 语义；新增 Session service 不另造 Run ledger/状态机 |

## PR 切片与进度

### R1.0：调用链、权威与合同审计

- [ ] 追踪 TUI、Desktop、Bot、child Session 各自 create/start/steer/cancel/history/replay 的真实生产调用链。
- [ ] 标注 RunController/RunSession、Host orchestrator、WorkerSessionRegistry 各自状态；为每个身份、receipt、seq、终态和执行 owner 指定单写者。
- [ ] 查明 canonical buildRunManifest 与 synthesized legacy 路径是否被 Bot/Worker 使用，列出迁移调用者，不用旧注释替代证据。
- [ ] 盘点 mailbox/input/Session handoff/客户端租约的真实语义，确定哪些可复用、哪些需要补合同；区分用户调度权与 Worker execution fence。
- [ ] 提交 additive protocol/端口草案、调用者矩阵和必要数据迁移；未执行 Runtime 迁移的条目保持未完成。

完成判据：能从具体客户端入口走到 Engine 和 durable terminal，并证明迁移后每个事实只有一个 authority。R2 可基于该合同开始配置设计。

### R1.1：Session 服务与依赖注入

- [ ] 在 agent-runtime/src/session 建立服务与公开 subpath，优先组合已有 Session/Run DTO、RunPersistence 和引擎端口。
- [ ] 将通用历史恢复、Session 操作次序和 Engine 桥接迁入 Runtime；Bot prompt/memory、全局 profile loader、DB、模型客户端改由 Host 提供。
- [ ] 服务通过 admission 端口请求启动；Host 冻结 manifest、保存 receipt 并创建 Run 身份，Runtime 不自行重复准入。
- [ ] admission adapter 调用现有控制面原子操作，不能回调已经转发 Runtime 的公开 start 入口形成递归；Worker handler 与客户端服务各自的调用方向有测试证明。
- [ ] Host 原入口先转发新服务，迁一个调用方验一个；已迁调用方关闭旧独立调度路径。
- [ ] 导出、依赖声明和 Worker bundle 引用同步更新，保持 Runtime 不反向导入 Host/data/ai/bot/Electron。

### R1.2：统一输入与用户控制

- [ ] 将 TUI mailbox、Host start/steer/queue 连接到同一个输入服务，接收 actor/source、requestId、expected Run/turn、attachments/context refs。
- [ ] 先核对既有持久 mailbox/receipt 是否足够；补齐原子 dedup、输入顺序与恢复游标，避免新增第二份 transcript。
- [ ] 明确输入持久接收、排队、交付、消费和拒绝的回执；不支持 steer 时排队到安全边界。
- [ ] 实现持久 user-control lease/revision，与 Bot 准入在 dispatch 前原子重验；观察状态不取得调度权。
- [ ] release、lease expiry、进程重启时对账最新 Run/输入后恢复；既有工具继续，取消仍经现有控制路径。

### R1.3：真实调用迁移与收口

- [ ] TUI、Desktop、Bot 和 child Session 调用统一服务；迁完后列出仅兼容转发的旧入口。
- [ ] 保持 Worker restart、stream replay、Session archive/fork、权限响应和执行位置 fence 行为；不将进程事件写成 Task 完成。
- [ ] 对真实 Worker 证明新服务实际到达 RunEngine，记录取消、重放和终态持久化证据。
- [ ] 更新 Runtime/Host 的 package 指南、架构图和依赖门禁；只在消费者清零后删除兼容代码。

## 验收

| 场景 | 预期 |
| --- | --- |
| 无 Bot 的 Session 客户端 | 创建、发送、观察、取消和恢复均能通过新服务完成，真实 Worker 使用既有 Engine |
| 同 Session 并发输入 | 顺序可恢复；重复 requestId 不重复执行；同一 Session 保持单一活动执行 owner |
| TUI 与 Desktop 共同访问 | 读取同一 transcript/Run；断线后按游标续订，无第二套历史 |
| expected Run/turn 过期 | 明确拒绝或要求重读，不把指令送入另一轮 |
| 用户接管 | 只读查看无副作用；开始协作阻止 Bot 新指令，不取消已启动工具 |
| 启动回执丢失 | 读取既有 receipt/Run 对账，不再启动一个 Run |
| Worker/Host 重启 | 已接纳输入和终态可查询，unknown 不冒充成功 |
| 旧 Session / Run | 历史、archive/fork、恢复和 fingerprint 继续可读 |

## 验证与迁移

实施时优先覆盖现有 engine、run-terminal-release、worker-session-history、session-service、bot-dispatcher、Session HTTP/Worker 测试；新用例针对顺序、重复输入、接管与崩溃窗口，验证真实调用路径。然后执行 typecheck:all、architecture:check；Worker/bundle 导入变化按构建指南验证打包。

已存在的起始测试命令如下；先按构建指南准备当前检出的产物/SQLite ABI，再按实际 diff 补充新的输入/租约用例：

    npx vitest run packages/agent-runtime/test/run-engine-loop.test.ts packages/agent-runtime/test/run-terminal-release.test.ts
    npx vitest run packages/host/tests/worker-session-history.test.ts packages/host/tests/session-service.test.ts packages/host/tests/worker-db-bridge-session.test.ts
    npm run typecheck:all
    npm run architecture:check

旧 API 保持可调用，内部转发统一服务。回退只在 Session 无在途执行时切换入口；已有 Run/输入数据继续保留并通过 receipt 对账。schema additive，迁移编号在开工时确认。

## 验证记录与接续

本模块未实施，未运行产品测试。规划的源码接缝来自总入口代码基线。

下一步：执行 R1.0 并提交生产调用者/单写者矩阵与最小协议 diff；完成该片后登记 SHA、命令、结果和 PR。
