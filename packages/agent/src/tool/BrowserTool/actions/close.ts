import { z } from 'zod/v4';
import type { ActionHandler, ActionContext } from './types.js';

const closeWindowSchema = z.object({});

export const closeWindowAction: ActionHandler<z.infer<typeof closeWindowSchema>> = {
  operation: 'close_window',
  schema: closeWindowSchema,
  async execute(_data, ctx) {
    if (ctx.cdp) {
      await ctx.cdp.closeWindow();
      return { closed: true, mode: ctx.mode };
    }
    return {
      closed: false,
      reason: 'No active browser window to close',
      mode: ctx.mode,
    };
  },
};
