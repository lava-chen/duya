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

- [x] 追踪 TUI、Desktop、Bot、child Session 各自 create/start/steer/cancel/history/replay 的真实生产调用链。
- [x] 标注 RunController/RunSession、Host orchestrator、WorkerSessionRegistry 各自状态；为每个身份、receipt、seq、终态和执行 owner 指定单写者。
- [x] 查明 canonical buildRunManifest 与 synthesized legacy 路径是否被 Bot/Worker 使用，列出迁移调用者，不用旧注释替代证据。
- [x] 盘点 mailbox/input/Session handoff/客户端租约的真实语义，确定哪些可复用、哪些需要补合同；区分用户调度权与 Worker execution fence。
- [x] 提交 additive protocol/端口草案、调用者矩阵和必要数据迁移；未执行 Runtime 迁移的条目保持未完成。

完成判据：能从具体客户端入口走到 Engine 和 durable terminal，并证明迁移后每个事实只有一个 authority。R2 可基于该合同开始配置设计。

审计产出：[R1.0 审计](r1-0-audit.md)。已登记的五条待裁决项 C1–C6（wire stage 降维、`steerAgentRun` 声明无实现、客户端直写 timeline、CLI 与 Desktop 历史投影不一致、Desktop 直调 `openRun`、协议重复声明）与四处双写/旁路，是 R1.1 与 R1.3 的收敛清单。R2 可基于本审计的配置结论开始。

### R1.1：Session 服务与依赖注入

- [x] 在 agent-runtime/src/session 建立服务与公开 subpath，优先组合已有 Session/Run DTO、RunPersistence 和引擎端口。（PR #574）
- [ ] 将通用历史恢复、Session 操作次序和 Engine 桥接迁入 Runtime；Bot prompt/memory、全局 profile loader、DB、模型客户端改由 Host 提供。（历史恢复与操作次序已迁入 PR #574；Engine 桥接的**引擎核心**已迁入 PR #578，**适配层**未迁——见下方「Engine 桥接迁移的边界」）
- [x] 服务通过 admission 端口请求启动；Host 冻结 manifest、保存 receipt 并创建 Run 身份，Runtime 不自行重复准入。（三态端口 PR #574；Host 适配器接线 PR #577）
- [x] admission adapter 调用现有控制面原子操作，不能回调已经转发 Runtime 的公开 start 入口形成递归；Worker handler 与客户端服务各自的调用方向有测试证明。（PR #577：适配器独占 `openRun`，`session-entry-guards.test.ts` 断言全仓只有该文件触达控制面起跑入口）
- [x] Host 原入口先转发新服务，迁一个调用方验一个；已迁调用方关闭旧独立调度路径。（`worker-process-entry` PR #574；`run-execution.ts` 与 Desktop 的 `openRun` 直调 PR #577 收敛，Desktop 改走同一 session service）
- [x] 导出、依赖声明和 Worker bundle 引用同步更新，保持 Runtime 不反向导入 Host/data/ai/bot/Electron。（PR #574）

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

审计已执行：基线 master `95c30f58`，五条只读代码调查（CLI/TUI、Desktop、Bot、Host 控制面、data/protocol），产出见 [R1.0 审计](r1-0-audit.md)。本片未改产品代码，未运行产品测试。

R1.1 第一个切片已实施：分支 `codex/bot-session-runtime-r1-1`（base `codex/bot-session-runtime-r1-0`，堆叠 PR #574），新增 `packages/agent-runtime/src/session/`（ports / history / service / index）与公开 subpath，Host 侧改为转发层并迁 `worker-process-entry` 一个调用方。验证：agent-runtime 115 文件 / 1221 用例、host 243 文件 / 2179 用例，均 0 失败；`typecheck:runtime`、`typecheck:cli`、`architecture:check`、`bundle:verify` 全绿。#574 已合并（`56d42535`），合并前在 master 上重建了分支与 bundle。

