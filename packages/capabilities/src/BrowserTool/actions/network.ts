import { z } from 'zod/v4';
import type { ActionHandler, ActionContext } from './types.js';

const networkStartSchema = z.object({
  pattern: z.string().optional().default('').describe('URL pattern to filter captured requests'),
  url: z.string().url().optional().describe('Optional URL to navigate after capture is armed, avoiding a monitoring race'),
});

export const networkStartAction: ActionHandler<z.infer<typeof networkStartSchema>> = {
  operation: 'network_start',
  schema: networkStartSchema,
  async execute(data, ctx) {
    if (!ctx.cdp) {
      return { error: 'Network capture not available in fallback mode', mode: 'fallback' };
    }
    const started = await ctx.cdp.startNetworkCapture(data.pattern);
    if (started && data.url) {
      await ctx.cdp.navigate(data.url);
    }
    return { started, pattern: data.pattern, navigated: data.url ?? null, mode: ctx.mode };
  },
};

// ─── network_read ─────────────────────────────────────────

const networkReadSchema = z.object({});

export const networkReadAction: ActionHandler<z.infer<typeof networkReadSchema>> = {
  operation: 'network_read',
  schema: networkReadSchema,
  async execute(_data, ctx) {
    if (!ctx.cdp) {
      return { error: 'Network capture not available in fallback mode', mode: 'fallback' };
    }
    const requests = await ctx.cdp.readNetworkCapture();
    return { requests, count: requests.length, mode: ctx.mode };
  },
};
