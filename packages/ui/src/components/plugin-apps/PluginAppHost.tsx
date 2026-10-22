"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  PLUGIN_APP_CHANNEL,
  getPluginAppAPI,
  parsePluginAppGuestRequest,
  toPluginAppHostMessage,
  type PluginAppLaunch,
} from "@/lib/plugin-app-ipc";
import "./plugin-app.css";

type WebviewElement = HTMLElement & {
  contentWindow: Window | null;
  getWebContentsId(): number;
};

interface PluginAppHostProps {
  pluginId: string;
  appId: string;
  /** The chat session the App acts in. Chosen by trusted code, not the App. */
  chatSessionId?: string;
  onError?: (message: string) => void;
}

/**
 * Host one externally hosted Plugin App.
 *
 * The App runs in a sandboxed webview: no preload, no `electronAPI`, no
 * direct channel to the Main process. It can only post a message to this
 * window, and a message is only accepted when it comes from this App's own
 * guest (`event.source` is that webview's `contentWindow`) — an object
 * identity check no other frame can forge.
 *
 * The host attaches the session handle and the freshness token itself, so
 * the App never learns the plugin, the App id, the instance or the chat
 * session it is acting for.
 */
export function PluginAppHost({ pluginId, appId, chatSessionId, onError }: PluginAppHostProps) {
  const [webviewNode, setWebviewNode] = useState<WebviewElement | null>(null);
  const [launch, setLaunch] = useState<PluginAppLaunch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const launchRef = useRef<PluginAppLaunch | null>(null);

  const setWebviewRef = useCallback((node: HTMLElement | null) => {
    setWebviewNode(node as WebviewElement | null);
  }, []);

  const reportError = useCallback(
    (message: string) => {
      setError(message);
      onError?.(message);
    },
    [onError],
  );

  // Launch the App. The Main process resolves the App's entry file inside
  // the installed package and mints the session; nothing here is trusted
  // input beyond the ids the host UI already knows.
  useEffect(() => {
    const api = getPluginAppAPI();
    if (!api) {
      reportError("Plugin Apps are not available in this client.");
      return;
    }
    let cancelled = false;
    void api
      .open({ pluginId, appId, chatSessionId })
      .then((result) => {
        if (cancelled) {
          if (result.sessionId) void api.close({ sessionId: result.sessionId });
          return;
        }
        if (!result.ok || !result.sessionId || !result.launchNonce || !result.entryUrl) {
          reportError(result.error ?? "Failed to launch the App.");
          return;
        }
        const next: PluginAppLaunch = {
          sessionId: result.sessionId,
          launchNonce: result.launchNonce,
          entryUrl: result.entryUrl,
        };
        launchRef.current = next;
        setLaunch(next);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        reportError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [pluginId, appId, chatSessionId, reportError, generation]);

  useEffect(() => {
    const api = getPluginAppAPI();
    return api?.onChanged(({ pluginId: changedId }) => {
      if (changedId !== pluginId) return;
      const current = launchRef.current;
      launchRef.current = null;
      if (current) void api.close({ sessionId: current.sessionId }).catch(() => {});
      setLaunch(null);
      setError(null);
      setGeneration((value) => value + 1);
    });
  }, [pluginId]);

  // Close the session when the host goes away, so the Host revokes the
  // binding the App minted.
  useEffect(() => {
    return () => {
      const current = launchRef.current;
      launchRef.current = null;
      if (!current) return;
      void getPluginAppAPI()?.close({ sessionId: current.sessionId }).catch(() => {});
    };
  }, []);

  // Relay guest messages into the Main process.
  useEffect(() => {
    if (!launch || !webviewNode) return;

    const blockNavigation = (event: Event) => {
      const targetUrl = (event as Event & { url?: string }).url;
      if (targetUrl !== launch.entryUrl) event.preventDefault();
    };
    const blockPopup = (event: Event) => event.preventDefault();
    webviewNode.addEventListener('will-navigate', blockNavigation);
    webviewNode.addEventListener('new-window', blockPopup);

    const handler = (event: MessageEvent) => {
      const guest = webviewNode.contentWindow;
      if (!guest || event.source !== guest) return;
      if (event.origin !== 'file://' && event.origin !== 'null') return;
      const request = parsePluginAppGuestRequest(event.data);
      if (!request) return;

      const api = getPluginAppAPI();
      if (!api) return;

      void api
        .call({
          sessionId: launch.sessionId,
          launchNonce: launch.launchNonce,
          message: toPluginAppHostMessage(request),
        })
        .then((result) => {
          guest.postMessage(
            {
              channel: PLUGIN_APP_CHANNEL,
              id: request.id,
              ok: result.ok,
              result: result.result,
              error: result.error,
            },
            "*",
          );
        })
        .catch(() => {
          guest.postMessage(
            { channel: PLUGIN_APP_CHANNEL, id: request.id, ok: false, error: "host_unavailable" },
            "*",
          );
        });
    };

    window.addEventListener("message", handler);
    return () => {
      window.removeEventListener("message", handler);
      webviewNode.removeEventListener('will-navigate', blockNavigation);
      webviewNode.removeEventListener('new-window', blockPopup);
    };
  }, [launch, webviewNode]);

  if (error) {
    return (
      <div className="plugin-app-host-error" role="alert">
        {error}
      </div>
    );
  }

  if (!launch) {
    return <div className="plugin-app-host-loading">Loading App…</div>;
  }

  return (
    <div className="plugin-app-host">
      <webview
        ref={setWebviewRef}
        src={launch.entryUrl}
        partition={`persist:duya-plugin-app-${pluginId}`}
      />
    </div>
  );
}
