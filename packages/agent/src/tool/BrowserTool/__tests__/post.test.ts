import { describe, it, expect, vi } from 'vitest';
import { postAction } from '../actions/post.js';
import { SchemaGenerator, ActionRegistry, getAllActions } from '../actions/index.js';
import type { ActionContext } from '../actions/types.js';

/**
 * Minimal ActionContext stub — only the fields the `post` action touches.
 * The `post` action itself never reads anything but `ctx.cdp` and `ctx.mode`,
 * so the heavy platform-hook dependencies can stay as inert mocks.
 */
function createMockContext(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    cdp: null,
    snapshotEngine: null,
    fallbackBrowser: null,
    mode: 'fallback',
    browserBackendMode: 'auto',
    extensionAvailable: false,
    platformHookManager: {
      shouldApplyHooks: vi.fn().mockReturnValue(false),
      applyPostNavigateHooks: vi.fn().mockResolvedValue(undefined),
      hasExtractor: vi.fn().mockReturnValue(false),
      extractContent: vi.fn().mockResolvedValue(null),
    },
    checkDomainBlocked: vi.fn().mockReturnValue(false),
    getBrowserPool: vi.fn().mockReturnValue({} as never),
    ...overrides,
  } as ActionContext;
}

describe('post is hidden from the schema yet still callable', () => {
  it('omits post from the auto-generated operation enum and fields', () => {
    const { inputSchema } = SchemaGenerator.generate(getAllActions());
    const enumList = (inputSchema.properties?.operation as { enum?: string[] })?.enum ?? [];
    expect(enumList).not.toContain('post');

    const variants =
      (inputSchema as { anyOf?: Array<{ properties?: { operation?: { enum?: string[] } } }> }).anyOf ?? [];
    expect(variants.some((v) => v.properties?.operation?.enum?.includes('post'))).toBe(false);
  });

  it('still resolves post through the ActionRegistry by operation name', () => {
    const registry = new ActionRegistry();
    registry.registerAll(getAllActions());
    expect(registry.get('post')).toBeDefined();
    expect(registry.get('post')?.hidden).toBe(true);
  });
});

describe('post platform dispatch', () => {
  it.each(['x', 'twitter'] as const)(
    'routes platform=%s to the Twitter publisher (requires a live session)',
    async (platform) => {
      const ctx = createMockContext({ cdp: null });
      const result = await postAction.execute({ platform, text: 'hello', images: [] }, ctx);

      // postOnTwitter() is the only handler that emits this prerequisite error,
      // so its presence proves the dispatch target was correct.
      expect(result.error).toMatch(/logged-in browser session on x\.com/i);
      expect(result.platform).toBe(platform);
    },
  );

  it.each(['weibo', 'linkedin'] as const)(
    'returns a not-implemented error for platform=%s',
    async (platform) => {
      const ctx = createMockContext();
      const result = await postAction.execute({ platform, text: 'hello' }, ctx);

      expect(result.error).toMatch(/not yet implemented/i);
      expect(result.platform).toBe(platform);
    },
  );

  it('rejects an empty text on a supported platform without posting', async () => {
    // The empty-text guard runs before any CDP call, so a non-null stub is
    // enough to reach it without touching the browser.
    const ctx = createMockContext({ cdp: {} as never });
    const result = await postAction.execute({ platform: 'x', text: '   ', images: [] }, ctx);
    expect(result.error).toMatch(/empty/i);
  });

  it('rejects unsupported platforms that slip past the enum at runtime', async () => {
    const ctx = createMockContext();
    const result = await postAction.execute(
      { platform: 'myspace' as never, text: 'hello' },
      ctx,
    );
    expect(result.error).toMatch(/Unsupported platform/i);
  });
});
