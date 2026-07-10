"use client";

import React, { useCallback, useMemo } from "react";
import { motion } from "framer-motion";
import { PlugIcon, MonitorIcon } from "@/components/icons";
import { useSettings } from "@/hooks/useSettings";
import { useBrowserExtension } from "@/hooks/useBrowserExtension";
import { useTranslation } from "@/hooks/useTranslation";

type BackendMode = "auto" | "extension" | "built-in";

/**
 * BrowserBackendToggle — segmented chip control for switching between
 * Chrome extension and built-in webview browser backend.
 *
 * Visual pattern matches AgentModeSelector (inline rounded chip group
 * with framer-motion sliding highlight).
 *
 * - "auto" mode is resolved to the effective backend for display:
 *   extension if connected, otherwise built-in. A small dot indicates
 *   the selection is auto-resolved rather than explicit.
 * - Clicking an option sets the explicit mode. To return to "auto",
 *   use Settings → Browser → Advanced.
 */
export function BrowserBackendToggle() {
  const { t } = useTranslation();
  const { settings, save, saving } = useSettings();
  const { isInstalled } = useBrowserExtension({ autoCheck: true, interval: 30000 });

  const mode: BackendMode = settings.browserBackendMode ?? "auto";

  // Resolve the effective backend for display when in auto mode
  const effectiveBackend = useMemo<"extension" | "built-in">(() => {
    if (mode === "extension") return "extension";
    if (mode === "built-in") return "built-in";
    // auto: extension wins if connected
    return isInstalled ? "extension" : "built-in";
  }, [mode, isInstalled]);

  const isAuto = mode === "auto";

  const handleSelect = useCallback(
    async (next: "extension" | "built-in") => {
      if (saving) return;
      if (next === "extension" && !isInstalled) return;
      // Persist to DB and broadcast to running agents in one go.
      await save({ browserBackendMode: next });
      // Live-update running agent processes without full re-init.
      window.electronAPI?.browserBackend?.updateMode(next).catch(() => {});
    },
    [save, saving, isInstalled],
  );

  const options: {
    id: "extension" | "built-in";
    label: string;
    icon: React.ElementType;
    disabled: boolean;
    title: string;
  }[] = [
    {
      id: "extension",
      label: t("browserBackend.extension"),
      icon: PlugIcon,
      disabled: !isInstalled || saving,
      title: isInstalled
        ? t("browserBackend.extensionTitle")
        : t("browserBackend.extensionOffline"),
    },
    {
      id: "built-in",
      label: t("browserBackend.builtin"),
      icon: MonitorIcon,
      disabled: saving,
      title: t("browserBackend.builtinTitle"),
    },
  ];

  return (
    <div
      className="browser-backend-toggle inline-flex items-center gap-0.5 rounded-lg p-0.5 shrink-0"
      style={{
        backgroundColor: "var(--surface)",
        border: "1px solid var(--border)",
      }}
      role="group"
      aria-label={t("browserBackend.label")}
    >
      {options.map((opt) => {
        const isActive = effectiveBackend === opt.id;
        const Icon = opt.icon;

        return (
          <button
            key={opt.id}
            type="button"
            disabled={opt.disabled}
            onClick={() => handleSelect(opt.id)}
            className="relative flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              color: isActive ? "var(--accent)" : "var(--muted)",
            }}
            title={opt.title}
          >
            {isActive && (
              <motion.div
                layoutId="browser-backend-active"
                className="absolute inset-0 rounded-md"
                style={{ backgroundColor: "var(--accent-soft)" }}
                transition={{ type: "spring", stiffness: 400, damping: 30 }}
              />
            )}
            <span className="relative z-10 flex items-center gap-1">
              <Icon size={11} weight={isActive ? "fill" : "regular"} />
              <span>{opt.label}</span>
              {isActive && isAuto && (
                <span
                  className="inline-block w-1 h-1 rounded-full"
                  style={{ backgroundColor: "var(--accent)" }}
                  title={t("browserBackend.autoIndicator")}
                />
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
