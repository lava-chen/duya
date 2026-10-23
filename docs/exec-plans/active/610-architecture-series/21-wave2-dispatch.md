# 21 — Wave 2 派工补充

2026-10-18；源码快照 `origin/master @ e87cfa8a`。
本文件细化 [19](19-fast-track-queue.md) 的 T20–T23，不另建执行队列或完成状态表。
本轮已实现 T20 的 Host 服务与真实 worker 接线；完成状态以本文末尾的实测记录为准。
尚未实施 T21/T22/T23，不把接口单测写成产品链路验收。

2026-10-19 再验证：#299 已合（`bed05724`）。#302 已整合当时最新 master
（含 Wave 1 收口、workspace file API、T30 和 T40a）；源码自动合并，
两个 worker bundle 生成产物冲突由同一合并源码重建解决。真实父子 worker + 权限/原生台账
14 文件 **57/57**；`typecheck:all` exit 0；`architecture:check` 2784/2784，
baseline 932 未改。同期补齐 Web workspace 缺失的 Node types 锁条目；
在没有 junction/node_modules 的 manifest 临时目录以 npm ci dry-run 验证，未改共享依赖树。
这次只收口可合入的 T20 服务/真实接线，不提前勾选 T21/T22/T23。

## 分工

用户已有 agent 全权负责 Wave 0/1。按 T00–T16 归它的口径避让：不重做
RunSession、TUI reducer、能力 hello、CLI 闭包门禁或 CI 清债，不改其 19 计划状态。
最新远端已合 #280，后续 Wave 1 PR 已推进到 #298；本地主检出落后且很脏，不能拿它验收。

本协调者负责 Wave 2 的任务拆分、公共接缝、集成和验收；实现使用独占文件的 agent。
使用 gpt-6-luna high 按独占文件并行完成服务、故障测试和真实 worker 验收；
公共接线由协调者串行修改，另一次只读审查核对身份、预算、取消和生产调用点。

Wave 1 owner 的最新交接：T10/T13/T14 完成；T11 投影与接缝已合
#291/#292/#294，渲染源开关有意不翻；T12 前置接缝 #296 已合，真 PTY 尚未验收；
T15 已落地，专用读文件路由仍是接缝请求。本文不接管这些文件或产品决定。

| 车道 | 现在能做 | 第一个用户可见结果 | 依赖 |
| --- | --- | --- | --- |
| Host/Bot | T20a 服务与身份合同，然后 T20b 接真实 worker | Desktop 关闭时，父会话启动两个子会话，追问一个、取消另一个，并查询对应 run 结果 | T00 已落；不等待 T11/T12 全收口 |
| 可靠事件输入 | 对 stdout 队列做 native event 压力故障注入 | 慢消费者不能使 run 在静默丢 durable 事件后仍声称成功 | 与 T20a 可并行；修法确认后接 Desktop intake |
| Desktop | T23 的相同输入/业务状态对照测试及小型 adapter | 一个真实 Desktop turn 的 text/tool/turn 由共享状态驱动 | 开关上线依赖可靠输入与原生 live feed；不改 Wave 1 的 client-core |

## A. T20a → T20b：独立 Host 子会话

基线调用链：`SessionTool → worker-tool-services/session-management → sessionSpawnDb
→ worker-db-bridge`。最后一跳缺少 `session:spawn*` 分支，落到 `unimplemented_domain`。
Desktop 的创建和管理实现在 `apps/desktop/src/main/agents/db-bridge.ts:664`、`:763` 起。

**T20a 独占**：新建 `packages/host/src/session-service.ts` 与
`packages/host/tests/session-service.test.ts`。约定内部 typed 接口，先不扩公共协议。
复用 Host Session API 的父子关系记录、`SessionStore`、`SpawnEdgeStore` 和现有 Run API。
child-run launcher 注入现有 Host 执行入口；不得另起一个引擎或把子任务放回父 worker 内执行。

首测目标：两个 spawn 返回不同的 child session/run 标识；受控 launcher 完成后 list/get
返回各自结果。拒绝跨父操作、无效父节点、未授权工作区、启动失败伪装成功。
新服务尚不存在时先得到合同失败；不得先写实现再补一份镜像测试。

**T20b 公共文件由协调者串行合入**：`worker-db-bridge.ts`、`run-execution.ts`、
`local-host.ts`，以及必要的现有 worker session adapter。其他 agent 不同时编辑这些文件。
真实 worker 发出的 spawn 请求必须接到服务，不能只证明测试直接调用服务成功。
验收复用 #280 的确定性 HTTP provider + 生产 bundle 模式，不需要真实模型凭证。

