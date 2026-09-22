/**
 * runtime.ts — dwf 脚本运行时 v1（Phase 2）。
 *
 * 执行模型：`node:vm` 沙箱 + 宿主原语桥。脚本本体经 esbuild 转译（TS → CJS）后在
 * 一个**最小全局**的 vm context 里执行——没有 require/process/fetch/定时器，脚本能
 * 触达外界的唯一通道是注入的 `wf` 对象。每个 `wf.*` 调用走与声明式引擎相同的
 * journal 纪律（reqHash 缓存经济学，§6.4）：resume 时相同调用直接命中缓存，不再
 * 重付成本。
 *
 * 执行边界（v1 决策记录）：
 *   - suspend/resume 靠「journal 缓存 + 重跑整个脚本」实现：脚本重跑时所有已成功
 *     的原语调用命中缓存，`wf.approve` 在 resume 路径上由宿主用已批准的决定立即
 *     放行——不需要在沙箱里实现可序列化的执行栈。
 *   - 确定性规则（§6.5）：沙箱不提供 Date.now/setTimeout/Math.random 之外的定时
 *     能力（Math.random 留给显示用途，**禁止**用作控制流）；时钟类操作一律走宿主。
 *
 * 打包注记：esbuild 当前是根 package.json 的依赖（构建链已在用）。若未来把 agent
 * 打包进没有 esbuild 的产物，需要把 transform 换成预编译或把 esbuild 列入运行时
 * 依赖——compileDwfScript 会在缺依赖时抛出明确的错误而不是含糊失败。
 */

import * as vm from 'node:vm';
import type { Journal } from '../journal.js';
import { computeReqHash } from '../journal.js';
import { BudgetLedger, Semaphore, type HostAgentSpec, type HostCallContext, type HostCallResult } from '../host.js';
import { classifyError, type WorkflowErrorClass } from '../error-class.js';
import { uncertainOutcomeFor, type DecisionRunOutcome } from '../decision-adapter.js';
import type { DecisionQuestionSpec } from '../schema.js';
import type { Question } from '@duya/ai';

// ─── 宿主端口（与 WorkflowHost 同构，decide/publish 为脚本专有扩展） ───

export interface DwfDecisionOutcome {
  answers: Record<string, { value: string | number; p?: number; verdict: string }>;
  output: Record<string, string | number>;
  lowConfidence: string[];
  source: 'decision' | 'unavailable';
}

/** 运行时需要的决策面（生产由 WorkflowDecisionAdapter 适配，测试注入 canned）。 */
export interface DwfDecisionPort {
  readonly available: boolean;
  run(questions: Record<string, DecisionQuestionSpec>, state: unknown, thresholds?: Record<string, number>): Promise<DwfDecisionOutcome>;
}

export interface DwfHostPorts {
  runTool(tool: string, input: unknown, ctx: HostCallContext): Promise<HostCallResult>;
  runAgent(spec: HostAgentSpec, ctx: HostCallContext): Promise<HostCallResult>;
  /** Human approval（498 卡管线）。resolve approve/deny/timeout。 */
  requestApproval(spec: { prompt: string; timeoutMs?: number }, ctx: HostCallContext): Promise<{ decision: 'approve' | 'deny' | 'timeout' }>;
  /** 551 DecisionService 桥。缺席 = 决策面不可用（走 onLowConfidence 路径）。 */
  decide?: DwfDecisionPort;
  /** 产物通道。缺席时 publish 只落 journal。 */
  publishArtifact?(name: string, content: unknown, contentType: string): Promise<void> | void;
  /** Per-record 进度挂钩（SSE 频道）——Journal.listener 的透传位。 */
  onJournalEvent?(record: Parameters<Journal['append']>[0]): void;
  /** agent 调用预算（默认走 WORKFLOW_BUDGET_DEFAULTS）。 */
  agentBudget?: number;
  /** map 并发上限（1..16，默认 4）。 */
  mapConcurrency?: number;
}

// ─── 脚本可见的错误类型 ───

export class DwfApprovalDeniedError extends Error {
  constructor(
    readonly prompt: string,
    readonly kind: 'denied' | 'escalate',
  ) {
    super(kind === 'denied' ? `approval denied: ${prompt}` : `approval timed out (escalate): ${prompt}`);
    this.name = 'DwfApprovalDeniedError';
  }
}

export class DwfBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DwfBudgetError';
  }
}

export class DwfCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DwfCompileError';
  }
}

// ─── 编译 ───

/** 缓存 esbuild 的动态 import，避免每脚本一次解析成本。 */
type EsbuildModule = { transform(input: string, options?: unknown): Promise<{ code: string; map: string }> };
let esbuildPromise: Promise<EsbuildModule | null> | undefined;

