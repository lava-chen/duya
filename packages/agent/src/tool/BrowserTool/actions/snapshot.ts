import { z } from 'zod/v4';
import type { ActionHandler, ActionContext } from './types.js';
import { getCapabilityGuide } from '../platform-extractors/capability-guides.js';
import type { PlatformContentType } from '../platform-extractors/types.js';

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

    // Try platform extractor first if available — run it in parallel with the
    // interactiveOnly backup so the common case (article + bundled refs) and
    // the fallback (full snapshot engine) finish in one round-trip instead of
    // two sequential CDP evaluate calls.
    if (ctx.platformHookManager && ctx.cdp && ctx.platformHookManager.hasExtractor(url)) {
      const extractPromise = ctx.platformHookManager.extractContent(ctx.cdp, url, {
        maxLength: data.maxLength,
        includeInteractive: true,
      }).catch(() => null);

      const backupRefsPromise = ctx.snapshotEngine
        ? ctx.snapshotEngine.capture({ maxLength: 50000, interactiveOnly: true }).catch(() => null)
        : Promise.resolve(null);

      const [platformContent, backupRefs] = await Promise.all([
        extractPromise,
        backupRefsPromise,
      ]);

      if (platformContent && platformContent.success && platformContent.text) {
        let elements = platformContent.interactiveElements || [];
        // Lift refs from the parallel snapshot pass instead of paying for a
        // second full-DOM walk.
        if (elements.length === 0 && backupRefs) {
          elements = backupRefs.interactiveElements.map(el => ({ ref: el.ref, tag: el.tag, text: el.text }));
        }
        return {
          url,
          title: platformContent.metadata?.title as string || '',
          snapshot: platformContent.text,
          interactiveElements: elements,
          truncated: platformContent.text.length > (data.maxLength ?? 100000),
          mode: ctx.mode,
          platformType: platformContent.type,
          guide: getCapabilityGuide(platformContent.type as PlatformContentType),
        };
      } else if (ctx.snapshotEngine) {
        // Extractor matched but failed/empty — capture the raw snapshot + refs.
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
