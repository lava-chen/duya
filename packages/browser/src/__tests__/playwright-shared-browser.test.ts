import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock state shared between the vi.mock factory and the test bodies.
const mocks = vi.hoisted(() => {
  const makePage = () => ({
    close: vi.fn(async () => {}),
    goto: vi.fn(async () => {}),
    url: () => 'https://example.com/',
    title: async () => 'Example',
    context: () => ({ newCDPSession: vi.fn(async () => ({ send: vi.fn() })) }),
  });
  const makeBrowser = () => {
    const context = { newPage: vi.fn(async () => makePage()) };
    const browser = {
      newContext: vi.fn(async () => context),
      on: vi.fn(),
      isConnected: vi.fn(() => true),
      close: vi.fn(async () => {
        browser.isConnected = vi.fn(() => false);
      }),
    };
    return { browser, context };
  };
  return {
    launch: vi.fn(),
    makePage,
    makeBrowser,
    browser: null as null | ReturnType<typeof makeBrowser>['browser'],
    context: null as null | ReturnType<typeof makeBrowser>['context'],
  };
});

vi.mock('playwright', () => ({
  chromium: {
    launch: mocks.launch,
  },
}));

// PlaywrightCDPClient holds the shared browser in module-level state, so the
// module is re-imported per test to start each case from a clean singleton.
let PlaywrightCDPClient: typeof import('../CDPClient.js').PlaywrightCDPClient;

function setupFreshBrowser() {
  // Each launch yields a fresh browser, like real Playwright. The first one
  // is kept in mocks.browser for call assertions.
  const first = mocks.makeBrowser();
  mocks.browser = first.browser;
  mocks.context = first.context;
  let firstLaunch = true;
  mocks.launch.mockImplementation(async () => {
    if (firstLaunch) {
      firstLaunch = false;
      return first.browser;
    }
    return mocks.makeBrowser().browser;
  });
}

describe('PlaywrightCDPClient shared browser', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    setupFreshBrowser();
    ({ PlaywrightCDPClient } = await import('../CDPClient.js'));
  });

  it('multiplexes one Chromium across clients (launch called once)', async () => {
    const a = new PlaywrightCDPClient();
    const b = new PlaywrightCDPClient();
    await a.connect();
    await b.connect();

    expect(mocks.launch).toHaveBeenCalledTimes(1);
    expect(mocks.context!.newPage).toHaveBeenCalledTimes(2);
  });

  it('keeps the shared browser alive while another session is open', async () => {
    const a = new PlaywrightCDPClient();
    const b = new PlaywrightCDPClient();
    await a.connect();
    await b.connect();

    await a.close();
    expect(mocks.browser!.close).not.toHaveBeenCalled();

    await b.close();
    expect(mocks.browser!.close).toHaveBeenCalledTimes(1);
  });

  it('closes only its own page on close()', async () => {
    const a = new PlaywrightCDPClient();
    await a.connect();
    const pageA = await (a as any).page;
    await a.close();

    expect(pageA.close).toHaveBeenCalledTimes(1);
    expect(mocks.context!.newPage).toHaveBeenCalledTimes(1);
  });

  it('relaunches a fresh browser after the last session released it', async () => {
    const a = new PlaywrightCDPClient();
    await a.connect();
    await a.close();

    const b = new PlaywrightCDPClient();
    await b.connect();

    expect(mocks.launch).toHaveBeenCalledTimes(2);
    await b.close();
  });

  it('scopes tabs()/newTab()/closeTab() to the session-owned pages', async () => {
    const a = new PlaywrightCDPClient();
    await a.connect();
    const pageA = await (a as any).page;
    await a.newTab('https://example.com');
    const pageA2 = (a as any).ownedPages[1];

    const tabs = await a.tabs();
    expect(tabs.map(t => t.id)).toEqual([0, 1]);

    await a.selectTab('0');
    expect(await (a as any).page).toBe(pageA);

    await a.closeTab(1);
    expect(pageA2.close).toHaveBeenCalledTimes(1);
    expect((await a.tabs()).map(t => t.id)).toEqual([0]);
    await a.close();
  });
});
