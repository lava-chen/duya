// usage.ts - Usage statistics and analytics types

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
  sessionCount: number;
}

export interface HourlyUsageEntry {
  hour: number;
  tokens: number;
  cost: number;
  sessionCount: number;
}

export interface HeatmapCell {
  day: number;
  hour: number;
  value: number;
  intensity: number;
}

export interface UsageSessionSummary {
  id: string;
  title: string;
  agentId?: string;
  channel?: string;
  modelProvider?: string;
  model?: string;
  createdAt: number;
  updatedAt: number;
  totalTokens: number;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  messageCount: number;
  toolCallCount: number;
  errorCount: number;
  durationMs: number;
  firstActivity: number;
  lastActivity: number;
  dailyBreakdown: { date: string; tokens: number; cost: number }[];
}

export interface UsageAggregates {
  messages: MessageCounts;
  tools: ToolUsageInfo;
  durationSumMs: number;
  sessionCount: number;
  activeDays: number;
}

export interface UsageTotals extends TokenUsageBreakdown, CostBreakdown {}

export interface UsageSummaryMetrics {
  totals: UsageTotals;
  aggregates: UsageAggregates;
  dailyData: DailyUsageEntry[];
  hourlyData: HourlyUsageEntry[];
  heatmapData: HeatmapCell[];
  sessions: UsageSessionSummary[];
}

export interface UsageFilters {
  dateFrom?: string;
  dateTo?: string;
  agentId?: string;
  model?: string;
  provider?: string;
  channel?: string;
  searchQuery?: string;
}

export interface UsageStatCardData {
  label: string;
  value: string | number;
  subtext?: string;
  status?: 'good' | 'warn' | 'bad' | 'neutral';
  icon?: string;
  format?: 'number' | 'currency' | 'percent' | 'duration';
}

export type ChartMode = 'tokens' | 'cost';
export type ChartStackMode = 'total' | 'breakdown';
