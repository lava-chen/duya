# 18 — Runtime Harness 能力退化排查计划

Date: 2026-10-17. Parent: [610](README.md). Status: Ready for diagnosis.

用户明确症状：**工具调用或多步执行中途停下**。本轮只制定诊断与验收任务，不修改生产实现。
执行 agent 负责复现、取证和测试；本对话负责审阅根因、验证方法与后续修复方案。

## 0. 第一项任务与交付

**先执行 H0 + H1：用当前真实 worker 装配复现“工具 A → 读取 A 结果 → 工具 B → 核验最终结果”，
指出第一次丢失进展的边界。暂不重构，不自动加继续提示，不提高轮次上限。**

第一轮报告必须回答：

1. 用户看到停止时，worker 是退出、仍运行、等待工具、等待审批，还是模型已经正常结束？
2. 最后一次工具结果有没有被记录，并且进入下一次实际 provider 请求？
3. 谁决定不再继续？给出实际分支、停止原因与调用链，而非只说 `completed`。
4. 故障在哪个层级复现，尚未经过哪些生产边界？
5. 最小修复应落在哪个 owner，有没有可先失败再通过的行为测试？

证据写入本目录的 `18-runtime-harness-diagnostic-report.md`；报告尚未生成。
诊断测试按职责放到已有测试体系，优先复用既有 harness，不另造通用测试框架。

## 1. 范围、并行工作与快照

- 本文件是 17 的运行行为诊断旁支，不重排共享平台 S0–S9，也不另开架构迁移主线。
- 2026-10-17 勘察时 HEAD 为 `15fa4850`，前序存储切片为 `ac1f5183`；主检出有未提交的 S1 修复。
  `run-orchestrator.ts`、`run-control-plane.ts`、Desktop 接线及新故障/子进程测试都正在变化。
  **当前 HEAD 不等于当前运行源码，更不等于当前 bundle。** 后续必须重新核对。
- H0/H1 可与 S1 并行取证；不得覆盖 S1 文件。新增测试必须先确认文件所有权。
  修改共享生产代码前先报告最小修复范围，并按仓库隔离流程实施。
- 若环境提供 `workspace_get_context`，先读共享上下文和 open tasks；本次工具清单未暴露该入口，
  因此未读取共享任务状态，不能声称没有其他任务。
- 先读仓库 AGENTS、exec-plans 基线、ARCHITECTURE、587/610 与 17；旧基线不能当本次结果。
  CodeGraph 可用时先查真实调用；注释、函数名、类型存在不能代替生产运行证据。
- 不删除旧包、不迁语言、不换模型掩盖问题、不扩大 replay 范围。诊断阶段不默认修改生产逻辑。

## 2. 当前已知线索，不是根因结论

| 线索 | 已看到的源码 | 必须验证的事实 |
| --- | --- | --- |
| 生产装配仍有多段接缝 | `packages/host/src/worker-engine-driver.ts` → `worker-run-composition.ts` → `run-engine-execution.ts` → `packages/agent-runtime/src/engine/run-engine.ts` | 实际请求是否走这条链，当前运行产物是否包含它 |
| 工具结果与下一轮分属不同 port | composition 的 `turnOutput.onToolResult` 调用 session 记录，`createLegacyAssembleTurn` 重新读取 messages | 写入顺序、callId、结果内容和下一次请求是否一致，不能只断言回调触发 |
| 有合法提前停止分支 | engine 的 `#shouldStop` 在继续工具后续轮次之前检查 maxTurns 与重复调用保护 | 预算来源、计数和阈值是否符合冻结输入，保护是否误判了有进展的任务 |
| 完成状态不等于任务完成 | `#terminalCandidate` 将 `max_turns`、`repeated_tool_calls` 映射为 `completed`，另有解释文字 | 原因是否跨 envelope、Host、API、UI 保留；不能仅凭状态评价任务完成，也不直接改协议枚举 |
| orchestrator 有独立分支 | driver 的 `selectRunDriverLeg` 可转到 `orchestratorFramesFor` | 用户失败任务的 mode/profile 到底走哪一支，普通 engine 的绿测是否覆盖它 |
| 产品测试已存在 | `worker-product-runtime` 的 turn-loop、assembly、composition 等测试 | 哪些实际调用当前 engine，哪些仍是兼容模拟、源码断言或旧测试；不得重复造相同 fixture |
| S1 正在修事件与结算 | 上一轮审查指出 Desktop writer、提交确认、append 拒绝、终态 epoch 接线风险 | 本次快照是否已修；它们能影响观察和收敛，但尚无证据证明它们导致本次能力退化 |

