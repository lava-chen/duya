# 336 记忆管线解卡修复方案（Phase1 提取 + Phase2 curation）

> **For agentic workers:** REQUIRED SUB-SKILL: 用 `executing-plans` 逐 task 实现。
> 步骤使用 checkbox（`- [ ]`）追踪。**本文档为修复方案，供用户确认后再动手**。

**Goal:** 解除记忆系统阻塞——让 Phase1（rollout 提取）恢复产出、Phase2（curation）
不再累积孤儿 run 并卡死 worker，同时清理存量脏数据。

**Architecture:** 三层修复。第一层保证 curation run 必然收敛（硬超时 + 孤儿 run 回收），
第二层让 curation 不再阻塞 phase1 的 tick 循环，第三层让 Stage1 提取在 MiniMax M3 上稳定
输出合法 JSON。最后一次性清理存量 114 个 `running` run 与失败 lease。

**Tech Stack:** TypeScript、better-sqlite3、Electron main、`@duya/ai`、Vitest。

**约定（沿用 AGENTS.md / 用户偏好）**：
- 测试跑在 Node ABI：`npm run rebuild:node` 后再 `npx vitest run <path>`。
- 每步提交用 Conventional Commits（英文）。代码注释一律英文。
- 不改动 messages 追加写等既有约束；本方案只加恢复逻辑，不破坏追加写。

---

## 背景与诊断（已核实）

针对 `memory-state.db` 的实况（`now≈2026-08-09 10:15`）调查结论：

1. **Phase1 卡住的原因 = LLM 校验失败 + worker 未持续推进。**
   - `rollout_leases` 104 条全部 `failed`，`last_error` 只有 `bad-job-status` / `llm-refused`。
   - 最近一次 lease 尝试在约 20h 前；最近一次 **成功** 的 `stage1_outputs` 在约 5.5 天前。
   - `stage1_outputs`：99 `succeeded` + 32 `succeeded_no_output`，之后不再增长。
   - 失败的 lease 处于 `failed` 状态并带 backoff（`next_retry_at`），**并未被永久 retire**
     （`MAX_RETRY_ATTEMPTS=10`，实际 `attempt_count` 只有 1–4）。也就是说：只要 worker 在跑，
     这些 rollouts 在 backoff 到期后本应被重新提取——但 20h 内没有任何新尝试，说明 **worker 的
     phase1 提取循环停转**。

