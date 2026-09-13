// usage.ts - Usage statistics and analytics types
//
// The usage dashboard is backed by a main-process aggregation over the
// core-db rollout files (`db:usage:summary` IPC). The renderer never
// aggregates in-memory store messages — the conversation store only holds
// transcripts of sessions opened during the current app run, which made
// renderer-side totals wildly inconsistent.

/** Per-token-bucket totals. `input`/`cacheRead`/`cacheWrite` are exclusive
 *  buckets (input is net of cache; see usage-aggregator for the convention). */
export interface TokenUsageBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

export interface CostBreakdown {
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  totalCost: number;
  /** True when at least one session's model has no pricing record in
   *  provider_model_capabilities — cost figures are partial, not exact. */
  costEstimated: boolean;
}

export interface MessageCounts {
  total: number;
  user: number;
  assistant: number;
  toolCalls: number;
  toolResults: number;
  errors: number;
}

export interface ToolUsageInfo {
  totalCalls: number;
  uniqueTools: number;
  tools: { name: string; count: number }[];
}

export interface DailyUsageEntry {
  date: string;
  tokens: number;
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  messageCount: number;
  /** Distinct sessions with activity on this day. */
  sessionCount: number;
  /** Per-model token totals for this day (model id -> tokens). */
  models: Record<string, number>;
}

export interface UsageSessionSummary {
  id: string;
  title: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  totalTokens: number;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Reasoning tokens (subset of outputTokens, display only). */
  reasoningTokens: number;
  /** Cache writes at the 1h-TTL premium — a SUBSET of cacheWriteTokens. */
  cacheWrite1hTokens: number;
  /** Cache-waste scan for this session (see electron/ipc/cache-waste.ts). */
  cacheHealth: CacheHealthTotals;
  messageCount: number;
  toolCallCount: number;
  errorCount: number;
  durationMs: number;
  dailyBreakdown: { date: string; tokens: number; cost: number }[];
}

/** Quantified prompt-cache waste: prompt tokens that were in the previous
 *  turn's context but were re-billed instead of served from cache.
 *  See docs/references/harness-comparison/token-accounting.md. */
export interface CacheHealthTotals {
  missedTokens: number;
  missedCost: number;
  /** Number of counted misses (turns above the 1024-token noise floor). */
  missCount: number;
  /** Counted misses whose idle gap exceeded the ~5min cache TTL — likely
   *  expiry rather than an unexplained cache break. */
  ttlExpiredMissCount: number;
}

export interface UsageAggregates {
  messages: MessageCounts;
  tools: ToolUsageInfo;
  durationSumMs: number;
  sessionCount: number;
  activeDays: number;
  /** Consecutive active days ending today (0 = no activity today). */
  currentStreak: number;
}

/** Stable model palette used for donut / stacked bars. Assign indices by
 *  sorted token volume so the largest model keeps the same color across
 *  refreshes. */
export const MODEL_PALETTE = [
  '#3b82f6', // blue-500
  '#22c55e', // green-500
  '#a855f7', // purple-500
  '#f59e0b', // amber-500
  '#ef4444', // red-500
  '#06b6d4', // cyan-500
  '#f97316', // orange-500
  '#ec4899', // pink-500
  '#84cc16', // lime-500
  '#6366f1', // indigo-500
];

/** Per-model token totals, sorted by tokens descending. */
export interface ModelUsageEntry {
  model: string;
  tokens: number;
  cost: number;
  percentage: number;
  /** Stable color index assigned by the aggregator. */
  colorIndex: number;
}

export interface UsageTotals extends TokenUsageBreakdown, CostBreakdown {
  /** Reasoning tokens summed across all usage (subset of output, display
   *  only — never added on top of totalTokens). */
  reasoningTokens: number;
  /** Cache writes billed at the 1h-TTL premium — a SUBSET of cacheWrite. */
  cacheWrite1hTokens: number;
}

/** Wire shape returned by `db:usage:summary`. Aggregated in the main
 *  process; the renderer only renders it. */
export interface UsageSummary {
  totals: UsageTotals;
  aggregates: UsageAggregates;
  dailyData: DailyUsageEntry[];
  modelUsage: ModelUsageEntry[];
  sessions: UsageSessionSummary[];
  /** Session-summed cache waste (see CacheHealthTotals). */
  cacheHealth: CacheHealthTotals;
  /** Audit stamp for the pricing table used (max provider_model_capabilities
   *  updated_at). Reproducibility: cost figures are only meaningful against
   *  the pricing version that produced them. */
  pricingVersion?: string;
  generatedAt: number;
}

export interface UsageStatCardData {
  label: string;
  value: string | number;
  subtext?: string;
  status?: 'good' | 'warn' | 'bad' | 'neutral';
  icon?: string;
  format?: 'number' | 'currency' | 'percent' | 'duration' | 'text';
}

export type ChartMode = 'tokens' | 'cost';
export type ChartStackMode = 'total' | 'breakdown' | 'model';