历史 memory skill 提供“检查运行 owner 与生产边界”的方法；其中旧路径和按类名推断迁移状态的规则
不适用于直接判断当前实现。必须跟随当前 Host worker 的实际模型、工具和下一轮调用。

## 3. 用一条跨轮次证据链定位故障

```text
用户任务 / Host 冻结输入
  → 实际 worker + driver 分支
  → 第 N 轮 provider 请求（上下文 + 工具定义 + 参数）
  → provider 工具调用帧（callId、参数、stop reason）
  → schema / 授权 / ticket / 实际工具执行
  → 工具结果 drain → turn output → session history
  → 继续/结束判定 → 第 N+1 轮组装 → provider 实际收到结果
  → 后续动作与最终产物 → Runtime / Host / UI 结束状态
```

每次复现采集最小结构化时间线：runId、sessionId、attempt、turn、messageId、toolCallId、
checkpoint、事件来源、结果状态、等待对象、停止原因、取消来源、预算/消耗和关键时刻。
provider 边界记录协议、模型、实际生效的参数、messages 的 role/id/callId/长度/摘要校验、
工具名称集合及 catalog revision。**必须在生产 adapter 之后的请求边界确认，不只看装配前对象。**

合成 fixture 可保留无敏感测试内容用于精确断言；真实任务使用脱敏摘要，不写 token、私有正文或
思维内容，不新增默认记录完整 prompt 的生产日志。使用临时工作目录、独立数据根和合成工具，
不向真实账号发消息，不执行外部不可逆副作用。

把“中途停下”先分类，再解释：

- 已退出：正常模型结束 / 轮次或预算限制 / 重复调用保护 / 取消 / provider 或工具失败 / 进程崩溃。
- 未退出：等待工具 / 审批 / connector auth / hook / compaction / drain / 消费者背压。
- 仅界面结束：底层继续运行但事件流、连接或投影停止；对比 worker 与 UI 时间线。
- 模型确实无工具地结束：请求内容完整时归入模型决策或提示/策略问题，不等同于 harness 丢轮。
  runtime 不应为追求“持续工作”无限重开一个合法结束的请求。

## 4. 执行队列与验收

### H0 — 冻结可比较基线与实际入口

- [ ] 记录 SHA、dirty 文件/patch 范围、OS、Node、构建步骤、worker 可执行路径与产物摘要。
      若源码变动，标明本次结果属于哪个快照；不把另一位 agent 的后续修改混入一次结果。
- [ ] 确认 Desktop、standalone Host/CLI 各自的 start → worker → driver → engine 调用链。
      审计入口是否忽略用户选择的模型、provider、模式、权限或预算；eval 入口单独标注。
- [ ] 阅读现有测试，建立当前定向失败集合 `(file, test, error signature)`，区分确定性、环境和 flaky。
      不沿用“7 个既有红”等历史数字，不以总数持平表示无回归。
- [ ] 确认 bundle 与源码一致。共享主检出上不运行会覆盖他人产物的全量构建或 SQLite ABI 切换；
      需要构建/打包/故障注入时使用隔离环境，遵循仓库 worktree 依赖与清理规则。

验收：一张入口/产物/测试基线表；尚未拿到真实用户任务时明确使用合成复现，不能臆造用户案例。

### H1 — 优先复现工具后不继续

- [ ] 使用本机 loopback provider 驱动生产 worker。先做 A → B → final 三次模型请求：
      A 生成本次随机标记，B 必须读取 A 返回值并校验，再生成可独立核验的产物。
      fixture 仅在真实收到正确结果后才发下一调用，不能预置答案或直接调用 engine 补下一轮。
