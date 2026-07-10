"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ArrowsClockwise, Robot } from "@phosphor-icons/react";

type WebviewElement = HTMLElement & {
  canGoBack(): boolean;
  canGoForward(): boolean;
  getWebContentsId(): number;
  getTitle(): string;
  getURL(): string;
  goBack(): void;
  goForward(): void;
  loadURL(url: string): void | Promise<void>;
  reload(): void;
};

const BROWSER_PARTITION = "persist:duya-local-browser";

interface AgentBrowserTabProps {
  sessionId: string;
  onTitleChange?: (title: string) => void;
}

export function AgentBrowserTab({ sessionId, onTitleChange }: AgentBrowserTabProps) {
  const webviewRef = useRef<WebviewElement | null>(null);
  const [url, setUrl] = useState("about:blank");
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);

  const syncFromWebview = useCallback(() => {
    const node = webviewRef.current;
    if (!node) return;
    try {
      const nextUrl = node.getURL() || "about:blank";
      const nextTitle = node.getTitle() || "";
      setUrl(nextUrl);
      setCanGoBack(node.canGoBack());
      setCanGoForward(node.canGoForward());
      if (nextTitle) onTitleChange?.(nextTitle);
    } catch {
      // Webview can throw while it is being attached or torn down.
    }
  }, [onTitleChange]);

  useEffect(() => {
    const node = webviewRef.current;
    if (!node) return;

    let registered = false;

    const handleDomReady = () => {
      if (registered) return;
      registered = true;
      try {
        const webContentsId = node.getWebContentsId();
        window.electronAPI.browserWebview
          .registerWebview(sessionId, webContentsId)
          .catch(() => {});
      } catch {
        // getWebContentsId can throw if the guest isn't ready yet
      }
      syncFromWebview();
    };

    const handleNavigate = () => syncFromWebview();
    const handleTitle = () => syncFromWebview();

    node.addEventListener("dom-ready", handleDomReady as EventListener);
    node.addEventListener("did-navigate", handleNavigate as EventListener);
    node.addEventListener("did-navigate-in-page", handleNavigate as EventListener);
    node.addEventListener("page-title-updated", handleTitle as EventListener);

    return () => {
      node.removeEventListener("dom-ready", handleDomReady as EventListener);
      node.removeEventListener("did-navigate", handleNavigate as EventListener);
      node.removeEventListener("did-navigate-in-page", handleNavigate as EventListener);
      node.removeEventListener("page-title-updated", handleTitle as EventListener);

      if (registered) {
        window.electronAPI.browserWebview
          .unregisterWebview(sessionId)
          .catch(() => {});
      }
    };
  }, [sessionId, syncFromWebview]);

  return (
    <div className="browser-panel">
      <div className="browser-panel-toolbar">
        <button
          type="button"
          className="browser-panel-icon-btn"
          onClick={() => webviewRef.current?.goBack()}
          disabled={!canGoBack}
          title="Back"
        >
          <ArrowLeft size={14} />
        </button>
        <button
          type="button"
          className="browser-panel-icon-btn"
          onClick={() => webviewRef.current?.goForward()}
          disabled={!canGoForward}
          title="Forward"
        >
          <ArrowRight size={14} />
        </button>
        <button
          type="button"
          className="browser-panel-icon-btn"
          onClick={() => webviewRef.current?.reload()}
          title="Reload"
        >
          <ArrowsClockwise size={14} />
        </button>
        <label className="browser-panel-address">
          <Robot size={13} weight="fill" />
          <input value={url} readOnly placeholder="Agent browser" spellCheck={false} />
        </label>
      </div>

      <div className="browser-panel-frame">
        <webview
          ref={(node) => {
            webviewRef.current = node as WebviewElement | null;
          }}
          src="about:blank"
          partition={BROWSER_PARTITION}
        />
      </div>
    </div>
  );
}
