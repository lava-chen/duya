# 权限拒绝恢复：把「被拒绝的工具调用」变成模型可见的结果

状态：active（#603 已合并；生产链路顺序、旧 worker 附着及审批升级边界补修中） · 负责人：Codex · 更新：2026-11-03
当前分支：`codex/write-denial-recovery-audit` · worktree：`D:/codex/worktrees/inspect-write-tool-stall/duya` · base：`9b8da5e8` · owner：Codex chat `01a1a19c-b965-7c90-988c-44679ba8e8dd`。原始 #603 的分支与工作区保留在下方历史记录。

## 目标与边界

修复 2026-11-03 TUI 会话 `507bb717` 实测到的静默停摆：auto 模式分类器拒绝一次 `bash` 后，整个 turn 以
`engine run settled: completed` 收场，模型没有拿到任何拒绝信息，TUI 停在
`There's a people directory — let me read the profile files.`。

行为目标（可观察）：

1. 被拒绝的工具调用**产出一条 tool result**：模型下一轮能看到拒绝原因并自行改路（换命令 / 回工作区 / 向用户解释）。
2. 该拒绝在 TUI / Desktop 里显示为失败的调用并带原因，不再显示 `Completed`。
3. 该 turn 不会因为「全部调用都被拒」而结束；反死循环由既有 `repeatedCallStop` 与 `max_turns` 兜住。
4. 拒绝的错误码是 `permission_denied_by_policy`，不再是假的 `tool.timed_out`。
5. 同一个被拒调用**第二次**出现时，若宿主有交互审批面，升级为用户审批卡片（codex `escalate_on_failure` 的形状）。

允许修改：`packages/agent-runtime/src/engine/{ports,run-engine}.ts`、`packages/agent-runtime/test/`、
`packages/host/src/worker-run-composition.ts` 及其测试、本计划文档。

不处理：真实沙箱能力（duya 无 Linux seatbelt/landlock 等价物，见「发现」D5）；协议 `ToolCallOutcome`
联合不新增成员（用既有 `permission_denied_by_policy` 错误码表达）；`packages/agent/` 遗留层。

关联：`419-permission-decision-bus`（审批状态通道）、`610` 系列（engine 接管循环）、
`430-unified-permission-gate`（权限门禁本体）。

## 验收

- `node node_modules/vitest/vitest.mjs run packages/agent-runtime/test/run-engine-loop.test.ts`
- `node node_modules/vitest/vitest.mjs run packages/agent-runtime/test/engine-ports.test.ts`
- `node node_modules/vitest/vitest.mjs run packages/host/tests` 中 `worker-run-composition` 相关用例
- `env -u CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR npm run typecheck:all`
- `npm run architecture:check`
- 基线：上述命令在 base `203d7d51` 上的失败需先记录，再比较文件/用例/错误签名。

## 进度

- [x] S0 证据：定位 `507bb717` 停摆链路（`#dispatchCall` 拒绝 → `tool.timed_out` → `dispatched===0` → `completed`）
- [x] S0 参照：读 codex `fbf5f0d3a7` 的拒绝→工具输出通路与沙箱/审批分层
- [x] S1 计划落盘
- [ ] S2 端口契约：`ApprovalVerdict` 带 `detail`，`ToolOutcome` 带 `errorCode`
- [ ] S3 引擎：抽出「结果落地」单一通道，拒绝走它；`TurnWork.refused` 让循环继续
- [ ] S4 Host：`gateRunApproval` 传原因 + 二次拒绝升级审批
- [ ] S5 测试：拒绝 → 结果 → 模型下一轮可见；不再静默结束；错误码与事件正确
- [ ] S6 门禁与 PR

## 发现与决策

### D1 根因（证据）

`run-engine.ts:1606` `#dispatchCall`：

```ts
if (!verdict.allowed) {
  ports.events.publish({ type: 'tool.timed_out', toolCallId, toolName, elapsedMs: 0 });
  return;                     // 既无 tool_result，也不 record()
}
```

`run-engine.ts:1998` `#shouldStop`：`if (turnWork.dispatched > 0) return null;` →
`dispatched === 0` → `{ reason: 'completed' }`（`:1875`）。

对照证据：同一会话 15:15:25 那步同时有 `bash`(拒) + `glob`(放行 41s)，`dispatched=1` → 继续；
15:17:05 那步只有 `bash`(拒)，`dispatched=0` → 结束。同 session 内自证。

### D2 契约早就写明了要回灌