- [ ] 同一任务先过真实 driver 装配，再过真实子进程 stdout/IPC → Host；Desktop 使用其真实生产入口。
      每层独立记录结果；stub worker 不能签收真实 worker 边界，driver harness 不能签收 Desktop。
- [ ] 对比每一步的 provider 原始停止原因、解析后事件、工具队列、drain、记录结果与继续判定。
      缺少 N+1 请求时定位最后到达 checkpoint；请求存在时先检查结果是否丢失或被改写。
- [ ] 增加工具返回错误后修正重试、延迟结果、同轮多个工具、串联 3 次以上工具的确定性变体。
      覆盖合法拒绝/超时；安全边界触发时允许停止，但必须有准确、可观察的原因。
- [ ] 为暂停型故障设置测试 deadline，输出最后进展和等待对象；超时只能记 blocked/failed，不能记成功。
- [ ] 取得确定性结果后，用当前已配置 provider 做受控真实模型 smoke，模型/参数固定，
      只运行临时目录内的任务。不扩大为完整模型评测，单次失败不直接归因于 runtime。

验收：一个可复现故障或明确的“该场景未复现”，附实际下一轮请求及最先偏离的边界。
若未复现，继续收集 mode/provider/工具种类/任务长度等变量，不能为了交根因而猜一个。

### H2 — Harness 部件覆盖矩阵

H1 先定位主症状；下表逐行盘点已有证据，按风险补缺，不要求一次重写所有测试。
每行标明生产 owner/caller、已测场景、证据层级、失败变体和未覆盖项；可选 port 也要盘点，
“类型允许缺省”不等于本产品不需要它。

| 部件 | 行为验收重点 |
| --- | --- |
| 冻结输入与 session | prompt、cwd、历史、附件、profile、mode、模型和预算到实际请求；会话不串线 |
| Provider adapter | Anthropic/OpenAI 已支持路径的 tool call 完整/增量帧、stop reason、EOF、空响应、重试、上下文截断；错误不能变正常结束 |
| 工具发现与 schema | 模型可见集合、guard 允许集合、真实执行 registry 一致；deferred schema 获取后下一轮可调用；catalog 刷新不丢工具 |
| 工具执行与结果 | 参数与 callId、stream/drain、并行结果归属、重复/晚到结果、错误与超时；准确返回模型且不重复副作用 |
| 上下文与历史 | assistant tool_use 与 tool_result 成对、顺序正确；工作目标/指令/附件不被重建覆盖；结果不是只进 UI/DB 而没进模型 |
| 继续与停止 | 工具后续轮次、maxTurns、token/时间预算、重复调用保护、空输出和模型停止；保留真正 stop cause，区分运行结束与任务达成 |
| 权限与等待 | allow/deny/ask、无审批界面、超时、取消、connector auth；返回明确状态，等待结束后恢复或收敛，无悬挂 Promise |
| Hook / mode / 扩展 | 每个产品依赖的 phase 是否注册并触发；before_finalize veto、注入内容、mode 继续与退出、orchestrator 分支；hook 抛错/卡住可归因 |
| Mailbox / inter-turn | 运行中输入、continue/soft_stop/hard_replace、完成边界消息；消费一次，内容进入后续请求，无误取消或丢失 |
| Compaction / memory | 强制触发压缩前后，目标、当前工具往返、schema、结果及下一步仍可用；预算更新、摘要失败和 memory 注入边界可观察 |
| 子任务 / 后台工作 | 仅当实际失败场景涉及时优先：child 完成/失败/取消回父 run，等待期间不假完成；未实现的能力明确 unsupported |
| 事件 / 存储 / UI | Runtime 身份、stdout 解析、live/台账、receipt、终态、epoch、断连、慢消费者；区分执行停止与显示停止，复用 S1 故障测试 |
| 产物与部署 | 开发/实际 bundle 的 prompt 资产、工具和入口一致；不得用源码绿测签收旧 bundle |

证据层级：L1 纯模块；L2 真实产品 driver + ports；L3 真实 worker + Host + 临时 RunStore；
L4 真实 Desktop/CLI 与配置 provider。每行写最高实际层级，缺失就写未测；不要求纯模块都单独上 L4，
但主症状必须建立跨生产边界的证明链。

### H3 — 让诊断测试证明自己能抓故障

