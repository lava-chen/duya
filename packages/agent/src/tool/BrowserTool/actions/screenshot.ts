import { z } from 'zod/v4';
import type { ActionHandler, ActionContext } from './types.js';

const screenshotSchema = z.object({
  fullPage: z.boolean().optional().default(false).describe('Capture full page'),
  selector: z.string().optional().describe('CSS selector for element screenshot'),
});

export const screenshotAction: ActionHandler<z.infer<typeof screenshotSchema>> = {
  operation: 'screenshot',
  schema: screenshotSchema,
  async execute(data, ctx) {
    if (ctx.cdp) {
      const base64 = await ctx.cdp.screenshot({
        fullPage: data.fullPage,
        selector: data.selector,
      });
      return {
        screenshot: `data:image/png;base64,${base64}`,
        fullPage: data.fullPage,
        selector: data.selector,
        mode: ctx.mode,
      };
    }
    return { error: 'Screenshots not available in fallback mode', mode: 'fallback' };
  },
};