async function loadEsbuild(): Promise<EsbuildModule | null> {
  esbuildPromise ??= import(/* webpackIgnore: true */ 'esbuild')
    .then((m) => m as unknown as EsbuildModule)
    .catch(() => null);
  return esbuildPromise;
}

/**
 * 脚本本体 → 可执行函数。要求脚本 `export default async function (wf) {...}`；
 * 编译失败（语法/类型级错误）抛 DwfCompileError，错误信息按**正文行号**报
 * （frontmatter 的 bodyLineOffset 由调用方在需要文件行号时再加）。
 *
 * `context`：目标 vm context。runDwfScript 会传入含 wf/args/console 的运行
 * context——脚本函数必须编译进创建它的那个 context，否则 args/console 这些
 * 全局在函数作用域里不可见（vm 的全局是 per-context 的）。校验场景（planner）
 * 不传，用一次性空 context。
 */
export async function compileDwfScript(
  body: string,
  context?: vm.Context,
): Promise<(wf: DwfApi) => Promise<unknown>> {
  const esbuild = await loadEsbuild();
  if (!esbuild) {
    throw new DwfCompileError('esbuild is not available in this runtime — dwf scripts cannot be compiled');
  }
  let js: string;
  try {
    js = (await esbuild.transform(body, { loader: 'ts', format: 'cjs' })).code;
  } catch (err) {
    throw new DwfCompileError(err instanceof Error ? err.message : String(err));
  }
  // CJS 产物把 default 挂在 module.exports（esbuild 的 `module.exports =
  // __toCommonJS(...)` 形态），exports 参数只是别名——两个位置都要兜。
  const target = context ?? vm.createContext({});
  const wrapper = vm.runInContext(
    `(function (module, exports) { ${js}\n; return typeof module.exports?.default === 'function' ? module.exports.default : (typeof exports.default === 'function' ? exports.default : (typeof module.exports === 'function' ? module.exports : undefined)); })`,
    target,
  ) as (module: { exports: unknown }, exports: Record<string, unknown>) => unknown;
  const mod = { exports: {} as Record<string, unknown> };
  const fn = wrapper(mod, mod.exports);
  if (typeof fn !== 'function') {
    throw new DwfCompileError('dwf script must export default an async function: `export default async function (wf) { ... }`');
  }
  return fn as (wf: DwfApi) => Promise<unknown>;
}

// ─── wf API 形状（脚本作者视角；实现在 createDwfApi） ───

export interface DwfApi {
  /** 零 LLM 的确定性工具调用（ToolRegistry 直达）。 */
  tool(tool: string, input?: Record<string, unknown>): Promise<unknown>;
  /** 开放式子任务（SubagentTool）。opts.outputSchema 走宿主校验+一次重试。 */
  agent(agentType: string, prompt: string, opts?: { model?: string; outputSchema?: Record<string, unknown> }): Promise<unknown>;
  /** 人在环审批。deny 抛错；timeout 按 onTimeout：fail=抛错、skip=返回 null、escalate=抛 escalate。 */
  approve(prompt: string, opts: { timeoutHours?: number; onTimeout: 'fail' | 'skip' | 'escalate' }): Promise<null | undefined>;
  /** System One 类型化决策。决策面缺席且无 default 时抛错。 */
  decide(questions: Record<string, DecisionQuestionSpec>, opts?: { state?: unknown; thresholds?: Record<string, number>; onLowConfidenceDefault?: string | number | boolean }): Promise<Record<string, string | number>>;
  /** fan-out：items 逐项调 fn，Semaphore 限并发。 */
  map<T, R>(items: readonly T[], fn: (item: T, index: number) => Promise<R>, opts?: { concurrency?: number }): Promise<R[]>;
  /** 发布一个用户可见产物（artifact journal + 可选宿主通道）。 */
  publish(name: string, content: unknown, contentType?: string): Promise<void>;
  /** 结构化进度日志（journal，不进对话流）。 */
  log(message: string): void;
}

// ─── 运行 ───

export interface DwfRunOptions {
  runId: string;
  journal: Journal;
  budget?: BudgetLedger;
  /** 脚本 args（frontmatter 声明）。缺省值在这里应用。 */
  args?: Record<string, unknown>;
  /** resume 判定：true 时 approve 走宿主的既有决定（缓存/已批准）直接放行。 */
  resuming?: boolean;
}

/** 调用计数 → 稳定 nodeId（同一脚本同一执行序 → 同一 id，缓存键的前提）。 */
function callNodeId(seq: number, action: string): string {
  return `dwf-${String(seq).padStart(3, '0')}-${action}`;
}

