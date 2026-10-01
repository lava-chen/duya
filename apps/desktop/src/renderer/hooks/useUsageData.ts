import { useCallback, useEffect, useState } from 'react';
import type { UsageSummary } from '@/types/usage';
import { getUsageSummaryIPC } from '@/lib/ipc-client';

export interface UseUsageDataResult {
  data: UsageSummary | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * Fetch the usage summary aggregated by the main process (`db:usage:summary`)
 * over core-db rollout files. Covers ALL sessions — not just the ones whose
 * transcripts happen to be loaded in the conversation store.
 */
export function useUsageData(): UseUsageDataResult {
  const [data, setData] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSummary = useCallback(async (isRefresh: boolean) => {
    if (isRefresh) setRefreshing(true);
    try {
      const summary = await getUsageSummaryIPC();
      setData(summary);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void fetchSummary(false);
  }, [fetchSummary]);

  const refresh = useCallback(() => fetchSummary(true), [fetchSummary]);

  return { data, loading, refreshing, error, refresh };
}

export function formatNumber(num: number): string {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return num.toLocaleString();
}

export function formatCurrency(amount: number): string {
  if (amount === 0) return '$0';
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  if (amount >= 0.01) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(6)}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
