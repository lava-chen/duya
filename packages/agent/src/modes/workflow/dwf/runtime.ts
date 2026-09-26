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
import { validateLooseJsonSchema, type LooseSchema } from '../output-schema.js';
import { uncertainOutcomeFor, type DecisionRunOutcome } from '../decision-adapter.js';
import type { DecisionQuestionSpec, GuiNodeSpec } from '../schema.js';
import type { GuiNodeOutcome } from '../gui-runner.js';
import type { BrowserNodeOutcome, BrowserNodeSpec, BrowserStep } from '../browser-runner.js';
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
  /**
   * RPA 步骤序列执行（gui-runner 的 runGuiNode 语义由宿主绑定层包装）。
   * 缺席时 wf.gui 抛明确错误——录制转换的脚本必须绑定此端口才有意义。
   */
  runGui(spec: GuiNodeSpec, annotation: Record<string, unknown> | undefined, ctx: HostCallContext): Promise<GuiNodeOutcome>;
  /**
   * 浏览器插件步骤序列（plan 564，browser-runner 的 runBrowserNode 语义由宿主
   * 绑定层包装）。缺席时 wf.browser 抛明确错误——扩展驱动的脚本必须绑定此端口。
   */
  runBrowser?(spec: BrowserNodeSpec, ctx: HostCallContext): Promise<BrowserNodeOutcome>;
  /**
   * 升级问询（plan 565 Phase D）：把问题投给锚定会话（AskUserQuestion 管线，
   * 复用 chat:permission 帧），受控答复后继续。缺席时 wf.ask 抛明确错误、
   * gui/browser 的 on_stuck:'agent' 档按既有降级路径走。
   */
  runAsk?(question: string, ctx: HostCallContext): Promise<{ answer: string | null }>;
  /** Human approval（498 卡管线）。resolve approve/deny/timeout。 */
  requestApproval(spec: { prompt: string; timeoutMs?: number }, ctx: HostCallContext): Promise<{ decision: 'approve' | 'deny' | 'timeout' }>;
  /** 551 DecisionService 桥。缺席 = 决策面不可用（走 onLowConfidence 路径）。 */
  decide?: DwfDecisionPort;
  /** 产物通道。缺席时 publish 只落 journal；返回 descriptor 时其 ref/relPath 进 journal（产物可点）。 */
  publishArtifact?(name: string, content: unknown, contentType: string): Promise<{ ref?: string; relPath?: string } | void> | { ref?: string; relPath?: string } | void;
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

/**
 * wf.agent 的对象调用形态（与位置参数 `wf.agent(agentType, prompt, opts?)`
 * 二选一，不可混用）。脚本作者常把 opts 与定位参数记混，这里把整个对象
 * 当第一参的写法也接住——历史 rpa 脚本就是这么写的。
 */
export interface DwfAgentObjectSpec {
  /** 也可以写别名 `type`。 */
  agentType?: string;
  type?: string;
  prompt: string;
  model?: string;
  outputSchema?: Record<string, unknown>;
  sticky?: string;
}

