/**
 * node-runner.ts — executes ONE node of any kind (plan 552 Phase 2;
 * four kinds here — tool / agent / decision / human (+ noop) — with the
 * gui runner plugging into the same contract in Phase 3).
 *
 * Every kind follows the same journal discipline (§4.4/§6.4):
 *   1. interpolate inputs against the scope,
 *   2. compute reqHash over the canonical payload,
 *   3. journal cache hit (nodeId + reqHash, succeeded) → reuse result,
 *   4. else execute through the host and append the record,
 *   5. on failure: dynamic on_error policy — retryable error classes
 *      consume `max_retries`; the rest honor skip / fail immediately.
 *
 * Determinism rules honored here (§6.5): no clock/random evaluation in
 * inputs; decision results are journaled (`kind:'decision'`) so resume
 * replays the cached answer instead of re-asking the classifier.
 */

import type { WorkflowNode } from './schema.js';
import type { WorkflowHost, HostCallContext, HostCallResult } from './host.js';
import { BudgetLedger, BudgetExceededError } from './host.js';
import type { Journal } from './journal.js';
import { computeReqHash, type JournalKind } from './journal.js';
import { interpolateDeep, interpolate, interpolateString, type ExprScope } from './expr.js';
import { classifyError, SuspensionSignal, RETRYABLE_CLASSES, type WorkflowErrorClass } from './error-class.js';
import { runHumanNode, type HumanNodeResult } from './human-runner.js';
import {
  WorkflowDecisionAdapter,
  uncertainOutcomeFor,
  type DecisionRunOutcome,
} from './decision-adapter.js';
import { validateLooseJsonSchema, type LooseSchema } from './output-schema.js';

export interface NodeRunContext {
  runId: string;
  node: WorkflowNode;
  scope: ExprScope;
  host: WorkflowHost;
  journal: Journal;
  budget: BudgetLedger;
  decisions?: WorkflowDecisionAdapter;
  approvalMode: 'await' | 'suspend';
  /** Dry-run: plan but never call the host (§10.3 baseline). */
  dryRun?: boolean;
  /** Map fan-out item context (the loop variable is already in scope). */
  item?: { index: number; as: string };
}

export interface NodeRunResult {
  status: 'succeeded' | 'skipped' | 'failed';
  output?: unknown;
  errorClass?: WorkflowErrorClass;
  error?: string;
  /** fresh-eyes annotation (plan 552 §2) — set by verify staging (Phase 5). */
  verification?: 'verified' | 'unconfirmed';
  /** Decision nodes: the typed answers block (also mirrored into output). */
  decision?: DecisionRunOutcome;
}

const DEFAULT_MAX_RETRIES = 1;

export function ctxFor(base: NodeRunContext, nodeId: string, itemIndex?: number): HostCallContext {
  return { runId: base.runId, nodeId, itemIndex };
}

export function failResult(error: string, errorClass: WorkflowErrorClass): NodeRunResult {
  return { status: 'failed', error, errorClass };
}

/** Journal + execute one host call with cache economics. */
async function cachedHostCall<T>(
  ctx: NodeRunContext,
  kind: JournalKind,
  nodeId: string,
  payload: unknown,
  attempt: number,
  execute: () => Promise<T>,
): Promise<{ cached: boolean; value: T }> {
  const reqHash = computeReqHash(kind, payload);
  const hit = ctx.journal.hit(nodeId, reqHash);
  if (hit && hit.result !== undefined) {
    return { cached: true, value: hit.result as T };
  }
  const value = await execute();
  ctx.journal.append({
    kind,
    nodeId,
    attempt,
    reqHash,
    status: 'succeeded',
    result: value === undefined ? null : value,
  });
  return { cached: false, value };
}

function hostFailure(result: HostCallResult, fallbackClass: WorkflowErrorClass): NodeRunResult {
  const errorClass = (result.errorClass as WorkflowErrorClass | undefined) ?? classifyError(result.error) ?? fallbackClass;
  return failResult(result.error ?? 'host call failed', errorClass);
}

// ─── tool node (① zero LLM, ToolRegistry direct) ───

async function runToolNode(ctx: NodeRunContext): Promise<NodeRunResult> {
  const node = ctx.node;
  const toolName = node.tool!;
  const input = node.input ? interpolateDeep(node.input, ctx.scope) : {};
  if (ctx.dryRun) {
    return { status: 'succeeded', output: { dryRun: true, tool: toolName, input } };
  }
  const payload = { tool: toolName, input };
  const attempt = 1;
  const { value } = await cachedHostCall(ctx, 'node_result', node.id, payload, attempt, async () => {
    ctx.budget.countHostCall();
    const result = await ctx.host.runTool(toolName, input, ctxFor(ctx, node.id));
    if (!result.ok) {
      const failure = hostFailure(result, 'tool_error');
      const err = new Error(failure.error ?? 'tool failed');
      (err as Error & { errorClass?: WorkflowErrorClass }).errorClass = failure.errorClass;
      throw err;
    }
    return result.output ?? null;
  });
  return { status: 'succeeded', output: value };
}

