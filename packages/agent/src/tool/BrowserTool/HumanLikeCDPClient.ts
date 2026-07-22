/**
 * HumanLikeCDPClient
 *
 * A decorator-style CDP client that turns DOM/selector operations into
 * realistic mouse and keyboard events. It wraps an existing ICDPClient
 * (typically the DUYA sidebar webview) and:
 *
 *  - Tracks the virtual cursor position across actions.
 *  - Moves the cursor along randomized cubic-bezier curves instead of
 *    teleporting instantly.
 *  - Clicks, types, and scrolls through CDP Input.* events so the page sees
 *    genuine pointer/keyboard events rather than JavaScript mutations.
 */

import { EventEmitter } from 'events';
import type { ICDPClient, TabInfo, BrowserCookie, CDPMode } from './CDPClient.js';

interface Point {
  x: number;
  y: number;
}

interface HumanLikeCDPClientOptions {
  base: ICDPClient;
  mode: CDPMode;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function cubicBezierPoint(t: number, p0: Point, p1: Point, p2: Point, p3: Point): Point {
  const oneMinusT = 1 - t;
  const x =
    Math.pow(oneMinusT, 3) * p0.x +
    3 * Math.pow(oneMinusT, 2) * t * p1.x +
    3 * oneMinusT * Math.pow(t, 2) * p2.x +
    Math.pow(t, 3) * p3.x;
  const y =
    Math.pow(oneMinusT, 3) * p0.y +
    3 * Math.pow(oneMinusT, 2) * t * p1.y +
    3 * oneMinusT * Math.pow(t, 2) * p2.y +
    Math.pow(t, 3) * p3.y;
  return { x, y };
}

export class HumanLikeCDPClient extends EventEmitter implements ICDPClient {
  private base: ICDPClient;
  private cursor: Point = { x: 0, y: 0 };
  private connected = false;
  private _mode: CDPMode;

  constructor(options: HumanLikeCDPClientOptions) {
    super();
    this.base = options.base;
    this._mode = options.mode;
  }

  async connect(): Promise<void> {
    await this.base.connect();
    this.connected = true;
    this.emit('connected');
  }

  async health(): Promise<{ status: string; mode: CDPMode }> {
    const baseHealth = await this.base.health();
    return { status: baseHealth.status, mode: this._mode };
  }

  async navigate(url: string): Promise<void> {
    await this.base.navigate(url);
    this.cursor = { x: 0, y: 0 };
  }

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.base.send(method, params);
  }

  async evaluate(expression: string, returnByValue?: boolean): Promise<unknown> {
    return this.base.evaluate(expression, returnByValue);
  }

  async screenshot(options?: { fullPage?: boolean; selector?: string }): Promise<string> {
    return this.base.screenshot(options);
  }

  async click(selector: string): Promise<void> {
    const point = await this.resolveSelectorPoint(selector);
    await this.smoothMoveTo(point);
    await this.dispatchMousePress(point, 1);
    await this.dispatchMouseRelease(point, 1);
  }

  async type(selector: string, text: string): Promise<void> {
    await this.click(selector);
    await sleep(randomBetween(80, 150));
    for (const char of text) {
      await this.base.send('Input.dispatchKeyEvent', { type: 'char', text: char });
      await sleep(randomBetween(25, 90));
    }
  }

