/**
 * browser-backend.ts — worker 侧生产 BrowserBackendPort（plan 564）。
 *
 * 把 browser-runner 的步骤契约映射到 ExtensionCDPClient（daemon HTTP /command
 * → 扩展 CDP 动作）。与 gui-backend 的差异：computer-use 走 worker→main RPC，
 * 而 daemon 是 localhost HTTP —— worker **直连**即可，不需要新的转发类型。
 *
 * set_value 走页面内 evaluate（native setter + input/change 事件，React 受控
 * 组件友好）；逐字符 type 留给需要真实键击节奏的场景。
 */

import { ExtensionCDPClient } from '../tool/BrowserTool/CDPClient.js';
import {
  runBrowserNode,
  type BrowserBackendPort,
  type BrowserNodeOutcome,
  type BrowserNodeSpec,
  type BrowserStepResult,
} from '../modes/workflow/browser-runner.js';
import type { ArtifactStore } from '../modes/workflow/gui-artifacts.js';

export const BROWSER_BRIDGE_UNAVAILABLE =
  'browser bridge unavailable — install/connect the DUYA Browser Bridge extension ' +
  '(daemon /ping did not report extensionConnected)';

/** native setter + 事件派发：绕过 React 对 value 的只读代理。 */
function setValueScript(selector: string, value: string): string {
  return `(function(){
  var el = document.querySelector(${JSON.stringify(selector)});
  if (!el) throw new Error('element not found: ${selector.replace(/'/g, "\\'")}');
  var proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  var desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) { desc.set.call(el, ${JSON.stringify(value)}); }
  else { el.value = ${JSON.stringify(value)}; }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
})()`;
}

/**
 * click_text 页面脚本：按可见文本找**最内层**匹配元素，上溯到可点击祖先
 * （a、button、role=button、class 含 btn / button / tab / item / card），
 * 再把完整事件序列（pointerdown 到 click）**直接派发到该元素**。不做坐标
 * 点击——SPA 站点常有浮层盖住按钮中心，坐标点击会落在浮层上（plan 564
 * 真机实录），直接派发则不受遮挡影响。
 */
function clickTextScript(text: string, exact: boolean): string {
  return `(function(){
  var text = ${JSON.stringify(text)};
  var exact = ${JSON.stringify(exact)};
  var all = document.querySelectorAll('a,button,div,span,li,p,h1,h2,h3,h4,label,td,th');
  var hits = [];
  for (var i = 0; i < all.length; i++) {
    var t = (all[i].textContent || '').trim();
    if (exact ? t === text : t.indexOf(text) !== -1) hits.push(all[i]);
  }
  if (!hits.length) return { ok: false, reason: 'not_found', text: text };
  // 最内层：不含其他命中（父容器与叶子同时命中时取叶子）。
  var innermost = hits.filter(function (el) {
    return !hits.some(function (o) { return o !== el && el.contains(o); });
  });
  // 优先可见命中，多个时取文档序第一个。
  var visible = innermost.filter(function (el) { return el.offsetWidth > 0 || el.offsetHeight > 0; });
  var leaf = (visible.length ? visible : innermost)[0];
  var target = leaf.closest('a,button,[role=button],[class*="btn"],[class*="button"],[class*="tab"],[class*="item"],[class*="card"]') || leaf;
  var r = target.getBoundingClientRect();
  var opts = { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
  ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (t) {
    var ev = typeof PointerEvent === 'function' && t.indexOf('pointer') === 0
      ? new PointerEvent(t, opts)
      : new MouseEvent(t, opts);
    target.dispatchEvent(ev);
  });
  return { ok: true, clicked: text, tag: target.tagName, cls: String(target.className).slice(0, 100) };
})()`;
}

/** wait text 页面脚本：可见文本命中的元素数。 */
function textPresenceScript(text: string): string {
  return `(function(){
  var text = ${JSON.stringify(text)};
  var n = 0;
  var all = document.querySelectorAll('a,button,div,span,li,p,h1,h2,h3,h4,label,td,th');
  for (var i = 0; i < all.length; i++) {
    var t = (all[i].textContent || '').trim();
    if (t.indexOf(text) !== -1 && (all[i].offsetWidth > 0 || all[i].offsetHeight > 0)) n++;
  }
  return n;
})()`;
}

