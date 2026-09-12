/**
 * CDPClient - Chrome DevTools Protocol client
 * Supports two modes:
 * 1. Extension mode: Connect via HTTP bridge to Chrome Extension (reuses user's Chrome)
 * 2. Playwright mode: One shared headed Chromium, each session owns a tab
 *    (no extension needed)
 */

import { EventEmitter } from 'events';
import { logger } from '../../utils/logger.js';
import { generateStealthJs } from './stealth.js';
import { WebviewCDPClient } from './WebviewCDPClient.js';
import { HumanLikeCDPClient } from './HumanLikeCDPClient.js';

export interface CDPResponse {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
  method?: string;
  params?: unknown;
}

export type CDPMode = 'extension' | 'playwright' | 'webview' | 'human-like';

export interface TabInfo {
  id?: number | string;
  url?: string;
  title?: string;
  active?: boolean;
}

export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

/**
 * Base CDP Client interface
 */
export interface ICDPClient {
  connect(): Promise<void>;
  health(): Promise<{ status: string; mode: CDPMode }>;
  navigate(url: string): Promise<void>;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  evaluate(expression: string, returnByValue?: boolean): Promise<unknown>;
  screenshot(options?: { fullPage?: boolean; selector?: string }): Promise<string>;
  click(selector: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  scroll(direction: 'up' | 'down' | 'left' | 'right', amount?: number): Promise<void>;
  goBack(): Promise<void>;
  pressKey(key: string): Promise<void>;
  getUrl(): Promise<string>;
  getTitle(): Promise<string>;
  close(): Promise<void>;
  // Window management
  closeWindow(): Promise<void>;
  // Tab management
  tabs(): Promise<TabInfo[]>;
  newTab(url?: string): Promise<string | undefined>;
  closeTab(target?: number | string): Promise<void>;
  selectTab(target: number | string): Promise<void>;
  // File upload
  setFileInput(files: string[], selector?: string): Promise<void>;
  // Network capture
  startNetworkCapture(pattern?: string): Promise<boolean>;
  readNetworkCapture(): Promise<unknown[]>;
  // Cookies
  getCookies(opts?: { domain?: string; url?: string }): Promise<BrowserCookie[]>;
  // Iframe support
  frames(): Promise<Array<{ index: number; frameId: string; url: string; name: string }>>;
  evaluateInFrame(js: string, frameIndex: number): Promise<unknown>;
  // Extended interactions
  hover(selector: string): Promise<void>;
  waitForElement(selector: string, timeoutMs?: number): Promise<void>;
  waitForLoad(timeoutMs?: number): Promise<void>;
  selectOption(selector: string, value: string): Promise<void>;
  // Raw CDP
  cdp(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

/**
 * Clear the browser's HTTP cache (and other storage) over raw CDP.
 * Backends that do not speak raw CDP (e.g. the extension action protocol)
 * fail silently — cache clearing is best-effort by design.
 */
export async function clearBrowserCache(client: ICDPClient): Promise<boolean> {
  try {
    await client.send('Network.enable');
    await client.send('Network.clearBrowserCache');
    return true;
  } catch {
    return false;
  }
}

// ========================================================================
// Extension Mode: HTTP Bridge to Chrome Extension via Daemon
// ========================================================================

const DAEMON_PORT = parseInt(process.env.DUYA_DAEMON_PORT ?? '19825', 10);
const DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`;
const DUYA_HEADERS = { 'X-DUYA': '1' };

let _idCounter = 0;
function generateId(): string {
  return `cmd_${process.pid}_${Date.now()}_${++_idCounter}`;
}

/**
 * CDP Client for Extension mode
 * Connects to Browser Daemon via HTTP (similar to OpenCLI's daemon-client)
 */
export class ExtensionCDPClient extends EventEmitter implements ICDPClient {
  private sessionId: string;
  private tabId: number | null = null;
  private connected = false;
  private lastUrl = '';
  private lastTitle = '';
  private _networkCaptureUnsupported = false;
  private _networkCaptureWarned = false;
  /** Reentrancy guard: prevents tab recovery from re-triggering itself. */
  private _recovering = false;

  constructor(sessionId: string) {
    super();
    this.sessionId = sessionId;
  }

  async connect(): Promise<void> {
    const health = await this.health();
    if (health.status !== 'ok') {
      throw new Error(
        'Browser Daemon not available. ' +
        'Please ensure DUYA app is running and Browser Bridge extension is installed.'
      );
    }
    this.connected = true;
    this.emit('connected');
  }

  async health(): Promise<{ status: string; mode: CDPMode }> {
    try {
      const res = await this.requestDaemon('/ping', { timeout: 2000 });
      if (!res.ok) return { status: 'unavailable', mode: 'extension' };
      const data = await res.json() as { ok: boolean; extensionConnected?: boolean };
      return {
        status: data.ok && data.extensionConnected ? 'ok' : 'unavailable',
        mode: 'extension'
      };
    } catch {
      return { status: 'unavailable', mode: 'extension' };
    }
  }

  async navigate(url: string): Promise<void> {
    if (!this.connected) await this.connect();

    const response = await this.sendCommand({
      action: 'navigate',
      url,
      ...(this.tabId !== null && { tabId: this.tabId }),
    }) as { data?: { tabId?: number; url?: string; title?: string }; error?: string };

    if (response.error) {
      throw new Error(`Navigation failed: ${response.error}`);
    }

    const result = response.data;
    if (result?.tabId) {
      this.tabId = result.tabId;
    }
    if (result?.url) this.lastUrl = result.url;
    if (result?.title) this.lastTitle = result.title;

    // Wait for page to be fully loaded with multiple checks
    await this._waitForPageLoad();

    // Inject stealth anti-detection
    await this._injectStealth();
  }

  /**
   * Wait for page to be fully loaded using CDP event-aware polling.
   * Attempts Page.loadEventFired first, falls back to readyState polling.
   */
  private async _waitForPageLoad(timeoutMs = 10000): Promise<void> {
    const startTime = Date.now();
    const checkInterval = 200;
    let stableCount = 0;
    let lastReadyState = '';

    while (Date.now() - startTime < timeoutMs) {
      try {
        const readyState = await this.evaluate('document.readyState') as string;

        if (readyState === lastReadyState && readyState === 'complete') {
          stableCount++;
          if (stableCount >= 2) {
            return;
          }
        } else {
          stableCount = 0;
          lastReadyState = readyState || '';
        }

        await new Promise(resolve => setTimeout(resolve, checkInterval));
      } catch {
        await new Promise(resolve => setTimeout(resolve, checkInterval));
      }
    }
  }

  private async _injectStealth(): Promise<void> {
    try {
      await this.evaluate(generateStealthJs());
    } catch {
      // Stealth is best-effort
    }
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.connected) throw new Error('Not connected');

    // If the previously active tab was closed (by the user or a dropped CDP
    // connection), restore the session before issuing the command. Transient
    // daemon-side errors are handled inside sendCommand().
    await this._ensureActiveTab();

    const result = await this.sendCommand({
      action: 'cdp',
      tabId: this.tabId,
      method,
      params,
    }) as { data?: unknown; error?: string };

    if (result.error) {
      throw new Error(`CDP error: ${result.error}`);
    }

    return result.data;
  }

  async evaluate(expression: string, _returnByValue = true): Promise<unknown> {
    // Restore the session if the tab was closed since the last operation.
    await this._ensureActiveTab();

    // Try extension evaluate action first (most reliable for extension mode)
    try {
      const extResult = await this.sendCommand({
        action: 'evaluate',
        tabId: this.tabId,
        script: expression,
      }) as { data?: unknown; error?: string };

      if (!extResult.error) {
        return extResult.data;
      }

      // If extension action fails with "Unknown action" or perm denied, try CDP
      if (extResult.error?.includes('Unknown action') ||
          extResult.error?.includes('not permitted')) {
        const cdpResult = await this.send('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: true,
        }) as { result?: { value?: unknown }; exceptionDetails?: { text: string } };

        if (cdpResult?.exceptionDetails) {
          throw new Error(`JS evaluation error: ${cdpResult.exceptionDetails.text}`);
        }
        return cdpResult?.result?.value;
      }

      throw new Error(extResult.error);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Fallback: try CDP directly (for cases where extension action returns data but not the right format)
      if (msg.includes('No matching signature') || msg.includes('not permitted')) {
        const cdpResult = await this.send('Runtime.evaluate', {
          expression,
          returnByValue: true,
        }) as { result?: { value?: unknown }; exceptionDetails?: { text: string } };
        if (cdpResult?.exceptionDetails) {
          throw new Error(`JS evaluation error: ${cdpResult.exceptionDetails.text}`);
        }
        return cdpResult?.result?.value;
      }
      throw err;
    }
  }

  async screenshot(options: { fullPage?: boolean; selector?: string } = {}): Promise<string> {
    if (!this.tabId) {
      throw new Error('No active tab. Navigate to a URL first.');
    }

    const { fullPage = false, selector } = options;

    // Approach 1: Try CDP Page.captureScreenshot (most reliable)
    try {
      if (selector) {
        // Element screenshot - need to find element first
        const docResult = await this.send('DOM.getDocument', {}) as { root?: { nodeId?: number } };
        const rootNodeId = docResult?.root?.nodeId;
        if (!rootNodeId) throw new Error('Could not get document root');

        const queryResult = await this.send('DOM.querySelector', { nodeId: rootNodeId, selector }) as { nodeId?: number };
        const nodeId = queryResult?.nodeId;
        if (!nodeId) throw new Error(`Element not found: ${selector}`);

        // Scroll element into view
        await this.send('DOM.scrollIntoViewIfNeeded', { nodeId }).catch(() => {});

        // Get element's bounding box for viewport clipping
        const boxResult = await this.send('DOM.getBoxModel', { nodeId }) as { model?: { content: number[] } };
        if (boxResult?.model?.content) {
          const [x1, y1, x2, y2] = boxResult.model.content;
          const clip = {
            x: Math.round(x1),
            y: Math.round(y1),
            width: Math.round(x2 - x1),
            height: Math.round(y2 - y1),
            scale: 1,
          };
          const screenshotResult = await this.send('Page.captureScreenshot', {
            format: 'png',
            clip,
          }) as { data?: string };
          if (screenshotResult?.data) return screenshotResult.data;
        }
      } else {
        // Full page or viewport screenshot
        const params: Record<string, unknown> = { format: 'png' };

        if (fullPage) {
          // Get full page metrics
          const metrics = await this.send('Page.getLayoutMetrics', {}) as {
            contentSize?: { width: number; height: number };
            cssContentSize?: { width: number; height: number };
          };
          const size = metrics.cssContentSize || metrics.contentSize;
          if (size) {
            // Set device metrics to full page size
            await this.send('Emulation.setDeviceMetricsOverride', {
              mobile: false,
              width: Math.ceil(size.width),
              height: Math.ceil(size.height),
              deviceScaleFactor: 1,
            });
          }
        }

        try {
          const result = await this.send('Page.captureScreenshot', params) as { data?: string };
          if (result?.data) return result.data;
        } finally {
          // Reset device metrics if we changed them for full-page
          if (fullPage) {
            await this.send('Emulation.clearDeviceMetricsOverride', {}).catch(() => {});
          }
        }
      }
    } catch (cdpError) {
      console.warn('[CDPClient] CDP screenshot failed, trying extension:', cdpError instanceof Error ? cdpError.message : cdpError);
    }

    // Approach 2: Fallback to extension screenshot action
    try {
      const response = await this.sendCommand({
        action: 'screenshot',
        tabId: this.tabId,
        fullPage,
      }) as { data?: { data?: string }; error?: string };

      if (!response.error && response.data?.data) {
        return response.data.data;
      }
    } catch (extError) {
      console.warn('[CDPClient] Extension screenshot failed:', extError instanceof Error ? extError.message : extError);
    }

    // Approach 3: Last resort - try DOM.captureScreenshot
    try {
      const docResult = await this.send('DOM.getDocument', {}) as { root?: { nodeId?: number } };
      const nodeId = docResult?.root?.nodeId;
      if (nodeId) {
        const cdpResult = await this.send('DOM.captureScreenshot', { nodeId, format: 'png' }) as { data?: string };
        if (cdpResult?.data) return cdpResult.data;
      }
    } catch {
      // All approaches failed
    }

    throw new Error('Screenshot failed: all capture methods failed. The page may not be fully loaded or the browser extension may not support screenshots.');
  }

  async click(selector: string): Promise<void> {
    if (!this.tabId) {
      throw new Error('No active tab. Navigate to a URL first.');
    }

    const result = await this.sendCommand({
      action: 'click',
      tabId: this.tabId,
      selector,
    }) as { ok?: boolean; error?: string };

    if (result.ok !== false) return;

    if (result.error?.includes('Unknown action')) {
      await this._cdpClickFallback(selector);
      return;
    }

    // Extension returned error (not "Unknown action"). Try CDP fallback.
    if (result.error) {
      await this._cdpClickFallback(selector);
    }
  }

  async type(selector: string, text: string): Promise<void> {
    if (!this.tabId) {
      throw new Error('No active tab. Navigate to a URL first.');
    }

    const result = await this.sendCommand({
      action: 'type',
      tabId: this.tabId,
      selector,
      text,
    }) as { ok?: boolean; error?: string };

    if (result.ok !== false) return;

    if (result.error?.includes('Unknown action')) {
      await this.click(selector);
      for (const char of text) {
        await this.send('Input.dispatchKeyEvent', { type: 'char', text: char });
      }
      return;
    }

    if (result.error) throw new Error(result.error);
  }

  async scroll(direction: 'up' | 'down' | 'left' | 'right' = 'down', amount = 300): Promise<void> {
    if (!this.tabId) {
      throw new Error('No active tab. Navigate to a URL first.');
    }

    const result = await this.sendCommand({
      action: 'scroll',
      tabId: this.tabId,
      direction,
      amount,
    }) as { ok?: boolean; error?: string };

    if (result.ok !== false) return;

    if (result.error?.includes('Unknown action') || result.error?.includes('not supported')) {
      await this._cdpScrollFallback(direction, amount);
      return;
    }

    // CDP fallback for any extension scroll error
    if (result.error) {
      try {
        await this._cdpScrollFallback(direction, amount);
        return;
      } catch {
        throw new Error(result.error);
      }
    }
  }

  private async _cdpScrollFallback(direction: string, amount: number): Promise<void> {
    const deltaMap: Record<string, [number, number]> = {
      up: [0, -amount],
      down: [0, amount],
      left: [-amount, 0],
      right: [amount, 0],
    };
    const [deltaX, deltaY] = deltaMap[direction] || [0, amount];
    await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 0, y: 0, deltaX, deltaY });
  }

  async goBack(): Promise<void> {
    if (!this.tabId) {
      throw new Error('No active tab. Navigate to a URL first.');
    }

    const result = await this.sendCommand({
      action: 'go_back',
      tabId: this.tabId,
    }) as { ok?: boolean; error?: string };

    if (result.ok !== false) {
      await this.waitForLoad();
      return;
    }

    if (result.error?.includes('Unknown action')) {
      await this.evaluate('history.back()');
      await this.waitForLoad();
      return;
    }

    if (result.error) throw new Error(result.error);
  }

  async pressKey(key: string): Promise<void> {
    if (!this.tabId) {
      throw new Error('No active tab. Navigate to a URL first.');
    }

    const result = await this.sendCommand({
      action: 'press_key',
      tabId: this.tabId,
      key,
    }) as { ok?: boolean; error?: string };

    if (result.ok !== false) return;

    if (result.error?.includes('Unknown action')) {
      const keyMap: Record<string, Record<string, unknown>> = {
        Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
        Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
        Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
        ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
        ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
        ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
        ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
      };
      const keyInfo = keyMap[key] || { key, code: key, keyCode: 0 };
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...keyInfo });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...keyInfo });
      return;
    }

    if (result.error) throw new Error(result.error);
  }

  async getUrl(): Promise<string> {
    if (this.lastUrl) return this.lastUrl;
    // Try to refresh from evaluate
    try {
      const url = await this.evaluate('window.location.href') as string;
      this.lastUrl = url;
      return url;
    } catch {
      return this.lastUrl || 'about:blank';
    }
  }

  async getTitle(): Promise<string> {
    if (this.lastTitle) return this.lastTitle;
    // Try to refresh from evaluate
    try {
      const title = await this.evaluate('document.title') as string;
      this.lastTitle = title;
      return title;
    } catch {
      return this.lastTitle || '';
    }
  }

  async close(): Promise<void> {
    this.connected = false;
    this.tabId = null;
    this.lastUrl = '';
    this.lastTitle = '';
    this._networkCaptureUnsupported = false;
    this._networkCaptureWarned = false;
    this.emit('closed');
  }

  async closeWindow(): Promise<void> {
    await this.sendCommand({
      action: 'close_window',
    });
    this.tabId = null;
    this.lastUrl = '';
    this.lastTitle = '';
  }

  async waitForLoad(_timeout = 30000): Promise<void> {
    // Extension's navigate action already waits for page load internally.
    // We just give a brief moment for any post-load scripts to settle.
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  /**
   * CDP fallback for clicking when extension action fails.
   * Uses Runtime.evaluate to find element and compute coordinates,
   * avoiding DOM.querySelector issues with stale nodeIds on dynamic pages.
   */
  private async _cdpClickFallback(selector: string): Promise<void> {
    if (selector.startsWith('@')) {
      const ref = selector.slice(1);
      await this.evaluate(`document.querySelector('[data-duya-ref="${ref}"]')?.click()`);
      return;
    }

    // Approach 1: Try direct JS click (works for most cases)
    try {
      const clicked = await this.evaluate(`
        (() => {
          const el = document.querySelector('${selector.replace(/'/g, "\\'")}');
          if (!el) return false;
          el.click();
          return true;
        })()
      `);
      if (clicked) return;
    } catch {
      // Continue to coordinate-based approach
    }

    // Approach 2: Get bounding box via JS and dispatch mouse events
    const box = await this.evaluate(`
      (() => {
        const el = document.querySelector('${selector.replace(/'/g, "\\'")}');
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()
    `) as { x: number; y: number } | null;

    if (!box) {
      throw new Error(`Element not found: ${selector}`);
    }

    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount: 1,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount: 1,
    });
  }

  async hover(selector: string): Promise<void> {
    if (!this.tabId) throw new Error('No active tab');
    const elSelector = this.resolveSelector(selector);
    const point = await this.evaluate(`
      (() => {
        const el = document.querySelector('${elSelector.replace(/'/g, "\\'")}');
        if (!el) throw new Error('Element not found: ${elSelector}');
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return null;
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()
    `) as { x: number; y: number } | null;
    if (!point) throw new Error(`Element has no visible size: ${selector}`);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  }

  async waitForElement(selector: string, timeoutMs = 15000): Promise<void> {
    if (!this.tabId) throw new Error('No active tab');
    const elSelector = this.resolveSelector(selector);
    const startTime = Date.now();
    const interval = 200;

    while (Date.now() - startTime < timeoutMs) {
      try {
        const found = await this.evaluate(
          `document.querySelector('${elSelector.replace(/'/g, "\\'")}') !== null`
        );
        if (found) return;
      } catch { /* retry */ }
      await new Promise(resolve => setTimeout(resolve, interval));
    }
    throw new Error(`Timeout waiting for element: ${selector}`);
  }

  async selectOption(selector: string, value: string): Promise<void> {
    if (!this.tabId) throw new Error('No active tab');
    const elSelector = this.resolveSelector(selector);
    await this.evaluate(
      `(()=>{const e=document.querySelector('${elSelector.replace(/'/g, "\\'")}');if(!e)throw new Error('Element not found');e.value='${value.replace(/'/g, "\\'")}';e.dispatchEvent(new Event('change',{bubbles:true}));})()`
    );
  }

  private resolveSelector(selector: string): string {
    if (selector.startsWith('@')) {
      return `[data-duya-ref="${selector.slice(1)}"]`;
    }
    return selector;
  }

  // ─── Tab Management ────────────────────────────────────────────────

  async tabs(): Promise<TabInfo[]> {
    const result = await this.sendCommand({
      action: 'tabs',
      op: 'list',
    }) as { data?: TabInfo[]; error?: string };

    if (result.error) {
      throw new Error(`Tabs error: ${result.error}`);
    }

    return Array.isArray(result.data) ? result.data : [];
  }

  async newTab(url?: string): Promise<string | undefined> {
    const result = await this.sendCommand({
      action: 'tabs',
      op: 'new',
      ...(url !== undefined && { url }),
    }) as { data?: { tabId?: number }; error?: string };

    if (result.error) {
      throw new Error(`New tab error: ${result.error}`);
    }

    return result.data?.tabId?.toString();
  }

  async closeTab(target?: number | string): Promise<void> {
    const params: Record<string, unknown> = { action: 'tabs', op: 'close' };
    if (typeof target === 'number') params.tabId = target;
    else if (typeof target === 'string') params.tabId = parseInt(target, 10);
    else if (this.tabId !== null) params.tabId = this.tabId;

    const result = await this.sendCommand(params) as { ok?: boolean; error?: string };

    if (result.error) {
      throw new Error(`Close tab error: ${result.error}`);
    }

    // If we closed the current tab, clear the reference
    if (!target || target === this.tabId) {
      this.tabId = null;
      this.lastUrl = '';
      this.lastTitle = '';
    }
  }

  async selectTab(target: number | string): Promise<void> {
    const result = await this.sendCommand({
      action: 'tabs',
      op: 'select',
      tabId: typeof target === 'number' ? target : parseInt(target, 10),
    }) as { data?: { tabId?: number }; error?: string };

    if (result.error) {
      throw new Error(`Select tab error: ${result.error}`);
    }

    if (result.data?.tabId) {
      this.tabId = result.data.tabId;
      this.lastUrl = '';
      this.lastTitle = '';
    }
  }

  // ─── File Upload ───────────────────────────────────────────────────

  async setFileInput(files: string[], selector?: string): Promise<void> {
    if (!this.tabId) {
      throw new Error('No active tab. Navigate to a URL first.');
    }

    const result = await this.sendCommand({
      action: 'set-file-input',
      tabId: this.tabId,
      files,
      selector,
    }) as { count?: number; error?: string };

    if (result.error) {
      throw new Error(`Set file input error: ${result.error}`);
    }

    if (!result?.count) {
      throw new Error('setFileInput returned no count - command may not be supported by the extension');
    }
  }

  // ─── Network Capture ───────────────────────────────────────────────

  async startNetworkCapture(pattern: string = ''): Promise<boolean> {
    if (!this.tabId) {
      throw new Error('No active tab. Navigate to a URL first.');
    }

    if (this._networkCaptureUnsupported) return false;

    try {
      const result = await this.sendCommand({
        action: 'network-capture-start',
        tabId: this.tabId,
        pattern,
      }) as { ok?: boolean; error?: string };

      if (result.error?.includes('Unknown action') || result.error?.includes('not supported')) {
        this._markUnsupportedNetworkCapture();
        return false;
      }

      return result.ok !== false;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('network capture') && message.includes('not supported')) {
        this._markUnsupportedNetworkCapture();
        return false;
      }
      throw err;
    }
  }

  async readNetworkCapture(): Promise<unknown[]> {
    if (!this.tabId) {
      throw new Error('No active tab. Navigate to a URL first.');
    }

    if (this._networkCaptureUnsupported) return [];

    try {
      const result = await this.sendCommand({
        action: 'network-capture-read',
        tabId: this.tabId,
      }) as { data?: unknown[]; error?: string };

      if (result.error?.includes('Unknown action') || result.error?.includes('not supported')) {
        this._markUnsupportedNetworkCapture();
        return [];
      }

      return Array.isArray(result.data) ? result.data : [];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('network capture') && message.includes('not supported')) {
        this._markUnsupportedNetworkCapture();
        return [];
      }
      throw err;
    }
  }

  private _markUnsupportedNetworkCapture(): void {
    this._networkCaptureUnsupported = true;
    if (this._networkCaptureWarned) return;
    this._networkCaptureWarned = true;
    console.warn(
      '[BrowserTool] Browser Bridge extension does not support network capture; continuing without it.'
    );
  }

  // ─── Cookies ───────────────────────────────────────────────────────

  async getCookies(opts: { domain?: string; url?: string } = {}): Promise<BrowserCookie[]> {
    if (!this.tabId) {
      throw new Error('No active tab. Navigate to a URL first.');
    }

    const result = await this.sendCommand({
      action: 'cookies',
      tabId: this.tabId,
      ...opts,
    }) as { data?: BrowserCookie[]; error?: string };

    if (result.error) {
      throw new Error(`Get cookies error: ${result.error}`);
    }

    return Array.isArray(result.data) ? result.data : [];
  }

  // ─── Iframe Support ────────────────────────────────────────────────

  async frames(): Promise<Array<{ index: number; frameId: string; url: string; name: string }>> {
    if (!this.tabId) {
      throw new Error('No active tab. Navigate to a URL first.');
    }

    const result = await this.sendCommand({
      action: 'frames',
      tabId: this.tabId,
    }) as { data?: Array<{ index: number; frameId: string; url: string; name: string }>; error?: string };

    if (result.error) {
      throw new Error(`Frames error: ${result.error}`);
    }

    return Array.isArray(result.data) ? result.data : [];
  }

  async evaluateInFrame(js: string, frameIndex: number): Promise<unknown> {
    if (!this.tabId) {
      throw new Error('No active tab. Navigate to a URL first.');
    }

    const result = await this.sendCommand({
      action: 'evaluate-in-frame',
      tabId: this.tabId,
      frameIndex,
      script: js,
    }) as { data?: unknown; error?: string };

    if (result.error) {
      throw new Error(`Evaluate in frame error: ${result.error}`);
    }

    return result.data;
  }

  // ─── Raw CDP ───────────────────────────────────────────────────────

  async cdp(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.send(method, params);
  }

  // ─── Private Helpers ───────────────────────────────────────────────

  /**
   * Ensure a tab is attached before operating. If the active tab was closed
   * (by the user or via a dropped CDP connection) and a last URL is known,
   * attempt to restore the session once before giving up with the original
   * error.
   */
  private async _ensureActiveTab(): Promise<void> {
    if (this.tabId !== null) return;
    if (this.lastUrl && (await this._retryWithTabRecovery())) return;
    throw new Error('No active tab. Navigate to a URL first.');
  }

  /**
   * Attempt to restore a lost browser tab session after the Chrome tab was
   * closed (by the user) or the CDP connection dropped.
   *
   * - Drops the stale tabId so the extension re-creates a fresh session tab
   * - Re-navigates to the last known URL
   * - Returns true if a session was restored, false if recovery is impossible
   */
  private async _retryWithTabRecovery(): Promise<boolean> {
    if (this._recovering) return false;
    if (!this.lastUrl) return false;

    this._recovering = true;
    try {
      logger.warn('[CDPClient] Browser tab session lost, restoring via last URL', undefined, 'BrowserTool');
      // Drop the stale tabId so navigate() re-creates a fresh session tab.
      this.tabId = null;
      await this.navigate(this.lastUrl);
      return this.tabId !== null;
    } catch (err) {
      logger.error(
        '[CDPClient] Browser tab session recovery failed',
        err instanceof Error ? err : new Error(String(err)),
        undefined,
        'BrowserTool'
      );
      return false;
    } finally {
      this._recovering = false;
    }
  }

  /**
   * Detect errors indicating the active Chrome tab was closed or its CDP
   * connection dropped, so the session can be recovered by re-navigating.
   */
  private _isTabConnectionError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err ?? '');
    return (
      message.includes('not attached') ||
      message.includes('Detached') ||
      message.includes('No active tab') ||
      message.includes('Failed to attach tab') ||
      message.includes('does not belong to session')
    );
  }

  private async sendCommand(command: Omit<Record<string, unknown>, 'id'>): Promise<unknown> {
    return this._sendCommandWithRetry(command, 0);
  }

  /**
   * Send a daemon command with a single tab-recovery retry. The extension's
   * own handleCDP already re-attaches once; if the command still surfaces a
   * detached/closed-tab error, restore the session and re-send the command
   * against the freshly created tab.
   */
  private async _sendCommandWithRetry(
    command: Omit<Record<string, unknown>, 'id'>,
    attempt: number,
  ): Promise<unknown> {
    const id = generateId();
    const body = { id, sessionId: this.sessionId, ...command };

    const res = await this.requestDaemon('/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeout: 120000,
    });

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Daemon error (${res.status}): ${error}`);
    }

    const result = (await res.json()) as { error?: unknown };

    if (
      attempt < 1 &&
      !this._recovering &&
      typeof command.tabId !== 'undefined' &&
      typeof result?.error === 'string' &&
      this._isTabConnectionError(result.error)
    ) {
      if (await this._retryWithTabRecovery()) {
        // Re-point the command at the freshly created tab.
        const freshTabId = this.tabId;
        const retryCommand =
          freshTabId !== null ? { ...command, tabId: freshTabId } : command;
        return this._sendCommandWithRetry(retryCommand, attempt + 1);
      }
    }

    return result;
  }

  private async requestDaemon(pathname: string, init?: RequestInit & { timeout?: number }): Promise<Response> {
    const { timeout = 2000, headers, ...rest } = init ?? {};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      return await fetch(`${DAEMON_URL}${pathname}`, {
        ...rest,
        headers: { ...DUYA_HEADERS, ...(headers || {}) },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

// ========================================================================
// Playwright Mode: shared headed Chromium, one tab per session
// ========================================================================

/**
 * Shared browser singleton. All PlaywrightCDPClient instances in this
 * process multiplex a single headed Chromium and a single browser context,
 * so parallel sessions appear as tabs of one window instead of one window
 * per task. Storage (cookies, localStorage) is shared across sessions —
 * the same trade-off the extension backend makes by driving the user's
 * real profile.
 */
interface SharedPlaywrightBrowser {
  browser: any;
  context: any;
  refCount: number;
}

let sharedPlaywright: SharedPlaywrightBrowser | null = null;
let sharedPlaywrightLaunch: Promise<SharedPlaywrightBrowser> | null = null;

async function launchSharedPlaywright(): Promise<SharedPlaywrightBrowser> {
  try {
    // Dynamic import to avoid loading when not needed
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const shared: SharedPlaywrightBrowser = { browser, context, refCount: 0 };
    browser.on('disconnected', () => {
      if (sharedPlaywright === shared) sharedPlaywright = null;
    });
    sharedPlaywright = shared;
    return shared;
  } finally {
    sharedPlaywrightLaunch = null;
  }
}

async function acquireSharedPlaywright(attempt = 0): Promise<SharedPlaywrightBrowser> {
  if (sharedPlaywright && sharedPlaywright.browser.isConnected()) {
    sharedPlaywright.refCount++;
    return sharedPlaywright;
  }
  if (!sharedPlaywrightLaunch) {
    sharedPlaywrightLaunch = launchSharedPlaywright();
  }
  const shared = await sharedPlaywrightLaunch;
  // The browser may have been torn down between launch and here if the
  // previous holder released it first; retry with a fresh launch.
  if (!shared.browser.isConnected()) {
    if (attempt >= 2) {
      throw new Error('Shared Playwright browser exited immediately after launch');
    }
    return acquireSharedPlaywright(attempt + 1);
  }
  shared.refCount++;
  return shared;
}

function releaseSharedPlaywright(shared: SharedPlaywrightBrowser): void {
  shared.refCount = Math.max(0, shared.refCount - 1);
  if (shared.refCount === 0) {
    if (sharedPlaywright === shared) sharedPlaywright = null;
    void shared.browser.close().catch(() => {});
  }
}

/**
 * CDP Client using Playwright (fallback when Extension is not available).
 * Connects to a shared headed Chromium; each client owns one tab.
 */
export class PlaywrightCDPClient extends EventEmitter implements ICDPClient {
  private shared: SharedPlaywrightBrowser | null = null;
  private page: unknown | null = null;
  private cdpSession: unknown | null = null;
  private ownedPages: any[] = [];
  private connected = false;

  async connect(): Promise<void> {
    try {
      this.shared = await acquireSharedPlaywright();
      this.page = await this.shared.context.newPage();
      this.ownedPages = [this.page];
      this.cdpSession = await (this.page as any).context().newCDPSession(this.page);
      this.connected = true;
      this.emit('connected');
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      // Provide helpful message if browser binaries are not installed
      if (errMsg.includes('Executable doesn\'t exist') || errMsg.includes('browserType.launch')) {
        throw new Error(
          `Playwright browser not found. ${errMsg}\n\n` +
          'To use the browser tool with an independent window, install Playwright browsers:\n' +
          '  npx playwright install chromium\n\n' +
          'Or use the DUYA Browser Bridge Chrome extension to connect to your existing browser.'
        );
      }
      throw new Error(`Failed to launch Playwright: ${errMsg}`);
    }
  }

  async health(): Promise<{ status: string; mode: CDPMode }> {
    return {
      status: this.connected ? 'ok' : 'unavailable',
      mode: 'playwright'
    };
  }

  async navigate(url: string): Promise<void> {
    if (!this.connected) await this.connect();
    await (this.page as any).goto(url, { waitUntil: 'networkidle', timeout: 15000 });
    try {
      await this.evaluate(generateStealthJs());
    } catch {
      // Best effort
    }
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.connected) throw new Error('Not connected');
    return await (this.cdpSession as any).send(method, params);
  }

  async evaluate(expression: string, returnByValue = true): Promise<unknown> {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue,
      awaitPromise: true,
    }) as { result?: { value?: unknown }; exceptionDetails?: { text: string } };

    if (result?.exceptionDetails) {
      throw new Error(`JS evaluation error: ${result.exceptionDetails.text}`);
    }

    return result?.result?.value;
  }

  async screenshot(options: { fullPage?: boolean; selector?: string } = {}): Promise<string> {
    const { fullPage = false, selector } = options;

    if (selector) {
      const element = await (this.page as any).locator(selector);
      const buffer = await element.screenshot();
      return buffer.toString('base64');
    }

    if (fullPage) {
      const buffer = await (this.page as any).screenshot({ fullPage: true });
      return buffer.toString('base64');
    }

    const buffer = await (this.page as any).screenshot();
    return buffer.toString('base64');
  }

  async click(selector: string): Promise<void> {
    if (selector.startsWith('@')) {
      const ref = selector.slice(1);
      await this.evaluate(`document.querySelector('[data-duya-ref="${ref}"]')?.click()`);
      return;
    }
    await (this.page as any).click(selector);
  }

  async type(selector: string, text: string): Promise<void> {
    await (this.page as any).fill(selector, text);
  }

  async scroll(direction: 'up' | 'down' | 'left' | 'right' = 'down', amount = 300): Promise<void> {
    const deltaMap = { up: [0, -amount], down: [0, amount], left: [-amount, 0], right: [amount, 0] };
    const [deltaX, deltaY] = deltaMap[direction] || [0, amount];
    await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 0, y: 0, deltaX, deltaY });
  }

  async goBack(): Promise<void> {
    await (this.page as any).goBack();
  }

  async pressKey(key: string): Promise<void> {
    await (this.page as any).keyboard.press(key);
  }

  async getUrl(): Promise<string> {
    return await (this.page as any).url();
  }

  async getTitle(): Promise<string> {
    return await (this.page as any).title();
  }

  async close(): Promise<void> {
    const page = this.page as any;
    this.page = null;
    this.cdpSession = null;
    if (page) {
      try { await page.close(); } catch {}
    }
    this.ownedPages = [];
    if (this.shared) {
      releaseSharedPlaywright(this.shared);
      this.shared = null;
    }
    this.connected = false;
    this.emit('closed');
  }

  async closeWindow(): Promise<void> {
    // Close this session's tab; the shared Chromium exits when the last
    // session releases it (refcount hits zero).
    await this.close();
  }

  // Tab management, scoped to the pages this session owns
  async tabs(): Promise<TabInfo[]> {
    const allTabs: TabInfo[] = [];
    for (let i = 0; i < this.ownedPages.length; i++) {
      const p = this.ownedPages[i];
      try {
        allTabs.push({
          id: i,
          url: p.url(),
          title: await p.title(),
          active: p === this.page,
        });
      } catch {
        // Page closed externally — drop it so indices stay stable going forward.
        this.ownedPages.splice(i, 1);
        i--;
      }
    }
    return allTabs;
  }

  async newTab(url?: string): Promise<string | undefined> {
    if (!this.shared) throw new Error('Not connected');
    const newPage = await this.shared.context.newPage();
    this.ownedPages.push(newPage);
    if (url) await newPage.goto(url);
    this.page = newPage;
    return String(this.ownedPages.length - 1);
  }

  async closeTab(target?: number | string): Promise<void> {
    const index = typeof target === 'number' ? target : parseInt(String(target), 10);
    const p = this.ownedPages[index];
    if (!p) throw new Error(`Tab not found: ${target}`);
    this.ownedPages.splice(index, 1);
    try { await p.close(); } catch {}
    if (this.page === p) {
      this.page = this.ownedPages[this.ownedPages.length - 1] ?? null;
    }
  }

  async selectTab(target: number | string): Promise<void> {
    const index = typeof target === 'number' ? target : parseInt(String(target), 10);
    if (!this.ownedPages[index]) {
      throw new Error(`Tab not found: ${target}`);
    }
    this.page = this.ownedPages[index];
  }

  // File upload stub for Playwright
  async setFileInput(files: string[], selector?: string): Promise<void> {
    if (!selector) throw new Error('Selector is required for setFileInput');
    const input = await (this.page as any).locator(selector);
    await input.setInputFiles(files);
  }

  // Network capture stubs
  async startNetworkCapture(): Promise<boolean> {
    console.warn('[BrowserTool] Network capture not supported in Playwright mode');
    return false;
  }

  async readNetworkCapture(): Promise<unknown[]> {
    return [];
  }

  // Cookies
  async getCookies(opts: { domain?: string; url?: string } = {}): Promise<BrowserCookie[]> {
    const context = await (this.page as any).context();
    const cookies = await context.cookies(opts.url);
    return cookies;
  }

  // Iframe support
  async frames(): Promise<Array<{ index: number; frameId: string; url: string; name: string }>> {
    const frames = await (this.page as any).frames();
    return frames.map((frame: any, index: number) => ({
      index,
      frameId: String(index),
      url: frame.url(),
      name: frame.name() || '',
    }));
  }

  async evaluateInFrame(js: string, frameIndex: number): Promise<unknown> {
    const frames = await (this.page as any).frames();
    if (!frames[frameIndex]) throw new Error(`Frame not found: ${frameIndex}`);
    return await frames[frameIndex].evaluate(js);
  }

  async waitForLoad(_timeout = 30000): Promise<void> {
    await (this.page as any).waitForLoadState('networkidle', { timeout: _timeout });
  }

  async hover(selector: string): Promise<void> {
    const elSelector = this._resolveSelector(selector);
    await (this.page as any).hover(elSelector);
  }

  async waitForElement(selector: string, timeoutMs = 15000): Promise<void> {
    const elSelector = this._resolveSelector(selector);
    await (this.page as any).waitForSelector(elSelector, { timeout: timeoutMs });
  }

  async selectOption(selector: string, value: string): Promise<void> {
    const elSelector = this._resolveSelector(selector);
    await (this.page as any).selectOption(elSelector, value);
  }

  private _resolveSelector(selector: string): string {
    if (selector.startsWith('@')) {
      return `[data-duya-ref="${selector.slice(1)}"]`;
    }
    return selector;
  }

  // Raw CDP
  async cdp(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.send(method, params);
  }
}

// ========================================================================
// Blocked Domains API
// ========================================================================

/**
 * Fetch blocked domains from daemon (configured in Extension)
 */
export async function fetchBlockedDomains(): Promise<string[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);

    const res = await fetch(`${DAEMON_URL}/blocked-domains`, {
      headers: DUYA_HEADERS,
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      return [];
    }

    const data = await res.json() as { ok: boolean; domains?: string[] };
    return data.domains || [];
  } catch {
    return [];
  }
}

// ========================================================================
// Factory
// ========================================================================

/**
 * Create CDP client honoring the configured backend mode.
 *
 * - extension: only ExtensionCDPClient (user's Chrome via daemon)
 * - built-in:  only WebviewCDPClient (DUYA sidebar webview)
 * - auto:      Extension → Webview → Playwright
 *
 * This replaces the previous hardcoded extension → Playwright behavior so
 * selecting "Built-in" in the UI never launches an external Chromium window.
 */
export async function createCDPClientForMode(
  sessionId: string,
  mode: 'auto' | 'extension' | 'built-in' | 'human-like',
  options: { background?: boolean } = {},
): Promise<ICDPClient> {
  if (mode === 'extension') {
    const extensionClient = new ExtensionCDPClient(sessionId);
    const health = await extensionClient.health();
    if (health.status === 'ok') {
      await extensionClient.connect();
      logger.info('Extension mode connected', undefined, 'BrowserTool');
      return extensionClient;
    }
    throw new Error('Browser backend mode is "extension" but the Chrome extension is not connected.');
  }

  if (mode === 'built-in' || mode === 'human-like') {
    const webviewClient = new WebviewCDPClient(sessionId, options);
    const health = await webviewClient.health();
    if (health.status === 'ok') {
      await webviewClient.connect();
      if (mode === 'human-like') {
        const humanLikeClient = new HumanLikeCDPClient({
          base: webviewClient,
          mode: 'human-like',
        });
        await humanLikeClient.connect();
        logger.info('Human-like webview mode connected', undefined, 'BrowserTool');
        return humanLikeClient;
      }
      logger.info('Built-in webview mode connected', undefined, 'BrowserTool');
      return webviewClient;
    }
    throw new Error(
      `Browser backend mode is "${mode}" but the DUYA webview daemon is not reachable. ` +
      'Open the browser panel so the webview can register.'
    );
  }

  // auto mode: try extension first, then DUYA webview, then Playwright as last resort
  const extensionClient = new ExtensionCDPClient(sessionId);
  const extensionHealth = await extensionClient.health();
  if (extensionHealth.status === 'ok') {
    await extensionClient.connect();
    logger.info('Extension mode connected', undefined, 'BrowserTool');
    return extensionClient;
  }

  const webviewClient = new WebviewCDPClient(sessionId, options);
  const webviewHealth = await webviewClient.health();
  if (webviewHealth.status === 'ok') {
    await webviewClient.connect();
    logger.info('Built-in webview mode connected', undefined, 'BrowserTool');
    return webviewClient;
  }

  logger.info('Extension and webview unavailable, launching Playwright mode (shared headed Chromium)...', undefined, 'BrowserTool');
  const playwrightClient = new PlaywrightCDPClient();
  await playwrightClient.connect();
  logger.info('Playwright mode connected - session runs as a tab of the shared browser window', undefined, 'BrowserTool');
  return playwrightClient;
}

/**
 * @deprecated Use createCDPClientForMode with an explicit mode.
 * Kept for callers that do not yet pass a mode; behaves like auto mode.
 */
export async function createCDPClient(sessionId: string): Promise<ICDPClient> {
  return createCDPClientForMode(sessionId, 'auto');
}

export { DebuggerConflict, WebviewNotReady } from './WebviewCDPClient.js';

export default createCDPClient;
