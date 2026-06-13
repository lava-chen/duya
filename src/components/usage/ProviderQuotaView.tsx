"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeftIcon, ArrowsClockwiseIcon, ChartBarIcon } from "@/components/icons";
import { useTranslation } from "@/hooks/useTranslation";
import { listProvidersIPC } from "@/lib/ipc-client";
import type { Provider as IpccProvider } from "@/lib/ipc-client";
import { isQuotaSupported } from "@/lib/providers/canCheckQuota";
import { ProviderQuotaCard, type ProviderQuotaState } from "./ProviderQuotaCard";

interface ProviderQuotaViewProps {
  onBack: () => void;
}

interface UnmaskedConfig {
  apiKey: string;
  baseUrl?: string;
  model: string;
  provider: string;
  authStyle: string;
}

/**
 * Fetch the unmasked API key for a given provider via the dedicated IPC channel.
 * The list-providers endpoint returns masked keys; only this channel returns the
 * real one. Provider model is not used by the quota API — pass empty string.
 */
async function fetchUnmaskedApiKey(providerId: string): Promise<string | null> {
  try {
    const electronApi = window.electronAPI as unknown as Record<string, unknown> | undefined;
    const providerApi = electronApi?.provider as
      | { getConfig: (id: string, model: string) => Promise<UnmaskedConfig | null> }
      | undefined;
    if (!providerApi?.getConfig) {
      return null;
    }
    const config = await providerApi.getConfig(providerId, "");
    return config?.apiKey ?? null;
  } catch {
    return null;
  }
}

export const ProviderQuotaView: React.FC<ProviderQuotaViewProps> = ({ onBack }) => {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<IpccProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [quotaStates, setQuotaStates] = useState<Record<string, ProviderQuotaState>>({});
  const [refreshing, setRefreshing] = useState(false);

  // Filter to providers whose providerType/baseUrl maps to a supported quota API
  const supportedProviders = useMemo(
    () => providers.filter((p) => isQuotaSupported(p.providerType, p.baseUrl) && p.hasApiKey),
    [providers]
  );

  const loadProviders = useCallback(async () => {
    try {
      setLoading(true);
      const list = await listProvidersIPC();
      setProviders(list);
    } catch (err) {
      console.warn("[ProviderQuotaView] Failed to load providers:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProviders();
  }, [loadProviders]);

  const fetchQuota = useCallback(async (provider: IpccProvider) => {
    setQuotaStates((prev) => ({
      ...prev,
      [provider.id]: {
        providerId: provider.id,
        providerName: provider.name,
        providerType: provider.providerType,
        baseUrl: provider.baseUrl,
        hasApiKey: provider.hasApiKey,
        status: "loading",
      },
    }));

    try {
      // Resolve the unmasked API key for this specific provider.
      // The list endpoint returns masked keys (***), which the quota API rejects.
      const apiKey = await fetchUnmaskedApiKey(provider.id);
      if (!apiKey) {
        setQuotaStates((prev) => ({
          ...prev,
          [provider.id]: {
            providerId: provider.id,
            providerName: provider.name,
            providerType: provider.providerType,
            baseUrl: provider.baseUrl,
            hasApiKey: provider.hasApiKey,
            status: "error",
            message: t("usage.quotaNoApiKey"),
          },
        }));
        return;
      }

      const result = await window.electronAPI.net.getProviderUsage({
        provider_type: provider.providerType,
        base_url: provider.baseUrl,
        api_key: apiKey,
      });

      if (result.success) {
        setQuotaStates((prev) => ({
          ...prev,
          [provider.id]: {
            providerId: provider.id,
            providerName: provider.name,
            providerType: provider.providerType,
            baseUrl: provider.baseUrl,
            hasApiKey: provider.hasApiKey,
            status: "success",
            plan: result.plan,
            quotas: result.quotas,
            message: result.message,
          },
        }));
      } else {
        setQuotaStates((prev) => ({
          ...prev,
          [provider.id]: {
            providerId: provider.id,
            providerName: provider.name,
            providerType: provider.providerType,
            baseUrl: provider.baseUrl,
            hasApiKey: provider.hasApiKey,
            status: "error",
            message: result.error?.message || result.message || t("usage.quotaError"),
          },
        }));
      }
    } catch (err) {
      setQuotaStates((prev) => ({
        ...prev,
        [provider.id]: {
          providerId: provider.id,
          providerName: provider.name,
          providerType: provider.providerType,
          baseUrl: provider.baseUrl,
          hasApiKey: provider.hasApiKey,
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        },
      }));
    }
  }, [t]);

  // Auto-fetch on mount once providers are loaded
  useEffect(() => {
    if (loading) return;
    if (supportedProviders.length === 0) return;
    supportedProviders.forEach((p) => {
      if (!quotaStates[p.id]) {
        void fetchQuota(p);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, supportedProviders.length]);

  const handleRefresh = useCallback(async () => {
    if (supportedProviders.length === 0) return;
    setRefreshing(true);
    setQuotaStates({});
    await Promise.all(supportedProviders.map((p) => fetchQuota(p)));
    setRefreshing(false);
  }, [supportedProviders, fetchQuota]);

  const orderedStates = useMemo(
    () =>
      supportedProviders
        .map((p) => quotaStates[p.id])
        .filter((s): s is ProviderQuotaState => Boolean(s)),
    [supportedProviders, quotaStates]
  );

  return (
    <div className="w-full max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[var(--border)] text-xs font-medium text-[var(--muted)] hover:text-[var(--text)] hover:border-[var(--accent-soft)] transition-all"
          >
            <ArrowLeftIcon size={14} />
            {t("usage.backToUsage")}
          </button>
          <div>
            <h2 className="text-xl font-bold text-[var(--text)] font-[family-name:--font-copernicus]">
              {t("usage.providerQuotaTitle")}
            </h2>
            <p className="text-sm text-[var(--muted)]">{t("usage.providerQuotaSubtitle")}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing || supportedProviders.length === 0}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[var(--border)] text-xs font-medium text-[var(--muted)] hover:text-[var(--text)] hover:border-[var(--accent-soft)] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <ArrowsClockwiseIcon size={14} className={refreshing ? "animate-spin" : ""} />
          {refreshing ? t("usage.refreshing") : t("usage.refresh")}
        </button>
      </div>

      {/* Content */}
      {loading ? (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)]/40 p-12 text-center text-sm text-[var(--muted)]">
          {t("usage.loadingProviders")}
        </div>
      ) : supportedProviders.length === 0 ? (
        <div className="rounded-xl border border-[var(--border)] bg-gradient-to-b from-[var(--surface)] to-[var(--bg-canvas)] p-12 text-center">
          <div className="w-16 h-16 rounded-full bg-[var(--surface)] flex items-center justify-center mx-auto mb-4">
            <ChartBarIcon size={28} className="text-[var(--muted)]" />
          </div>
          <h3 className="text-lg font-semibold text-[var(--text)] mb-2">
            {t("usage.noQuotaProviders")}
          </h3>
          <p className="text-sm text-[var(--muted)] max-w-md mx-auto">
            {t("usage.noQuotaProvidersDesc")}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {orderedStates.map((state) => (
              <ProviderQuotaCard
                key={state.providerId}
                state={state}
                onRetry={() => {
                  const p = supportedProviders.find((sp) => sp.id === state.providerId);
                  if (p) void fetchQuota(p);
                }}
              />
            ))}
          </div>

          <div className="text-[11px] text-[var(--muted)] text-center pt-2">
            {t("usage.supportedProvidersList")}
          </div>
        </div>
      )}
    </div>
  );
};