`ports.ts:660` 注释：「A denial is a user decision and **belongs in the transcript**」，
但引擎侧从未实现；`ApprovalVerdict` 的 `denied` / `cancelled` / `unavailable` 三分在引擎被抹平成一种静默。

### D3 codex 参照（`E:\cloned-projects\codex` @ `fbf5f0d3a7`）

| 环节 | codex | 证据 |
| --- | --- | --- |
| 沙箱粒度 | 限制写与网络，读不设边界 | `protocol/src/protocol.rs:1249` `SandboxPolicy::{ReadOnly,WorkspaceWrite}` 只有 `network_access` / `writable_roots` |
| 沙箱失败后的提权重试 | `SandboxErr::Denied` → 若 policy 允许则带原因问用户免沙箱重跑 | `core/src/tools/orchestrator.rs:364-520` |
| 拒绝的表示 | 一律 `FunctionCallError::RespondToModel(msg)` | `core/src/tools/events.rs:409,418,434,440,467`；自动复核同款 `core/src/tools/native_tool_review.rs:81` |
| 拒绝进 transcript | `ResponseInputItem::FunctionCallOutput{output: Text(msg)}` | `core/src/stream_events_utils.rs:426-441`，注释 "…(or was denied); push that response into the transcript." |
| 循环是否继续 | 继续；终止只由模型、`max_turns`、`repeated_tool_calls`、abort 决定 | 同左，无「拒绝即结束」分支 |
| 自动复核默认值 | `ApprovalsReviewer` 默认 `user`，`auto_review` 是显式选择 | `protocol/src/config_types.rs:183` |

**结论**：codex 没有「拒绝 = 结束 turn」这条分支，也没有「拒绝不可见」这条分支。duya 两样都有。

### D4 duya auto 层的实际形状（`permissions.ts:680-790`）

1. 工作区内 → 直接放行（`:686` `isToolWithinWorkspace`）
2. auto 且 workspace-safe → 直接放行（`:706`）
3. 越界 → LLM 分类器（`:723`）→ `shouldBlock` 则 deny（`:755`），走 `denialTracking` 熔断（`:745`）
4. 分类器不可用 → `ask`（`:700`，这条兜底已经对了）

问题不在「判得对不对」，而在 deny 之后**没有任何人接收这个决定**：宿主 `gateRunApproval`
（`worker-run-composition.ts:230`）把 deny 折成 `{allowed:false, reason:'denied'}` 且 `void askApproval`，
引擎再把它折成一次假超时。

分类器还有个稳定性问题：同一会话里 `ls -la ~/.duya/` 与 `ls -R ~/.duya/memory/global` 都放行，
`ls -la ~/.duya/memory/global/people/ .../preferences/` 被拒，理由是「访问个人记忆与偏好数据」——
同一形状的命令判不同结果，说明它是 LLM 按字面语义判断、有随机性。所以兜底不能假设「拒绝是罕见且正确的」。

### D5 duya 没有等价沙箱（本轮不做）

`507bb717` 启动日志：`[Sandbox] Docker daemon not available, skipping sandbox image build`。
能力限制层不存在，所以 auto 模式只能靠「判 + 拒」。这意味着「拒绝要可恢复」比 codex 更关键：
codex 拒绝时还有一层沙箱内重跑的余地，duya 只有这一刀。

### D6 决策

- **D6.1 拒绝合成一条 `ToolOutcome`**，走与真实结果完全相同的落地通道（ledger→事件→defer→transcript→after_tool）。
  为此把 drain 循环里的「结果落地」抽成 `#commitToolResult`，两条路径共用，避免第二份实现漂移。
- **D6.2 新增 `TurnWork.refused` 而不是复用 `dispatched`。** 现有注释明确「denied 不算 dispatched」的理由
  （`run-engine.ts:1665-1669`），保留该语义；`#shouldStop` 改为 `dispatched > 0 || refused > 0`，
  并在注释里写清「被拒也是模型必须看到的答案」。
- **D6.3 被拒调用计入 `repeatedCalls` 连击。** 否则模型可以无限重发同一条被拒命令，每轮一次模型调用。
  计入后由宿主既有 `repeatedCallStop.hardStopAt` 兜底；改变命令即重置连击，正常改路不受影响。
- **D6.4 错误码用 `permission_denied_by_policy`**（`agent-protocol/src/errors.ts:112` 已存在），
  不新增 `ToolCallOutcome` 成员——那会牵动 registry/required/legacy 投影与 conformance，收益不抵。
  `ToolOutcome.errorCode` 作为可选字段只影响 `toolOutcomeOf`。
