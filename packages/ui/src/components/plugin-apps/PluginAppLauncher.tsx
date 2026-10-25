"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { useTranslation } from "@/hooks/useTranslation";
import { useConversationStore } from "@/stores/conversation-store";
import { useOptionalPanel } from "@/hooks/usePanel";

interface PluginAppLauncherProps {
  pluginId: string;
  apps: ReadonlyArray<{ appId: string; entry?: string; runtime?: 'agent-run' | 'standalone' }>;
}

/**
 * Entry point for one plugin's Apps.
 *
 * The App is hosted as an external mini app: it runs in an opaque-origin
 * sandboxed frame and reaches the agent only through the session this launcher
 * asks the Main process to mint. Launching opens the App as a side-panel page
 * — the panel is the App's only surface; nothing takes over the window.
 */
export function PluginAppLauncher({ pluginId, apps }: PluginAppLauncherProps) {
  const { t } = useTranslation();
  const panel = useOptionalPanel();
  const activeThreadId = useConversationStore((state) => state.activeThreadId);
  const [hint, setHint] = useState<string | null>(null);

  const staticApps = apps.filter((app) => app.entry !== undefined);
  if (staticApps.length === 0) return null;

  const open = (app: { appId: string; entry?: string; runtime?: 'agent-run' | 'standalone' }) => {
    // An agent-run App acts inside a chat session; a standalone App owns its
    // MCP runtime and needs none. Without a session the launch is refused
    // here instead of opening a panel that cannot bind.
    if (app.runtime !== 'standalone' && !activeThreadId) {
      setHint(t("apps.selectChat"));
      return;
    }
    setHint(null);
    panel?.openOrActivatePage("plugin-app", {
      pluginId,
      appId: app.appId,
      title: app.appId,
      availability: app.runtime === 'standalone' ? "always" : "session",
    });
  };

  return (
    <div className="mt-2 space-y-2 pl-11">
      <div className="flex flex-wrap items-center gap-2">
        {staticApps.map((app) => (
          <Button
            key={app.appId}
            variant="secondary"
            size="sm"
            onClick={() => open(app)}
          >
            {app.appId}
          </Button>
        ))}
      </div>
      {hint ? (
        <p className="plugin-app-host-error" role="alert">{hint}</p>
      ) : null}
    </div>
  );
}
