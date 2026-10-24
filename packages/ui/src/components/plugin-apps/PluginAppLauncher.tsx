"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/Button";
import { useConversationStore } from "@/stores/conversation-store";
import { PluginAppHost } from "./PluginAppHost";

interface PluginAppLauncherProps {
  pluginId: string;
  apps: ReadonlyArray<{ appId: string; entry?: string; runtime?: 'agent-run' | 'standalone' }>;
  /** Shown when no chat session is selected — the App needs a running one to bind. */
  emptyHint?: string;
}

/**
 * Entry point for one plugin's Apps.
 *
 * The App is hosted as an external mini app: it runs in an opaque-origin
 * sandboxed frame and reaches the agent only through the session this launcher
 * asks the Main process to mint.
 */
export function PluginAppLauncher({ pluginId, apps, emptyHint }: PluginAppLauncherProps) {
  const [openAppId, setOpenAppId] = useState<string | null>(null);
  const activeThreadId = useConversationStore((state) => state.activeThreadId);

  useEffect(() => {
    if (!openAppId) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenAppId(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [openAppId]);

  const staticApps = apps.filter((app) => app.entry !== undefined);
  if (staticApps.length === 0) return null;

  const open = staticApps.find((app) => app.appId === openAppId);

  return (
    <div className="mt-2 space-y-2 pl-11">
      <div className="flex flex-wrap items-center gap-2">
        {staticApps.map((app) => (
          <Button
            key={app.appId}
            variant="secondary"
            size="sm"
            onClick={() => setOpenAppId(app.appId === openAppId ? null : app.appId)}
          >
            {app.appId}
          </Button>
        ))}
      </div>

      {open ? createPortal(
        <div className="plugin-app-overlay" role="dialog" aria-modal="true" aria-label={open.appId}>
          <div className="plugin-app-overlay-bar">
            <span>{open.appId}</span>
            <Button variant="secondary" size="sm" onClick={() => setOpenAppId(null)}>Close</Button>
          </div>
          {open.runtime === 'standalone' || activeThreadId ? (
            <PluginAppHost pluginId={pluginId} appId={open.appId} chatSessionId={open.runtime === 'standalone' ? undefined : activeThreadId ?? undefined} />
          ) : (
            <div className="plugin-app-host-error" role="alert">
              {emptyHint ?? "Select a chat session before opening an App."}
            </div>
          )}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