// ─── agent node (⑤ open-ended subtask + output_schema contract) ───

async function runAgentNode(ctx: NodeRunContext, promptOverride?: string, itemIndex?: number): Promise<NodeRunResult> {
  const node = ctx.node;
  const prompt = interpolateString(promptOverride ?? node.prompt ?? '', ctx.scope);
  const schema = node.output_schema as LooseSchema | undefined;
  if (ctx.dryRun) {
    return { status: 'succeeded', output: { dryRun: true, agent: node.agent, prompt } };
  }
  const payload = { agent: node.agent, prompt, model: node.model, item: itemIndex };
  const { value } = await cachedHostCall(ctx, 'node_result', node.id, payload, 1, async () => {
    const ticket = ctx.budget.reserveAgent(); // reserve → spawn → release (§6.5)
    try {
      let result = await ctx.host.runAgent(
        { agent: node.agent!, prompt, model: node.model, outputSchema: node.output_schema },
        ctxFor(ctx, node.id, itemIndex),
      );
      ctx.budget.commit(ticket);
      // Constraint c: host validates output_schema + ONE re-ask retry.
      if (schema && result.ok) {
        const reason = validateLooseJsonSchema(result.output, schema);
        if (reason) {
          const retryPrompt = `${prompt}\n\nYour previous answer failed schema validation: ${reason}. Return the answer again as JSON matching the schema.`;
          result = await ctx.host.runAgent(
            { agent: node.agent!, prompt: retryPrompt, model: node.model, outputSchema: node.output_schema },
            ctxFor(ctx, node.id, itemIndex),
          );
          const retryReason = validateLooseJsonSchema(result.output, schema);
          if (retryReason) {
            const err = new Error(`output_schema mismatch: ${retryReason}`);
            (err as Error & { errorClass?: WorkflowErrorClass }).errorClass = 'schema_mismatch';
            throw err;
          }
        }
      }
      if (!result.ok) {
        const err = new Error(result.error ?? 'agent failed');
        (err as Error & { errorClass?: WorkflowErrorClass }).errorClass =
          (result.errorClass as WorkflowErrorClass | undefined) ?? classifyError(result.error);
        throw err;
      }
      return result.output ?? null;
    } catch (err) {
      ctx.budget.release(ticket); // failed spawn refunds — no double billing
      throw err;
    }
  });
  return { status: 'succeeded', output: value };
}

// ─── decision node (③ — 551 DecisionService; journal the verdict) ───

async function runDecisionNode(ctx: NodeRunContext): Promise<NodeRunResult> {
  const node = ctx.node;
  const spec = node.decision!;
  // State: `{ output: "${ref}" }` template or inline object (interpolated).
  let state: unknown;
  if ('output' in spec.state && typeof spec.state.output === 'string') {
    state = interpolate(spec.state.output, ctx.scope);
  } else {
    state = interpolateDeep(spec.state, ctx.scope);
  }

  const payload = { nodeId: node.id, state, questions: spec.questions, thresholds: spec.thresholds };
  const reqHash = computeReqHash('decision', payload);

  // 铁律 §6.5: decision 是 host-call — cache hit means NEVER re-ask.
  const hit = ctx.journal.hit(node.id, reqHash);
  let outcome: DecisionRunOutcome;
  if (hit) {
    outcome = hit.result as DecisionRunOutcome;
  } else if (!ctx.decisions || ctx.dryRun) {
    // No backend (or dry-run): rule tier absent → everything uncertain;
    // the workflow's on_low_confidence behavior keeps it zero-broken (§5).
    outcome = uncertainOutcomeFor(spec);
  } else {
    try {
      outcome = await ctx.decisions.run(spec, state);
    } catch (err) {
      if (WorkflowDecisionAdapter.isUnavailableError(err)) {
        outcome = uncertainOutcomeFor(spec);
      } else {
        throw err;
      }
    }
    ctx.journal.append({
      kind: 'decision',
      nodeId: node.id,
      attempt: 1,
      reqHash,
      status: 'succeeded',
      result: outcome,
    });
  }

  // on_low_confidence: ask → human gate (park) | default → fill + unconfirmed | skip.
  const policy = spec.on_low_confidence ?? 'ask';
  if (outcome.lowConfidence.length > 0) {
    if (policy === 'skip') {
      return { status: 'skipped', output: outcome.output, decision: outcome };
    }
    if (policy === 'ask') {
      if (ctx.dryRun) {
        return { status: 'succeeded', output: outcome.output, decision: outcome, verification: 'unconfirmed' };
      }
      // Escalate to the human channel (same 498 pipeline); the approval
      // record rides this node's journal — input into the world, not the
      // suspension point.
      const humanResult = await escalateToHuman(ctx, outcome.lowConfidence);
      if (humanResult.status === 'failed') {
        return failResult(humanResult.error ?? 'decision escalation failed', humanResult.errorClass ?? 'approval_timeout');
      }
      if (humanResult.status === 'skipped') {
        return { status: 'skipped', output: outcome.output, decision: outcome };
      }
      outcome = {
        ...outcome,
        answers: Object.fromEntries(
          Object.entries(outcome.answers).map(([id, a]) => [id, a.verdict === 'uncertain' ? { ...a, defaulted: true } : a]),
        ),
      };
      return { status: 'succeeded', output: outcome.output, decision: outcome, verification: 'unconfirmed' };
    }
    // { default: value } — already applied by the adapter for absent answers;
    // answers the model returned but in the gray band stay unconfirmed.
    return { status: 'succeeded', output: outcome.output, decision: outcome, verification: 'unconfirmed' };
  }
  return { status: 'succeeded', output: outcome.output, decision: outcome };
}

