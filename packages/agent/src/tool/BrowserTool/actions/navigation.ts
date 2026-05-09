import { z } from 'zod/v4';
import type { ActionHandler, ActionContext } from './types.js';

const navigateSchema = z.object({
  url: z.string().describe('URL to navigate to'),
});

export const navigateAction: ActionHandler<z.infer<typeof navigateSchema>> = {
  operation: 'navigate',
  schema: navigateSchema,
  async execute(data, ctx) {
    if (ctx.mode !== 'extension' && ctx.checkDomainBlocked(data.url)) {
      throw new Error(`Navigation blocked: ${data.url} is in the domain blocklist`);
    }

    if (ctx.cdp) {
      await ctx.cdp.navigate(data.url);

      const url = await ctx.cdp.getUrl();
      const title = await ctx.cdp.getTitle();

      if (ctx.platformHookManager.shouldApplyHooks(url)) {
        await ctx.platformHookManager.applyPostNavigateHooks(ctx.cdp, url);
      }

      let compactSnapshot: string | null = null;
      let interactiveElements: Array<{ ref: number; tag: string; text: string }> = [];
      if (ctx.snapshotEngine) {
        try {
          const snap = await ctx.snapshotEngine.capture({ maxLength: 50000, interactiveOnly: false });
          compactSnapshot = snap.snapshot;
          interactiveElements = snap.interactiveElements.map(el => ({
            ref: el.ref,
            tag: el.tag,
            text: el.text,
          }));
        } catch { /* best effort */ }
      }

      return {
        url,
        title,
        status: 'loaded',
        mode: ctx.mode,
        ...(compactSnapshot !== null && compactSnapshot.length > 50
          ? { compactSnapshot, interactiveElements }
          : { snapshotNote: 'Use snapshot operation for full DOM view' }),
      };
    }

    if (!ctx.fallbackBrowser) {
      throw new Error('Browser not initialized');
    }
    const snapshot = await ctx.fallbackBrowser.navigate(data.url);
    return {
      url: snapshot.url,
      title: snapshot.title,
      status: 'loaded',
      mode: 'fallback',
      note: 'Running in fallback mode (no Extension). Interactive features unavailable.',
    };
  },
};

// ─── go_back ──────────────────────────────────────────────

const goBackSchema = z.object({});

export const goBackAction: ActionHandler<z.infer<typeof goBackSchema>> = {
  operation: 'go_back',
  schema: goBackSchema,
  async execute(_data, ctx) {
    if (ctx.cdp) {
      await ctx.cdp.goBack();
      return {
        url: await ctx.cdp.getUrl(),
        title: await ctx.cdp.getTitle(),
        mode: ctx.mode,
      };
    }
    return { error: 'History navigation not available in fallback mode', mode: 'fallback' };
  },
};