身份规则：Host 从可信 worker 连接取得调用方，拒绝 payload 自报的 caller/parent 冒用。
接缝需同时明确旧 worker/被撤销 attempt 的消息如何拒绝，不能替旧消息套上当前 run 身份。
workspace、permission、provider/model、预算继承逐项显式约定；管理操作只作用于直接子节点。
取消绑定受理时的 child runId，不能因为同一 child session 已开始新 run 就误杀新任务。
返回 child sessionId、runId 与可追踪受理身份，不以一个 sessionId 冒充任务完成身份。

验收命令：`npx vitest run packages/host/tests/session-service.test.ts`，再跑新建的
真实 worker 子会话整链路测试及 Host 类型检查。只允许把这一范围内的通过写成完成。
回退：撤掉新增 bridge 分支与服务；不改已有 session schema，不删除已有父子关系数据。

## B. T23 前置：可靠 native intake

已运行复现：`worker-transport.ts:21-44` 的有界 stdout 队列溢出时无差别
移除旧帧；`sendToMain` 镜像 IPC，但 Desktop IPC handler 未接 run:event。
基线 `worker-transport-write-queue.test.ts` 只覆盖可裁剪的 chat:text。
新增两个普通失败断言：2101 帧压力丢 seq 2–101；80 个大信封跨字符上限丢 seq 2–11。
这是 stdout 队列故障证据，尚未修复，也不是 Desktop 端到端证明；不混入 T20 的提交。
复现补丁保存在 [21-native-pressure.patch](evidence/21-native-pressure.patch)，未应用到
T20 分支的测试文件。下一位 owner 在隔离分支 `git apply` 后运行该测试即可复现。

独占 `packages/host/src/worker-transport.ts` 与现有队列测试文件。先注入 stdout 停滞，
混入超过 2,000 帧及 4 MiB 的 native/legacy 消息，证明 durable 信封不会无声消失。
队列错误必须在真实 Host 终态上可观察；不能只测一个数组保住了事件。

修法由预检和红测决定：可靠独立通道、背压，或可观测的 fail-closed；不把无界内存队列
包装成可靠性。`sendEvent(): void` 今天不能承诺 await 背压。
若需要改 Desktop router/worker bootstrap，由协调者领取公共文件，不与 A 车道混写。
保持 envelope 的 runId/seq/epoch 原值。数字 seq 可因 ephemeral 缺席而稀疏，不能猜空洞。

2026-10-22 实现 owner：`fix/durable-worker-transport`，基于 `96dadf4d`
（`/tmp/duya-durable-transport` 独立 worktree）。仅改本节授权的
`packages/host/src/worker-transport.ts` 与 `packages/host/tests/worker-transport-write-queue.test.ts`。
stdout 背压时只淘汰 `chat:text_delta`、`chat:thinking_delta`、`chat:tool_use_delta`；
native `run:event` 与其他控制/结果帧无法留在有界队列时，记录错误并以 exit 70 结束 worker。
队列测试断言帧数和字符数上限下不会静默删 native event，且完成帧保留；Host 故障测试另
确认无事件 worker 经 settle 后得到非成功 durable terminal。未改变 envelope 的 runId/seq/epoch。

具名验证：`npm exec vitest -- run packages/host/tests/worker-transport-write-queue.test.ts`
6/6；`npm exec vitest -- run packages/host/tests/worker-product-runtime/native-channel-faults.test.ts`
4/4；`git diff --check` 通过。Host typecheck 未通过验证：首次无依赖构建时 workspace
模块未解析；全量 `build:packages` 被既有 `@duya/ui` → `@duya/client-core` 声明解析错误挡住；
Host 依赖闭包构建随后被 `@duya/capabilities` → `@duya/sandbox` 和 `picomatch` 声明解析错误挡住。
因此不记 Host typecheck 为通过，也未声称真实 Desktop SSE/IPC 端到端已验收。

2026-10-23 复核 owner：`fix/durable-worker-transport` 重放到 `af6e7eb6`
（`master`，原基线 `96dadf4d`）。重放无冲突：master 已删除 conductor / browser /
computer-use 等子树，本分支未触碰这些路径。分支提交 `a2477781` 保留原实现语义。
架构门禁 `npm run architecture:check` 通过（2608 total / 2608 tolerated / 0 new）；
baseline 另有 255 条 master 删除代码后失效的旧指纹，属 master 既有债务，未重录、未新增指纹。
worker bundle 因 `worker-transport.ts` 变更而失效，按 `npm run bundle:worker` 重新生成并
随本提交一起入库，`npm run bundle:verify` 由 STALE 转为 fresh。

具名验证：`npx vitest run packages/host/tests/worker-transport-write-queue.test.ts` 6/6；
`npx vitest run packages/host/tests` 176 文件 / 1631 通过 / 1 skipped；`npm run typecheck:all`
退出码 0。仍未声称真实 Desktop SSE/IPC 端到端已验收。