  async scroll(direction: 'up' | 'down' | 'left' | 'right', amount = 300): Promise<void> {
    const deltaMap: Record<string, [number, number]> = {
      up: [0, -amount],
      down: [0, amount],
      left: [-amount, 0],
      right: [amount, 0],
    };
    const [deltaX, deltaY] = deltaMap[direction] || [0, amount];
    await this.base.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: this.cursor.x,
      y: this.cursor.y,
      deltaX,
      deltaY,
    });
  }

  async goBack(): Promise<void> {
    await this.base.goBack();
  }

  async pressKey(key: string): Promise<void> {
    const keyMap: Record<string, Record<string, unknown>> = {
      Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
      Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
      Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
      ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
      ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
      ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
      ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    };
    const info = keyMap[key] || { key, code: key, keyCode: 0 };
    await this.base.send('Input.dispatchKeyEvent', { type: 'keyDown', ...info });
    await this.base.send('Input.dispatchKeyEvent', { type: 'keyUp', ...info });
  }

  async getUrl(): Promise<string> {
    return this.base.getUrl();
  }

  async getTitle(): Promise<string> {
    return this.base.getTitle();
  }

  async close(): Promise<void> {
    await this.base.close();
    this.connected = false;
    this.emit('closed');
  }

  async closeWindow(): Promise<void> {
    await this.base.closeWindow();
  }

  async tabs(): Promise<TabInfo[]> {
    return this.base.tabs();
  }

  async newTab(url?: string): Promise<string | undefined> {
    return this.base.newTab(url);
  }

  async closeTab(target?: number | string): Promise<void> {
    await this.base.closeTab(target);
  }

  async selectTab(target: number | string): Promise<void> {
    await this.base.selectTab(target);
  }

  async setFileInput(files: string[], selector?: string): Promise<void> {
    await this.base.setFileInput(files, selector);
  }

  async startNetworkCapture(pattern?: string): Promise<boolean> {
    return this.base.startNetworkCapture(pattern);
  }

  async readNetworkCapture(): Promise<unknown[]> {
    return this.base.readNetworkCapture();
  }

  async getCookies(opts?: { domain?: string; url?: string }): Promise<BrowserCookie[]> {
    return this.base.getCookies(opts);
  }

  async frames(): Promise<Array<{ index: number; frameId: string; url: string; name: string }>> {
    return this.base.frames();
  }

  async evaluateInFrame(js: string, frameIndex: number): Promise<unknown> {
    return this.base.evaluateInFrame(js, frameIndex);
  }

  async hover(selector: string): Promise<void> {
    const point = await this.resolveSelectorPoint(selector);
    await this.smoothMoveTo(point);
  }

  async waitForElement(selector: string, timeoutMs?: number): Promise<void> {
    await this.base.waitForElement(selector, timeoutMs);
  }

  async waitForLoad(timeoutMs?: number): Promise<void> {
    await this.base.waitForLoad(timeoutMs);
  }

  async selectOption(selector: string, value: string): Promise<void> {
    await this.base.selectOption(selector, value);
  }

  async cdp(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.base.cdp(method, params);
  }

  private async resolveSelectorPoint(selector: string): Promise<Point> {
    const resolved = selector.startsWith('@')
      ? `[data-duya-ref="${selector.slice(1)}"]`
      : selector;

    const box = (await this.base.evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(resolved)});
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return null;
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        };
      })()
    `)) as Point | null;

    if (!box) {
      throw new Error(`Element not found or not visible: ${selector}`);
    }
    return box;
  }

  private async smoothMoveTo(target: Point, durationMs = randomBetween(250, 450)): Promise<void> {
    const start = this.cursor;
    const distance = Math.hypot(target.x - start.x, target.y - start.y);
    if (distance < 2) {
      this.cursor = target;
      return;
    }

    const cp1 = this.randomControlPoint(start, target, 0.2);
    const cp2 = this.randomControlPoint(start, target, 0.8);

    const steps = Math.max(10, Math.min(40, Math.round(distance / 10)));
    const stepDuration = durationMs / steps;

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const easedT = this.easeInOutCubic(t);
      const point = cubicBezierPoint(easedT, start, cp1, cp2, target);
      await this.base.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: point.x,
        y: point.y,
      });
      this.cursor = point;
      await sleep(stepDuration);
    }
  }

  private randomControlPoint(start: Point, end: Point, t: number): Point {
    const base = {
      x: start.x + (end.x - start.x) * t,
      y: start.y + (end.y - start.y) * t,
    };
    const offsetRange = Math.hypot(end.x - start.x, end.y - start.y) * 0.35;
    return {
      x: base.x + randomBetween(-offsetRange, offsetRange),
      y: base.y + randomBetween(-offsetRange, offsetRange),
    };
  }

  private easeInOutCubic(t: number): number {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  private async dispatchMousePress(point: Point, clickCount: number): Promise<void> {
    await this.base.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: point.x,
      y: point.y,
      button: 'left',
      clickCount,
    });
  }

  private async dispatchMouseRelease(point: Point, clickCount: number): Promise<void> {
    await this.base.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: point.x,
      y: point.y,
      button: 'left',
      clickCount,
    });
  }
}