- **D6.5 二次拒绝升级审批**（codex `escalate_on_failure` 的对位）：`gateRunApproval` 记住
  (toolName, input) 的拒绝次数，第二次相同调用若有 `askApproval` 就落审批卡片；卡片允许则放行，
  否则仍按策略原因拒绝。默认（首次）仍静默拒绝，保持 auto 模式不打扰。
- **D6.6 `budget_exhausted` 同病同治**：`#budgetExhausted` 分支也合成一条拒绝结果再返回，
  避免同一类「模型问了没人答」的洞。
- **D6.7 拒绝必须带 `tool.call_started` 配对（实现期发现，推翻初稿「不发 started」的设计）。**
  `agent-protocol/run-ledger.ts:221-229` 的生命周期不变量对一切无 start 的 completion 类事件抛
  `tool_completed_without_start`，emitter 把它转成拒绝返回值，生产端口 `void emit` 丢弃——
  这正是 plan 610 D9 度量过的「拒绝到达不了任何消费者」链路。不修的话合成结果只到引擎，
  过不了 ledger，TUI 与持久层仍然什么都看不到。取 D9 文档候选方案一：`#refuseCall` 先发
  started 再发 completed。`started` 在 ledger 语义下是「引擎接手了该 callId 并承诺回答」，
  拒绝是回答的一种；「工具没有执行」由 completed 的 `permission_denied_by_policy` 与
  转录文本表达。`engine-publication.test.ts` 的 `it.fails` TARGET CONTRACT 随之转正为常规断言。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| 基线 `203d7d51` | Windows / Node 22.22.2 | 待补 | | |

## 原始实现接续（#603 历史记录）

worktree `.claude/worktrees/auto-denial-recovery`（分支 `codex/auto-denial-recovery`），实现完成、未提交。

改动面：
- `packages/agent-runtime/src/engine/ports.ts`：`ToolOutcome.errorCode?`（协议封闭 `ErrorCode`）、
  `ApprovalVerdict` deny 分支新增 `detail?`（审批者的原话）。
- `packages/agent-runtime/src/engine/run-engine.ts`：drain 的「结果落地」抽为 `#commitToolResult`；
  新增 `#refuseCall`（started→completed 配对 + 转录回灌 + `TurnWork.refuse()`）；`#shouldStop`
  改为 `dispatched > 0 || refused > 0`；`toolOutcomeOf` 透传 `errorCode`；`refusalText` 产出
  `<tool_use_error>` 包裹、面向模型的拒绝文案（含审批 detail，sanitize `<`/换行）。
- `packages/host/src/worker-run-composition.ts`：`gateRunApproval` 携带 classifier 的 `message`
  作为 `detail`；同一调用的第二次拒绝升级 `askApproval`（卡片允许则放行），首次仍静默。
- 测试：`run-engine-loop.test.ts`（拒绝回灌/预算拒绝/detail 透传/循环重开）、
  `engine-publication.test.ts`（D9 交付度量改写、TARGET CONTRACT 转正）、
  `gate-run-approval-reachability.test.ts`（二次升级、不同调用不共享计数）。

验证：`typecheck:all` 通过（worktree 内，junction overlay 解析 worktree 源码）；
agent-runtime/test + host/tests vitest 全量通过（workspace 3 个 git 测试在全量并发下
超时为既有环境问题，单独运行与主检出均全绿）；`bundle:verify` FRESH（bundle 已同
commit 重建）。

## 交付

commit `19100cb0`（分支 `codex/auto-denial-recovery`）→
**PR #603** https://github.com/lava-chen/duya/pull/603（base master，2026-11-03 开）。

回收：待 PR review/CI 通过并经授权合并后，按 worktree 指南回收本检出。
下一步：跟踪 CI（architecture/build/test/test scope/typecheck 五项），review 意见回落本计划。


## 2026-11-03 Codex 再审与 write 回归

Owner：Codex chat `01a1a19c-b965-7c90-988c-44679ba8e8dd`；分支 `codex/write-denial-recovery-audit`；managed worktree `D:/codex/worktrees/inspect-write-tool-stall/duya`；base `9b8da5e8`。Workspace 工具不可用，以版本化计划、Git 与运行进程对账。

