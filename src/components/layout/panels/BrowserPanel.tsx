"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowsClockwiseIcon,
  CameraIcon,
  CaretDownIcon,
  CaretUpIcon,
  CursorClickIcon,
  GlobeIcon,
  MagnifyingGlassIcon,
  StarIcon,
  WarningCircleIcon,
  XIcon,
} from "@/components/icons";
import { usePanel } from "@/hooks/usePanel";
import { useSettings } from "@/hooks/useSettings";
import { useTranslation } from "@/hooks/useTranslation";
import type { PageTab } from "./registry";
import { AgentBrowserTab } from "./AgentBrowserTab";
import { IconButton } from "@/components/ui/IconButton";
import { NewTabPage } from "@/components/browser/NewTabPage";
import { BrowserMenu } from "@/components/browser/BrowserMenu";
import {
  isFavorited,
  isRecordableUrl,
  recordVisit,
  toggleFavorite,
} from "@/lib/browser-newtab";

type WebviewElement = HTMLElement & {
  canGoBack(): boolean;
  canGoForward(): boolean;
  capturePage(): Promise<{ toDataURL(): string }>;
  executeJavaScript<T = unknown>(code: string, userGesture?: boolean): Promise<T>;
  findInPage(text: string, options?: { forward?: boolean; findNext?: boolean }): void;
  getTitle(): string;
  getURL(): string;
  goBack(): void;
  goForward(): void;
  loadURL(url: string): void | Promise<void>;
  reload(): void;
  setZoomLevel(level: number): void;
  stopFindInPage(action?: "clearSelection" | "keepSelection" | "activateSelection"): void;
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
const FALLBACK_HOME_URL = "https://www.google.com";
const BROWSER_PARTITION = "persist:duya-local-browser";

/** Zoom presets mirroring Chromium's menu steps. */
const ZOOM_STEPS = [0.3, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

function nearestZoomStepIndex(factor: number): number {
  let best = 0;
  for (let i = 1; i < ZOOM_STEPS.length; i++) {
    if (Math.abs(ZOOM_STEPS[i] - factor) < Math.abs(ZOOM_STEPS[best] - factor)) best = i;
  }
  return best;
}

/** Electron zoom levels are exponential: zoomFactor = 1.2 ^ zoomLevel. */
function zoomLevelForFactor(factor: number): number {
  return Math.log(factor) / Math.log(1.2);
}

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

  const { settings } = useSettings();
  const { t } = useTranslation();

  const initialUrl = useMemo(() => {
    const raw = tab?.params?.url;
    if (typeof raw === "string" && raw.trim()) {
      return normalizeBrowserAddress(raw);
    }
    const homeUrl = settings.browserHomeUrl?.trim();
    return homeUrl ? normalizeBrowserAddress(homeUrl) : FALLBACK_HOME_URL;
  }, [tab?.params, settings.browserHomeUrl]);

  // A tab opened without an explicit URL lands on the new-tab page
  // (favorites bar + history cards) instead of loading a search engine.
  const startsAsNewTab = !tab?.params?.url;
  const [pendingNewTab, setPendingNewTab] = useState(startsAsNewTab);
  const [currentSrc, setCurrentSrc] = useState<string | null>(
    startsAsNewTab ? null : initialUrl,
  );
  const [favorited, setFavorited] = useState(false);
  const [zoomDisplay, setZoomDisplay] = useState(100);
  const faviconRef = useRef<string | undefined>(undefined);

  const webviewRef = useRef<WebviewElement | null>(null);
  const [addressValue, setAddressValue] = useState(initialUrl);
  const [url, setUrl] = useState(initialUrl);
  const [title, setTitle] = useState(labelFromUrl(initialUrl));
  const [loading, setLoading] = useState(!startsAsNewTab);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [picking, setPicking] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Zoom + find-in-page. Zoom lives per panel instance and resets on remount.
  // <webview> guests swallow keyboard events, so Cmd/Ctrl shortcuts are
  // intercepted via the guest's before-input-event and, when focus sits in
  // the host UI (address bar etc.), via the panel's own onKeyDown.
  const zoomFactorRef = useRef(1);
  const [zoomPercent, setZoomPercent] = useState<number | null>(null);
  const zoomHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findMatches, setFindMatches] = useState<{ active: number; count: number } | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);

  const flashZoom = useCallback((factor: number) => {
    setZoomPercent(Math.round(factor * 100));
    if (zoomHideTimer.current) clearTimeout(zoomHideTimer.current);
    zoomHideTimer.current = setTimeout(() => setZoomPercent(null), 1500);
  }, []);

  useEffect(() => () => {
    if (zoomHideTimer.current) clearTimeout(zoomHideTimer.current);
  }, []);

  const applyZoomFactor = useCallback((factor: number) => {
    const clamped = Math.min(ZOOM_STEPS[ZOOM_STEPS.length - 1], Math.max(ZOOM_STEPS[0], factor));
    zoomFactorRef.current = clamped;
    try {
      webviewRef.current?.setZoomLevel(zoomLevelForFactor(clamped));
    } catch {
      // Webview can throw while it is being attached or torn down.
    }
    setZoomDisplay(Math.round(clamped * 100));
    flashZoom(clamped);
  }, [flashZoom]);

  const stepZoom = useCallback((direction: 1 | -1) => {
    const index = nearestZoomStepIndex(zoomFactorRef.current);
    const next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, index + direction))];
    applyZoomFactor(next);
  }, [applyZoomFactor]);

  const openFind = useCallback(() => {
    setFindOpen(true);
    setFindMatches(null);
    // Focus once the bar mounts; select any previous query for quick replace.
    setTimeout(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    }, 0);
  }, []);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindMatches(null);
    try {
      webviewRef.current?.stopFindInPage("clearSelection");
    } catch {
      // Webview can throw while it is being attached or torn down.
    }
  }, []);

  const runFind = useCallback((forward: boolean, findNext: boolean) => {
    const node = webviewRef.current;
    const query = findQuery.trim();
    if (!node || !query) return;
    try {
      node.findInPage(query, { forward, findNext });
    } catch {
      // Webview can throw while it is being attached or torn down.
    }
  }, [findQuery]);

  const handleFindInput = useCallback((value: string) => {
    setFindQuery(value);
    const node = webviewRef.current;
    const query = value.trim();
    if (!node) return;
    try {
      if (query) {
        node.findInPage(query, { forward: true, findNext: false });
      } else {
        node.stopFindInPage("clearSelection");
        setFindMatches(null);
      }
    } catch {
      // Webview can throw while it is being attached or torn down.
    }
  }, []);

  const handleBrowserShortcut = useCallback((key: string, mod: boolean): boolean => {
    if (!mod) return false;
    const normalized = key.toLowerCase();
    if (normalized === "f") {
      openFind();
      return true;
    }
    if (normalized === "=" || normalized === "+") {
      stepZoom(1);
      return true;
    }
    if (normalized === "-") {
      stepZoom(-1);
      return true;
    }
    if (normalized === "0") {
      applyZoomFactor(1);
      return true;
    }
    return false;
  }, [applyZoomFactor, openFind, stepZoom]);

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
      setFavorited(isRecordableUrl(nextUrl) ? isFavorited(nextUrl) : false);
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
    if (pendingNewTab) {
      // Leaving the new-tab page: the webview mounts with this src and
      // starts loading on attach.
      setCurrentSrc(nextUrl);
      setPendingNewTab(false);
      return;
    }
    webviewRef.current?.loadURL(nextUrl);
  }, [pendingNewTab]);

  const handleToggleFavorite = useCallback(() => {
    if (!isRecordableUrl(url)) return;
    const { favorited: next } = toggleFavorite({
      url,
      title: title || labelFromUrl(url),
      favicon: faviconRef.current,
    });
    setFavorited(next);
    setStatus(next ? "Added to favorites" : "Removed from favorites");
  }, [title, url]);

  const handleClearData = useCallback(async () => {
    if (!window.confirm(t('browserAdvanced.clearDataConfirm'))) return;
    try {
      await window.electronAPI?.browserCookie?.clearData();
      setStatus("Browser data cleared");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Clear failed");
    }
  }, [t]);

  const handleNewTabNavigate = useCallback((raw: string) => {
    navigate(raw);
  }, [navigate]);

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
      // Feed the new-tab page's history cards. The webview is the single
      // record point — main-frame loads only (in-page navigations are
      // filtered by isRecordableUrl + dedupe in the store).
      try {
        const visitUrl = node.getURL() || "";
        if (isRecordableUrl(visitUrl)) {
          recordVisit({
            url: visitUrl,
            title: node.getTitle() || labelFromUrl(visitUrl),
            favicon: faviconRef.current,
          });
        }
      } catch {
        // Webview can throw while it is being attached or torn down.
      }
    };
    const handleNavigate = (event: WebviewNavigationEvent) => {
      if (event.isMainFrame === false) return;
      syncFromWebview();
    };
    const handleTitle = () => syncFromWebview();
    const handleFavicon = (event: Event & { favicons?: string[] }) => {
      const favicons = (event as Event & { favicons?: string[] }).favicons;
      if (Array.isArray(favicons) && favicons.length > 0) {
        faviconRef.current = favicons[0];
        if (tab?.id) {
          updateTabFavicon(tab.id, favicons[0]);
        }
      }
    };
    const handleFail = (event: Event & { errorDescription?: string; validatedURL?: string }) => {
      setLoading(false);
      setError(event.errorDescription || "Failed to load page");
      syncFromWebview();
    };
    // Guest pages keep their own keyboard events; this is the only reliable
    // host-side hook for Cmd/Ctrl shortcuts typed while the page has focus.
    const handleBeforeInput = (event: Event) => {
      const detail = event as Event & {
        preventDefault(): void;
        input?: { type?: string; key?: string; controlKey?: boolean; metaKey?: boolean };
      };
      const input = detail.input;
      if (!input || input.type !== "keyDown") return;
      const consumed = handleBrowserShortcut(
        input.key || "",
        Boolean(input.controlKey || input.metaKey),
      );
      if (consumed) detail.preventDefault();
    };
    const handleFoundInPage = (event: Event) => {
      const result = (event as Event & {
        result?: { activeMatchOrdinal?: number; matches?: number };
      }).result;
      if (result) {
        setFindMatches({
          active: result.activeMatchOrdinal ?? 0,
          count: result.matches ?? 0,
        });
      }
    };

    node.addEventListener("did-start-loading", handleStart);
    node.addEventListener("did-stop-loading", handleStop);
    node.addEventListener("did-navigate", handleNavigate);
    node.addEventListener("did-navigate-in-page", handleNavigate);
    node.addEventListener("page-title-updated", handleTitle);
    node.addEventListener("page-favicon-updated", handleFavicon as EventListener);
    node.addEventListener("did-fail-load", handleFail as EventListener);
    node.addEventListener("before-input-event", handleBeforeInput as EventListener);
    node.addEventListener("found-in-page", handleFoundInPage as EventListener);
    return () => {
      node.removeEventListener("did-start-loading", handleStart);
      node.removeEventListener("did-stop-loading", handleStop);
      node.removeEventListener("did-navigate", handleNavigate);
      node.removeEventListener("did-navigate-in-page", handleNavigate);
      node.removeEventListener("page-title-updated", handleTitle);
      node.removeEventListener("page-favicon-updated", handleFavicon as EventListener);
      node.removeEventListener("did-fail-load", handleFail as EventListener);
      node.removeEventListener("before-input-event", handleBeforeInput as EventListener);
      node.removeEventListener("found-in-page", handleFoundInPage as EventListener);
    };
  }, [syncFromWebview, tab?.id, updateTabFavicon, handleBrowserShortcut, pendingNewTab]);

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
    <div
      className="browser-panel"
      onKeyDown={(event) => {
        if (event.key === "Escape" && findOpen) {
          event.preventDefault();
          closeFind();
          return;
        }
        if (handleBrowserShortcut(event.key, event.metaKey || event.ctrlKey)) {
          event.preventDefault();
        }
      }}
    >
      <form
        className="browser-panel-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          navigate(addressValue);
        }}
      >
        <BrowserMenu
          onFindInPage={openFind}
          onZoomIn={() => stepZoom(1)}
          onZoomOut={() => stepZoom(-1)}
          onZoomReset={() => applyZoomFactor(1)}
          onClearData={() => void handleClearData()}
          zoomPercent={zoomDisplay}
        />
        <div className="browser-nav-pill" role="group" aria-label="Page navigation">
          <button
            type="button"
            className="browser-nav-btn"
            aria-label="Back"
            onClick={() => webviewRef.current?.goBack()}
            disabled={!canGoBack || pendingNewTab}
            title="Back"
          >
            <ArrowLeftIcon size={14} />
          </button>
          <button
            type="button"
            className="browser-nav-btn"
            aria-label="Forward"
            onClick={() => webviewRef.current?.goForward()}
            disabled={!canGoForward || pendingNewTab}
            title="Forward"
          >
            <ArrowRightIcon size={14} />
          </button>
          <span className="browser-nav-divider" aria-hidden="true" />
          <button
            type="button"
            className="browser-nav-btn"
            aria-label="Reload"
            onClick={() => webviewRef.current?.reload()}
            disabled={pendingNewTab}
            title="Reload"
          >
            <ArrowsClockwiseIcon size={14} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
        <label className="browser-panel-address">
          <GlobeIcon size={13} />
          <input
            value={addressValue}
            onChange={(event) => setAddressValue(event.target.value)}
            placeholder="localhost:3000, https://..., or E:\\page.html"
            spellCheck={false}
          />
        </label>
        <IconButton
          type="button"
          variant="default"
          shape="square"
          className={`browser-panel-icon-btn${favorited ? " active" : ""}`}
          aria-label={favorited ? t('browserMenu.removeFavorite') : t('browserMenu.addFavorite')}
          onClick={handleToggleFavorite}
          disabled={pendingNewTab || !isRecordableUrl(url)}
          title={favorited ? t('browserMenu.removeFavorite') : t('browserMenu.addFavorite')}
        >
          <StarIcon size={14} />
        </IconButton>
        <IconButton
          type="button"
          variant="default"
          shape="square"
          className={`browser-panel-icon-btn${findOpen ? " active" : ""}`}
          aria-label="Find in page"
          onClick={openFind}
          disabled={pendingNewTab}
          title="Find in page (Cmd/Ctrl+F)"
        >
          <MagnifyingGlassIcon size={14} />
        </IconButton>
        <IconButton
          type="button"
          variant="default"
          shape="square"
          className={`browser-panel-icon-btn${picking ? " active" : ""}`}
          aria-label="Pick element"
          onClick={handlePickElement}
          disabled={loading || picking || pendingNewTab}
          title="Pick element"
        >
          <CursorClickIcon size={14} />
        </IconButton>
        <IconButton
          type="button"
          variant="default"
          shape="square"
          className="browser-panel-icon-btn"
          aria-label="Screenshot to input"
          onClick={handleScreenshot}
          disabled={loading || pendingNewTab}
          title="Screenshot to input"
        >
          <CameraIcon size={14} />
        </IconButton>
      </form>

      {(status || error) && (
        <div className={`browser-panel-status${error ? " error" : ""}`}>
          {error ? <WarningCircleIcon size={13} /> : <span className="browser-panel-status-dot" />}
          <span>{error || status}</span>
        </div>
      )}

      <div className="browser-panel-frame" data-loading={!pendingNewTab && loading ? "true" : undefined}>
        {pendingNewTab ? (
          <NewTabPage onNavigate={handleNewTabNavigate} />
        ) : (
          <webview
            ref={(node) => {
              webviewRef.current = node as WebviewElement | null;
            }}
            src={currentSrc ?? initialUrl}
            partition={BROWSER_PARTITION}
          />
        )}
        {findOpen && (
          <div className="browser-find-bar">
            <MagnifyingGlassIcon size={13} />
            <input
              ref={findInputRef}
              value={findQuery}
              onChange={(event) => handleFindInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  runFind(!event.shiftKey, true);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  closeFind();
                }
              }}
              placeholder="Find in page"
              spellCheck={false}
            />
            <span className="browser-find-count">
              {findQuery.trim() && findMatches ? `${findMatches.active}/${findMatches.count}` : ""}
            </span>
            <IconButton type="button" variant="default" shape="square" className="browser-panel-icon-btn" aria-label="Previous match" onClick={() => runFind(false, true)} title="Previous match">
              <CaretUpIcon size={12} />
            </IconButton>
            <IconButton type="button" variant="default" shape="square" className="browser-panel-icon-btn" aria-label="Next match" onClick={() => runFind(true, true)} title="Next match">
              <CaretDownIcon size={12} />
            </IconButton>
            <IconButton type="button" variant="default" shape="square" className="browser-panel-icon-btn" aria-label="Close find bar" onClick={closeFind} title="Close (Esc)">
              <XIcon size={12} />
            </IconButton>
          </div>
        )}
        {zoomPercent !== null && (
          <div className="browser-panel-zoom-chip">{zoomPercent}%</div>
        )}
      </div>
    </div>
  );
}