## C. T23：Desktop 的第一个共享状态消费者

独占 renderer 的新 adapter、`stream-session-manager.ts` 与
`lib/__tests__/stream-session-shared.test.ts`；保留通知、窗口、rAF、preload 的平台职责。
先比较同一录制 text/tool/turn 输入在 Desktop 与共享 RunSession 的业务状态，覆盖错序与重复。
不同 UI 允许呈现差异；不可重新实现一份去重、排序与终态裁决。

接开关前必须明确原生实时来源：Desktop 的当前 SSE 是 legacy callbacks，router 会把
run:event 从 SSE 剔除并入持久化队列。不能直接把 legacy frame 强转成 RunEventEnvelope。
若通过 Host 原生 run stream，复用现有鉴权与 run 身份；若新增转发接缝，须由 transport
owner 审查。durable window 用于重连补齐；ephemeral text delta 需要 live feed，不能靠台账恢复。

真实验收：`npm run electron:build` 后运行 `npm run test:e2e:turn`，验证工具与审批。
构建受环境阻挡时保留对照测试成果，明确未完成 Electron 验收，不用 Vite 预览冒充。
回退：撤下 Desktop 新 adapter 的接线；保留旧展示路径直至真实验证通过。

## 后续顺序与调度规则

- T20b 后接 T21，把 Desktop 的 spawn 业务实现退化为 Host 转发；不要一次搬整个 db-bridge。
- T22 在受理身份稳定后做结果投递与重启对账。先复用/评估现有 mailbox 与 pending-wake。
  `packages/memory/src/outbox.ts` 是 DB→文件投影队列，不能因同名直接拿来当 Bot 消息 outbox。
- 第一阶段不承诺执行 resume、外部副作用 exactly-once 或父取消自动级联；这些要另写明确合同。
- mcode/MiniMax 适合按冻结接口写 fixture 与故障测试；身份、权限、取消和入账边界由主协调者复核。
- 每个实现切片独立 PR；具名测试结果、commit、生产调用方缺一不宣称 done。
  仅接口设计/源代码预检不算运行通过，历史全仓 CI 红不阻塞独立切片实施。
- Web / Plugin Mini App 后续再进入真实消费者验收；这轮不抽共享 React UI，也不引入 Rust 桥。

## 本轮实现与验收记录

T20a 服务复用已有 Session API、SpawnEdgeStore、RunStore，无 schema 迁移。
T20b 生产链路为 `SessionTool → worker DB IPC → HostRunExecutionController
→ HostSessionService → 同一个 HostRunExecutionController → 独立 child worker`。
服务保存最近一次受理的 child runId；get 从该 run 的 durable 事件读取结果；
reply 串行受理且拒绝仍在执行的 child；cancel 只取消捕获的那个 runId。

边界约定：

- Host 验证连接所属 session、捕获的 runId/epoch 和当前运行状态；拒绝缺上下文、
  冒用 session、旧 attempt、被替换 worker 的请求，不能用当前 run 替旧消息补身份。
  worker 允许旧 Desktop bridge 收到不含 execution 的消息，保持原有 interagent 调用兼容；
  拒绝缺身份的权威边界在独立 Host 接收端，不通过伪造上下文放行。
- child 继承 workspace 绑定、provider、permission/profile/mode；当前只允许同一规范化
  working directory。可覆盖 model，但不由模型自选 provider 或提升权限。
- child 的 manifest 继承父 maxTurns 上限，台账记录 parentRunId 和 agent origin。
  这是每个 child 的轮次上限继承，尚非跨所有后代共享的总预算。
- 受理后保存 run 身份失败会取消该具体 run，写失败回执；补偿失败也在回执中说明。
- 完成回执显式为 query，父模型通过 get 取结果；T22 自动唤醒/重启投递未实现。

运行发现并修复的接缝：

1. 首个 chat:start 自初始化后同步等待整轮，导致 stdin 读不到审批/interrupt；
   现在转入已有非阻塞 admission 路径。
2. Session API 默认隐藏 child，导致 list 可见而 get/reply 拒绝；内部查询显式
   includeAllSessions，随后仍核对直接 parentSessionId。单测模拟真实的默认隐藏行为。
3. SessionTool 旧文案一律承诺自动唤醒，现按 Host 返回的 completion policy 呈现；
   get 的真实文本结果包含 tracked runId 和输出，避免只在测试侧查询到结果。
4. 独立 Host 只接 IPC，未消费 worker 同时镜像输出的 stdout；长 turn 在 Windows
   堵满管道后同步卡住。Standalone controller 创建 worker 后显式 resume stdout；
   不给 Desktop 的 stdout tee 增加第二个事件消费/持久化入口。

