# 权限拒绝恢复：把「被拒绝的工具调用」变成模型可见的结果

状态：active · 负责人：duya 会话（auto-denial-recovery） · 更新：2026-11-03
分支：`codex/auto-denial-recovery` · worktree：`E:/Projects/duya/.claude/worktrees/auto-denial-recovery` · base：`203d7d51` · owner：本会话

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

## 接续 / 结果

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
