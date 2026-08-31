"use client";

// PluginInstallDialog — codex-style install flow (plan 455 follow-up,
// reference image 3): clicking an uninstalled marketplace plugin opens
// this dialog instead of a detail page.
//
// Sequencing (user decision: failure rolls back):
//   1. `plugin:install` materializes the plugin;
//   2. when the plugin declares an app connection with
//      `authPolicy: 'on_install'`, `appConnection:connect` runs the OAuth
//      loopback flow and BLOCKS until it resolves;
//   3. cancel / failure at any step after install → `plugin:remove`
//      rollback, so "installed" always means "usable".

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import {
  SpinnerGapIcon,
  XIcon,
  CheckIcon,
  ChatCircleIcon,
  LightningIcon,
  WrenchIcon,
  PlugIcon,
  ServerIcon,
  TerminalIcon,
} from "@/components/icons";
import { ConnectorIcon } from "./connector-icons";
import { useTranslation } from "@/hooks/useTranslation";
import { cn } from "@/lib/utils";
import { getPluginAPI } from "@/lib/plugin-ipc";
import { getAppConnectionAPI } from "@/lib/app-connection-ipc";
import { dispatchPrefillChatInput } from "@/lib/prefill-chat-input-event";
import type { PluginCatalogEntry, PluginCapabilityDisplay } from "@/lib/plugin-types";
import type {
  AppConnectionProviderDTO,
  ProviderId,
} from "@/lib/app-connection-ipc";

interface PluginInstallDialogProps {
  plugin: PluginCatalogEntry;
  providers: AppConnectionProviderDTO[];
  /** Called after a successful (install + optional connect) — refresh. */
  onSuccess: () => void;
  onClose: () => void;
}

type Phase = "idle" | "installing" | "connecting" | "error";

/** Display order for capability groups in the "What's included" list. */
const CAPABILITY_TYPE_ORDER: PluginCapabilityDisplay["type"][] = [
  "skill",
  "connector",
  "mcp",
  "tool",
  "cli",
];

