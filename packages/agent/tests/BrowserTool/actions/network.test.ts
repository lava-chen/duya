import { describe, expect, it, vi } from 'vitest';
import { networkStartAction } from '../../../src/tool/BrowserTool/actions/network.js';
import type { ActionContext } from '../../../src/tool/BrowserTool/actions/types.js';

function createContext() {
  const cdp = {
    startNetworkCapture: vi.fn().mockResolvedValue(true),
    navigate: vi.fn().mockResolvedValue(undefined),
  };
  return {
    cdp,
    context: { cdp, mode: 'webview' } as unknown as ActionContext,
  };
}

describe('networkStartAction', () => {
  it('arms capture before atomically navigating the active tab', async () => {
    const { cdp, context } = createContext();

    await expect(networkStartAction.execute({ pattern: '/api', url: 'https://example.com' }, context))
      .resolves.toEqual({
        started: true,
        pattern: '/api',
        navigated: 'https://example.com',
        mode: 'webview',
      });

    expect(cdp.startNetworkCapture).toHaveBeenCalledWith('/api');
    expect(cdp.navigate).toHaveBeenCalledWith('https://example.com');
    expect(cdp.startNetworkCapture.mock.invocationCallOrder[0])
      .toBeLessThan(cdp.navigate.mock.invocationCallOrder[0]);
  });

  it('does not navigate if capture could not be armed', async () => {
    const { cdp, context } = createContext();
    cdp.startNetworkCapture.mockResolvedValueOnce(false);

    await networkStartAction.execute({ pattern: '', url: 'https://example.com' }, context);

    expect(cdp.navigate).not.toHaveBeenCalled();
  });
});