export interface DwfApi {
  /** 零 LLM 的确定性工具调用（ToolRegistry 直达）。 */
  tool(tool: string, input?: Record<string, unknown>): Promise<unknown>;
  /**
   * RPA：对目标应用执行确定性步骤序列（capture/click/type_text/key/scroll）。
   * `som:<n>` 引用 annotation.som 里记录的元素（录制转换产物）或自己上一次
   * capture 的新索引。失败抛错；skipped resolve null；成功 resolve outcome.output。
   */
  gui(spec: GuiNodeSpec, opts?: { annotation?: Record<string, unknown> }): Promise<unknown>;
  /**
   * 浏览器插件节点（plan 564）：对真实浏览器执行确定性步骤序列（navigate/
   * click/type/set_value/key/scroll/wait/screenshot，CSS selector 定位）。
   * 需要 DUYA Browser Bridge 扩展在线；失败抛错；on_stuck:'skip' 时 resolve null。
   */
  browser(spec: BrowserNodeSpec): Promise<unknown>;
  /**
   * 开放式子任务（SubagentTool）。
   * - opts.outputSchema：宿主校验 + 一次同上下文 nudge 重试（plan 565 Phase C；
   *   此前该参数被静默丢弃，注释承诺的校验从未存在）。二次仍不符抛
   *   schema_mismatch，交由节点 on_stuck 阶梯裁决。
   * - opts.sticky：run 内 actor 键。同键的后续调用把上轮结果摘要拼进 prompt
   *   （v1 降级实现——SubagentTool 的 resume_from 是宣传未实现的死参数，真续
   *   会话需要动执行器，超出 dwf 范围）。sticky 轮的 reqHash 含拼入的上轮
   *   摘要，天然不与首轮撞缓存。
   */
  agent(agentType: string | DwfAgentObjectSpec, prompt?: string, opts?: { model?: string; outputSchema?: Record<string, unknown>; sticky?: string }): Promise<unknown>;
  /** 人在环审批。deny 抛错；timeout 按 onTimeout：fail=抛错、skip=返回 null、escalate=抛 escalate。 */
  approve(prompt: string, opts: { timeoutHours?: number; onTimeout: 'fail' | 'skip' | 'escalate' }): Promise<null | undefined>;
  /**
   * 升级问询（plan 565 Phase D，ZCode escalate 的对应物）：把自由文本问题投给
   * 锚定会话的问询卡（AskUserQuestion 管线），答案落 journal（nodeKind 'ask'，
   * resume 重放不再打扰）。卡片被拒/超时 → resolve null，脚本自行裁决。
   */
  ask(question: string): Promise<string | null>;
  /** System One 类型化决策。决策面缺席且无 default 时抛错。 */
  decide(questions: Record<string, DecisionQuestionSpec>, opts?: { state?: unknown; thresholds?: Record<string, number>; onLowConfidenceDefault?: string | number | boolean }): Promise<Record<string, string | number>>;
  /** fan-out：items 逐项调 fn，Semaphore 限并发。 */
  map<T, R>(items: readonly T[], fn: (item: T, index: number) => Promise<R>, opts?: { concurrency?: number }): Promise<R[]>;
  /** 发布一个用户可见产物（artifact journal + 可选宿主通道）。 */
  publish(name: string, content: unknown, contentType?: string): Promise<void>;
  /** 结构化进度日志（journal，不进对话流）。 */
  log(message: string): void;
  /**
   * 阶段分隔（plan 560 §6.2，第 9 个原语）。落一条 `kind:'phase'` 的 journal
   * 记录，渲染层据此**按 seq 切段**：首个 phase 之前的记录归隐式阶段「准备」，
   * 其后所有记录归该阶段。不返回任何值，也不参与缓存经济学。
   *
   * 存量脚本没有 phase → 渲染成单个隐式阶段，不报错。
   */
  phase(name: string): void;
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
  /**
   * Run 级 agent 模型（plan 568）：`wf.agent` 未显式传 `opts.model` 时的默认。
   * launch 链路从启动对话框的覆盖字段贯通而来；缺省 = 继承 worker 主模型
   * （SubagentTool 的 `model || definition.model || mainLoopModel` 链）。
   */
  agentModel?: string;
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

/**
 * 从模型的字符串输出里提取 JSON 候选（plan 568）。模型经常把 JSON 包进
 * ```json fence 或前后缀 prose——schema 校验直接看到 string，报
 * "expected type object, got string" 假阳性（实测 rpa-news-digest 两个
 * agent 均此死法）。提取顺序：整串 parse → fenced block → 首个平衡的
 * {…}/[…] 片段。提取失败返回 undefined（调用方回落原值）。
 */
export function extractJsonCandidate(output: unknown): unknown {
  if (typeof output !== 'string') return undefined;
  const text = output.trim();
  if (text === '') return undefined;
  const tryParse = (s: string): unknown | undefined => {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      return undefined;
    }
  };
  const direct = tryParse(text);
  if (direct !== undefined) return direct;
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenced) {
    const inner = tryParse(fenced[1].trim());
    if (inner !== undefined) return inner;
  }
  for (const [open, close] of [['{', '}'], ['[', ']']] as const) {
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    if (start !== -1 && end > start) {
      const parsed = tryParse(text.slice(start, end + 1));
      if (parsed !== undefined) return parsed;
    }
  }
  return undefined;
}