/** Low-confidence decision → human approval via the same host gate. */
async function escalateToHuman(ctx: NodeRunContext, questions: string[]): Promise<HumanNodeResult> {
  const surrogate: WorkflowNode = {
    id: ctx.node.id,
    human: {
      prompt: `Decision "${ctx.node.id}" is low-confidence for: ${questions.join(', ')}. Approve to continue with the best guess?`,
      timeout: { hours: 1, on_timeout: 'fail' },
    },
  };
  return runHumanNode({
    node: surrogate,
    human: surrogate.human!,
    host: ctx.host,
    journal: ctx.journal,
    ctx: ctxFor(ctx, ctx.node.id),
    approvalMode: ctx.approvalMode,
  });
}

// ─── human node (④) ───

async function runHumanNodeSafe(ctx: NodeRunContext): Promise<NodeRunResult> {
  // Dry-run plans the gate without involving a human (§10.3 baseline).
  if (ctx.dryRun) {
    return {
      status: 'succeeded',
      output: { approved: false, timedOut: false, dryRun: true },
      verification: 'unconfirmed',
    };
  }
  try {
    const human = {
      ...ctx.node.human!,
      prompt: interpolateString(ctx.node.human!.prompt, ctx.scope),
    };
    const result = await runHumanNode({
      node: ctx.node,
      human,
      host: ctx.host,
      journal: ctx.journal,
      ctx: ctxFor(ctx, ctx.node.id),
      approvalMode: ctx.approvalMode,
    });
    if (result.status === 'failed') {
      return failResult(result.error ?? 'approval failed', result.errorClass ?? 'approval_timeout');
    }
    return { status: result.status, output: result.output };
  } catch (err) {
    if (err instanceof SuspensionSignal) throw err;
    return failResult(err instanceof Error ? err.message : String(err), classifyError(err));
  }
}

// ─── dispatcher with the dynamic on_error policy ───

export async function runNode(ctx: NodeRunContext): Promise<NodeRunResult> {
  const node = ctx.node;
  const maxRetries = node.on_error === 'retry' ? (node.max_retries ?? DEFAULT_MAX_RETRIES) : 0;
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await runNodeOnce(ctx);
    } catch (err) {
      if (err instanceof SuspensionSignal) throw err;
      // Budget exhaustion is a RUN-level stop (§6.4: journal-free,
      // replayable) — never converted into a skipped node.
      if (err instanceof BudgetExceededError) throw err;
      const errorClass = (err as Error & { errorClass?: WorkflowErrorClass }).errorClass ?? classifyError(err);
      const message = err instanceof Error ? err.message : String(err);
      attempt++;
      // Block-level attempt audit (Skyvern semantics): every exhausted
      // attempt lands a failed record — the trailing one is the sentinel
      // `pruneTrailingFailures` cuts before a resume.
      ctx.journal.append({
        kind: 'node_result',
        nodeId: node.id,
        attempt,
        status: 'failed',
        result: null,
        errorClass,
      });
      if (attempt <= maxRetries && RETRYABLE_CLASSES.has(errorClass)) {
        continue;
      }
      if (node.on_error === 'skip' || node.on_error === undefined) {
        // Default policy is skip (415 §3.2) — a failed node never blocks
        // independent siblings; downstream refs resolve to undefined.
        return { status: 'skipped', errorClass, error: message };
      }
      return { status: 'failed', errorClass, error: message };
    }
  }
}

async function runNodeOnce(ctx: NodeRunContext): Promise<NodeRunResult> {
  const node = ctx.node;
  if (node.noop) {
    ctx.journal.append({
      kind: 'node_result',
      nodeId: node.id,
      attempt: 1,
      reqHash: computeReqHash('node_result', { noop: true }),
      status: 'succeeded',
      result: null,
    });
    return { status: 'succeeded', output: null };
  }
  if (node.tool) return runToolNode(ctx);
  if (node.agent) return runAgentNode(ctx, node.map ? node.map.prompt : undefined, ctx.item?.index);
  if (node.decision) return runDecisionNode(ctx);
  if (node.human) return runHumanNodeSafe(ctx);
  return failResult('gui nodes require the Phase 3 gui-runner', 'tool_missing');
}
