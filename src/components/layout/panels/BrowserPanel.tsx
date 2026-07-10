"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowsClockwise,
  Camera,
  CursorClick,
  Globe,
  WarningCircle,
} from "@phosphor-icons/react";
import { usePanel } from "@/hooks/usePanel";
import type { PageTab } from "./registry";
import { AgentBrowserTab } from "./AgentBrowserTab";
import { BrowserBackendToggle } from "./BrowserBackendToggle";

type WebviewElement = HTMLElement & {
  canGoBack(): boolean;
  canGoForward(): boolean;
  capturePage(): Promise<{ toDataURL(): string }>;
  executeJavaScript<T = unknown>(code: string, userGesture?: boolean): Promise<T>;
  getTitle(): string;
  getURL(): string;
  goBack(): void;
  goForward(): void;
  loadURL(url: string): void | Promise<void>;
  reload(): void;
};

type WebviewNavigationEvent = Event & {
  isMainFrame?: boolean;
  url?: string;
};

interface BrowserElementSnapshot {
  selector: string;
  label: string;
  text: string;
  position: { x: number; y: number; width: number; height: number };
  htmlHint: string;
  style?: Record<string, string>;
}

const EMPTY_URL = "about:blank";
const DEFAULT_URL = "http://localhost:3000/";
const BROWSER_PARTITION = "persist:duya-local-browser";

