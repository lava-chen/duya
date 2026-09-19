/**
 * map-runner.ts — dynamic fan-out over agent/tool nodes (plan 415 §4.2
 * + 552 ruling 1: parallel soft-fail = that item null, siblings keep
 * going; no re-planning of the action sequence mid-flight).
 *
 * Per-item cache economics (§6.4): every item is journaled under
 * `${nodeId}#${index}` with its own reqHash, so a params change that
 * only affects some items re-pays just those.
 */

import type { WorkflowHost, Semaphore } from './host.js';
import { interpolateDeep, interpolateString, evaluateExpr, NOT_FOUND, type ExprScope } from './expr.js';
import { computeReqHash } from './journal.js';
import { classifyError } from './error-class.js';
import { failResult, ctxFor, type NodeRunContext, type NodeRunResult } from './node-runner.js';

/** Scope with the loop variable bound (item refs resolve into the element). */
export function itemScope(base: ExprScope, as: string, value: unknown): ExprScope {
  return {
    resolve(path) {
      if (path[0] === as) {
        if (path.length === 1) return value;
        let cur: unknown = value;
        for (const seg of path.slice(1)) {
          if (cur && typeof cur === 'object' && seg in (cur as Record<string, unknown>)) {
            cur = (cur as Record<string, unknown>)[seg];
          } else {
            return NOT_FOUND;
          }
        }
        return cur;
      }
      return base.resolve(path);
    },
  };
}

/**
 * Fan out the wrapped agent/tool node over `over` (an array expression),
 * collecting results (soft-fail nulls included) as the node output.
 */
export async function runMapNode(ctx: NodeRunContext, semaphore: Semaphore): Promise<NodeRunResult> {
  const node = ctx.node;
  const map = node.map!;

  let items: unknown[];
  try {
    const over = evaluateExpr(map.over, ctx.scope);
    if (!Array.isArray(over)) {
      return failResult(`map.over must evaluate to an array, got ${typeof over}`, 'expr_error');
    }
    items = over;
  } catch (err) {
    return failResult(err instanceof Error ? err.message : String(err), 'expr_error');
  }

  if (ctx.dryRun) {
    return {
      status: 'succeeded',
      output: items.map(() => ({ dryRun: true, fanout: node.agent ?? node.tool })),
    };
  }

  const parallel = map.parallel ?? true;
  const itemRunner = async (index: number): Promise<unknown> => {
    const value = items[index];
    const itemNodeId = `${node.id}#${index}`;
    const itemCtx: NodeRunContext = {
      ...ctx,
      node,
      scope: itemScope(ctx.scope, map.as, value),
      item: { index, as: map.as },
    };

    const release = parallel ? await semaphore.acquire() : () => {};
    try {
      // Tool fan-out: input from map.input (falling back to node.input).
      if (node.tool) {
        const rawInput = map.input ?? node.input ?? {};
        const input = interpolateDeep(rawInput, itemCtx.scope);
        const reqHash = computeReqHash('node_result', { tool: node.tool, input, item: value });
        const hit = ctx.journal.hit(itemNodeId, reqHash);
        if (hit) return hit.result ?? null;
        ctx.budget.countHostCall();
        const result = await ctx.host.runTool(node.tool, input, ctxFor(ctx, node.id, index));
        if (!result.ok) {
          ctx.journal.append({
            kind: 'node_result',
            nodeId: itemNodeId,
            attempt: 1,
            reqHash,
            status: 'failed',
            result: null,
            errorClass: result.errorClass ?? classifyError(result.error),
          });
          return null; // soft-fail: item null, siblings continue
        }
        const output = result.output ?? null;
        ctx.journal.append({
          kind: 'node_result',
          nodeId: itemNodeId,
          attempt: 1,
          reqHash,
          status: 'succeeded',
          result: output,
        });
        return output;
      }

      // Agent fan-out: prompt from map.prompt (falling back to node.prompt).
      const prompt = interpolateString(map.prompt ?? node.prompt ?? '', itemCtx.scope);
      const reqHash = computeReqHash('node_result', { agent: node.agent, prompt, model: node.model, item: value });
      const hit = ctx.journal.hit(itemNodeId, reqHash);
      if (hit) return hit.result ?? null;
      const ticket = ctx.budget.reserveAgent();
      try {
        const result = await ctx.host.runAgent(
          { agent: node.agent!, prompt, model: node.model, outputSchema: node.output_schema },
          ctxFor(ctx, node.id, index),
        );
        ctx.budget.commit(ticket);
        const output = result.ok ? result.output ?? null : null;
        ctx.journal.append({
          kind: 'node_result',
          nodeId: itemNodeId,
          attempt: 1,
          reqHash,
          status: result.ok ? 'succeeded' : 'failed',
          result: output,
          errorClass: result.ok ? undefined : result.errorClass ?? classifyError(result.error),
        });
        return output;
      } catch (err) {
        ctx.budget.release(ticket);
        throw err;
      }
    } catch {
      return null; // soft-fail (grok E:643-647)
    } finally {
      release();
    }
  };

  const results: unknown[] = parallel
    ? await Promise.all(items.map((_, i) => itemRunner(i)))
    : await (async () => {
        const out: unknown[] = [];
        for (let i = 0; i < items.length; i++) out.push(await itemRunner(i));
        return out;
      })();

  return { status: 'succeeded', output: results };
}
