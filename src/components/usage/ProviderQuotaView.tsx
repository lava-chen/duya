"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeftIcon, ArrowsClockwiseIcon, ChartBarIcon } from "@/components/icons";
import { useTranslation } from "@/hooks/useTranslation";
import { listProvidersIPC } from "@/lib/ipc-client";
import type { Provider as IpccProvider } from "@/lib/ipc-client";
import { ProviderIcon } from "./ProviderIcon";
import { ProviderQuotaCard, type ProviderQuotaState } from "./ProviderQuotaCard";

interface ProviderQuotaViewProps {
  onBack: () => void;
}

/**
 * Detect whether a provider's baseUrl maps to a service with quota API support.
 * Mirrors the detection logic in electron/services/network/provider-usage.ts.
 */
function isQuotaSupported(baseUrl: string): boolean {
  const url = baseUrl.toLowerCase();
  return (
    url.includes("minimax.io") ||
    url.includes("minimaxi.com") ||
    url.includes("bigmodel.cn") ||
    url.includes("z.ai")
  );
}

export const ProviderQuotaView: React.FC<ProviderQuotaViewProps> = ({ onBack }) => {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<IpccProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [quotaStates, setQuotaStates] = useState<Record<string, ProviderQuotaState>>({});
  const [refreshing, setRefreshing] = useState(false);

  // Filter to providers whose baseUrl maps to a supported quota API
  const supportedProviders = useMemo(
    () => providers.filter((p) => p.baseUrl && isQuotaSupported(p.baseUrl) && p.hasApiKey),
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
      const result = await window.electronAPI.net.getProviderUsage({
        provider_type: provider.providerType,
        base_url: provider.baseUrl,
        api_key: provider.apiKey,
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
            message: result.error?.message || result.message || "查询失败",
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
  }, []);

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
            返回使用统计
          </button>
          <div>
            <h2 className="text-xl font-bold text-[var(--text)] font-[family-name:--font-copernicus]">
              服务商限额
            </h2>
            <p className="text-sm text-[var(--muted)]">查看已连接服务商的配额与重置时间</p>
          </div>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing || supportedProviders.length === 0}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[var(--border)] text-xs font-medium text-[var(--muted)] hover:text-[var(--text)] hover:border-[var(--accent-soft)] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <ArrowsClockwiseIcon size={14} className={refreshing ? "animate-spin" : ""} />
          {refreshing ? "刷新中…" : "刷新"}
        </button>
      </div>

      {/* Content */}
      {loading ? (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)]/40 p-12 text-center text-sm text-[var(--muted)]">
          正在加载服务商配置…
        </div>
      ) : supportedProviders.length === 0 ? (
        <div className="rounded-xl border border-[var(--border)] bg-gradient-to-b from-[var(--surface)] to-[var(--bg-canvas)] p-12 text-center">
          <div className="w-16 h-16 rounded-full bg-[var(--surface)] flex items-center justify-center mx-auto mb-4">
            <ChartBarIcon size={28} className="text-[var(--muted)]" />
          </div>
          <h3 className="text-lg font-semibold text-[var(--text)] mb-2">暂无可查询的服务商</h3>
          <p className="text-sm text-[var(--muted)] max-w-md mx-auto">
            当前已连接的服务商中没有可查询限额的（支持 MiniMax、GLM/Zhipu）。请在「服务商」中配置后再来查看。
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Provider list with brand icons */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {orderedStates.map((state) => (
              <div key={state.providerId} className="relative">
                <div className="absolute top-3 right-3 z-10">
                  <ProviderIcon
                    providerType={state.providerType}
                    baseUrl={state.baseUrl}
                    size={18}
                  />
                </div>
                <ProviderQuotaCard
                  state={state}
                  onRetry={() => {
                    const p = supportedProviders.find((sp) => sp.id === state.providerId);
                    if (p) void fetchQuota(p);
                  }}
                />
              </div>
            ))}
          </div>

          <div className="text-[11px] text-[var(--muted)] text-center pt-2">
            支持的服务商：MiniMax（中国/国际区）、GLM / 智谱（中国/国际区）
          </div>
        </div>
      )}
    </div>
  );
};
