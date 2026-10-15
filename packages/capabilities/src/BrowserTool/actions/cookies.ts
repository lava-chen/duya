import { z } from 'zod/v4';
import type { ActionHandler, ActionContext } from './types.js';

const cookiesSchema = z.object({
  domain: z.string().optional().describe('Filter cookies by domain'),
  url: z.string().optional().describe('Filter cookies by URL'),
});

export const cookiesAction: ActionHandler<z.infer<typeof cookiesSchema>> = {
  operation: 'cookies',
  schema: cookiesSchema,
  async execute(data, ctx) {
    if (!ctx.cdp) {
      return { error: 'Cookie access not available in fallback mode', mode: 'fallback' };
    }
    const cookies = await ctx.cdp.getCookies({
      domain: data.domain,
      url: data.url,
    });
    return {
      cookies: cookies.map(c => ({
        name: c.name,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite,
        hasValue: !!c.value,
      })),
      count: cookies.length,
      mode: ctx.mode,
    };
  },
};
