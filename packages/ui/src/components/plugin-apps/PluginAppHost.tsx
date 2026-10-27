"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import { subscribeToStreamingEvents } from "@/lib/stream-session-manager";
import {
  isPluginAppGuestReady,
  pluginUiEventFromToolUse,
  type PluginAppUiEvent,
} from "@/lib/plugin-app-ui-events";
import {
  PLUGIN_APP_CHANNEL,
  getPluginAppAPI,
  getPluginAppDocumentToken,
  isPluginAppEntryUrl,
  parsePluginAppCallResult,
  parsePluginAppGuestRequest,
  toPluginAppHostMessage,
  type PluginAppHostThemeMessage,
  type PluginAppLaunch,
} from "@/lib/plugin-app-ipc";
import "./plugin-app.css";

interface PluginAppHostProps {
  pluginId: string;
  appId: string;
  surfaceId?: string;
  server?: string;
  title?: string;
  /** The chat session the App acts in. Chosen by trusted code, not the App. */
  chatSessionId?: string;
  onError?: (message: string) => void;
}

function launchErrorMessage(error: unknown, t: ReturnType<typeof useTranslation>["t"]): string {
  switch (error) {
    case "surface_not_found": return t("apps.surfaceNotFound");
    case "resource_unavailable": return t("apps.resourceUnavailable");
    case "resource_invalid": return t("apps.resourceInvalid");
    case "resource_too_large": return t("apps.resourceTooLarge");
    case "resource_mime_unsupported": return t("apps.resourceMimeUnsupported");
    case "resource_server_mismatch": return t("apps.resourceServerMismatch");
    case "plugin_disabled": return t("apps.pluginDisabled");
    case "plugin_not_found":
    case "app_not_found": return t("apps.appUnavailable");
    case "instance_unavailable": return t("apps.instanceUnavailable");
    default: return t("apps.launchFailed");
  }
}

/**
 * The theme duya is rendering with.
 *
 * `data-theme` on <html> is the source of truth at runtime (see
 * hooks/useTheme.ts), so the host reads it from there instead of keeping a
 * second copy of the setting.
 */
