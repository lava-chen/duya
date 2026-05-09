import { z } from 'zod/v4';
import type { ActionHandler, ActionContext } from './types.js';

const evaluateSchema = z.object({
  script: z.string().describe('JavaScript code to execute'),
});

export const evaluateAction: ActionHandler<z.infer<typeof evaluateSchema>> = {
  operation: 'evaluate',
  schema: evaluateSchema,
  async execute(data, ctx) {
    if (ctx.cdp) {
      const result = await ctx.cdp.evaluate(data.script);
      return { result, script: data.script, mode: ctx.mode };
    }

    if (!ctx.fallbackBrowser) throw new Error('Browser not initialized');
    const fallbackResult = await ctx.fallbackBrowser.evaluate(data.script);
    return { ...fallbackResult, script: data.script, mode: 'fallback' };
  },
};

// ─── iframe_evaluate ──────────────────────────────────────

const iframeEvaluateSchema = z.object({
  frameIndex: z.number().describe('Iframe index from frames list'),
  script: z.string().describe('JavaScript code to execute in iframe'),
});

export const iframeEvaluateAction: ActionHandler<z.infer<typeof iframeEvaluateSchema>> = {
  operation: 'iframe_evaluate',
  schema: iframeEvaluateSchema,
  async execute(data, ctx) {
    if (!ctx.cdp) {
      return { error: 'Iframe evaluation not available in fallback mode', mode: 'fallback' };
    }
    const result = await ctx.cdp.evaluateInFrame(data.script, data.frameIndex);
    return { result, frameIndex: data.frameIndex, mode: ctx.mode };
  },
};