// ─── 输入摘要（plan 560 §6.1：display-only，绝不进 reqHash） ───

/** 最像「一行命令」的键，按优先级取第一个非空字符串。 */
const SUMMARY_KEYS = [
  'cmd',
  'command',
  'command_text',
  'file_path',
  'path',
  'pattern',
  'query',
  'url',
  'prompt',
  'text',
  'name',
  'title',
] as const;

/** 一行输入摘要；压平空白并截断。绝不参与任何哈希。 */
function pickSummaryText(value: unknown, max = 200): string {
  let text = '';
  if (typeof value === 'string') {
    text = value;
  } else if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of SUMMARY_KEYS) {
      const candidate = obj[key];
      if (typeof candidate === 'string' && candidate.trim() !== '') {
        text = candidate.trim();
        break;
      }
    }
    if (text === '') {
      try {
        text = JSON.stringify(value) ?? '';
      } catch {
        text = '';
      }
    }
  } else if (value !== undefined) {
    text = String(value);
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 单个 RPA 步骤的一行摘要（`click som:3`、`capture`…）。 */
function describeGuiStep(
  step: { do?: string; element?: string; key?: string; direction?: string } | undefined,
): string {
  if (!step) return 'no steps';
  const element = typeof step.element === 'string' && step.element !== '' ? ` ${step.element}` : '';
  switch (step.do) {
    case 'capture':
      return 'capture';
    case 'click':
      return `click${element}`;
    case 'type_text':
      return `type_text${element}`;
    case 'set_value':
      return `set_value${element}`;
    case 'key':
      return `key ${step.key ?? ''}`.trim();
    case 'scroll':
      return `scroll ${step.direction ?? 'down'}`;
    default:
      return step.do ?? 'step';
  }
}

/** 单个 browser 步骤的一行摘要（`navigate https://…`、`click #submit`…）。 */
function describeBrowserStep(step: BrowserStep | undefined): string {
  if (!step) return 'no steps';
  switch (step.do) {
    case 'navigate':
      return `navigate ${step.url}`;
    case 'click':
      return `click ${step.selector}`;
    case 'click_text':
      return `click_text ${step.text}`;
    case 'type':
      return `type ${step.selector}`;
    case 'set_value':
      return `set_value ${step.selector}`;
    case 'key':
      return `key ${step.key}`;
    case 'scroll':
      return `scroll ${step.direction ?? 'down'}`;
    case 'wait':
      return step.selector ? `wait ${step.selector}` : step.text ? `wait text:${step.text}` : 'wait';
    case 'screenshot':
      return `screenshot${step.name ? ` ${step.name}` : ''}`;
  }
}

/**
 * cachedCall 的输入摘要 —— run 卡片步骤行显示的那一行（plan 560 §7.2）。
 * 由 payload 推导而不是各原语手传，保证「同一个 payload → 同一个摘要」，
 * 也让新增原语不必记得补这个字段。
 */
function summarizeCall(action: string, nodeKind: string, payload: unknown): string {
  const obj = (payload ?? {}) as Record<string, unknown>;
  switch (nodeKind) {
    case 'tool':
      return pickSummaryText(obj.input);
    case 'gui': {
      const spec = obj.spec as GuiNodeSpec | undefined;
      const steps = spec?.steps ?? [];
      const head = describeGuiStep(steps[0]);
      const rest = steps.length > 1 ? ` +${steps.length - 1}` : '';
      return `${spec?.target_app ?? 'gui'}: ${head}${rest}`;
    }
    case 'browser': {
      const spec = obj.spec as BrowserNodeSpec | undefined;
      const steps = spec?.steps ?? [];
      const head = describeBrowserStep(steps[0]);
      const rest = steps.length > 1 ? ` +${steps.length - 1}` : '';
      return `${spec?.start_url ?? 'browser'}: ${head}${rest}`;
    }
    case 'agent':
    case 'human':
      return pickSummaryText(obj.prompt);
    case 'decision': {
      const ids = Object.keys((obj.questions ?? {}) as Record<string, unknown>);
      return ids.length > 0 ? `decide ${ids.join(', ')}` : 'decide';
    }
    default:
      return action;
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
  // Sticky actor notebook (plan 565 Phase C): sticky key → last result text.
  // Populated on BOTH fresh execution and cache hits, so a resumed run (the
  // first sticky call replaying from the seeded journal) still hands the
  // previous answer to the second sticky turn.
  const stickyLast = new Map<string, string>();

  /** Cap the carried-over answer so one huge turn cannot bloat every later prompt. */
  const STICKY_CARRY_MAX = 4_000;

  /** 共享的「缓存优先宿主调用」。返回 [值, 是否缓存命中]。 */
  async function cachedCall<T>(
    kind: 'node_result' | 'decision' | 'approval',
    action: string,
    nodeKind: 'tool' | 'gui' | 'browser' | 'agent' | 'decision' | 'human' | 'ask',
    payload: unknown,
    execute: () => Promise<{ value: T; meta?: { childSessionId?: string; exitCode?: number | null; usage?: { inputTokens: number; outputTokens: number } } }>,
  ): Promise<{ value: T; cached: boolean }> {
    const nodeId = callNodeId(callSeq++, action);
    const reqHash = computeReqHash(kind, payload);
    // 同样的 payload 必得同样的摘要（§6.1）——它只服务显示，从不进 reqHash。
    const inputSummary = summarizeCall(action, nodeKind, payload);
    const hit = journal.hit(nodeId, reqHash);
    if (hit && hit.result !== undefined) {
      journal.append({ kind, nodeId, attempt: 1, status: 'succeeded', result: hit.result, nodeKind, action, inputSummary, replayed: true, durationMs: 0 });
      return { value: hit.result as T, cached: true };
    }
    // Plan 568: 节点启动即落一条 running 记录——「one write, three uses」的
    // 实时面。cache 只认 succeeded，resume 语义不变；崩溃残留的 trailing
    // running 记录由 UI 侧 last-wins 折叠，不影响重放。
    journal.append({ kind, nodeId, attempt: 1, status: 'running', nodeKind, action, inputSummary });
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
        inputSummary,
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
        inputSummary,
        errorClass: classifyError(err),
        durationMs: Date.now() - startedAt,
        // 失败的 agent 也可能已经建了子会话（schema_mismatch / 中途出错）——
        // 带上它，运行卡片的 agent chip 才能点进实时界面。
        ...((err as { childSessionId?: string } | null)?.childSessionId
          ? { childSessionId: (err as { childSessionId: string }).childSessionId }
          : {}),
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

    async gui(spec, guiOpts) {
      const { value } = await cachedCall('node_result', `gui:${spec.target_app}`, 'gui', { spec, annotation: guiOpts?.annotation }, async () => {
        budget.countHostCall();
        const outcome = await ports.runGui(spec, guiOpts?.annotation, ctx);
        if (outcome.status === 'failed') {
          throw new Error(outcome.error ?? `gui "${spec.target_app}" failed`);
        }
        if (outcome.status === 'skipped') return { value: null };
        return { value: outcome.output ?? null };
      });
      return value;
    },

    async browser(spec) {
      const { value } = await cachedCall('node_result', `browser:${spec.start_url ?? spec.steps[0]?.do ?? 'browser'}`, 'browser', { spec }, async () => {
        budget.countHostCall();
        if (!ports.runBrowser) {
          throw new Error('wf.browser is not bound in this worker — no browser bridge port');
        }
        const outcome = await ports.runBrowser(spec, ctx);
        if (outcome.status === 'failed') {
          throw new Error(outcome.error ?? 'browser node failed');
        }
        if (outcome.status === 'skipped') return { value: null };
        return { value: outcome.output ?? null };
      });
      return value;
    },

    async agent(agentType, prompt, agentOpts) {
      // 对象形态归一化：wf.agent({ agentType, prompt, model?, outputSchema?, sticky? })
      // 等价于 wf.agent(agentType, prompt, opts)。两种写法二选一，混用即抛。
      // （此前对象被原样当成 agentType 传给 SubagentTool 的 subagent_type，
      // 在 .trim() 上爆出无从理解的 "o.trim is not a function"。）
      if (agentType !== null && typeof agentType === 'object') {
        if (prompt !== undefined || agentOpts !== undefined) {
          throw new TypeError(
            'wf.agent: object form and positional form cannot be mixed — use wf.agent({agentType, prompt, ...}) OR wf.agent(agentType, prompt, opts?)',
          );
        }
        const spec = agentType as DwfAgentObjectSpec;
        agentOpts = {
          ...(spec.model !== undefined ? { model: spec.model } : {}),
          ...(spec.outputSchema !== undefined ? { outputSchema: spec.outputSchema } : {}),
          ...(spec.sticky !== undefined ? { sticky: spec.sticky } : {}),
        };
        prompt = spec.prompt;
        agentType = spec.agentType ?? spec.type ?? '';
      }
      if (typeof agentType !== 'string' || agentType.trim() === '') {
        throw new TypeError(
          `wf.agent: agentType must be a non-empty string (got ${agentType === null ? 'null' : typeof agentType}) — usage: wf.agent('general-purpose', prompt, opts?) or wf.agent({agentType, prompt, ...})`,
        );
      }
      if (typeof prompt !== 'string' || prompt.trim() === '') {
        throw new TypeError('wf.agent: prompt must be a non-empty string');
      }
      const stickyKey = agentOpts?.sticky;
      // Sticky continuation: bake the actor's previous answer into the prompt.
      // The embedded summary changes the payload → a different reqHash than
      // the first turn's, so sticky turns never collide with (or suppress)
      // each other in the journal replay cache.
      const prev = stickyKey ? stickyLast.get(stickyKey) : undefined;
      const effectivePrompt =
        prev !== undefined
          ? `<sticky_context>\nThe previous turn of this actor produced:\n${prev.length > STICKY_CARRY_MAX ? `${prev.slice(0, STICKY_CARRY_MAX)}…` : prev}\n</sticky_context>\n\n${prompt}`
          : prompt;

      const { value } = await cachedCall(
        'node_result',
        `agent:${agentType}`,
        'agent',
        { agentType, prompt: effectivePrompt, ...(agentOpts?.model !== undefined ? { model: agentOpts.model } : {}), ...(agentOpts?.outputSchema !== undefined ? { outputSchema: agentOpts.outputSchema } : {}) },
        async () => {
          const ticket = budget.reserveAgent();
          try {
            const runSpec = {
              agent: agentType,
              prompt: effectivePrompt,
              // 显式 opts.model > run 级 agentModel（plan 568）> 子代理自身默认。
              ...(agentOpts?.model !== undefined
                ? { model: agentOpts.model }
                : opts.agentModel !== undefined
                  ? { model: opts.agentModel }
                  : {}),
              ...(agentOpts?.outputSchema !== undefined ? { outputSchema: agentOpts.outputSchema } : {}),
            };
            let res = await ports.runAgent(runSpec, ctx);
            // 模型常把 JSON 包进 fence/prose——先提取再校验（plan 568），否则
            // "expected type object, got string" 假阳性。提取结果同时作为最终
            // 输出，脚本拿到的就是结构化对象。
            if (res.ok) {
              const extracted = extractJsonCandidate(res.output);
              if (extracted !== undefined) res = { ...res, output: extracted };
            }
            // Host-side outputSchema contract + ONE same-context nudge retry
            // (plan 565 Phase C). The retry reuses the effective prompt (with
            // its sticky context) — economically the ZCode "reject → repair
            // in the same turn" slot, minus a persisted sub-session.
            const schema = agentOpts?.outputSchema as LooseSchema | undefined;
            if (schema && res.ok) {
              const reason = validateLooseJsonSchema(res.output, schema);
              if (reason) {
                const nudgePrompt = `${effectivePrompt}\n\nYour previous answer failed schema validation: ${reason}. Return the answer again as JSON matching the schema — raw JSON only, no markdown fences or prose.`;
                res = await ports.runAgent({ ...runSpec, prompt: nudgePrompt }, ctx);
                if (res.ok) {
                  const retryExtracted = extractJsonCandidate(res.output);
                  if (retryExtracted !== undefined) res = { ...res, output: retryExtracted };
                }
                const retryReason = res.ok ? validateLooseJsonSchema(res.output, schema) : 'agent failed';
                if (retryReason) {
                  const err = new Error(`output_schema mismatch: ${retryReason}`);
                  (err as Error & { errorClass?: string }).errorClass = 'schema_mismatch';
                  if (res.childSessionId) (err as { childSessionId?: string }).childSessionId = res.childSessionId;
                  throw err;
                }
              }
            }
            if (!res.ok) {
              const err = new Error(res.error ?? `agent "${agentType}" failed`);
              // 失败也可能已有子会话——带上传给 journal，chip 才能点进观看。
              if (res.childSessionId) (err as { childSessionId?: string }).childSessionId = res.childSessionId;
              throw err;
            }
            budget.commit(ticket);
            return { value: res.output, meta: { childSessionId: res.childSessionId, usage: res.usage } };
          } catch (err) {
            budget.release(ticket);
            throw err;
          }
        },
      );
      if (stickyKey) {
        stickyLast.set(
          stickyKey,
          typeof value === 'string' ? value : JSON.stringify(value) ?? String(value),
        );
      }
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

    async ask(question) {
      const { value } = await cachedCall('approval', 'ask', 'ask', { question }, async () => {
        if (!ports.runAsk) {
          // 与 runGui/runBrowser 缺端口的语义同构：明确报错，而非静默 null。
          throw new Error('wf.ask is not bound in this worker — no ask port on the host ports');
        }
        const outcome = await ports.runAsk(question, ctx);
        // 卡片拒绝/超时 → { answered: false }：journal 里是 succeeded(null)，
        // 与 approve skip 同一经济学——已完成的问询不再重付。
        return { value: outcome.answer ?? null };
      });
      return value as string | null;
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
      // Plan 568: descriptor.ref 落进 journal result——运行卡片 / 面板靠它
      // 把产物芯片变成可点击（此前 descriptor 被丢弃，产物永远点不开）。
      const descriptor = ports.publishArtifact
        ? await ports.publishArtifact(name, content, contentType ?? 'text/plain')
        : undefined;
      // ref 与 relPath 同值（`<runId>/<name><ext>`）——renderer 的点击键。
      const ref =
        descriptor && typeof descriptor === 'object'
          ? ((descriptor as { ref?: unknown }).ref ?? (descriptor as { relPath?: unknown }).relPath)
          : undefined;
      const refStr = typeof ref === 'string' && ref !== '' ? ref : undefined;
      journal.append({
        kind: 'artifact',
        nodeId,
        attempt: 1,
        status: 'succeeded',
        result: { name, contentType: contentType ?? 'text/plain', content, ...(refStr !== undefined ? { ref: refStr } : {}) },
        nodeKind: 'noop',
        action: 'publish',
        inputSummary: name,
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
        inputSummary: pickSummaryText(message),
      });
    },

    phase(name) {
      // §6.2：`JournalKind` 早就有 'phase'，此前从没有生产者。落下这条记录，
      // 渲染层按 seq 切段即可得到阶段列表；不返回、不缓存、不进预算。
      journal.append({
        kind: 'phase',
        nodeId: callNodeId(callSeq++, `phase:${name}`),
        attempt: 1,
        status: 'running',
        action: name,
        nodeKind: 'noop',
        inputSummary: name,
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
