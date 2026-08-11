# 417 Memory curation: replace LLM-as-agent with single-shot LLM call

> **For agentic workers:** REQUIRED SUB-SKILL: 用 `executing-plans` 逐 task 实现。
> 步骤使用 checkbox（`- [ ]`）追踪。**本文档为修复方案，用户已授权执行**。

**Goal:** Phase 2 curation 24小时内 19 次 succeed 但都是空操作（0 publications），agent 永远卡在
Turn 5-7 后哑火。这源于 `packages/ai/src/api/anthropic-messages.ts:1767` 的设计：M3
发 `result`（带 usage）但**不发 `message_stop`**，导致 SDK 流不关闭，外层 `for await` 永久阻塞。
Plan 336 Task B 的 20-min 看门狗只是兜底，不是根因修复。

把 Phase 2 改为**单次非流式 LLM 调用 + 确定性文件落地**——参考 `grok-build/crates/codegen/xai-grok-memory/src/dream.rs:394` 的
`execute_dream(lock, storage, response, ...)` 模式（LLM 调用由外部 caller 一次性收集完整响应，
再交给纯函数处理文件）。`hermes-agent/agent/memory_manager.py:547` 的
`_external_prefetch_timeout` daemon-thread 模式也一并借鉴。

**Architecture:**

```
┌────────────────────────────────────────────────────────────────────────┐
│ MemoryWorker.tick (every 1s)                                           │
│   ├── Phase 1: selectEligible → Stage1Extractor.extract → projection   │  (unchanged)
│   └── Phase 2 trigger: every 5 min                                    │
│       └── curationCycle (single-flight, see curationCycle.ts)          │
│           ├── abandonExpiredRuns()                                     │
│           ├── queryEligibleInputs() → MAX_INPUTS=3                     │
│           ├── claimRun()                                              │
│           ├── git backup                                              │
│           └── runSingleShotCuration(db, opts, llmClient)              │
│               ├── read all input rollout_summaries/*.md                │
│               ├── read existing global/areas/{relevant}.md            │
│               ├── llmClient.chat(messages, {effort:'off', stream:false, maxTokens:8192}) │  ← NO STREAMING
│               ├── parse response → CurationAction[]                    │
│               └── for each action: deterministic file write            │
└────────────────────────────────────────────────────────────────────────┘
```

**Tech Stack:** TypeScript、better-sqlite3、`@duya/ai`、`llmClient.chat()`（non-streaming）、Vitest。

**约定（沿用 AGENTS.md）：**
- 测试 Node ABI：`npm run rebuild:node` → `npx vitest run <path>`。
- 提交用 Conventional Commits（英文）。注释一律英文。
- 不改 messages 追加写。`curation_runs` ledger 保留。

---

## 背景与诊断

### 已确认的失败模式

`~/.duya/logs/agent/agent-curation-memory-worker-*.log` 一律呈现：

```
[Agent-Process] streamChat tools (3): agentProfileId=memory-curator, mode=automation
[Agent-Process] [Image-Processing] Model multimodal detection: MiniMax-M3 → true (probed)
[Agent-Process] [Agent-Process] Event 1: turn_start
[Agent-Process] [Agent-Process] Event 2: text I'll
[Agent-Process] [Agent-Process] Event 3: text  start by exploring the memory root
[Agent-Process] [Agent-Process] Event 4: tool_use_started
[Agent-Process] [Agent-Process] Event 5: tool_use
[Agent-Process] [Agent-Process] Received result event, tokenUsage set: input=0, output=291
[Agent-Process] [Agent-Process] Unknown SSE event type: result
[duya-ai] [toAnthropicMessages] Reordered 1 tool round(s)...
[silence 20 minutes → withHardDeadline fires]
[Agent-Process] Agent process exited (released) code:1
```

