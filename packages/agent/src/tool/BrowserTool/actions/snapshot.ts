import { z } from 'zod/v4';
import type { ActionHandler, ActionContext } from './types.js';

const snapshotSchema = z.object({
  maxLength: z.number().optional().default(100000).describe('Maximum snapshot length'),
  interactiveOnly: z.boolean().optional().default(false).describe('Only show interactive elements'),
});

export const snapshotAction: ActionHandler<z.infer<typeof snapshotSchema>> = {
  operation: 'snapshot',
  schema: snapshotSchema,
  async execute(data, ctx) {
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
