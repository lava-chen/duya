"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { useConversationStore } from "@/stores/conversation-store";
import { PluginAppHost } from "./PluginAppHost";

interface PluginAppLauncherProps {
  pluginId: string;
  apps: ReadonlyArray<{ appId: string; entry: string }>;
  /** Shown when no chat session is selected — the App needs a running one to bind. */
  emptyHint?: string;
}

/**
 * Entry point for one plugin's Apps.
 *
 * The App is hosted as an external mini app: it runs in a sandboxed
 * webview and reaches the agent only through the session this launcher
 * asks the Main process to mint.
 */
export function PluginAppLauncher({ pluginId, apps, emptyHint }: PluginAppLauncherProps) {
  const [openAppId, setOpenAppId] = useState<string | null>(null);
  const activeThreadId = useConversationStore((state) => state.activeThreadId);

  if (apps.length === 0) return null;

  const open = apps.find((app) => app.appId === openAppId);

  return (
    <div className="mt-2 space-y-2 pl-11">
      <div className="flex flex-wrap items-center gap-2">
        {apps.map((app) => (
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

      {open ? (
        activeThreadId ? (
          <PluginAppHost pluginId={pluginId} appId={open.appId} chatSessionId={activeThreadId} />
        ) : (
          <div className="plugin-app-host-error" role="alert">
            {emptyHint ?? "Select a chat session before opening an App."}
          </div>
        )
      ) : null}
    </div>
  );
}
