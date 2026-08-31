"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { useTranslation } from "@/hooks/useTranslation";
import { cn } from "@/lib/utils";
import { ConnectorIcon } from "./connector-icons";
import { getAppConnectionAPI } from "@/lib/app-connection-ipc";
import type {
  AppConnectionProviderDTO,
  AppConnectionStatusDTO,
  ProviderId,
} from "@/lib/app-connection-ipc";

interface ConnectionsSubPageProps {
  connections: AppConnectionStatusDTO[];
  providers: AppConnectionProviderDTO[];
  busyProvider: ProviderId | null;
  searchQuery: string;
  onConnect: (provider: AppConnectionProviderDTO) => void;
  onDisconnect: (connectionId: string) => void;
  onConfigure: (provider: AppConnectionProviderDTO) => void;
}

function StatusPill({ status }: { status: string }) {
  const { t } = useTranslation();
  const colors: Record<string, string> = {
    connected: "bg-emerald-500/10 text-emerald-600",
    pending: "bg-blue-500/10 text-blue-600",
    expired: "bg-amber-500/10 text-amber-600",
    revoked: "bg-red-500/10 text-red-600",
    error: "bg-red-500/10 text-red-600",
    disconnected: "bg-muted text-muted-foreground",
    notConfigured: "bg-amber-500/10 text-amber-600",
  };
  return (
    <span
      className={cn(
        "inline-flex rounded-md px-2 py-0.5 text-xs font-medium",
        colors[status] ?? colors.disconnected
      )}
    >
      {t(`extensions.status.${status}` as never, { defaultValue: status })}
    </span>
  );
}

/**
 * Global "Always Allow" management (Plan 449). Lists every provider:tool
 * approval persisted by the permission card's Always Allow button and lets
 * the user revoke it; revocation refreshes worker descriptors so the gate
 * asks again on the next call.
 */
function ApprovedToolsSection() {
  const { t } = useTranslation();
  const [approvals, setApprovals] = useState<string[]>([]);
  const [revoking, setRevoking] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const api = getAppConnectionAPI();
    if (!api) return;
    try {
      const res = await api.listToolApprovals();
      setApprovals(res.data ?? []);
    } catch {
      // Leave the previous list in place on transient failures.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const grouped = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const key of approvals) {
      const idx = key.indexOf(":");
      if (idx <= 0) continue;
      const provider = key.slice(0, idx);
      const tool = key.slice(idx + 1);
      const list = map.get(provider) ?? [];
      list.push(tool);
      map.set(provider, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [approvals]);

  if (grouped.length === 0) return null;

  const revoke = async (provider: string, tool: string) => {
    setRevoking(`${provider}:${tool}`);
    try {
      const api = getAppConnectionAPI();
      if (api) await api.revokeToolApproval(provider, tool);
      await refresh();
    } catch {
      // Keep the row; the user can retry.
    } finally {
      setRevoking(null);
    }
  };

  return (
    <div className="mt-4 rounded-lg border border-border/40 bg-[var(--surface)] overflow-hidden">
      <div className="px-4 py-2 text-xs font-medium text-muted-foreground border-b border-border/30">
        {t("extensions.approvals.title")}
        <span className="ml-2 font-normal">{t("extensions.approvals.hint")}</span>
      </div>
      {grouped.map(([provider, tools]) => (
        <div key={provider} className="px-4 py-3 border-b border-border/20 last:border-b-0">
          <div className="flex items-center gap-2 mb-2">
            <ConnectorIcon provider={provider as ProviderId} size={16} />
            <span className="text-sm font-medium text-foreground">{provider}</span>
          </div>
          <div className="flex flex-col gap-1 pl-6">
            {tools.sort().map((tool) => {
              const key = `${provider}:${tool}`;
              return (
                <div key={tool} className="flex items-center justify-between gap-3">
                  <code className="text-xs text-muted-foreground truncate">{tool}</code>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={revoking === key}
                    onClick={() => void revoke(provider, tool)}
                  >
                    {t("extensions.approvals.revoke")}
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

export function ConnectionsSubPage({
  connections,
  providers,
  busyProvider,
  searchQuery,
  onConnect,
  onDisconnect,
  onConfigure,
}: ConnectionsSubPageProps) {
  const { t } = useTranslation();

  const connectionByProvider = useMemo(() => {
    const map = new Map<ProviderId, AppConnectionStatusDTO>();
    for (const c of connections) map.set(c.provider, c);
    return map;
  }, [connections]);

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return providers;
    const q = searchQuery.toLowerCase();
    return providers.filter((p) => p.label.toLowerCase().includes(q));
  }, [providers, searchQuery]);

  if (filtered.length === 0) {
    return (
      <div className="rounded-xl border border-border/40 bg-[var(--surface)] px-4 py-12 text-center">
        <p className="text-sm text-muted-foreground">
          {t("extensions.empty.connections")}
        </p>
      </div>
    );
  }

  return (
    <div>
    <div className="rounded-lg border border-border/40 bg-[var(--surface)] overflow-hidden">
      {/* Header */}
      <div
        className="grid items-center gap-4 px-4 py-2 text-xs font-medium text-muted-foreground border-b border-border/30"
        style={{ gridTemplateColumns: "1.5fr 120px 1fr 120px" }}
      >
        <div>{t("extensions.connections.table.app")}</div>
        <div>{t("extensions.connections.table.status")}</div>
        <div>{t("extensions.connections.table.account")}</div>
        <div className="text-right">{t("extensions.table.actions")}</div>
      </div>

      {/* Rows */}
      {filtered.map((provider) => {
        const conn = connectionByProvider.get(provider.id);
        const isConnected = conn?.status === "connected";

        let statusKey = "disconnected";
        if (!provider.configured) statusKey = "notConfigured";
        else if (conn) statusKey = conn.status;

        return (
          <div
            key={provider.id}
            className={cn(
              "grid items-center gap-4 px-4 py-3 text-sm border-b border-border/20 transition-colors last:border-b-0",
              "hover:bg-[var(--surface-hover)]"
            )}
            style={{ gridTemplateColumns: "1.5fr 120px 1fr 120px" }}
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-solid)]">
                <ConnectorIcon
                  provider={provider.id}
                  size={18}
                  monogram={provider.monogram}
                  label={provider.label}
                />
              </span>
              <span className="font-medium text-foreground truncate">{provider.label}</span>
            </div>
            <div>
              <StatusPill status={statusKey} />
            </div>
            <div className="truncate text-muted-foreground text-xs">
              {conn?.accountLabel || conn?.accountId || "—"}
            </div>
            <div className="flex justify-end">
              {!provider.configured && provider.supportsManualConfiguration ? (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={busyProvider === provider.id}
                  onClick={() => onConfigure(provider)}
                >
                  {t("marketplace.connectors.configure")}
                </Button>
              ) : isConnected ? (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busyProvider === provider.id}
                  onClick={() => conn && onDisconnect(conn.id)}
                >
                  {t("marketplace.connectors.disconnect")}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!provider.configured || busyProvider === provider.id}
                  title={provider.configurationHint}
                  onClick={() => onConnect(provider)}
                >
                  {t("marketplace.connectors.connect")}
                </Button>
              )}
            </div>
          </div>
        );
      })}
    </div>
    <ApprovedToolsSection />
    </div>
  );
}