function safeJsonSize(value: unknown): number {
  try {
    return JSON.stringify(value ?? null)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** map 的实现（独立泛型函数：对象字面量方法会丢掉接口的类型参数）。 */
async function runMap<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  limit: number,
): Promise<R[]> {
  const lane = new Semaphore(limit);
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      const release = await lane.acquire();
      try {
        results[index] = await fn(items[index]!, index);
      } finally {
        release();
      }
    }
  });
  await Promise.all(workers);
  return results as R[];
}

/**
 * 构造脚本可见的 `wf` 对象。所有原语共享一条 journal 纪律：
 * reqHash 缓存命中 → 直接复用（resume 免重付）；否则执行宿主调用并落一条成功记录。
 * 失败也落记录（errorClass 分类），但**不**进缓存——重跑会真正重试。
 */
export function createDwfApi(ports: DwfHostPorts, opts: DwfRunOptions): DwfApi {
  const journal = opts.journal;
  // 实时进度挂钩：Journal.listener 是单槽，链式接——宿主可能已挂自己的 tap。
  if (ports.onJournalEvent) {
    const tap = ports.onJournalEvent;
    const prev = journal.listener;
    journal.listener = (record) => {
      try {
        tap(record);
      } catch {
        // 进度 tap 永不破坏执行。
      }
      prev?.(record);
    };
  }
  const budget = opts.budget ?? new BudgetLedger(ports.agentBudget);
  const ctx: HostCallContext = { runId: opts.runId, nodeId: '' };
  let callSeq = 0;

  /** 共享的「缓存优先宿主调用」。返回 [值, 是否缓存命中]。 */
  async function cachedCall<T>(
    kind: 'node_result' | 'decision' | 'approval',
    action: string,
    nodeKind: 'tool' | 'agent' | 'decision' | 'human',
    payload: unknown,
    execute: () => Promise<{ value: T; meta?: { childSessionId?: string; exitCode?: number | null; usage?: { inputTokens: number; outputTokens: number } } }>,
  ): Promise<{ value: T; cached: boolean }> {
    const nodeId = callNodeId(callSeq++, action);
    const reqHash = computeReqHash(kind, payload);
    const hit = journal.hit(nodeId, reqHash);
    if (hit && hit.result !== undefined) {
      journal.append({ kind, nodeId, attempt: 1, status: 'succeeded', result: hit.result, nodeKind, action, durationMs: 0 });
      return { value: hit.result as T, cached: true };
    }
    const startedAt = Date.now();
    try {
      const outcome = await execute();
      journal.append({
        kind,
        nodeId,
        attempt: 1,
        reqHash,
        status: 'succeeded',
        result: outcome.value === undefined ? null : outcome.value,
        nodeKind,
        action,
        durationMs: Date.now() - startedAt,
        outputSize: safeJsonSize(outcome.value),
        ...(outcome.meta?.childSessionId !== undefined ? { childSessionId: outcome.meta.childSessionId } : {}),
        ...(outcome.meta?.exitCode !== undefined ? { exitCode: outcome.meta.exitCode } : {}),
        ...(outcome.meta?.usage !== undefined ? { usage: outcome.meta.usage } : {}),
      });
      return { value: outcome.value, cached: false };
    } catch (err) {
      journal.append({
        kind,
        nodeId,
        attempt: 1,
        status: 'failed',
        nodeKind,
        action,
        errorClass: classifyError(err),
        durationMs: Date.now() - startedAt,
      });
      throw err;
    }
  }

  const wf: DwfApi = {
    async tool(tool, input) {
      const { value } = await cachedCall('node_result', `tool:${tool}`, 'tool', { tool, input }, async () => {
        budget.countHostCall();
        const res = await ports.runTool(tool, input ?? {}, ctx);
        if (!res.ok) throw new Error(res.error ?? `tool "${tool}" failed`);
        return { value: res.output, meta: { exitCode: res.exitCode ?? null } };
      });
      return value;
    },

    async agent(agentType, prompt, agentOpts) {
      const { value } = await cachedCall('node_result', `agent:${agentType}`, 'agent', { agentType, prompt, ...agentOpts }, async () => {
        const ticket = budget.reserveAgent();
        try {
          const res = await ports.runAgent({ agent: agentType, prompt, ...(agentOpts?.model !== undefined ? { model: agentOpts.model } : {}), ...(agentOpts?.outputSchema !== undefined ? { outputSchema: agentOpts.outputSchema } : {}) }, ctx);
          if (!res.ok) throw new Error(res.error ?? `agent "${agentType}" failed`);
          budget.commit(ticket);
          return { value: res.output, meta: { childSessionId: res.childSessionId, usage: res.usage } };
        } catch (err) {
          budget.release(ticket);
          throw err;
        }
      });
      return value;
    },

    async approve(prompt, approveOpts) {
      const { value } = await cachedCall('approval', 'approve', 'human', { prompt }, async () => {
        const res = await ports.requestApproval(
          { prompt, ...(approveOpts.timeoutHours !== undefined ? { timeoutMs: approveOpts.timeoutHours * 3_600_000 } : {}) },
          ctx,
        );
        if (res.decision === 'approve') return { value: 'approved' as const };
        if (res.decision === 'deny') throw new DwfApprovalDeniedError(prompt, 'denied');
        // timeout → 按 onTimeout 三态（YAML human 节点同一条语义）。
        if (approveOpts.onTimeout === 'skip') return { value: 'skipped' as const };
        throw new DwfApprovalDeniedError(prompt, 'escalate');
      });
      // skip 的 timeout 在 journal 里是 succeeded('skipped')，对脚本呈现为 null。
      return value === 'skipped' ? null : undefined;
    },

    async decide(questions, decideOpts) {
      const { value } = await cachedCall('decision', 'decide', 'decision', { questions, state: decideOpts?.state, thresholds: decideOpts?.thresholds }, async () => {
        const backend = ports.decide;
        let outcome: DecisionRunOutcome;
        if (backend && backend.available) {
          const res = await backend.run(questions, decideOpts?.state, decideOpts?.thresholds);
          outcome = {
            answers: res.answers as DecisionRunOutcome['answers'],
            output: res.output,
            lowConfidence: res.lowConfidence,
            source: 'decision',
          };
        } else {
          // 与 YAML 决策节点同一条不可用路径：default 填充，否则全部落入灰带。
          outcome = uncertainOutcomeFor({
            state: { output: '' },
            questions,
            ...(decideOpts?.thresholds !== undefined ? { thresholds: decideOpts.thresholds } : {}),
            ...(decideOpts?.onLowConfidenceDefault !== undefined
              ? { on_low_confidence: { default: decideOpts.onLowConfidenceDefault } }
              : {}),
          });
        }
        if (outcome.lowConfidence.length > 0) {
          throw new Error(`decision uncertain for: ${outcome.lowConfidence.join(', ')} — add onLowConfidenceDefault or a decision backend`);
        }
        return { value: outcome.output };
      });
      return value as Record<string, string | number>;
    },

    async map(items, fn, mapOpts) {
      const limit = Math.min(Math.max(mapOpts?.concurrency ?? ports.mapConcurrency ?? 4, 1), 16);
      return runMap(items, fn, limit);
    },

    async publish(name, content, contentType) {
      const nodeId = callNodeId(callSeq++, `publish:${name}`);
      if (ports.publishArtifact) await ports.publishArtifact(name, content, contentType ?? 'text/plain');
      journal.append({
        kind: 'artifact',
        nodeId,
        attempt: 1,
        status: 'succeeded',
        result: { name, contentType: contentType ?? 'text/plain', content },
        nodeKind: 'noop',
        action: 'publish',
        outputSize: safeJsonSize(content),
      });
    },

    log(message) {
      const nodeId = callNodeId(callSeq++, 'log');
      journal.append({
        kind: 'node_result',
        nodeId,
        attempt: 1,
        status: 'succeeded',
        result: message,
        nodeKind: 'noop',
        action: 'log',
      });
    },
  };

  return wf;
}