- [ ] 在隔离测试里丢掉 A 的结果或破坏 callId，H1 必须报告请求边界不匹配。
- [ ] 截断工具后的下一次模型请求，测试必须失败，不能因已有文件或一条 done 而通过。
- [ ] 人为设置合法低轮次限制，确认报告指出限制而非“任务完成”；不绕过预算保护。
- [ ] UI-only 丢帧与 provider/工具卡住分别注入，报告必须区分“仍执行但不可见”和“真正没继续”。
- [ ] 对实际根因增加最小 failing test。不得删断言、用 skip/it.fails 掩盖，或把新错误加进架构 baseline。

变异仅在临时 fixture/隔离补丁内，恢复后确认通过；不在共享 worker 上制造故障。

### H4 — 审阅后窄修复与回归

- [ ] 先交诊断报告与最小修复方案，本对话审阅；根因未明时不启动架构重构。
- [ ] 修复前后的同一场景、同一输入、同一 provider/参数可比较；先失败再通过，并核验独立产物。
- [ ] 跑受影响的模块/产品/子进程测试，与 H0 失败集合对照；typecheck:all、architecture:check 按仓库要求验证。
- [ ] 触及 worker bundle/资产/模块加载时执行 electron:build；涉及 Desktop 观测或交互时做真实 Electron 验证。
      新鲜隔离检出须按构建依赖顺序准备，不能借主检出旧 dist 证明通过。
- [ ] 复验一个失败/取消场景，保证“更会继续”没有变成不响应取消、重复副作用或无限循环。

完成条件：症状可归因、回归测试能抓故障、受影响生产入口经过验证；未测矩阵项继续保留。
不以“所有测试绿”宣称 harness 所有能力永久正确。

## 5. 现有测试入口与执行建议

优先阅读并复用，具体命令以执行快照的 package scripts / Vitest include 为准：

- `packages/host/tests/worker-product-runtime/{engine-run-composition,turn-loop-product-behavior,turn-assembly-seam,turn-pipeline-producer}.test.ts`，
  以及同目录辅助文件 `engine-turn-harness.ts`。
- `packages/agent-runtime/test/{run-engine-loop,run-engine-ports-drain,tool-drain-contract,run-engine-compaction,inter-turn-input-port}.test.ts`。
- `packages/agent-runtime/tests/{anti-dead-loop-hard-stop,engine-hook-loop-facts,compaction-seam}.test.ts`。
- `packages/host/tests/worker-hooks/`、`runtime-context-contracts/`、`worker-permission-requests.test.ts`。
- 在途 S1：`native-channel-faults.test.ts`、`worker-subprocess-ledger.test.ts`；先与 owner 确认并复用，不能复制一套。
- `e2e/turn/electron-turn.spec.ts` 与 `npm run test:e2e:turn`：先核对实际入口、fixture、构建和 ABI，
  该 script 的 pretest 会切换 SQLite ABI，禁止与其他共享环境测试相互干扰。

先跑 H1 所需文件，不以全仓测试红海代替定位；初次检查不跑广域修复。

## 6. 报告模板与派工指令

报告保持简短，可另附脱敏 fixture：

1. 快照与复现：SHA、dirty/bundle 状态、入口、模型/模式、输入、预期、实际、命令。
2. 首次偏离：一条跨模型/工具/下一轮的时间线，实际等待/停止原因及源码位置。
3. 根因置信度：已证实 / 待验证；与 provider 决策、S1 观测问题的关系。
4. 部件矩阵：owner、生产 caller、L1–L4、正/负例、缺口。
5. 最小修复建议、影响面、先失败后通过的验证方案；列出未执行的检查。

可直接派给执行 agent：

> 读取 18-runtime-harness-diagnostic-plan.md，先执行 H0/H1。用户症状是工具调用或多步执行中途停下。
> 用现有生产 driver、真实 worker 与本机 provider fixture 追踪工具结果到下一轮实际请求，找到首次偏离。
> 先交证据与最小修复方案，不改生产逻辑，不增加自动继续循环，不覆盖在途 S1 修改。
> 结果写入同目录 diagnostic-report；未复现就明确写未复现及下一项区分实验。