function normalizeBrowserAddress(raw: string): string {
  const value = raw.trim();
  if (!value) return EMPTY_URL;
  if (value === EMPTY_URL) return EMPTY_URL;
  if (/^(https?|file):\/\//i.test(value)) return value;
  if (/^localhost(:\d+)?(\/.*)?$/i.test(value)) return `http://${value}`;
  if (/^(127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/.*)?$/i.test(value)) return `http://${value}`;
  if (/^[a-zA-Z]:[\\/]/.test(value)) {
    return `file:///${encodeURI(value.replace(/\\/g, "/"))}`;
  }
  if (value.startsWith("/") || value.startsWith("\\")) {
    return `file://${encodeURI(value.replace(/\\/g, "/"))}`;
  }
  if (/^[\w.-]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(value)) return `https://${value}`;
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

function labelFromUrl(url: string): string {
  if (!url || url === EMPTY_URL) return "New Tab";
  try {
    const parsed = new URL(url);
    return parsed.hostname || parsed.pathname || url;
  } catch {
    return url;
  }
}

function dataUrlByteSize(dataUrl: string): number {
  const [, base64 = ""] = dataUrl.split(",", 2);
  return Math.round((base64.length * 3) / 4);
}

function elementPickerScript(): string {
  return `
(() => new Promise((resolve) => {
  const previousCancel = window.__duyaBrowserPickerCancel;
  if (typeof previousCancel === 'function') {
    try { previousCancel(); } catch (_) {}
  }
  const style = document.createElement('style');
  style.setAttribute('data-duya-browser-picker', 'true');
  style.textContent = [
    '* { cursor: crosshair !important; }',
    '.__duya_browser_pick_hover__ { outline: 2px solid #47b5ff !important; outline-offset: 2px !important; box-shadow: 0 0 0 9999px rgba(0,0,0,0.18) !important; }'
  ].join('\\n');
  document.head.appendChild(style);

  let hovered = null;
  let finished = false;

  function escIdent(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(String(value));
    return String(value).replace(/[^a-zA-Z0-9_-]/g, function(ch) { return '\\\\' + ch; });
  }
  function visibleRect(el) {
    const rect = el.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return rect;
  }
  function elementFor(node) {
    let el = node && node.nodeType === 1 ? node : null;
    while (el && el !== document.documentElement) {
      const tag = el.tagName ? el.tagName.toLowerCase() : '';
      if (!/^(script|style|template|meta|link|title|noscript)$/i.test(tag) && visibleRect(el)) return el;
      el = el.parentElement;
    }
    return visibleRect(document.body) ? document.body : document.documentElement;
  }
  function selectorFor(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      const tag = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(tag + '#' + escIdent(node.id));
        break;
      }
      let index = 1;
      let prev = node.previousElementSibling;
      while (prev) {
        if (prev.tagName === node.tagName) index += 1;
        prev = prev.previousElementSibling;
      }
      parts.unshift(tag + ':nth-of-type(' + index + ')');
      node = node.parentElement;
    }
    return parts.join(' > ') || 'body';
  }
  function styleSnapshot(el) {
    const s = window.getComputedStyle(el);
    return {
      color: s.color,
      backgroundColor: s.backgroundColor,
      fontSize: s.fontSize,
      fontWeight: s.fontWeight,
      lineHeight: s.lineHeight,
      textAlign: s.textAlign,
      fontFamily: s.fontFamily,
      paddingTop: s.paddingTop,
      paddingRight: s.paddingRight,
      paddingBottom: s.paddingBottom,
      paddingLeft: s.paddingLeft,
      borderRadius: s.borderRadius
    };
  }
  function publicClassNames(el) {
    if (!el || !el.classList) return [];
    return Array.from(el.classList).filter(function(name) {
      return name !== '__duya_browser_pick_hover__' && name.indexOf('__duya_') !== 0;
    });
  }
  function sanitizedOpeningTag(el) {
    try {
      const clone = el.cloneNode(false);
      if (clone && clone.classList) {
        Array.from(clone.classList).forEach(function(name) {
          if (name === '__duya_browser_pick_hover__' || name.indexOf('__duya_') === 0) {
            clone.classList.remove(name);
          }
        });
      }
      const match = String(clone.outerHTML || '').replace(/\\s+/g, ' ').match(/^<[^>]+>/);
      return match ? match[0] : '';
    } catch (_) {
      return '';
    }
  }
  function snapshotFor(el) {
    const rect = el.getBoundingClientRect();
    const tag = el.tagName ? el.tagName.toLowerCase() : 'element';
    const classNames = publicClassNames(el);
    const cls = classNames.length ? '.' + classNames.slice(0, 2).join('.') : '';
    const htmlHint = sanitizedOpeningTag(el);
    return {
      selector: selectorFor(el),
      label: tag + cls,
      text: String(el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 500),
      position: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      htmlHint: htmlHint.slice(0, 500),
      style: styleSnapshot(el)
    };
  }
  function setHover(el) {
    if (hovered === el) return;
    if (hovered) hovered.classList.remove('__duya_browser_pick_hover__');
    hovered = el;
    if (hovered) hovered.classList.add('__duya_browser_pick_hover__');
  }
  function cleanup(result) {
    if (finished) return;
    finished = true;
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    if (hovered) hovered.classList.remove('__duya_browser_pick_hover__');
    style.remove();
    window.__duyaBrowserPickerCancel = null;
    resolve(result || null);
  }
  function onMove(ev) {
    setHover(elementFor(ev.target));
  }
  function onClick(ev) {
    const el = elementFor(ev.target);
    if (!el) return;
    ev.preventDefault();
    ev.stopPropagation();
    cleanup(snapshotFor(el));
  }
  function onKeyDown(ev) {
    if (ev.key === 'Escape') cleanup(null);
  }

  window.__duyaBrowserPickerCancel = () => cleanup(null);
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
}))()
`;
}

function formatElementPrompt(snapshot: BrowserElementSnapshot, pageUrl: string, title: string): string {
  const style = snapshot.style ?? {};
  return [
    "Browser element reference:",
    `- Page: ${title || labelFromUrl(pageUrl)}`,
    `- URL: ${pageUrl}`,
    `- Selector: ${snapshot.selector}`,
    `- Label: ${snapshot.label}`,
    `- Bounds: x=${snapshot.position.x}, y=${snapshot.position.y}, w=${snapshot.position.width}, h=${snapshot.position.height}`,
    snapshot.text ? `- Text: ${snapshot.text}` : "",
    snapshot.htmlHint ? `- HTML hint: ${snapshot.htmlHint}` : "",
    Object.keys(style).length > 0
      ? `- Style: ${JSON.stringify(style)}`
      : "",
    "",
    "Use this selected element as the target for the UI change.",
  ].filter(Boolean).join("\n");
}

function dispatchBrowserScreenshot(dataUrl: string, pageUrl: string, title: string): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const attachmentId = crypto.randomUUID();
  window.dispatchEvent(new CustomEvent("browser-add-to-input", {
    detail: {
      reference: {
        kind: "screenshot",
        label: "Screenshot",
        title: title || labelFromUrl(pageUrl),
        url: pageUrl,
        content: [
          "Browser screenshot reference:",
          `- Page: ${title || labelFromUrl(pageUrl)}`,
          `- URL: ${pageUrl}`,
          "Use the attached screenshot as visual context for the UI change.",
        ].join("\n"),
        attachmentId,
      },
      attachment: {
        id: attachmentId,
        name: `browser-screenshot-${stamp}.png`,
        type: "image/png",
        url: dataUrl,
        size: dataUrlByteSize(dataUrl),
      },
    },
  }));
}

export function BrowserPanel({ tab }: { tab?: PageTab; embedded?: boolean }) {
  const { updateTabTitle, updateTabFavicon } = usePanel();

  // Agent-driven browser tab: render the AgentBrowserTab component which
  // auto-registers its webview with the daemon for CDP command execution.
  const agentSessionId = tab?.params?.kind === "agent"
    ? typeof tab.params.sessionId === "string" ? tab.params.sessionId : undefined
    : undefined;

  if (agentSessionId) {
    return (
      <AgentBrowserTab
        sessionId={agentSessionId}
        onTitleChange={(title) => {
          if (tab?.id) updateTabTitle(tab.id, title);
        }}
      />
    );
  }

  const initialUrl = useMemo(() => {
    const raw = tab?.params?.url;
    return typeof raw === "string" && raw.trim() ? normalizeBrowserAddress(raw) : DEFAULT_URL;
  }, [tab?.params]);

  const webviewRef = useRef<WebviewElement | null>(null);
  const [addressValue, setAddressValue] = useState(initialUrl);
  const [url, setUrl] = useState(initialUrl);
  const [title, setTitle] = useState(labelFromUrl(initialUrl));
  const [loading, setLoading] = useState(true);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [picking, setPicking] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const syncFromWebview = useCallback(() => {
    const node = webviewRef.current;
    if (!node) return;
    try {
      const nextUrl = node.getURL() || EMPTY_URL;
      const nextTitle = node.getTitle() || labelFromUrl(nextUrl);
      setUrl(nextUrl);
      setTitle(nextTitle);
      setAddressValue(nextUrl === EMPTY_URL ? "" : nextUrl);
      setCanGoBack(node.canGoBack());
      setCanGoForward(node.canGoForward());
      if (tab?.id) {
        updateTabTitle(tab.id, nextTitle);
      }
    } catch {
      // Webview can throw while it is being attached or torn down.
    }
  }, [tab?.id, updateTabTitle]);

  const navigate = useCallback((nextRaw: string) => {
    const nextUrl = normalizeBrowserAddress(nextRaw);
    setError(null);
    setStatus(null);
    setUrl(nextUrl);
    setAddressValue(nextUrl === EMPTY_URL ? "" : nextUrl);
    webviewRef.current?.loadURL(nextUrl);
  }, []);

  useEffect(() => {
    const node = webviewRef.current;
    if (!node) return;

    const handleStart = () => {
      setLoading(true);
      setError(null);
    };
    const handleStop = () => {
      setLoading(false);
      syncFromWebview();
    };
    const handleNavigate = (event: WebviewNavigationEvent) => {
      if (event.isMainFrame === false) return;
      syncFromWebview();
    };
    const handleTitle = () => syncFromWebview();
    const handleFavicon = (event: Event & { favicons?: string[] }) => {
      const favicons = (event as Event & { favicons?: string[] }).favicons;
      if (tab?.id && Array.isArray(favicons) && favicons.length > 0) {
        updateTabFavicon(tab.id, favicons[0]);
      }
    };
    const handleFail = (event: Event & { errorDescription?: string; validatedURL?: string }) => {
      setLoading(false);
      setError(event.errorDescription || "Failed to load page");
      syncFromWebview();
    };

    node.addEventListener("did-start-loading", handleStart);
    node.addEventListener("did-stop-loading", handleStop);
    node.addEventListener("did-navigate", handleNavigate);
    node.addEventListener("did-navigate-in-page", handleNavigate);
    node.addEventListener("page-title-updated", handleTitle);
    node.addEventListener("page-favicon-updated", handleFavicon as EventListener);
    node.addEventListener("did-fail-load", handleFail as EventListener);
    return () => {
      node.removeEventListener("did-start-loading", handleStart);
      node.removeEventListener("did-stop-loading", handleStop);
      node.removeEventListener("did-navigate", handleNavigate);
      node.removeEventListener("did-navigate-in-page", handleNavigate);
      node.removeEventListener("page-title-updated", handleTitle);
      node.removeEventListener("page-favicon-updated", handleFavicon as EventListener);
      node.removeEventListener("did-fail-load", handleFail as EventListener);
    };
  }, [syncFromWebview, tab?.id, updateTabFavicon]);

  const handleScreenshot = useCallback(async () => {
    const node = webviewRef.current;
    if (!node) return;
    setStatus("Capturing screenshot...");
    setError(null);
    try {
      const image = await node.capturePage();
      dispatchBrowserScreenshot(image.toDataURL(), url, title);
      setStatus("Screenshot added to input");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Screenshot failed");
      setStatus(null);
    }
  }, [title, url]);

  const handlePickElement = useCallback(async () => {
    const node = webviewRef.current;
    if (!node || picking) return;
    setPicking(true);
    setStatus("Click an element in the page, or press Esc");
    setError(null);
    try {
      const snapshot = await node.executeJavaScript<BrowserElementSnapshot | null>(elementPickerScript(), true);
      if (snapshot) {
        window.dispatchEvent(new CustomEvent("browser-add-to-input", {
          detail: {
            reference: {
              kind: "element",
              label: snapshot.label || "Element",
              title: title || labelFromUrl(url),
              url,
              content: formatElementPrompt(snapshot, url, title),
            },
          },
        }));
        setStatus("Element reference added to input");
      } else {
        setStatus("Element picking cancelled");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Element picking failed");
      setStatus(null);
    } finally {
      setPicking(false);
    }
  }, [picking, title, url]);

  return (
    <div className="browser-panel">
      <form
        className="browser-panel-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          navigate(addressValue);
        }}
      >
        <button type="button" className="browser-panel-icon-btn" onClick={() => webviewRef.current?.goBack()} disabled={!canGoBack} title="Back">
          <ArrowLeft size={14} />
        </button>
        <button type="button" className="browser-panel-icon-btn" onClick={() => webviewRef.current?.goForward()} disabled={!canGoForward} title="Forward">
          <ArrowRight size={14} />
        </button>
        <button type="button" className="browser-panel-icon-btn" onClick={() => webviewRef.current?.reload()} title="Reload">
          <ArrowsClockwise size={14} className={loading ? "animate-spin" : ""} />
        </button>
        <label className="browser-panel-address">
          <Globe size={13} />
          <input
            value={addressValue}
            onChange={(event) => setAddressValue(event.target.value)}
            placeholder="localhost:3000, https://..., or E:\\page.html"
            spellCheck={false}
          />
        </label>
        <button
          type="button"
          className={`browser-panel-icon-btn${picking ? " active" : ""}`}
          onClick={handlePickElement}
          disabled={loading || picking}
          title="Pick element"
        >
          <CursorClick size={14} />
        </button>
        <button
          type="button"
          className="browser-panel-icon-btn"
          onClick={handleScreenshot}
          disabled={loading}
          title="Screenshot to input"
        >
          <Camera size={14} />
        </button>
        <BrowserBackendToggle />
      </form>

      {(status || error) && (
        <div className={`browser-panel-status${error ? " error" : ""}`}>
          {error ? <WarningCircle size={13} /> : <span className="browser-panel-status-dot" />}
          <span>{error || status}</span>
        </div>
      )}

      <div className="browser-panel-frame" data-loading={loading ? "true" : undefined}>
        <webview
          ref={(node) => {
            webviewRef.current = node as WebviewElement | null;
          }}
          src={initialUrl}
          partition={BROWSER_PARTITION}
        />
      </div>
    </div>
  );
}
