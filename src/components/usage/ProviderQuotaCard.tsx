"use client";

import React from "react";
import { useTranslation } from "@/hooks/useTranslation";

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

function formatResetAt(resetAt: string | null): string | null {
  if (!resetAt) return null;
  const ms = Date.parse(resetAt);
  if (Number.isNaN(ms)) return null;
  const diff = ms - Date.now();
  if (diff <= 0) return "即将重置";
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes} 分钟后重置`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时后重置`;
  const days = Math.floor(hours / 24);
  return `${days} 天后重置`;
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
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-[var(--text)]">{state.providerName}</span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--muted)]/10 text-[var(--muted)] border border-[var(--border)]">
              查询中
            </span>
          </div>
        </div>
        <div className="h-2 rounded-full bg-[var(--muted)]/10 overflow-hidden">
          <div className="h-full w-1/3 bg-[var(--muted)]/30 animate-pulse" />
        </div>
        <div className="text-[11px] text-[var(--muted)] mt-2">正在获取限额数据…</div>
      </div>
    );
  }

  if (state.status === "unsupported") {
    return (
      <div className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface)]/40 p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-[var(--text)]">{state.providerName}</div>
            <div className="text-[11px] text-[var(--muted)] mt-1">该服务商暂不支持限额查询</div>
          </div>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--muted)]/10 text-[var(--muted)] border border-[var(--border)]">
            Not Supported
          </span>
        </div>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="rounded-xl border border-[var(--error)]/20 bg-[var(--error)]/5 p-4">
        <div className="flex items-center justify-between">
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-[var(--text)]">{state.providerName}</div>
            <div className="text-[11px] text-[var(--error)] mt-1 truncate">
              {state.message || "获取失败"}
            </div>
          </div>
          <button
            type="button"
            onClick={onRetry}
            className="shrink-0 text-[11px] px-2.5 py-1 rounded-md border border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)] hover:border-[var(--accent-soft)] transition-colors"
          >
            重试
          </button>
        </div>
      </div>
    );
  }

  const entries = Object.entries(state.quotas || {});
  if (entries.length === 0) {
    return (
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)]/40 p-4">
        <div className="text-sm font-medium text-[var(--text)]">{state.providerName}</div>
        <div className="text-[11px] text-[var(--muted)] mt-1">未返回限额数据</div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[var(--border)] bg-gradient-to-b from-[var(--surface)] to-[var(--bg-canvas)] p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-[var(--text)]">{state.providerName}</span>
          {state.plan && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--accent)]/10 text-[var(--accent)] border border-[var(--accent)]/20">
              {state.plan}
            </span>
          )}
        </div>
      </div>

      <div className="space-y-3">
        {entries.map(([key, quota]) => {
          const resetLabel = formatResetAt(quota.resetAt);
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