当前具名检查：

- 2026-10-19 最终合跑：上述服务/权限/真实 worker/receipt/台账/传输回归
  **14 文件，57/57**；临时 stdout 排空变异已恢复，临时生产日志已移除。
- `session-service.test.ts`：10/10，通过隐藏 child、并发 reply、分页、过期父 attempt、
  启动拒绝和 accepted-run 身份保存抛错补偿。
- `worker-db-authority.test.ts`：2/2；`session-delegation-authority.test.ts`：1/1；
  `worker-manager-delegation.test.ts`：1/1，含旧 worker 被替换后仍有后台任务的路径。
- 与 `run-execution.test.ts`、`worker-db-client-transport.test.ts`、
  `session-receipts.test.ts` 合跑：7 文件 27/27。
- `host-child-sessions.test.ts` + `run-execution.test.ts`：最终 2 文件 9/9。
  真生产 bundle / HTTP provider / Host / SQLite：父模型先发现 deferred session 工具，
  通过真实 HTTP 审批后 spawn 两个独立 session，追问一个、取消另一个，get 取回
  对应 run 的最终输出，list 看到完成/取消状态，父 run 最后 completed。
  所有 child run 的 parentRunId、agent origin 和 maxTurns=16 均有非条件断言。
- stdout 回归：子进程必须排完 8 MiB stdout 才发送 IPC 终态；删掉 resume 后
  running≠completed 转红，恢复后通过。临时生产诊断和 stdout tap 已撤除。
- capability 既有 session 工具与 receipt/context 回归：3 文件 11/11。
- native ledger/fault/queue/subprocess 回归：最终 4 文件 19/19。
  首次 18/19 的一条是显式 durable 测试清单漏列 turn.completed，实际台账有两个这样的事件。
  将该类型加入独立的硬编码期望清单后，原来的完整 seq 对比与重复投递断言均通过；
  未改生产持久性判断，未放宽断言或重录 baseline。
- `architecture:check`：exit 0，2764/2764 tolerated，baseline 932 未重录。
- `typecheck:all`：最终 exit 0；electron ratchet 231 known / 0 new。
- Host worker bundle 已重建；没有用假 worker 替代上述整链路中的生产 emit。
- Electron build 主体尝试：`npm --ignore-scripts run electron:build` 在
  build:cli-bundle 失败，首个错误为 `@puppeteer/browsers` 找不到 proxy-agent。
  为避免改变其他 agent 正在使用的共享 SQLite ABI，跳过 lifecycle prehook；
  未修改依赖或伪造 external。没有完成 Electron 构建或真实界面验收。
- T20a checkpoint：`8c242f89` / [PR #299](https://github.com/lava-chen/duya/pull/299)。
  此服务切片本身无生产接线，不单独宣称完整 T20 完成。

另一个真实观察留给终态/live owner：取消 child 时台账已正确为 cancelled，但日志出现
`durable terminal is not the one this event describes`，被持有的类型为 run.completed。
当前 get/list 从 durable 读取所以链路通过；不可据此宣称取消终态的 live 发布已验收。
T22 / 原生 live 消费者接线前须复核该映射并补真实取消订阅测试。

下一步顺序：T20 真链路证据收口 → T21 Desktop delegation 转发与 T22 结果投递
可分工并行；可靠 native intake 修复后再翻 T23 共享状态消费者开关。
不要以 Wave 1 reducer 删除或历史全仓红测作为 T20–T22 的前置条件。

下一轮可直接派的独占范围：

| 任务 | 独占文件 | 第一个验收结果 |
| --- | --- | --- |
| T21 Desktop 转发 | Desktop db-bridge 的 session:spawn* 段及对应 adapter 测试；需要的 Host API 接缝由协调者单写 | 从实际 Desktop 调用点创建 child，由同一 Host service 受理；get/reply/cancel 对同一个 child run 生效 |
| T22 结果投递 | 先新增 Host delivery service 与故障测试；mailbox/pending-wake 接缝集中处理 | 父会话先结束，child 后完成；重启 Host 后结果仍可查询且只确认一次交付，不冒充副作用 exactly-once |
| 可靠 native 输入 | 先应用本文 evidence 补丁，独占 worker-transport 测试/实现；Desktop intake 公共文件另申请接缝 | 背压下 durable 信封保身份或明确失败；真 Host 终态可观察，不以数组保留量代替验收 |

三条车道可以并行，不同时修改 run-api / run-orchestrator / worker-process-entry；
Desktop shared state 开关仍待可靠输入与重连路径，Wave 1 owner 的既有决定保持。
