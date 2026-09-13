import { describe, it, expect, vi } from 'vitest';
import { parseTweetTarget } from '../actions/twitterPost.js';
import { postAction } from '../actions/post.js';
import type { ActionContext } from '../actions/types.js';

/**
 * Minimal ActionContext stub — only the fields the `post` action touches.
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

describe('parseTweetTarget', () => {
  it('accepts a full x.com status URL', () => {
    expect(parseTweetTarget('https://x.com/user/status/1234567890')).toEqual({
      url: 'https://x.com/user/status/1234567890',
      id: '1234567890',
    });
  });

  it('normalizes a twitter.com link to x.com', () => {
    expect(parseTweetTarget('https://twitter.com/user/status/42')).toEqual({
      url: 'https://x.com/user/status/42',
      id: '42',
    });
  });

  it('accepts a bare numeric id', () => {
    expect(parseTweetTarget('99')).toEqual({ url: 'https://x.com/i/status/99', id: '99' });
  });

  it('rejects a non-status x.com URL', () => {
    const r = parseTweetTarget('https://x.com/user');
    expect('error' in r).toBe(true);
  });

  it('rejects a foreign host', () => {
    const r = parseTweetTarget('https://example.com/user/status/1');
    expect('error' in r && r.error).toMatch(/Unsupported reply target host/i);
  });

  it('rejects empty input', () => {
    const r = parseTweetTarget('   ');
    expect('error' in r).toBe(true);
  });
});

describe('post replyTo dispatch', () => {
  it('routes a reply on platform=x to the Twitter publisher (needs a live session)', async () => {
    const ctx = createMockContext({ cdp: null });
    const result = await postAction.execute(
      { platform: 'x', text: 'replying', replyTo: 'https://x.com/u/status/1' },
      ctx,
    );
    // Only postOnTwitter emits this prerequisite error — proves the dispatch target.
    expect(result.error).toMatch(/logged-in browser session on x\.com/i);
    expect(result.platform).toBe('x');
  });

  it('reports an invalid reply target before touching the browser', async () => {
    const ctx = createMockContext({ cdp: {} as never });
    const result = await postAction.execute(
      { platform: 'x', text: 'replying', replyTo: 'not-a-valid-target' },
      ctx,
    );
    expect(result.error).toMatch(/Invalid reply target/i);
  });

  it('still posts a top-level tweet when replyTo is omitted', async () => {
    const ctx = createMockContext({ cdp: null });
    const result = await postAction.execute({ platform: 'x', text: 'hello' }, ctx);
    expect(result.error).toMatch(/logged-in browser session on x\.com/i);
  });
});
