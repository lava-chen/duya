import { z } from 'zod/v4';
import type { ActionHandler, ActionContext } from './types.js';
import { getCapabilityGuide } from '../platform-extractors/capability-guides.js';
import type { PlatformContentType } from '../platform-extractors/types.js';

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

      // Run the platform extractor and (if needed) the interactiveOnly backup
      // snapshot engine pass in parallel — both are CDP evaluate scripts so
      // they're effectively racing against the same target. The article
      // extractor now bundles interactive refs into the same response, so
      // the backup is mostly a no-op for http(s) pages that hit the fallback.
      const hasExtractor = !!ctx.platformHookManager && ctx.platformHookManager.hasExtractor(url);

      const extractPromise = hasExtractor
        ? ctx.platformHookManager!.extractContent(ctx.cdp!, url, {
            maxLength: 50000,
            includeInteractive: true,
          }).catch(() => null)
        : Promise.resolve(null);

      const backupSnapshotPromise = ctx.snapshotEngine
        ? ctx.snapshotEngine.capture({ maxLength: 50000, interactiveOnly: !hasExtractor }).catch(() => null)
        : Promise.resolve(null);

      const [platformContent, backupSnap] = await Promise.all([
        extractPromise,
        backupSnapshotPromise,
      ]);

      let compactSnapshot: string | null = null;
      let interactiveElements: Array<{ ref: number; tag: string; text: string }> = [];
      let platformType: string | undefined;

      if (platformContent && platformContent.success && platformContent.text && platformContent.text.length > 0) {
        compactSnapshot = platformContent.text;
        interactiveElements = (platformContent.interactiveElements || []).map(el => ({
          ref: el.ref,
          tag: el.tag,
          text: el.text,
        }));
        platformType = platformContent.type;
      } else if (backupSnap) {
        // Either no extractor, or extractor returned empty — use the snapshot.
        compactSnapshot = backupSnap.snapshot;
        interactiveElements = backupSnap.interactiveElements.map(el => ({
          ref: el.ref,
          tag: el.tag,
          text: el.text,
        }));
      }

      // If the platform extractor succeeded but didn't include refs, lift the
      // interactive refs from the parallel snapshot pass instead of paying
      // for a second full-DOM walk.
      if (compactSnapshot && interactiveElements.length === 0 && backupSnap) {
        interactiveElements = backupSnap.interactiveElements.map(el => ({
          ref: el.ref,
          tag: el.tag,
          text: el.text,
        }));
      }

      return {
        url,
        title,
        status: 'loaded',
        mode: ctx.mode,
        ...(compactSnapshot !== null && compactSnapshot.length > 10
          ? {
              compactSnapshot,
              interactiveElements,
              platformType,
              guide: platformType ? getCapabilityGuide(platformType as PlatformContentType) : undefined,
            }
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
      compactSnapshot: snapshot.snapshot,
      interactiveElements: snapshot.interactiveElements,
      truncated: snapshot.truncated,
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