- [x] 对照本地 Codex `fbf5f0d3a716d08c254d3e4941d5b12eaff5afe7`：`core/src/tools/orchestrator.rs` 的 Forbidden 直接 Rejected，沙箱失败重试仍受批准策略限制；`tools/events.rs` 将拒绝转换成 Failure 事件及 RespondToModel，工具调用必须有答案。
- [x] 核对 #603 已于 20:49 合并，已有模型回灌与 started/completed 配对。现场 TUI 来自 `master.9b8da5e`，但 Host PID 9132 / worker PID 520 来自 `master.cccab45-transparent`，分别在 14:46 / 15:15 启动。新客户端复用了旧引擎。
- [x] `?` 来自 TranscriptModel.finishRun 将无结果的 running 调用置为 unknown，折叠内容为 Run ended before a tool result was received；不是审批状态。
- [x] 修复自动附着旧 worker 无提示：Host 启动时记录 worker SHA256；新 TUI 比对配套 worker，缺失/不一致时在创建 session 前拒绝并给出重启指引；不终止其他客户端的 Host。
- [x] 限制 #603 二次升级为 auto classifier 明确可升级的拒绝；硬规则、plan gate、异常拒绝不可因重复调用升级授权。基线新增 hard-policy 回归失败：第二次得到 allowed:true；原引擎回灌/事件测试通过。
- [x] 给 unknown 符号补文字说明，验证渲染和错误结果区别。
- [x] 相关回归、类型/架构门禁、真实 worker/CLI 构建与独立数据目录验收；已提交 Draft PR #606。

策略：保留工作区边界；参考 Codex 的可恢复拒绝与有限审批升级，不能把任何 deny 都当作可升级建议。

### 生产链路发现与实现

生产 worker 验收证明 #603 仍有顺序缺口：`#refuseCall` 在模型流内立即 recordToolResult，而含 tool_use 的 assistant message 要在流结束后才 recordAssistantMessage。历史成为 result→use，Anthropic 配对修复删除孤立 result。受控 provider 第二次收不到拒绝，重发 write 后等待审批；45 秒观察 status=running，7 个事件，目标文件未创建。

修复：把拒绝结果加入每轮 TurnWork 队列，在 assistant 消息落盘后的 drain 阶段调用既有 commitToolResult；保留无 side-effect ticket、started/completed 配对、重试计数。新增断言固定 assistant→result→assistant 顺序。重新构建生产 worker 后，隔离 Host/真实 fork/loopback Anthropic：2 次主模型请求；第二次实际收到 NOT executed；12 个持久事件含 permission_denied_by_policy；run completed；目标文件不存在。Run ID `05657b82-97af-46c2-870b-c73ebe2bf7c1`，本地复跑材料 `docs-local/research/write-denial/worker-smoke.mjs`。未调用真实付费模型，未改用户配置或运行中 Host。

Codex 对照补充：orchestrator 的 Forbidden 在执行前返回 Rejected；只有符合当前审批/沙箱策略的失败才允许重试。events.rs:444–468 将拒绝既映射成 Failure 事件，也返回 RespondToModel。Duya 采用对应语义，但使用既有 run ledger、权限 gate 和 per-turn pipeline，不新增权限引擎；auto classifier 的拒绝由可信 gate 标记可升级，硬拒绝/未知来源缺省不可升级。

### 本轮验证（base 9b8da5e8 + 本任务 dirty）

- Windows / Node v24.16.0；worktree overlay 第三方依赖，workspace 源码和构建来自本检出。
- 基线：新增 hard-policy deny 用例在 #603 上失败（第二次 allowed:true）；原引擎模型回灌与事件测试通过。生产 worker 另复现上述配对丢失。
- 初步回归 5 套件 75/75；补充 4 套件 42/42；排序修复后引擎/事件/审批 52/52。最终范围待下方更新。
- build:packages、build:cli-dev、bundle:worker 退出 0。
- 真实 CLI 附着用户旧 Host：退出 1，明确提示旧 worker/PID 9132/关闭客户端后重启；未创建会话、未停止用户 Host。
- 真实 PTY 两项审批验收 2/2。首次与全仓构建并行时 V8 Zone Allocation OOM（未执行用例），构建资源释放后单独重跑通过；ConPTY 清理打印 AttachConsole failed，测试主进程退出 0。
- architecture:check 退出 0，无新增边界违规、baseline 未改。
- 源码 git diff --check 通过；生成 minified bundle 含源字符串行尾空格，不手改生成代码；bundle:verify 在未提交状态报告 dirty stale，提交后再核验。

### 当前 Codex / Duya 对照（本轮源码核对）