/**
 * 编译 + 在最小全局 vm 沙箱里执行一个 dwf 脚本。args 先应用声明默认值再注入。
 * 返回脚本的 return 值。脚本报错原样抛出（调用方决定 run 状态）。
 */
export async function runDwfScript(
  scriptBody: string,
  ports: DwfHostPorts,
  opts: DwfRunOptions,
): Promise<unknown> {
  const wf = createDwfApi(ports, opts);
  const sandboxArgs = { ...opts.args };

  // 先建含 wf/args/console 的 context，再把它交给编译——脚本函数必须活在
  // 这个 context 里，全局（args/console）才在它的作用域链上。
  const context = vm.createContext({
    // 最小全局：无 process/require/fetch/定时器。JSON/Math/console/URL/Text* 是
    // 无副作用或宿主代理的显示面。
    JSON,
    Math,
    URL,
    TextEncoder,
    TextDecoder,
    console: {
      log: (...parts: unknown[]) => wf.log(parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')),
      warn: (...parts: unknown[]) => wf.log(`[warn] ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}`),
      error: (...parts: unknown[]) => wf.log(`[error] ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}`),
    },
    wf,
    args: sandboxArgs,
  });
  const fn = await compileDwfScript(scriptBody, context);

  try {
    return await fn(wf);
  } catch (err) {
    if (err instanceof Error && err.name === 'BudgetExceededError') {
      throw new DwfBudgetError(err.message);
    }
    throw err;
  }
}

/** 重新导出：调用方（manager/IPC）构造 ports 时需要的 Question 形状来源。 */
export type { Question };