function readHostTheme(): "light" | "dark" {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

/**
 * Host one externally hosted Plugin App.
 *
 * The App runs in an opaque-origin sandboxed iframe: no preload, no
 * `electronAPI`, no direct channel to the Main process. The iframe keeps the
 * normal parent/postMessage contract expected by Plugin Apps. A message is
 * only accepted when it comes from this App's own frame
 * (`event.source === iframe.contentWindow`), has the opaque sandbox origin,
 * and carries the launch token from the served document URL. The token stops
 * a later remote navigation from reusing the frame's stable WindowProxy.
 *
 * The host attaches the session handle and the freshness token itself, so
 * the App never learns the plugin, the App id, the instance or the chat
 * session it is acting for.
 */
export function PluginAppHost({ pluginId, appId, surfaceId, server, title, chatSessionId, onError }: PluginAppHostProps) {
  const { t } = useTranslation();
  const translateRef = useRef(t);
  translateRef.current = t;
  const [guestFrame, setGuestFrame] = useState<HTMLIFrameElement | null>(null);
  const [launch, setLaunch] = useState<PluginAppLaunch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const launchRef = useRef<PluginAppLaunch | null>(null);
  const guestFrameRef = useRef<HTMLIFrameElement | null>(null);
  const guestReadyRef = useRef(false);
  const pendingHostEventsRef = useRef<Array<Omit<PluginAppUiEvent, "channel" | "type" | "documentToken">>>([]);

  const setGuestFrameRef = useCallback((node: HTMLIFrameElement | null) => {
    guestFrameRef.current = node;
    setGuestFrame(node);
  }, []);

  const postHostEvent = useCallback((event: Omit<PluginAppUiEvent, "channel" | "type" | "documentToken">) => {
    const launchNow = launchRef.current;
    const frame = guestFrameRef.current;
    if (!launchNow || !frame?.isConnected || !frame.contentWindow) return;
    if (!guestReadyRef.current) {
      pendingHostEventsRef.current.push(event);
      if (pendingHostEventsRef.current.length > 64) pendingHostEventsRef.current.shift();
      return;
    }
    frame.contentWindow.postMessage({
      channel: PLUGIN_APP_CHANNEL,
      type: "event",
      documentToken: launchNow.documentToken,
      ...event,
    } satisfies PluginAppUiEvent, "*");
  }, []);

  const reportError = useCallback(
    (message: string) => {
      setError(message);
      onError?.(message);
    },
    [onError],
  );

  /**
   * Tell the App which theme duya is rendering with.
   *
   * The App runs in an opaque-origin sandboxed iframe: it cannot read
   * duya's `data-theme` and cannot inherit duya's CSS variables, so a
   * plugin that ships its own token layer has no way to know which one to
   * use. The host pushes it instead.
   */
  const postTheme = useCallback(() => {
    const launchNow = launchRef.current;
    const frame = guestFrameRef.current;
    if (!launchNow || !frame?.isConnected || !frame.contentWindow) return;
    const message: PluginAppHostThemeMessage = {
      channel: PLUGIN_APP_CHANNEL,
      type: "theme",
      documentToken: launchNow.documentToken,
      theme: readHostTheme(),
    };
    frame.contentWindow.postMessage(message, "*");
  }, []);

  // Launch the App. The Main process resolves the App's entry file inside
  // the installed package and mints the session; nothing here is trusted
  // input beyond the ids the host UI already knows.
  useEffect(() => {
    const api = getPluginAppAPI();
    setLaunch(null);
    setError(null);
    guestReadyRef.current = false;
    pendingHostEventsRef.current = [];
    if (!api) {
      reportError(translateRef.current("apps.unavailable"));
      return;
    }
    let cancelled = false;
    let opened: PluginAppLaunch | null = null;
    void api
      .open({ pluginId, appId, chatSessionId, surfaceId })
      .then((result) => {
        if (cancelled) {
          if (result.sessionId) void api.close({ sessionId: result.sessionId }).catch(() => {});
          return;
        }
        const documentToken = typeof result.entryUrl === "string"
          ? getPluginAppDocumentToken(result.entryUrl)
          : null;
        if (
          !result.ok
          || typeof result.sessionId !== "string"
          || result.sessionId.length === 0
          || typeof result.launchNonce !== "string"
          || result.launchNonce.length === 0
          || !isPluginAppEntryUrl(result.entryUrl)
          || !documentToken
        ) {
          if (typeof result.sessionId === "string" && result.sessionId.length > 0) {
            void api.close({ sessionId: result.sessionId }).catch(() => {});
          }
          reportError(launchErrorMessage(result.error, translateRef.current));
          return;
        }
        const next: PluginAppLaunch = {
          sessionId: result.sessionId,
          launchNonce: result.launchNonce,
          entryUrl: result.entryUrl,
          documentToken,
        };
        opened = next;
        launchRef.current = next;
        setLaunch(next);
      })
      .catch(() => {
        if (cancelled) return;
        reportError(launchErrorMessage(undefined, translateRef.current));
      });
    return () => {
      cancelled = true;
      guestReadyRef.current = false;
      pendingHostEventsRef.current = [];
      if (opened && launchRef.current === opened) {
        launchRef.current = null;
        void api.close({ sessionId: opened.sessionId }).catch(() => {});
      }
    };
  }, [pluginId, appId, surfaceId, chatSessionId, reportError, generation]);

  useEffect(() => {
    if (!chatSessionId || !surfaceId || !server || !launch) return;
    let observedEventCount: number | undefined;
    return subscribeToStreamingEvents(chatSessionId, (events) => {
      if (observedEventCount === undefined) {
        observedEventCount = events.length;
        return;
      }

      // Tool-use rows can first arrive as `tool_use_started` and then be
      // replaced by the final arguments under the same id. Wait for the
      // matching result event, then read the latest row so partial input
      // cannot consume the event before it is complete.
      if (events.length < observedEventCount) {
        observedEventCount = events.length;
        return;
      }
      const newEvents = events.slice(observedEventCount);
      observedEventCount = events.length;
      for (const event of newEvents) {
        if (event.type !== "tool_result" || event.toolResult.is_error) continue;
        const toolUse = [...events].reverse().find((candidate) =>
          candidate.type === "tool_use" && candidate.toolUse.id === event.toolResult.tool_use_id,
        );
        if (!toolUse || toolUse.type !== "tool_use") continue;
        const uiEvent = pluginUiEventFromToolUse(toolUse.toolUse, { pluginId, server, surfaceId });
        if (uiEvent) postHostEvent(uiEvent);
      }
    });
  }, [chatSessionId, launch, pluginId, postHostEvent, server, surfaceId]);

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

  // Keep the App's theme in sync with duya's. The first push covers the App
  // that is already running; the observer covers every later switch.
  useEffect(() => {
    if (!launch || !guestFrame) return;
    postTheme();
    const observer = new MutationObserver(() => postTheme());
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, [launch, guestFrame, postTheme]);

  // Relay guest messages into the Main process. A sandbox without
  // `allow-same-origin` gives the App an opaque origin; that is why the host
  // checks both frame identity and the browser's `null` origin.
  useEffect(() => {
    if (!launch || !guestFrame) return;

    const handler = (event: MessageEvent) => {
      const guest = guestFrame.contentWindow;
      if (!guest || event.source !== guest) return;
      if (event.origin !== 'null') return;
      if (isPluginAppGuestReady(event.data, launch.documentToken)) {
        guestReadyRef.current = true;
        const pending = pendingHostEventsRef.current.splice(0);
        for (const hostEvent of pending) postHostEvent(hostEvent);
        return;
      }
      const request = parsePluginAppGuestRequest(event.data, launch.documentToken);
      if (!request) return;

      const api = getPluginAppAPI();
      if (!api) return;

      void api
        .call({
          sessionId: launch.sessionId,
          launchNonce: launch.launchNonce,
          message: toPluginAppHostMessage(request),
        })
        .then((rawResult: unknown) => {
          if (!guestFrame.isConnected || launchRef.current !== launch || guestFrame.contentWindow !== guest) return;
          const result = parsePluginAppCallResult(rawResult);
          guest.postMessage({
            channel: PLUGIN_APP_CHANNEL,
            id: request.id,
            ok: result?.ok ?? false,
            ...(result?.result !== undefined ? { result: result.result } : {}),
            ...(!result ? { error: "host_unavailable" } : result.error ? { error: result.error } : {}),
          }, "*");
        })
        .catch(() => {
          if (!guestFrame.isConnected || launchRef.current !== launch || guestFrame.contentWindow !== guest) return;
          guest.postMessage(
            { channel: PLUGIN_APP_CHANNEL, id: request.id, ok: false, error: "host_unavailable" },
            "*",
          );
        });
    };

    window.addEventListener("message", handler);
    return () => {
      window.removeEventListener("message", handler);
    };
  }, [launch, guestFrame, postHostEvent]);

  if (error) {
    return (
      <div className="plugin-app-host-error" role="alert">
        {error}
      </div>
    );
  }

  if (!launch) {
    return <div className="plugin-app-host-loading">{t("apps.loadingSurface")}</div>;
  }

  return (
    <div className="plugin-app-host">
      <iframe
        ref={setGuestFrameRef}
        src={launch.entryUrl}
        title={title ?? `${pluginId} app`}
        referrerPolicy="no-referrer"
        sandbox="allow-scripts allow-forms allow-downloads allow-popups"
        onLoad={() => {
          guestReadyRef.current = false;
          // The guest installs its theme listener while its module script
          // runs, which is before the load event — so the App is listening by
          // the time this push arrives.
          postTheme();
        }}
      />
    </div>
  );
}