| 环节 | Codex 本地源码 | Duya 现状与本轮裁定 |
| --- | --- | --- |
| 约束与批准 | `tools/orchestrator.rs:164–230` 先计算审批 requirement，Forbidden 直接 Rejected；NeedsApproval 才进入审批 | `authorization/permission-gate.ts` 的硬 deny 与 auto classifier 都返回 deny，但此前来源被丢弃；本轮增加可信 `approvalEscalatable`，仅 auto classifier 可升级 |
| 受限执行与重试 | `orchestrator.rs:390–551` 沙箱拒绝后还检查 wants_no_sandbox_approval、unsandboxed_allowed、strict_auto_review；不是“第二次就批准” | 原 #603 对所有 deny 计数后 askApproval。本轮保持显式规则、模式闸门、异常 fail-closed，不允许反复调用改变硬策略 |
| 模型看到的拒绝 | `tools/events.rs:444–468` 同时发 Failure(Rejected) 与 RespondToModel | #603 有结果但时序 result→assistant tool_use；本轮排队到 assistant 落盘后，在统一 drain 中提交，使 provider 真正收到配对结果 |
| 调用 ID / 副作用真实性 | Codex ToolContext 传 call_id，拒绝发生在工具实际执行前 | Duya 拒绝仍发 started/completed 配对表示接手与回答，但不建立副作用 ticket；错误码 permission_denied_by_policy；未执行的事实不伪装成工具超时 |
| 审批对象绑定 | Codex ApprovalContext 带 call_id/tool_name/review_context/exec_requirement，审批与所请求的执行 authority 绑定 | Duya #558 的 live target/schema/approved args 绑定保留；本轮不把“用户同意分类器复审”变成权限引擎的通用绕过 |
| 回合继续与终止 | RespondToModel 走正常工具结果通道，模型可读失败后改路；取消与失败各有分支 | Duya 保留 refused 与 dispatched 分别计数、repeatedCallStop 与 budget 上限；新增真实 worker 验收证明拒绝后下一模型请求有结果，最终能完成 |
| 运行构建一致性 | Codex 的权限编排位于 core 工具执行路径；不能从 UI 版本推断服务进程已更新 | 本机 Duya 有独立常驻 Host + fork worker，TUI 更新仍自动附着旧进程。增加本地 runtime descriptor worker SHA256，比对缺失/不一致时创建会话前拒绝；显式远程/测试 attach 仍由操作者选择，不强制停止现有进程 |
| 未收到终态 | Codex 在工具失败事件里明确 rejection 文本；其源码也注明 Rejected 包括部分 setup failures，不能把每个分支都等同于用户拒绝 | Duya finishRun 仅把无结果调用标成 unknown，不能猜成 denied。本轮保留 ? 语义并补“结果未知”；收到已知拒绝结果则正常显示 ✖ |

范围限制：本轮补齐可复现的拒绝恢复、结果顺序、升级边界和本地附着检查；未声称 Duya 已获得 Codex 的 OS 沙箱能力。当前用户 Host 仍是旧构建；PR 合并及安装后，须在活跃任务结束后重启 Host 才会运行新引擎。

### 最终验证与交付接续

- `npm run typecheck:all`：退出 0（保留既有 Electron baseline，无新增错误）。
- `npm run architecture:check`：退出 0，无新增违规。
- 最终相关回归：9 套件 122/122，退出 0；真实 PTY 2/2，退出 0。
- 生产 worker 最终复跑：run `bd7fa3d0-6719-4555-9221-08675f0ef163`，2 次主模型请求、模型收到拒绝、文件未创建、12 个事件、completed；同一真实 Host 的 descriptor 指纹与配套 worker 匹配，附着检查通过。
- `npm run -w @duya/host build` 与 `npm run build:cli-bundle`：退出 0（最后的 Host 指纹采集移至启动前）。
- 主 worktree 与用户数据只读。新建本任务独立 managed checkout、分支与隔离验收数据；未停止用户 PID 9132/520，未改安装、用户配置、真实 session。
- 已实现且本地验证；等待 PR review/CI 与授权集成。工作区保留以便接续；原始材料为 ignored，不入提交。下一步：推送本任务 PR，提交后核对 bundle freshness，记录 PR URL。

交付：Draft PR [#606](https://github.com/lava-chen/duya/pull/606)。运行时/CLI 源码与 bundle 验证提交 `dd55468c`；最后仅追加本计划/索引交付状态。提交后 bundle:verify FRESH（0/1111）。工作区 clean，分支已推送；待最新 head 的 CI/review 和授权集成，保留 managed worktree。用户旧 Host 未重启，安装未变。