R1.1 第二个切片已实施：分支 `codex/bot-session-unified-entry`（base `master` `56d42535`，PR #577）。三处改动同源：Runtime 准入结果带命名 stage；Host 新增 `packages/host/src/session-admission.ts` 作为唯一准入适配器（独占控制面 `openRun`，不再回调已转发 Runtime 的公开 start 入口）；Desktop router 改走同一 session service，不再自行判定拒绝语义。C1 已修：wire 新增 `refused_session_busy` / `refused_run_already_exists` / `refused_run_not_created` / `refused_run_not_durable` / `refused_dispatch_threw`，"等一等 / 按回执对账 / 重试并告警"三种下一步不再同名。准入端口改为对请求类型泛型（`SessionRunRequest` 为默认形），Host 传自己解析好的 turn。验证：host + agent-runtime 362 文件 / 3426 用例、desktop server 15 文件 / 147 用例，均 0 失败；`typecheck:electron` 无新增类型错误、`typecheck:runtime` exit 0、`architecture:check` 无新增违规、`bundle:verify` FRESH。新增真实 Worker 端到端测试（`packages/host/tests/session-admission-e2e.test.ts`）与结构守卫（`session-entry-guards.test.ts`）。

#577 的 CI 首轮 `41393157489` 在 `packages/agent-protocol/test/13-citation-drift.test.ts` 失败：#577 重写 Desktop router 后，协议包注释里指向 router 的 10 处 `file:line` 锚点整体位移。门禁只捕获同一行有反引号符号的 7 处，另外 3 处（`envelope.ts:19`、`:31`、`run.ts:27`）同样失效但无锚点，一并修正。修协议包注释会使两个 bundle 输入文件变化，`bundle:verify` 随即报 STALE，故补一个 bundle 刷新 commit（`4229c62e`）。协议包是叶子包，改的只有注释。

### Engine 桥接迁移的边界

「Engine 桥接」在代码上分两层，边界不在文件而在**词汇表**：

| 层 | 文件 | 含 `@duya/ai` 词汇 |
| --- | --- | --- |
| 引擎核心 | `run-event-spine.ts` / `run-engine-execution.ts` / `worker-tool-ledger.ts` | 否 |
| 适配层 | `worker-engine-driver.ts` / `worker-run-composition.ts` / `worker-run-session-port.ts` / `worker-run-contracts.ts` | 是 |

`architecture-policy.yaml` 里 `agent-runtime` 的 `requires` 不含 `ai`，而 `worker-run-contracts.ts` 把 `@duya/ai` 的 `Message` / `MessageContent` / `SSEEvent` / `TokenUsage` 重导出成全仓词汇，`EngineProductSession`（25 个方法）也建在这套类型上。**把适配层搬进 Runtime 是一次 worker 消息词汇表迁移**：`@duya/agent-protocol/transcript` 有等价类型，但 `MessageContent` 联合成员是 6 个而 `@duya/ai` 是 4 个，形状不同，影响面横跨 `packages/ai` 的 provider 适配与 `packages/host` 的 turn 管线。

R1.1 第三个切片已实施：分支 `codex/bot-session-engine-bridge`（PR #578）。引擎核心三件迁入 `packages/agent-runtime/src/engine/`，Host 保留三个薄转发层保住已发布 subpath，`worker-engine-driver.ts` 与遗留 `packages/agent` 直接引 Runtime，ledger 测试随实现迁移到 `packages/agent-runtime/test/`。验证：host + agent-runtime 361 文件 / 3425 用例、0 失败；`typecheck:runtime` exit 0、`typecheck:electron` 无新增类型错误、`architecture:check` 无新增违规、`bundle:verify` FRESH。bundle 重建经 metafile 核对为**搬家不是漂移**：inputs 2051 → 2051，移出 3 条 host 路径、移入 3 条 runtime 路径，其余 2048 个输入 `bytesInOutput` 逐项相等。

R1.1 剩余：适配层（driver + composition + session port + contracts）仍在 Host，需先做 worker 消息词汇表迁移，见上表与「边界」段。R1.2 输入服务、R1.3 子会话收口（`worker-subagents/service.ts` 仍不过控制面）均未开始。
