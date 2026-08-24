import { z } from 'zod/v4';
import type { ActionHandler, ActionContext } from './types.js';

/**
 * Cap what reaches the model: an unconstrained evaluate can return hundreds
 * of KB of page data, which bloats every later turn's context and slows every
 * subsequent response. Serialize once (cycle-safe), truncate the serialized form.
 */
const EVALUATE_RESULT_MAX_CHARS = 50_000;

function serializeForCap(result: unknown): string {
  if (typeof result === 'string') return result;
  const seen = new WeakSet<object>();
  try {
    return (
      JSON.stringify(result, (_key, value: unknown) => {
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value as object)) return '[Circular]';
          seen.add(value as object);
        }
        return value;
      }) ?? String(result)
    );
  } catch {
    // BigInt and friends — fall back to a best-effort string form.
    return String(result);
  }
}

export function capEvaluateResult(result: unknown): { result: unknown; truncated?: boolean } {
  const serialized = serializeForCap(result);
  if (serialized.length <= EVALUATE_RESULT_MAX_CHARS) return { result };
  return {
    result:
      `${serialized.slice(0, EVALUATE_RESULT_MAX_CHARS)}…` +
      ` [truncated ${serialized.length - EVALUATE_RESULT_MAX_CHARS} chars — narrow the script output (slice arrays, pick fields) and re-run]`,
    truncated: true,
  };
}

const evaluateSchema = z.object({
  script: z.string().describe('JavaScript code to execute'),
});

export const evaluateAction: ActionHandler<z.infer<typeof evaluateSchema>> = {
  operation: 'evaluate',
  schema: evaluateSchema,
  async execute(data, ctx) {
    if (ctx.cdp) {
      const raw = await ctx.cdp.evaluate(data.script);
      return { ...capEvaluateResult(raw), script: data.script, mode: ctx.mode };
    }

    if (!ctx.fallbackBrowser) throw new Error('Browser not initialized');
    const fallbackResult = await ctx.fallbackBrowser.evaluate(data.script);
    return { ...fallbackResult, script: data.script, mode: 'fallback' };
  },
};

// ─── iframe_evaluate ──────────────────────────────────────

const iframeEvaluateSchema = z.object({
  frameIndex: z.preprocess(
    (val) => {
      if (typeof val === 'string') {
        const parsed = Number(val);
        return isNaN(parsed) ? val : parsed;
      }
      return val;
    },
    z.number()
  ).describe('Iframe index from frames list'),
  script: z.string().describe('JavaScript code to execute in iframe'),
});

export const iframeEvaluateAction: ActionHandler<z.infer<typeof iframeEvaluateSchema>> = {
  operation: 'iframe_evaluate',
  schema: iframeEvaluateSchema,
  async execute(data, ctx) {
    if (!ctx.cdp) {
      return { error: 'Iframe evaluation not available in fallback mode', mode: 'fallback' };
    }
    const raw = await ctx.cdp.evaluateInFrame(data.script, data.frameIndex);
    return { ...capEvaluateResult(raw), frameIndex: data.frameIndex, mode: ctx.mode };
  },
};
