"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, ArrowsClockwise, Robot } from "@phosphor-icons/react";
import { BrowserBackendToggle } from "./BrowserBackendToggle";

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
  // Use state instead of a plain ref so the effect re-runs once the webview
  // element is actually mounted by React. A callback ref alone can leave the
  // effect running before the DOM node exists, causing us to miss `dom-ready`.
  const [webviewNode, setWebviewNode] = useState<WebviewElement | null>(null);
  const setWebviewRef = useCallback((node: HTMLElement | null) => {
    setWebviewNode(node as WebviewElement | null);
  }, []);
  const [url, setUrl] = useState("about:blank");
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [registrationError, setRegistrationError] = useState<string | null>(null);

  const syncFromWebview = useCallback((node: WebviewElement | null) => {
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
    const node = webviewNode;
    if (!node) return;

    let registered = false;

    const register = () => {
      if (registered) return;
      registered = true;
      try {
        const webContentsId = node.getWebContentsId();
        window.electronAPI.browserWebview
          .registerWebview(sessionId, webContentsId)
          .then((res: { ok?: boolean; error?: string }) => {
            if (res?.ok === false) {
              setRegistrationError(res.error ?? "Registration failed");
            } else {
              setRegistrationError(null);
            }
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            setRegistrationError(message);
          });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setRegistrationError(message);
      }
      syncFromWebview(node);
    };

    const handleDomReady = () => register();
    const handleNavigate = () => syncFromWebview(node);
    const handleTitle = () => syncFromWebview(node);

    node.addEventListener("dom-ready", handleDomReady as EventListener);
    node.addEventListener("did-navigate", handleNavigate as EventListener);
    node.addEventListener("did-navigate-in-page", handleNavigate as EventListener);
    node.addEventListener("page-title-updated", handleTitle as EventListener);

    // dom-ready may already have fired before React ran this effect, so try
    // to register immediately as well. getWebContentsId throws until the guest
    // process is ready; if it throws we wait for the event.
    try {
      if (node.getWebContentsId()) {
        register();
      }
    } catch {
      // Guest not ready yet — dom-ready handler will retry.
    }

    // Safety net: if the event was missed or never fires, poll for readiness
    // for a short window so the agent doesn't sit waiting on a 404 forever.
    const pollInterval = setInterval(() => {
      if (registered) {
        clearInterval(pollInterval);
        return;
      }
      try {
        if (node.getWebContentsId()) {
          register();
          clearInterval(pollInterval);
        }
      } catch {
        // Still not ready — keep waiting for dom-ready or next poll tick.
      }
    }, 250);

    return () => {
      clearInterval(pollInterval);
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
  }, [webviewNode, sessionId, syncFromWebview]);

  return (
    <div className="browser-panel">
      <div className="browser-panel-toolbar">
        <button
          type="button"
          className="browser-panel-icon-btn"
          onClick={() => webviewNode?.goBack()}
          disabled={!canGoBack}
          title="Back"
        >
          <ArrowLeft size={14} />
        </button>
        <button
          type="button"
          className="browser-panel-icon-btn"
          onClick={() => webviewNode?.goForward()}
          disabled={!canGoForward}
          title="Forward"
        >
          <ArrowRight size={14} />
        </button>
        <button
          type="button"
          className="browser-panel-icon-btn"
          onClick={() => webviewNode?.reload()}
          title="Reload"
        >
          <ArrowsClockwise size={14} />
        </button>
        <label className="browser-panel-address">
          <Robot size={13} weight="fill" />
          <input value={url} readOnly placeholder="Agent browser" spellCheck={false} />
        </label>
        <BrowserBackendToggle />
      </div>

      {registrationError && (
        <div className="browser-panel-error">
          Agent browser registration failed: {registrationError}
        </div>
      )}
      <div className="browser-panel-frame">
        <webview
          ref={setWebviewRef}
          src="about:blank"
          partition={BROWSER_PARTITION}
        />
      </div>
    </div>
  );
}
