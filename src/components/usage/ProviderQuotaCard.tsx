"use client";

import React from "react";
import { useTranslation } from "@/hooks/useTranslation";
import type { I18nContextValue } from "@/components/layout/I18nProvider";
import { ProviderIcon } from "./ProviderIcon";

export interface QuotaItem {
  used: number;
  total: number;
  remaining: number;
  remainingPercentage: number;
  resetAt: string | null;
  unlimited: boolean;
}

export type ProviderQuotaStatus = "loading" | "success" | "error" | "unsupported";

export interface ProviderQuotaState {
  providerId: string;
  providerName: string;
  providerType: string;
  baseUrl: string;
  hasApiKey: boolean;
  status: ProviderQuotaStatus;
  plan?: string;
  quotas?: Record<string, QuotaItem>;
  message?: string;
}

interface ProviderQuotaCardProps {
  state: ProviderQuotaState;
  onRetry: () => void;
}

function formatResetAt(
  resetAt: string | null,
  t: I18nContextValue["t"],
): string | null {
  if (!resetAt) return null;
  const ms = Date.parse(resetAt);
  if (Number.isNaN(ms)) return null;
  const diff = ms - Date.now();
  if (diff <= 0) return t("usage.quotaSoonReset");
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return t("usage.minutesReset", { minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("usage.hoursReset", { hours });
  const days = Math.floor(hours / 24);
  return t("usage.daysReset", { days });
}

function getBarColor(percentage: number): string {
  if (percentage >= 50) return "bg-[var(--success)]";
  if (percentage >= 20) return "bg-[var(--warning)]";
  return "bg-[var(--error)]";
}

function getStatusBg(percentage: number): string {
  if (percentage >= 50) return "bg-[var(--success)]/10 border-[var(--success)]/20";
  if (percentage >= 20) return "bg-[var(--warning)]/10 border-[var(--warning)]/20";
  return "bg-[var(--error)]/10 border-[var(--error)]/20";
}

export const ProviderQuotaCard: React.FC<ProviderQuotaCardProps> = ({ state, onRetry }) => {
  const { t } = useTranslation();

  if (state.status === "loading") {
    return (
      <div className="rounded-xl border border-[var(--border)] bg-gradient-to-b from-[var(--surface)] to-[var(--bg-canvas)] p-4">
        <div className="flex items-center gap-2.5 mb-3">
          <ProviderIcon
            providerType={state.providerType}
            baseUrl={state.baseUrl}
            size={20}
          />
          <span className="text-sm font-medium text-[var(--text)] flex-1 truncate">
            {state.providerName}
          </span>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--muted)]/10 text-[var(--muted)] border border-[var(--border)]">
            {t("usage.quotaLoading")}
          </span>
        </div>
        <div className="h-2 rounded-full bg-[var(--muted)]/10 overflow-hidden">
          <div className="h-full w-1/3 bg-[var(--muted)]/30 animate-pulse" />
        </div>
        <div className="text-[11px] text-[var(--muted)] mt-2">{t("usage.quotaLoadingDesc")}</div>
      </div>
    );
  }

  if (state.status === "unsupported") {
    return (
      <div className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface)]/40 p-4">
        <div className="flex items-center gap-2.5">
          <ProviderIcon
            providerType={state.providerType}
            baseUrl={state.baseUrl}
            size={20}
          />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-[var(--text)] truncate">
              {state.providerName}
            </div>
            <div className="text-[11px] text-[var(--muted)] mt-0.5">
              {t("usage.quotaUnsupportedDesc")}
            </div>
          </div>
          <span className="shrink-0 text-[10px] px-2 py-0.5 rounded-full bg-[var(--muted)]/10 text-[var(--muted)] border border-[var(--border)]">
            {t("usage.quotaUnsupported")}
          </span>
        </div>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="rounded-xl border border-[var(--error)]/20 bg-[var(--error)]/5 p-4">
        <div className="flex items-start gap-2.5">
          <div className="shrink-0 mt-0.5">
            <ProviderIcon
              providerType={state.providerType}
              baseUrl={state.baseUrl}
              size={20}
            />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-[var(--text)] truncate">
              {state.providerName}
            </div>
            <div className="text-[11px] text-[var(--error)] mt-1 break-all">
              {state.message || t("usage.quotaError")}
            </div>
          </div>
          <button
            type="button"
            onClick={onRetry}
            className="shrink-0 text-[11px] px-2.5 py-1 rounded-md border border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)] hover:border-[var(--accent-soft)] transition-colors"
          >
            {t("usage.quotaRetry")}
          </button>
        </div>
      </div>
    );
  }

  const entries = Object.entries(state.quotas || {});
  if (entries.length === 0) {
    return (
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)]/40 p-4">
        <div className="flex items-center gap-2.5">
          <ProviderIcon
            providerType={state.providerType}
            baseUrl={state.baseUrl}
            size={20}
          />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-[var(--text)] truncate">
              {state.providerName}
            </div>
            <div className="text-[11px] text-[var(--muted)] mt-0.5">{t("usage.quotaNoData")}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[var(--border)] bg-gradient-to-b from-[var(--surface)] to-[var(--bg-canvas)] p-4">
      <div className="flex items-center gap-2.5 mb-3">
        <ProviderIcon
          providerType={state.providerType}
          baseUrl={state.baseUrl}
          size={20}
        />
        <span className="text-sm font-medium text-[var(--text)] flex-1 truncate">
          {state.providerName}
        </span>
        {state.plan && (
          <span className="shrink-0 text-[10px] px-2 py-0.5 rounded-full bg-[var(--accent)]/10 text-[var(--accent)] border border-[var(--accent)]/20">
            {state.plan}
          </span>
        )}
      </div>

      <div className="space-y-3">
        {entries.map(([key, quota]) => {
          const resetLabel = formatResetAt(quota.resetAt, t);
          const isPercent = quota.total > 0 && quota.total <= 100;
          return (
            <div key={key}>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs text-[var(--muted)]">{key}</span>
                <span className="text-xs font-medium text-[var(--text)] tabular-nums">
                  {isPercent
                    ? `${quota.remaining.toFixed(0)}%`
                    : `${quota.remaining} / ${quota.total}`}
                </span>
              </div>
              <div className={`h-2 rounded-full overflow-hidden ${getStatusBg(quota.remainingPercentage)}`}>
                <div
                  className={`h-full transition-all duration-500 ${getBarColor(quota.remainingPercentage)}`}
                  style={{ width: `${Math.max(0, Math.min(100, quota.remainingPercentage))}%` }}
                />
              </div>
              {resetLabel && (
                <div className="text-[10px] text-[var(--muted)] mt-1">{resetLabel}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