/**
 * 构造生产后端。每次 `wf.browser` 调用一个实例（一个扩展会话标签页）；
 * connect() 是显式的连通性门——扩展未装/未连通时抛面向用户的消息。
 */
export function createExtensionBrowserBackend(sessionId: string): BrowserBackendPort {
  const client = new ExtensionCDPClient(sessionId);
  let ready = false;

  const ensureConnected = async (): Promise<void> => {
    if (ready) return;
    const health = await client.health();
    if (health.status !== 'ok') {
      throw new Error(BROWSER_BRIDGE_UNAVAILABLE);
    }
    ready = true;
  };

  const wrap = (err: unknown): BrowserStepResult => ({
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  });

  return {
    async connect() {
      await ensureConnected();
    },

    async run(step): Promise<BrowserStepResult> {
      try {
        await ensureConnected();
        switch (step.do) {
          case 'navigate': {
            await client.navigate(step.url);
            const [url, title] = await Promise.all([client.getUrl(), client.getTitle()]);
            return { ok: true, data: { url, title } };
          }
          case 'click': {
            await client.click(step.selector);
            return { ok: true };
          }
          case 'click_text': {
            const result = (await client.evaluate(clickTextScript(step.text, step.exact ?? true))) as
              | { ok?: boolean; reason?: string; clicked?: string; tag?: string }
              | undefined;
            if (!result || result.ok !== true) {
              return {
                ok: false,
                error: `Text not found: ${step.text}`,
              };
            }
            return { ok: true, data: { clicked: result.clicked, tag: result.tag } };
          }
          case 'type': {
            await client.type(step.selector, step.text);
            return { ok: true };
          }
          case 'set_value': {
            await client.evaluate(setValueScript(step.selector, step.value));
            return { ok: true };
          }
          case 'key': {
            await client.pressKey(step.key);
            return { ok: true };
          }
          case 'scroll': {
            await client.scroll(step.direction ?? 'down', step.amount ?? 300);
            return { ok: true };
          }
          case 'wait': {
            if (step.selector) {
              await client.waitForElement(step.selector, step.timeoutMs ?? 10_000);
            } else if (typeof step.text === 'string') {
              // 文本出现等待：SPA 换页/换 tab 后 click_text 前的确定性护栏。
              const deadline = Date.now() + (step.timeoutMs ?? 10_000);
              let present = 0;
              while (Date.now() < deadline) {
                present = (await client.evaluate(textPresenceScript(step.text))) as number;
                if (typeof present === 'number' && present > 0) return { ok: true };
                await new Promise((resolve) => setTimeout(resolve, 500));
              }
              return { ok: false, error: `Timeout waiting for text: ${step.text}` };
            } else if (typeof step.ms === 'number' && step.ms > 0) {
              await new Promise((resolve) => setTimeout(resolve, step.ms));
            }
            return { ok: true };
          }
          case 'screenshot': {
            const base64 = await client.screenshot({ fullPage: step.fullPage ?? false });
            return { ok: true, data: { base64 } };
          }
        }
      } catch (err) {
        return wrap(err);
      }
    },

    async close() {
      // 仅回收本会话标签页（daemon close_session → 扩展 closeSessionTab）。
      try {
        await client.closeSession();
      } finally {
        await client.close();
      }
    },
  };
}

/** runBrowser 的便捷组合：backend 生命周期随节点结束（close_tab 语义由 runner 管）。 */
export async function runBrowserWithExtensionBackend(
  sessionId: string,
  spec: BrowserNodeSpec,
  deps: {
    artifacts?: ArtifactStore;
    runId: string;
    /** on_stuck:'agent' escalation (plan 565 Phase D). Absent → ladder fails as before. */
    ask?: (question: string) => Promise<string | null>;
  },
): Promise<BrowserNodeOutcome> {
  return runBrowserNode({
    browser: spec,
    backend: createExtensionBrowserBackend(sessionId),
    ...(deps.artifacts ? { artifacts: deps.artifacts } : {}),
    ...(deps.ask ? { ask: deps.ask } : {}),
    runId: deps.runId,
  });
}