export function PluginInstallDialog({
  plugin,
  providers,
  onSuccess,
  onClose,
}: PluginInstallDialogProps) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [bottomTab, setBottomTab] = useState<"examples" | "included">(
    "examples",
  );

  // App-connection gate: declared in `.app.json` (→ components.appConnections)
  // + catalog authentication policy. Only the first declared provider is
  // connected at install time (all current on_install plugins declare one).
  const appDeclarations = useMemo(() => {
    const m = plugin.manifest;
    return m?.schemaVersion === "duya.plugin.v2"
      ? (m.components?.appConnections ?? [])
      : [];
  }, [plugin]);
  const providerId = useMemo(
    () => (appDeclarations.length > 0 ? appDeclarations[0] : null),
    [appDeclarations]
  );
  const needsConnect = plugin.authPolicy === "on_install" && providerId !== null;
  const provider = useMemo(
    () => providers.find((p) => p.id === providerId) ?? null,
    [providers, providerId]
  );
  // Unknown provider id (custom declarative connector without a host
  // binding) → install without a connect step; the detail page can wire it
  // once the connector registry resolves it.
  const connectable = needsConnect && provider !== null;

  const usageExamples = useMemo(() => {
    if (plugin.usageExamples?.length) return plugin.usageExamples.slice(0, 3);
    return [];
  }, [plugin]);

  // Capabilities grouped by type, in the order we want to display them.
  // Falls back to v2 manifest `components` when the catalog did not populate
  // `capabilities` (some plugins only have names, not descriptions).
  const includedGroups = useMemo(() => {
    const fromCatalog = plugin.capabilities ?? [];
    const items: PluginCapabilityDisplay[] = fromCatalog.length
      ? fromCatalog
      : (() => {
          const m = plugin.manifest;
          if (!m) return [];
          const v2 =
            m.schemaVersion === "duya.plugin.v2" ? m.components : null;
          const list: PluginCapabilityDisplay[] = [];
          for (const name of v2?.skills ?? []) {
            list.push({ id: name, name, type: "skill", description: "", required: false, enabled: true });
          }
          for (const id of v2?.appConnections ?? []) {
            list.push({
              id,
              name: id,
              type: "connector",
              description: "",
              required: false,
              enabled: true,
            });
          }
          for (const name of v2?.mcpServers ?? []) {
            list.push({ id: name, name, type: "mcp", description: "", required: false, enabled: true });
          }
          // Map v1 `capabilities.tools` / `cli` if present.
          if (m.schemaVersion === "duya.plugin.v1") {
            for (const c of m.capabilities?.cli ?? []) {
              list.push({
                id: c.name,
                name: c.name,
                type: "cli",
                description: c.command,
                required: false,
                enabled: true,
              });
            }
          }
          return list;
        })();

    const groups = new Map<PluginCapabilityDisplay["type"], PluginCapabilityDisplay[]>();
    for (const cap of items) {
      const arr = groups.get(cap.type) ?? [];
      arr.push(cap);
      groups.set(cap.type, arr);
    }
    return CAPABILITY_TYPE_ORDER.filter((t) => groups.has(t)).map((t) => ({
      type: t,
      items: groups.get(t)!,
    }));
  }, [plugin]);

  const busy = phase === "installing" || phase === "connecting";

  async function rollbackInstall(pluginId: string): Promise<void> {
    const api = getPluginAPI();
    if (!api) return;
    await api.registry.remove({ pluginId, deleteData: true });
  }

  async function handleConfirm(): Promise<void> {
    const pluginApi = getPluginAPI();
    const connectionApi = getAppConnectionAPI();
    if (!pluginApi || busy) return;

    setErrorMessage(null);

    // 1. Install.
    setPhase("installing");
    const installRes = await pluginApi.registry.install({
      pluginId: plugin.id,
      marketplace: plugin.marketplace,
    });
    if (!installRes.success) {
      setErrorMessage(installRes.error ?? t("marketplace.dialog.installFailed"));
      setPhase("error");
      return;
    }

    // 2. Connect (app-connection plugins with on_install policy).
    if (connectable && providerId && connectionApi) {
      setPhase("connecting");
      let connected = false;
      let connectError: string | undefined;
      try {
        // Declared connector ids are open-namespace strings (plan 455 D1);
        // the connect handler validates against the host catalog.
        const connRes = await connectionApi.connect({
          provider: providerId as ProviderId,
        });
        connected = connRes.success;
        connectError = connRes.error;
      } catch (err) {
        connectError = err instanceof Error ? err.message : String(err);
      }
      if (!connected) {
        // 3. Rollback — install without a completed connection is not a
        // successful install (user decision, plan 455 follow-up).
        await rollbackInstall(plugin.id);
        setErrorMessage(
          connectError ?? t("marketplace.dialog.rollbackNotice")
        );
        setPhase("error");
        return;
      }
    }

    setPhase("idle");
    onSuccess();
    onClose();
  }

  if (!plugin) return null;

  const title = connectable
    ? t("marketplace.dialog.installConnectTitle", { name: plugin.name })
    : t("marketplace.dialog.installTitle", { name: plugin.name });
  const description = plugin.shortDescription || plugin.description;
  const primaryLabel = connectable
    ? t("marketplace.dialog.installConnectButton")
    : t("marketplace.dialog.installButton");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="relative w-full max-w-lg rounded-2xl bg-[var(--main-bg)] border border-border/50 shadow-xl p-6">
        <IconButton
          variant="ghost"
          size="sm"
          shape="square"
          aria-label={t("marketplace.close")}
          className="absolute right-4 top-4"
          disabled={busy}
          onClick={onClose}
        >
          <XIcon size={18} />
        </IconButton>

        {/* Icon cluster — duya agent mark → (connector mark → check) */}
        <div className="flex items-center justify-center gap-3 mb-4 mt-2">
          <div
            className="flex shrink-0 items-center justify-center rounded-[10px] overflow-hidden"
            style={{ width: 56, height: 56 }}
          >
            <img
              src="/icon.png"
              alt="DUYA"
              draggable={false}
              className="h-full w-full object-cover"
            />
          </div>
          {connectable && provider && (
            <>
              <span className="flex items-center gap-1 text-muted-foreground/50">
                <span className="h-1 w-1 rounded-full bg-current" />
                <span className="h-1 w-1 rounded-full bg-current" />
                <span className="h-1 w-1 rounded-full bg-current" />
              </span>
              <div className="relative">
                <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-[var(--surface-hover)]">
                  <ConnectorIcon
                    provider={provider.id}
                    size={32}
                    monogram={provider.monogram}
                    label={provider.label}
                  />
                </div>
                <span className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-white">
                  <CheckIcon size={12} />
                </span>
              </div>
            </>
          )}
        </div>

        <h2 className="text-center text-lg font-semibold text-foreground">{title}</h2>
        <p className="mt-2 text-center text-sm text-muted-foreground line-clamp-3">
          {description}
        </p>

        {connectable && provider && (
          <p className="mt-2 text-center text-xs text-muted-foreground/80">
            {t("marketplace.dialog.needsConnectHint", { provider: provider.label })}
          </p>
        )}

        <div className="mt-5 flex justify-center">
          <Button
            variant="primary"
            size="md"
            disabled={busy}
            onClick={() => void handleConfirm()}
            className="bg-black text-white hover:bg-black/85 dark:bg-foreground dark:text-background dark:hover:bg-foreground/85"
          >
            {busy ? (
              <SpinnerGapIcon size={14} className="animate-spin" />
            ) : (
              <PlugIcon size={14} />
            )}
            {phase === "installing"
              ? t("marketplace.dialog.installing")
              : phase === "connecting"
                ? t("marketplace.dialog.connecting")
                : primaryLabel}
          </Button>
        </div>

        {phase === "error" && errorMessage && (
          <p className="mt-3 text-center text-xs text-red-500 break-all">{errorMessage}</p>
        )}

        {(usageExamples.length > 0 || includedGroups.length > 0) && (
          <div className="mt-5">
            {/* Header + segmented control. When only one section has content
                we skip the tabs to keep the dialog compact. */}
            <div className="flex items-center justify-between gap-3 mb-2">
              {usageExamples.length > 0 && includedGroups.length > 0 ? (
                <div className="inline-flex rounded-lg border border-border/40 bg-[var(--surface)] p-0.5 text-[12px]">
                  <button
                    type="button"
                    className={cn(
                      "px-2.5 py-1 rounded-md transition-colors",
                      bottomTab === "examples"
                        ? "bg-[var(--main-bg)] text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    onClick={() => setBottomTab("examples")}
                  >
                    {t("marketplace.dialog.tabTryIt")}
                  </button>
                  <button
                    type="button"
                    className={cn(
                      "px-2.5 py-1 rounded-md transition-colors",
                      bottomTab === "included"
                        ? "bg-[var(--main-bg)] text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    onClick={() => setBottomTab("included")}
                  >
                    {t("marketplace.dialog.tabIncluded")}
                  </button>
                </div>
              ) : (
                <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                  {usageExamples.length > 0 ? (
                    <>
                      <ChatCircleIcon size={14} className="text-muted-foreground" />
                      {t("marketplace.dialog.tryThese")}
                    </>
                  ) : (
                    <>
                      <LightningIcon size={14} className="text-muted-foreground" />
                      {t("marketplace.dialog.included")}
                    </>
                  )}
                </p>
              )}
            </div>

            {/* Try-it examples */}
            {usageExamples.length > 0 &&
              (includedGroups.length > 0 ? bottomTab === "examples" : true) && (
                <div className="space-y-2">
                  {usageExamples.map((example) => (
                    <button
                      key={example.prompt}
                      type="button"
                      className="w-full flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-[var(--surface)] px-3.5 py-2.5 text-left text-sm text-foreground hover:border-border/60 transition-colors"
                      onClick={() => {
                        dispatchPrefillChatInput(example.prompt);
                        onClose();
                      }}
                    >
                      <span className="truncate">"{example.prompt}"</span>
                      <ChatCircleIcon size={14} className="shrink-0 text-muted-foreground" />
                    </button>
                  ))}
                </div>
              )}

            {/* What's included — grouped by capability type */}
            {includedGroups.length > 0 &&
              (usageExamples.length > 0 ? bottomTab === "included" : true) && (
                <div className="space-y-3">
                  {includedGroups.map((group) => (
                    <div key={group.type}>
                      <p className="flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground mb-1.5">
                        <CapabilityTypeIcon type={group.type} size={12} />
                        {t(`marketplace.dialog.capabilityType.${group.type}`)}
                      </p>
                      <ul className="space-y-1.5">
                        {group.items.map((cap) => (
                          <li
                            key={cap.id}
                            className="rounded-lg border border-border/40 bg-[var(--surface)] px-3 py-2"
                          >
                            <div className="text-[13px] font-medium text-foreground">
                              {cap.name}
                            </div>
                            {cap.description && (
                              <p className="mt-0.5 text-[12px] text-muted-foreground line-clamp-2">
                                {cap.description}
                              </p>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                  {includedGroups.every((g) => g.items.every((i) => !i.description)) && (
                    <p className="text-[11px] text-muted-foreground/70">
                      {t("marketplace.dialog.includedEmpty")}
                    </p>
                  )}
                </div>
              )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Small inline icon next to a capability group header. */
function CapabilityTypeIcon({
  type,
  size = 12,
}: {
  type: PluginCapabilityDisplay["type"];
  size?: number;
}) {
  const cls = "text-muted-foreground";
  if (type === "skill") return <LightningIcon size={size} className={cls} />;
  if (type === "connector") return <PlugIcon size={size} className={cls} />;
  if (type === "mcp") return <ServerIcon size={size} className={cls} />;
  if (type === "tool") return <WrenchIcon size={size} className={cls} />;
  if (type === "cli") return <TerminalIcon size={size} className={cls} />;
  return null;
}