2. **Phase2 卡住的原因 = curation run 永不收敛。**
   - `curation_runs` 114 条 `running`，lease 全部过期；`curation_run_inputs` 912 条
     `disposition=null`（pending）。
   - `runCurationCycle` 只有在 `runCurationAgent` **reject** 时才会 `failRun`（
     [curation_publish_orchestrator.ts](file:///e:/Projects/duya/electron/memory/curation_publish_orchestrator.ts#L193-L203)）。
     但当前运行实例下 agent 既不 `chat:done` 也不 `chat:error`，且 runner 的完成超时
     被 `timer.unref()`（
     [curation_agent_runner.ts](file:///e:/Projects/duya/electron/memory/curation_agent_runner.ts#L268)）
     与 `pool.acquire` 可能在超时计时器武装之前就挂起，导致 `runCurationAgent` **既不 resolve
     也不 reject** → `runCurationCycle` 挂起 → 该 run 永远 `running`、输入永远 pending。

3. **Phase1 与 Phase2 互相牵制（根因之一）。**
   - `runTick` 在 `extracted>0` 时会 `await curationTick(...)`（
     [memory-worker.ts](file:///e:/Projects/duya/electron/memory/memory-worker.ts#L666-L667)）。
     一旦这次 curation 挂起，`runTick` 不返回 → `state.tickInFlight` 恒为 true →
     后续 tick 全部跳过（[memory-worker.ts](file:///e:/Projects/duya/electron/memory/memory-worker.ts#L721-L724)）
     → **phase1 提取随之整体停转**。

4. **MiniMax M3 输出不合 Stage1 契约。**
   - `bad-job-status` = 返回了合法 JSON，但 `job_status` 不在 `{succeeded, succeeded_no_output}`
     （[extractor.ts](file:///e:/Projects/duya/packages/agent/src/memory-rollout/extractor.ts#L216-L219)）。
   - `llm-refused` = `streamChat` 抛错（refusal/policy）或返回空文本（
     [extractor.ts](file:///e:/Projects/duya/packages/agent/src/memory-rollout/extractor.ts#L616-L632)）。
   - `@duya/ai` 层已正确为 MiniMax 启用 adaptive thinking（
     [anthropic-messages.ts](file:///e:/Projects/duya/packages/ai/src/api/anthropic-messages.ts#L1078-L1084) 处理
     `thinking_delta`；`resolveAnthropicThinking` 在 `effort==='off'` 时返回 `undefined`，见
     [anthropic-messages.ts](file:///e:/Projects/duya/packages/ai/src/api/anthropic-messages.ts#L917-L933)），
     但 Stage1 提取默认请求 thinking 且 `LLM_MAX_TOKENS=4096`，adaptive thinking 可能烧掉整段输出预算，
     导致文本为空（`llm-refused`）或被截断/包装（`bad-job-status`）。Stage1 是结构化 JSON 提取，
     不需要推理。

5. 当前无 electron 进程在跑；本机 app.log 本次启动未出现任何 memory worker 日志，需补观测。

---

## 二次诊断与修复（2026-08-13，phase1 再次停转的真实根因）

**现象**：stage1 自 2026-08-10 21:25 后再无 `succeeded` 产出；`rollout_catalog` 有 556 个
active 且完全无 stage1 记录的 rollout 等待提取；但 worker 日志每分钟重复
`MemoryWorkerTick {selected:2, extracted:0, skippedNoop:2}`，同一批 rollout 被反复选中又
反复 noop。

**根因（恶性挑选死循环 / starvation）**：
1. `selectEligible`（`packages/agent/src/memory-state/eligibility.ts`）按「最久未处理」排序取前 N
   （worker 并发=2），命中的是 `gw-1783941272983` 与 `acbc478b` 两个 **re-extract（已
   `succeeded` 但 source 又更新）** 的 rollout。
2. 二者各带一条 `job_status='failed'`、`next_retry_at` 在未来的 lease（`schema-violation`）。
3. re-extract 分支（原 Case 2）**没有 backoff 守卫**（Case 1 有、Case 2 漏了）。
4. 每 tick 都选中它们 → `acquireLease`（`memory-state/lease.ts`）见 failed lease 仍在 backoff
   返回 `busy` → `extractor.extract` 返回 `noop_skipped` → 不写任何终态（无 stage1、不改 lease）
   → 下个 tick 又选中同样两个 → 死循环。
5. 556 个真正待提取的 rollout 永远抢不到并发槽。

这正是 `eligibility.ts` 原有注释（"permanently-failing old rollouts would sit at the front of
the idle-time ordering and starve newer sessions"）警告的场景，但守卫只覆盖 Case 1。

**修复（已实现）**：在 `SELECT_ELIGIBLE_SQL` 加**全局 backoff 守卫**——任何 `job_status='failed'`
且 `next_retry_at > now` 的 rollout 一律排除，对 Case 1/2/3 全部生效。这样 re-extract 在 backoff
期间不再抢占并发槽，回退到按自身 backoff 节奏重试；待提取的 556 个得以进入。
- 修改：`packages/agent/src/memory-state/eligibility.ts`
- 测试：`packages/agent/src/memory-state/__tests__/eligibility.test.ts` 新增 `10d`（re-extract +
  backoff → 排除，且不饿死 fresh rollout）。
- 已在真实 `memory-state.db` 上验证：加守卫后 top 8 从卡死的 re-extract 对变为真正待提取的
  08-11 rollouts（`gw-1786435415518`、`562a9dce`、`487f05b1`…）。

**待办**：应用重启后 phase1 应开始消费 556 个 pool；若其中仍有 `schema-violation`，按 Task E2
（bare items 容错信封回退）走降级，且因守卫存在不会再次饿死其它 rollout。

---

## 修复方案总览

| Task | 文件 | 内容 |
|------|------|------|
| A | `packages/agent/src/memory-state/curation_ledger.ts` | 新增 `abandonExpiredRuns()` |
| B | `electron/memory/curation_agent_runner.ts` | runner 硬超时，保证必然 reject |
| C | `electron/memory/curation_publish_orchestrator.ts` | cycle 顶层回收孤儿 run + 看门狗 |
| D | `electron/memory/memory-worker.ts` | curation 与 phase1 tick 解耦 |
| E | `packages/agent/src/memory-rollout/extractor.ts` | Stage1 禁用推理 + 失败时记录原始响应 |
| F | 一次性数据清理 | 回收存量脏数据 |

---

## Task A: curation_ledger 新增孤儿 run 回收

**Files:**
- Modify: `packages/agent/src/memory-state/curation_ledger.ts`
- Test: `packages/agent/tests/memory-state/curation_ledger.test.ts`（若存在，否则就近新建）

**Step 1: 写失败/空测试**
把 `status='running'` 且 lease 过期的 run 标记为 `abandoned`，并返回回收数量。回收只改 run 状态，
**不标记 inputs**——inputs 保持 `disposition=null`，因此 `queryEligibleInputs` 会继续把它们视为
可 claim（它只排除 succeeded run 上已吸收/无变化/拒绝的 inputs）。

```ts
export function abandonExpiredRuns(db: Database, now?: number): number {
  const ts = now ?? Date.now();
  const result = db.prepare(
    `UPDATE curation_runs
       SET status = 'abandoned',
           error = 'lease-expired',
           finished_at = ?
     WHERE status = 'running' AND lease_expires_at <= ?`
  ).run(ts, ts);
  return result.changes;
}
```

**Step 2: 跑测试确认失败**（尚未实现）
`npx vitest run packages/agent/tests/memory-state/curation_ledger.test.ts`

**Step 3: 实现**（粘贴上面代码）

**Step 4: 跑测试确认通过**

**Step 5: 提交**
`git add packages/agent/src/memory-state/curation_ledger.ts packages/agent/tests/memory-state/curation_ledger.test.ts`
`git commit -m "fix(agent): add abandonExpiredRuns to recover orphaned curation runs"`

---

## Task B: curation agent runner 保证必然 reject（不挂起）

**Files:**
- Modify: `electron/memory/curation_agent_runner.ts`

**Step 1: 为整体执行加硬超时**
`runCurationAgent` 的 `pool.acquire`（
[L177](file:///e:/Projects/duya/electron/memory/curation_agent_runner.ts#L177)）可能在完成计时器
武装之前就挂起。用外层硬截止兜底，任何情况下 `runCurationAgent` 都会 settle，从而让 orchestrator
的 `failRun` 有机会执行。

```ts
function withHardDeadline<T>(fn: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    fn.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
```

在 `runCurationAgent` 入口把整个 body 包一层：
```ts
export async function runCurationAgent(opts: RunCurationAgentOpts): Promise<RunCurationAgentResult> {
  return withHardDeadline(runInner(opts), opts.timeoutMs + 30_000, 'curation agent');
}
```
（把现有 body 改名为 `runInner`，或用一个立即执行的 async 函数包裹现有 body。）

**Step 2: 完成超时不再 unref，保证必然触发**
把 [L268](file:///e:/Projects/duya/electron/memory/curation_agent_runner.ts#L268) 的
`timer.unref?.()` 去掉（或改为非 unref），确保 `waitForAgentCompletion` 的 10 分钟超时一定会
reject，进而触发 orchestrator 的 `failRun`。agent 进程池本身会让事件循环保持活跃，去掉 unref
不会拖住 Electron 退出。

**Step 3: 跑既有 runner 测试**
`npx vitest run electron/memory/curation_agent_runner.test.ts`（如存在）

**Step 4: 提交**
`git commit -m "fix(electron): guarantee curation agent runner settles on timeout"`

---

## Task C: cycle 顶层回收孤儿 run + 看门狗

**Files:**
- Modify: `electron/memory/curation_publish_orchestrator.ts`

**Step 1: 在 `runCurationCycle` 开头回收过期孤儿 run**
在 `queryEligibleInputs` 之前调用，保证每次 cycle 启动时 ledger 一致，且被挂起 run 占用的
inputs 不再滞留。

```ts
import { abandonExpiredRuns } from '../../packages/agent/src/memory-state/curation_ledger';
// ...在 runCurationCycle 顶部、queryEligibleInputs 之前：
abandonExpiredRuns(db, now);
```

**Step 2: 对 `runCurationAgent` 加看门狗（冗余保险）**
现有 catch（[L193-L203](file:///e:/Projects/duya/electron/memory/curation_publish_orchestrator.ts#L193-L203)）
已对 reject 调用 `failRun`；Task B 保证了 runner 会 settle。若仍需要更激进保险，可在
`runCurationAgent` 外套一个 `Promise.race` 与 `AGENT_TIMEOUT_MS` 竞速，超时则 `failRun`
并返回失败——但通常 Task B 已足够，此步标记为可选。

**Step 3: 跑 orchestrator 测试**
`npx vitest run electron/memory/curation_publish_orchestrator.test.ts`（如存在）

**Step 4: 提交**
`git commit -m "fix(electron): recover orphaned curation runs at cycle start"`

---

## Task D: curation 与 phase1 tick 解耦

**Files:**
- Modify: `electron/memory/memory-worker.ts`

**Step 1: 移除 tick 内对 curation 的 await，避免挂起拖死 phase1**
`runTick` 中的 [L666-L667](file:///e:/Projects/duya/electron/memory/memory-worker.ts#L666-L667)
在 `extracted>0` 时 `await curationTick(...)`。一旦 curation 挂起，`tickInFlight` 恒 true，
phase1 停转。改为**不再在 tick 内 await curation**，只依赖独立的 `sweepConsolidator`
（5 分钟间隔，且 `curationTick` 自带 `consolidatorInFlight` 单飞守卫）。

把 [L666-L679](file:///e:/Projects/duya/electron/memory/memory-worker.ts#L666-L679) 整段
（`let curated...` 到 drain 二次冲刷）删除或改为非阻塞触发：

```ts
// Do not await curation inside the tick — a hung curation must never
// freeze the phase1 extraction loop. sweepConsolidator owns curation.
if ((extracted > 0 || (options.force && cfg.consolidatorOnForceSweep)) && deps.curation) {
  curationTick({ force: options.force }).catch(() => { /* logged inside */ });
}
```

**Step 2: 给 `curationTick` 加墙钟硬超时，保证 `consolidatorInFlight` 必然复位**
在 [L416](file:///e:/Projects/duya/electron/memory/memory-worker.ts#L416) 的
`await runCurationCycle(...)` 外包一层硬超时（复用 Task B 的 `withHardDeadline`，或本地实现），
超时后记录 WARN 并让 `finally` 复位 `consolidatorInFlight`，避免单飞守卫被永久占用。

**Step 3: 跑 worker 相关测试**
`npx vitest run electron/memory/memory-worker.test.ts`（如存在）

**Step 4: 提交**
`git commit -m "fix(electron): decouple curation from phase1 tick to prevent freeze"`

---

## Task E: Stage1 提取在 MiniMax M3 上稳定输出（复用现有 `effort` 接口）

**背景（框架复用确认）**：`effort` 是 ai 包 `StreamOptions`/`SimpleChatOptions` 的一等选项
（[simple-options.ts](file:///e:/Projects/duya/packages/ai/src/utils/simple-options.ts#L80)），
全框架已贯通透传（worker-protocol → agent-process-entry → DuyaAgent → session/model）。
MiniMax 侧已正确消费：`effort:'off'` → `resolveAnthropicThinking` 返回 `undefined`（关 thinking），
见 [anthropic-messages.ts](file:///e:/Projects/duya/packages/ai/src/api/anthropic-messages.ts#L917-L933)。
Stage1 extractor 是**唯一**没传 `effort` 的直连调用点，因此继承了默认 `medium` → 推理模型开
adaptive thinking → 输出预算被烧。本 Task **只补上现有接口，不新增任何机制**。

**Files:**
- Modify: `packages/agent/src/memory-rollout/extractor.ts`
- Test: `packages/agent/tests/memory-rollout/extractor.test.ts`（如存在）

**Step 1: 提取调用复用现有 `effort:'off'` 关闭推理**
Stage1 是确定性结构化 JSON 提取，不需要推理。把 [L601-L605](file:///e:/Projects/duya/packages/agent/src/memory-rollout/extractor.ts#L601-L605)
的调用补上 `effort: 'off'`：

```ts
const generator = this.streamChat([userMessage], {
  systemPrompt,
  maxTokens: LLM_MAX_TOKENS,
  signal: abortController.signal,
  effort: 'off', // deterministic JSON extraction — reuse existing effort switch to skip reasoning
});
```

> 附注：`visual-analysis.ts`（[L93](file:///e:/Projects/duya/packages/agent/src/agent/visual-analysis.ts#L93)）
> 也漏传 `effort`，但走 vision 且传 `temperature:0`，暂无害。**不并入本方案**（YAGNI），
> 若未来它在推理模型上出同类问题，用同样方式补即可。

**Step 2: 校验失败时记录原始响应（可诊断）**
在 [L636-L638](file:///e:/Projects/duya/packages/agent/src/memory-rollout/extractor.ts#L636-L638)
的 `!parsed.valid` 分支，**保持 `last_error`/`errorMessage` 为稳定错误码**（`invalid-json` /
`invalid-promotion` 等，供调用方与测试精确匹配），改经 `console.warn` 输出截断的原始响应片段，
便于诊断 M3 到底返回了什么（沿用该文件已有的 console.warn 风格）：

```ts
if (!parsed.valid) {
  console.warn(
    `[Stage1Extractor] ${rolloutId} validation failed (${parsed.error}): ${llmResponse.slice(0, 500)}`,
  );
  fail(this.memoryDb, { rolloutId, token, error: parsed.error });
  return { status: 'failed', contentOutcome: null, projectionPath: null, stage1RowId: rolloutId, durationMs: elapsed(), errorMessage: parsed.error };
}
```

**Step 3: 视诊断结果决定是否抬高 `LLM_MAX_TOKENS`**
若 Task E 之后仍有截断，把 [L58](file:///e:/Projects/duya/packages/agent/src/memory-rollout/extractor.ts#L58)
的 `LLM_MAX_TOKENS` 从 `4096` 抬到如 `8192`。此项以 Task E 的实际观测为准。

**Step 4: 跑 extractor 测试**
`npx vitest run packages/agent/tests/memory-rollout/extractor.test.ts`

**Step 5: 提交**
`git commit -m "fix(agent): make stage1 extraction reliable for MiniMax M3"`

### Task E2: 容错信封回退（M3 返回裸 items 数组）

**背景（实况）**：Task E 的 `effort:'off'` 让 M3 返回了干净可解析的 JSON，但**只吐了
`raw_memory` 的外壳**——顶层 `{"items":[...]}`，丢弃了外层信封
（`job_status`/`content_outcome`/`rollout_summary`/`rollout_slug`）。`parseAndValidate`
找不到 `job_status` 报 `bad-job-status`，items 仍会被丢弃。这不是截断（JSON 完整可解析），
是 M3 系统性只输出 items。

**方案**：在 `parseAndValidate` 加**容错信封回退**——顶层对象缺 `job_status` 但含合法 `items`
数组时，把 `items` 提升为 `raw_memory`，合成一个降级的 `succeeded` 信封（`content_outcome:
'uncertain'`、`rollout_summary` 由各 claim 拼接、`rollout_slug:'memory-items'`），再走同一套
严格校验。耐久记忆 items 落库，叙事质量降级但不丢数据。

**Files:**
- Modify: `packages/agent/src/memory-rollout/extractor.ts`
- Test: `packages/agent/src/memory-rollout/extractor.test.ts`

**Step 1: 抽出 `validateSucceededEnvelope`**
把原 `succeeded` 校验块（原 L258-440）整体抽成 `function validateSucceededEnvelope(obj)`，
`parseAndValidate` 在 `succeeded` 分支改为 `return validateSucceededEnvelope(obj);`。

**Step 2: 在 `job_status` 校验前插入回退**
```ts
if (typeof jobStatus !== 'string') {
  const promotedItems = Array.isArray(obj.items) ? obj.items : undefined;
  if (promotedItems) {
    const promoted: Record<string, unknown> = {
      job_status: 'succeeded',
      content_outcome: 'uncertain',
      rollout_summary: synthesizeRolloutSummary(promotedItems),
      rollout_slug: 'memory-items',
      raw_memory: { items: promotedItems },
    };
    return validateSucceededEnvelope(promoted);
  }
}
if (typeof jobStatus !== 'string' || !VALID_JOB_STATUS.has(jobStatus)) {
  return { valid: false, error: 'bad-job-status' };
}
```

**Step 3: 新增 `synthesizeRolloutSummary`**
把 items 的 `claim` 拼成 `# Memory Items\n\n## Decisions` 的 Markdown 降级摘要。

**Step 4: 测试**
新增 2 条：① 裸 items 数组 → `succeeded` + `rollout_slug:'memory-items'` + summary 含
`Memory Items`；② 裸 items 含非法 item → 仍 `schema-violation`。
`npx vitest run packages/agent/src/memory-rollout/extractor.test.ts` 全绿（30 tests）。

**Step 5: 提交**
`git commit -m "fix(agent): tolerate bare items envelope from MiniMax M3 stage1"`

---

## Task F: 一次性清理存量脏数据

**Files:**
- 临时脚本或 `electron/memory` 下的一个 recovery 入口（建议做成幂等函数，不破坏追加写）

**Step 1: 回收 114 个孤儿 curation run**
调用 Task A 的 `abandonExpiredRuns(memoryDb, Date.now())`，把过期 `running` 全部置为
`abandoned`。912 个 pending inputs 因此重新可 claim。

**Step 2: 让 phase1 失败 lease 尽快重试（可选）**
把 `rollout_leases` 中 `job_status='failed'` 的 `next_retry_at` 置 `NULL`（等效让 backoff 立刻
到期），使修复后的 worker 能立即重提取：

```sql
UPDATE rollout_leases SET next_retry_at = NULL WHERE job_status = 'failed';
```

**Step 3: 确认 catalog 同步**
确认 worker 启动后 `syncAllFromMainDb` 能把新会话写入 `rollout_catalog`（当前 500 条停滞）。

**Step 4: 提交**
`git commit -m "chore(memory): reconcile orphaned curation runs and stale leases"`

---

## 验证

1. `npm run rebuild:node`；`npx vitest run packages/agent/tests/memory-state/curation_ledger.test.ts`
   及其余相关测试通过。
2. `npm run electron:dev` 启动，检查 app.log：
   - 出现 `Memory worker started (shadow mode)`（说明 worker 真正启动，llmClient 非空）。
   - 出现 `MemoryWorker started` 与正常 `MemoryWorkerTick`。
3. phase1：观察 `rollout_leases` 不再堆积 `failed`，`stage1_outputs` 的 `succeeded` 数增长。
4. phase2：观察 `curation_runs` 的 `running` 被回收为 `abandoned`，随后出现 `succeeded`/`failed`
   而非无限 `running`；`curation_run_inputs` 的 `disposition` 不再长期为 `null`。
5. 确认 phase1 tick 不再被 curation 卡死（tick 持续有 `selected`/`extracted` 输出）。

---

## 待用户确认的点

- Task E 采用「Stage1 提取禁用推理（`effort:'off'`）」作为首选缓解，是否认可？（备选：保留
  thinking 并抬 `LLM_MAX_TOKENS`。）
- 实施方式：Subagent-Driven（逐 task 分派）还是 Inline Execution（本会话内批量执行 + 检查点）？
