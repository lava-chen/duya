import { z } from 'zod/v4';
import type { ActionHandler, ActionContext } from './types.js';

const snapshotSchema = z.object({
  maxLength: z.preprocess(
    (val) => {
      if (typeof val === 'string') {
        const parsed = Number(val);
        return isNaN(parsed) ? val : parsed;
      }
      return val;
    },
    z.number().optional().default(100000)
  ).describe('Maximum snapshot length'),
  interactiveOnly: z.preprocess(
    (val) => {
      if (typeof val === 'string') return val.toLowerCase() === 'true';
      return val;
    },
    z.boolean().optional().default(false)
  ).describe('Only show interactive elements'),
});

export const snapshotAction: ActionHandler<z.infer<typeof snapshotSchema>> = {
  operation: 'snapshot',
  schema: snapshotSchema,
  async execute(data, ctx) {
    // Get current URL
    const url = ctx.cdp ? await ctx.cdp.getUrl() : '';

    // Try platform extractor first if available
    if (ctx.platformHookManager && ctx.cdp && ctx.platformHookManager.hasExtractor(url)) {
      const platformContent = await ctx.platformHookManager.extractContent(ctx.cdp, url, {
        maxLength: data.maxLength,
        includeInteractive: true,
      });

      if (platformContent && platformContent.success && platformContent.text) {
        console.log(`[SnapshotAction] Using ${platformContent.type} extractor for ${url}`);
        return {
          url,
          title: platformContent.metadata?.title as string || '',
          snapshot: platformContent.text,
          interactiveElements: platformContent.interactiveElements || [],
          truncated: platformContent.text.length > (data.maxLength ?? 100000),
          mode: ctx.mode,
          platformType: platformContent.type,
        };
      }
    }

    // Fallback to standard snapshot engine
    if (ctx.snapshotEngine) {
      const snapshot = await ctx.snapshotEngine.capture({
        maxLength: data.maxLength,
        interactiveOnly: data.interactiveOnly,
      });
      return {
        url: snapshot.url,
        title: snapshot.title,
        snapshot: snapshot.snapshot,
        interactiveElements: snapshot.interactiveElements.map(el => ({
          ref: el.ref,
          tag: el.tag,
          text: el.text,
        })),
        truncated: snapshot.truncated,
        mode: ctx.mode,
      };
    }

    if (!ctx.fallbackBrowser) {
      throw new Error('Browser not initialized');
    }
    const snapshot = await ctx.fallbackBrowser.navigate('');
    return {
      url: snapshot.url,
      title: snapshot.title,
      snapshot: snapshot.snapshot,
      interactiveElements: snapshot.interactiveElements,
      truncated: snapshot.truncated,
      mode: 'fallback',
    };
  },
};
