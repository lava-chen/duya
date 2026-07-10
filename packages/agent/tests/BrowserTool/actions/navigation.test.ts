import { describe, expect, it, vi } from 'vitest';
import { navigateAction } from '../../../src/tool/BrowserTool/actions/navigation.js';
import type { ActionContext } from '../../../src/tool/BrowserTool/actions/types.js';

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
  };
}

describe('navigateAction', () => {
  it('returns fallback snapshot content from navigate', async () => {
    const fallbackBrowser = {
      navigate: vi.fn().mockResolvedValue({
        url: 'file:///workspace/page.html',
        title: 'Page',
        snapshot: '<main>Visible content</main>',
        interactiveElements: [{ ref: 1, tag: 'button', text: 'Click' }],
        truncated: false,
        source: 'fallback' as const,
      }),
    };
    const ctx = createMockContext({ fallbackBrowser: fallbackBrowser as never });

    const result = await navigateAction.execute(
      { url: 'file:///workspace/page.html' },
      ctx,
    );

    expect(result).toMatchObject({
      url: 'file:///workspace/page.html',
      title: 'Page',
      mode: 'fallback',
      compactSnapshot: '<main>Visible content</main>',
      interactiveElements: [{ ref: 1, tag: 'button', text: 'Click' }],
      truncated: false,
    });
  });
});