**根因**（[packages/ai/src/api/anthropic-messages.ts:1767-1781](file:///e:/Projects/duya/packages/ai/src/api/anthropic-messages.ts#L1767)）：

```typescript
if (internalEvent.type === 'done') {
  if (internalEvent.message.usage) {
    yield { type: 'result', data: internalEvent.message.usage };  // ← yields 'result'
  }
  const doneSse = emitSSE(internalEvent);
  if (doneSse) {
    pendingDone = doneSse;  // ← 'done' deferred to AFTER inner loop
  }
}
...
// After inner loop:
if (pendingDone) yield pendingDone;
```

M3 的 anthropic 兼容端点**发 `message_delta`（带 usage）但不发 `message_stop`**。
Anthropic SDK 流的内部 `done` 永远不来 → generator 永远不 return → 外层 `for await` 永远阻塞。

### 已有的 24h 内成果（保留）
- 19 次 `succeeded` 中有 **1 次真正成功**（2026-08-11 00:15, 33s）→ `global/areas/*.md` 多份更新
- 但 `curation_publications` 表 = 0 行（`succeeded` 都是 "nothing to publish"）

### Plan 336 已修的（不重做）
- Task A：curation_ledger.ts `abandonExpiredRuns` — 工作中（145 abandoned 证据）
- Task B：withHardDeadline — 工作中（每次 20-min timeout 都能 settle）
- Task C：cycle 顶部回收孤儿 run
- Task D：curation 与 phase1 tick 解耦
- Task E：extractor effort:'off'
- Task E2：tolerant envelope fallback for bare items
- Task F：`scripts/reconcile-memory-state.mjs` 已 commit (65c6b3f3)

### Plan 417 解决剩余问题
Phase 2 不再依赖流式 LLM agent；改成单次非流式调用 + 确定性文件操作。

---

## 设计要点

### 1. 单次非流式 LLM 调用（grok 模式）

参考 [`run_dream_model_call`](file:///e:/cloned-projects/grok-build/crates/codegen/xai-grok-shell/src/session/acp_session_impl/memory_dream.rs#L397)：
```rust
let response = sampling_client.conversation_collect(request).await?;  // 非流式
Ok(response.assistant_text())
```

在 `packages/agent/src/memory-rollout/extractor.ts` 里 `streamChat` 旁边已经存在
[packages/agent/src/agent/DuyaAgent.ts:1827]() 的 `chat()` 方法走非流式路径（参照
[packages/ai/src/api/anthropic-messages.ts:1793]() 的 `chat()`）。**复用同一个 `@duya/ai` 的 chat API**。

### 2. LLM 输出契约（参考 `process_dream_response`）

LLM 返回一段 JSON：
```json
{
  "decisions": [
    { "rollout_id": "...", "disposition": "absorbed" | "no_signal" | "uncertain", "reason": "..." }
  ],
  "actions": [
    {
      "op": "append" | "replace" | "no_op",
      "area_path": "global/areas/agent-fabrication-anti-pattern.md",
      "content": "## Claim\n- ...",
      "reason": "..."
    }
  ]
}
```

协议规则：
- `decisions[].disposition='absorbed'`：input 被合并进 area 文件
- `decisions[].disposition='no_signal'`：input 无持久化价值，跳过
- `decisions[].disposition='uncertain'`：LLM 不确定，input 留待下一轮
- `actions[].op='no_op'`：显式"什么都不做"（grok 的 `NO_REPLY` 协议）
- 任何 `actions[].op='replace'` 必须显式给出完整的 `content`（不允许 diff/patch）

### 3. 硬超时（grok 的 30-min 模式 + hermes 的 8s daemon 模式）

参考 [`run_dream_inner` 的 `tokio::time::timeout(Duration::from_secs(30*60), ...)`](file:///e:/cloned-projects/grok-build/crates/codegen/xai-grok-shell/src/session/acp_session_impl/memory_dream.rs#L301-L304)。

Plan 417 选用 **4 min**（比 cron 的 10 min 短很多，比 stage1 的单次 30s 长）。理由：
- 大多数 curation 实际 < 33s（参考 2026-08-11 00:15:00 那次成功的 33s）
- 4 min 给慢响应留余量，但不让 worker 一周期吃掉 20 min
- 实现：`AbortController` + `setTimeout(abort, 4*60_000)`

### 4. 文件落地（确定性）

每条 `action` 落地的顺序：
1. 校验 `area_path` 在 `~/.duya/memory/global/areas/` 之内（防 path traversal）
2. 若 `op='append'`：读现有文件，规范化（trim/去尾/检查 heading），追加新内容
3. 若 `op='replace'`：原子写（先写到 `tmp`，rename）
4. 若 `op='no_op'`：跳过

写完后调用 `memory_entries_rebuild.ts` 的现有逻辑重新生成 `MEMORY.md` / `summary.md` / `global/{areas,people}/index.md`（**只是 trigger，不重写逻辑**）。

### 5. 锁与状态保留

继续用现有的 `curation_runs` ledger（不重写 schema）：
- `abandonExpiredRuns` 已经在做（Plan 336 Task A）
- `claimRun` 仍然 single-flight
- `completeRun` 在所有 actions 落地后调用
- `failRun` 在 timeout / parse error 时调用

---

## Task 清单

| Task | 文件 | 内容 |
|------|------|------|
| A | `electron/memory/curation_single_shot.ts` | 新模块：`runSingleShotCuration` |
| B | `electron/memory/curation_publish_orchestrator.ts` | 替换 `runCurationAgent` → `runSingleShotCuration` |
| C | `electron/memory/curation_response_parser.ts` | 解析 LLM JSON 响应（含 Zod schema） |
| D | `electron/memory/curation_file_writer.ts` | 确定性文件落地（append / replace / no-op） |
| E | `electron/memory/memory-worker.ts` | `curationTick` 改用单次调用（移除 withHardDeadline） |
| F | tests | 单测 `curation_response_parser` + `curation_file_writer` + `curation_single_shot` |
| G | 集成测试 | 模拟完整 cycle：3 个 input → LLM 返回 2 个 action → 文件正确落地 |
| H | 文档 | 更新 ARCHITECTURE.md + `electron/memory/README.md`（如有） |

---

## Task A: 新模块 `curation_single_shot.ts`

**Files:**
- Create: `electron/memory/curation_single_shot.ts`
- Test: `electron/memory/__tests__/curation_single_shot.test.ts`

**Step 1: 写空 test 文件** — 验证 `runSingleShotCuration` 在 mock llmClient 下的行为。

**Step 2: 实现 `runSingleShotCuration`**
```typescript
export interface SingleShotCurationOpts {
  memoryRoot: string;       // ~/.duya/memory
  inputs: CurationInput[];  // from queryEligibleInputs
  llmClient: AIClient;
  cwd: string;
  provider: { provider: string; model: string; baseUrl?: string; apiKey: string };
  timeoutMs?: number;       // default 4 * 60_000
}

export interface CurationAction {
  op: 'append' | 'replace' | 'no_op';
  area_path: string;        // relative to memoryRoot
  content: string;
  reason: string;
}

export interface CurationDecision {
  rollout_id: string;
  disposition: 'absorbed' | 'no_signal' | 'uncertain';
  reason: string;
}

export interface CurationResponse {
  decisions: CurationDecision[];
  actions: CurationAction[];
}

export interface RunResult {
  success: boolean;
  response: CurationResponse | null;
  rawResponse: string;
  durationMs: number;
  actionsApplied: number;
  error?: string;
}

export async function runSingleShotCuration(
  opts: SingleShotCurationOpts
): Promise<RunResult>;
```

实现骨架：
1. **Assemble prompt**:
   - 读每个 input rollout 的 `~/.duya/memory/rollout_summaries/<file>.md`
   - 收集 `rollout_slug` 用于挑相关 area 文件（已有索引或在 prompt 列出）
   - System prompt = `CURATION_SINGLE_SHOT_SYSTEM_PROMPT`
   - User prompt = JSON dump: `{inputs: [{path, summary, slug}], existing_areas: {slug: content}, instructions}`
2. **Single non-streaming LLM call**:
   - `await llmClient.chat(messages, {systemPrompt, maxTokens: 8192, effort: 'off', temperature: 0.2})`
   - Wrap in `withAbortTimeout`（4 min default）
3. **Parse response** with `parseCurationResponse` (Task C)
4. **Apply actions** via `applyCurationActions` (Task D)
5. **Return** `RunResult` with success/partial/error flag

**Step 3: 实现 `withAbortTimeout`**
参考 grok 的 `tokio::time::timeout` + hermes 的 `_external_prefetch_timeout`：
```typescript
function withAbortTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
```

注意：必须 hook 进 `chat()` 调用，让 abort signal 真正传给 LLM client（不是只在外层 reject）。

**Step 4: 测试**
- happy path：mock `chat()` 返回合法 JSON → actions 落地、RunResult 正确
- timeout：mock `chat()` 永不 resolve → 4 min 后 reject（测试用 `vi.useFakeTimers`）
- parse error：mock 返回不合规 JSON → RunResult.error，actions 不落地
- LLM 返回 `op='no_op'`：actions 空数组，success=true

---

## Task B: `curation_publish_orchestrator.ts` 替换调用

**Files:**
- Modify: `electron/memory/curation_publish_orchestrator.ts`

**Step 1: 把 `runCurationAgent` 改为 `runSingleShotCuration`**
- 删掉 `import { runCurationAgent } from './curation_agent_runner';`
- 加 `import { runSingleShotCuration } from './curation_single_shot';`
- 在 `runCurationCycle` 内 `runInner` 调用处替换：
  ```typescript
  await runSingleShotCuration({
    memoryRoot: opts.memoryRoot,
    inputs: rolloutEligible,
    llmClient: ???,  // see Step 2
    provider: opts.providerConfig,
  });
  ```

**Step 2: 注入 llmClient**
memory-worker.ts 已经有 llmClient（用于 Stage1 extractor）。把它传给 `runCurationCycle`：
- 在 `MemoryWorkerDeps` 添加 `llmClient: AIClient`
- 在 `runCurationCycle` opts 添加 `llmClient: AIClient`

**Step 3: 删除 `curation_agent_runner.ts`**
- 整个文件不再被引用
- 把它的测试 `curation_agent_runner.test.ts` 也删掉

**Step 4: 删除 `electron/memory/__tests__/shadow-mode.test.ts`**（如果它专门测 curation agent runner 的 shadow mode）

---

## Task C: `curation_response_parser.ts`

**Files:**
- Create: `electron/memory/curation_response_parser.ts`
- Test: `electron/memory/__tests__/curation_response_parser.test.ts`

**Step 1: 定义 Zod schema**
```typescript
import { z } from 'zod';

export const CurationActionSchema = z.object({
  op: z.enum(['append', 'replace', 'no_op']),
  area_path: z.string().regex(/^global\/(areas|people)\/[a-z0-9-]+\.md$/),  // 严格白名单
  content: z.string().default(''),
  reason: z.string(),
}).refine(
  (a) => a.op === 'no_op' || (a.content.length > 0 && a.content.length <= 50_000),
  { message: 'append/replace actions must have 1-50000 chars of content' },
);

export const CurationDecisionSchema = z.object({
  rollout_id: z.string(),
  disposition: z.enum(['absorbed', 'no_signal', 'uncertain']),
  reason: z.string(),
});

export const CurationResponseSchema = z.object({
  decisions: z.array(CurationDecisionSchema).min(1),
  actions: z.array(CurationActionSchema),
});

export type CurationResponse = z.infer<typeof CurationResponseSchema>;

export function parseCurationResponse(raw: string): CurationResponse;
```

**Step 2: 实现 `parseCurationResponse`**
1. 剥 markdown code fence（```json ... ```）
2. `JSON.parse` + Zod parse
3. 失败抛 `CurationParseError`（带 raw 文本前 500 字符用于诊断）

**Step 3: 测试**
- 合法 JSON
- 不合规 Zod（缺字段、`op` 越界、`area_path` 越界）
- markdown code fence 包裹
- raw 文本里有非 JSON 前缀（"Here is the curation result: {...}"）

---

## Task D: `curation_file_writer.ts`

**Files:**
- Create: `electron/memory/curation_file_writer.ts`
- Test: `electron/memory/__tests__/curation_file_writer.test.ts`

**Step 1: 实现 `applyCurationActions`**
```typescript
export interface ApplyResult {
  applied: number;
  errors: Array<{ action: CurationAction; error: string }>;
}

export async function applyCurationActions(
  memoryRoot: string,
  actions: CurationAction[]
): Promise<ApplyResult>;
```

实现细节：
1. 对每个 action 校验 `area_path` 在 `${memoryRoot}/global/` 之内（防 path traversal：拒绝 `..`、绝对路径、`${memoryRoot}` 之外）
2. `op='no_op'`：跳过（applied 不计）
3. `op='append'`：
   - 读现有文件（不存在则视为空）
   - 规范化：用 `String#trim()` + 确保以 `\n` 结尾
   - 在结尾追加新内容，前面加 `\n\n`
   - 原子写：`writeFile(path + '.tmp', content); rename(path + '.tmp', path)`
4. `op='replace'`：同上但跳过读，直接写
5. 任何错误：不抛，append 到 `errors[]` 让 caller 决定

**Step 2: 实现 `validateAreaPath`**
```typescript
function validateAreaPath(memoryRoot: string, areaPath: string): string {
  const absolute = path.resolve(memoryRoot, areaPath);
  const root = path.resolve(memoryRoot, 'global');
  if (!absolute.startsWith(root + path.sep) && absolute !== root) {
    throw new Error(`path traversal blocked: ${areaPath} -> ${absolute}`);
  }
  return absolute;
}
```

**Step 3: 测试**
- 正常 append（文件不存在 / 文件存在）
- 正常 replace
- path traversal 拒绝（`../../etc/passwd`、`/etc/passwd`）
- 并发写入（vitest's `vi.useFakeTimers`）

---

## Task E: `memory-worker.ts` 简化

**Files:**
- Modify: `electron/memory/memory-worker.ts`

**Step 1: 把 `withHardDeadline` / 20-min 调整移除**
单次调用自带 4-min timeout，cycle 顶层不需要额外硬超时。但保留一个 `cycleTimeoutMs` 默认 6 min（比单次多 2 min 给解析+落盘），如果 cycle 整体超时则 failRun。

**Step 2: 把 `MemoryWorkerDeps` 注入 llmClient**
（Task B Step 2 已准备；这里 wire 给 `curationTick` → `runCurationCycle`）

**Step 3: 把 `consolidatorIntervalMs` 从 5min 改为 4min**（更频繁但每次更短）

---

## Task F: 单测

**Files:**
- `electron/memory/__tests__/curation_response_parser.test.ts` — 至少 8 个 case
- `electron/memory/__tests__/curation_file_writer.test.ts` — 至少 6 个 case
- `electron/memory/__tests__/curation_single_shot.test.ts` — 至少 6 个 case
- 删除 `electron/memory/curation_agent_runner.test.ts`
- 删除 `electron/memory/__tests__/shadow-mode.test.ts`（如果专测旧 runner）

**测试原则**：mock LLM client 返回固定字符串；用 `os.tmpdir()` + uuid 隔离每个测试的 memory root。

---

## Task G: 集成测试

**Files:**
- 新增 `electron/memory/__tests__/curation_integration.test.ts`

模拟：
1. 准备 3 个 `rollout_summaries/*.md`（固定内容）
2. mock `llmClient.chat()` 返回一个完整的 `CurationResponse`（含 2 个 append + 1 个 no_op）
3. 调用 `runCurationCycle` end-to-end
4. 验证 `global/areas/<file>.md` 正确写入
5. 验证 `curation_runs` ledger 标 succeeded
6. 验证 `curation_run_inputs` 标 absorbed / no_signal

---

## Task H: 文档

**Files:**
- Modify: `ARCHITECTURE.md` — 把 Phase 2 一节改为"single-shot LLM call + 确定性文件落地"
- Modify: `docs/exec-plans/README.md` — 把本 plan 加入 Active Plans 表

---

## 验证（接受标准）

1. `npm run rebuild:node` + `npx vitest run electron/memory/__tests__/curation_*.test.ts` 全绿
2. `npm run typecheck:all` 通过
3. `npm run electron:dev` 启动 30 min 后 `app.log` 出现：
   - `MemoryWorkerCurationCycle {"success":true,"durationMs":<30000,"actionsApplied":N}`（不是 1200000）
   - `phase2_workspace_diff.md` 在 cycle 成功后被更新
4. `global/areas/*.md` 在 cycle 成功时被合理更新
5. `MEMORY.md` / `summary.md` / `global/{areas,people}/index.md` 在 cycle 成功后被刷新
6. 24h 持续运行后 `curation_runs.succeeded` > 0 且 `curation_publications` > 0

## 风险与回滚

- **风险**：LLM 给出不合规 JSON → 每次 cycle 0 actions applied → 无害（curation 完全空跑）
- **风险**：path traversal bug → 文件写入越界 → 测试覆盖（Task D Step 3）+ Zod 严格白名单
- **回滚**：保留 `curation_agent_runner.ts` 在 git history；`git revert` Plan 417 commits 即可

## 不在本 plan 范围内

- Proactive memory enhancement（Plan 104：RealTimeCapture / decay）
- Research Memory / literature plugin（Plan 84，已完成 MVP + 移除）
- Memory 召回路径改造（plan 411 mode engine 集成）
- `MEMORY.md` / `summary.md` 生成 prompt 的 canary（Plan 405 已 done）