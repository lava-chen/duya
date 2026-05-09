import { useMemo } from 'react';
import type { Message, TokenUsage } from '@/types/message';
import type { Thread } from '@/stores/conversation-store';
import type {
  UsageSummaryMetrics,
  UsageTotals,
  UsageAggregates,
  DailyUsageEntry,
  HourlyUsageEntry,
  HeatmapCell,
  UsageSessionSummary,
  UsageFilters,
} from '@/types/usage';

export interface UseUsageDataOptions {
  messages: Record<string, Message[]>;
  threads: Thread[];
  filters?: UsageFilters;
}

function formatDateKey(timestamp: number): string {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getHourKey(timestamp: number): number {
  return new Date(timestamp).getHours();
}

function getDayKey(timestamp: number): number {
  return new Date(timestamp).getDay();
}

function parseTokenUsage(msg: Message): TokenUsage | null {
  if (msg.tokenUsage) {
    return msg.tokenUsage;
  }
  return null;
}

function estimateCost(tokens: TokenUsage, model?: string): number {
  const inputRate = 2.5 / 1_000_000;
  const outputRate = 10.0 / 1_000_000;
  const cacheReadRate = 0.625 / 1_000_000;
  const cacheWriteRate = 1.25 / 1_000_000;

  const inputCost = (tokens.input_tokens || 0) * inputRate;
  const outputCost = (tokens.output_tokens || 0) * outputRate;
  const cacheReadCost = (tokens.cache_hit_tokens || 0) * cacheReadRate;
  const cacheWriteCost = (tokens.cache_creation_tokens || 0) * cacheWriteRate;

  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}

export function useUsageData({ messages, threads, filters }: UseUsageDataOptions): UsageSummaryMetrics {
  return useMemo(() => {
    const filteredThreads = threads.filter((thread) => {
      if (!filters) return true;
      if (filters.dateFrom && thread.updatedAt < new Date(filters.dateFrom).getTime()) return false;
      if (filters.dateTo && thread.updatedAt > new Date(filters.dateTo).getTime()) return false;
      if (filters.searchQuery && !thread.title.toLowerCase().includes(filters.searchQuery.toLowerCase())) {
        return false;
      }
      return true;
    });

    const totals: UsageTotals = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      totalCost: 0,
    };

    const aggregates: UsageAggregates = {
      messages: { total: 0, user: 0, assistant: 0, toolCalls: 0, toolResults: 0, errors: 0 },
      tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
      durationSumMs: 0,
      sessionCount: filteredThreads.length,
      activeDays: 0,
    };

    const dailyMap = new Map<string, DailyUsageEntry>();
    const hourlyMap = new Map<string, HourlyUsageEntry>();
    const heatmapMap = new Map<string, { day: number; hour: number; value: number; count: number }>();
    const activeDaysSet = new Set<string>();
    const toolCounts = new Map<string, number>();
    const sessionSummaries: UsageSessionSummary[] = [];

    for (const thread of filteredThreads) {
      const threadMessages = messages[thread.id] || [];
      if (threadMessages.length === 0) continue;

      let threadTokens = 0;
      let threadCost = 0;
      let threadInput = 0;
      let threadOutput = 0;
      let threadCacheRead = 0;
      let threadCacheWrite = 0;
      let threadToolCalls = 0;
      let threadErrors = 0;
      let threadDuration = 0;
      const threadDailyMap = new Map<string, { tokens: number; cost: number }>();

      const firstMsg = threadMessages[0];
      const lastMsg = threadMessages[threadMessages.length - 1];
      const firstActivity = firstMsg?.timestamp || thread.createdAt;
      const lastActivity = lastMsg?.timestamp || thread.updatedAt;

      for (const msg of threadMessages) {
        aggregates.messages.total++;
        activeDaysSet.add(formatDateKey(msg.timestamp));

        if (msg.role === 'user') aggregates.messages.user++;
        if (msg.role === 'assistant') aggregates.messages.assistant++;
        if (msg.msgType === 'tool_use') {
          aggregates.messages.toolCalls++;
          threadToolCalls++;
          if (msg.toolName) {
            toolCounts.set(msg.toolName, (toolCounts.get(msg.toolName) || 0) + 1);
          }
        }
        if (msg.msgType === 'tool_result') aggregates.messages.toolResults++;
        if (msg.status === 'error') {
          aggregates.messages.errors++;
          threadErrors++;
        }

        const tokens = parseTokenUsage(msg);
        if (tokens) {
          const input = tokens.input_tokens || 0;
          const output = tokens.output_tokens || 0;
          const cacheRead = tokens.cache_hit_tokens || 0;
          const cacheWrite = tokens.cache_creation_tokens || 0;
          const total = tokens.total_tokens || input + output + cacheRead + cacheWrite;
          const cost = estimateCost(tokens);

          totals.input += input;
          totals.output += output;
          totals.cacheRead += cacheRead;
          totals.cacheWrite += cacheWrite;
          totals.totalTokens += total;

          const inputCost = input * (2.5 / 1_000_000);
          const outputCost = output * (10.0 / 1_000_000);
          const cacheReadCost = cacheRead * (0.625 / 1_000_000);
          const cacheWriteCost = cacheWrite * (1.25 / 1_000_000);

          totals.inputCost += inputCost;
          totals.outputCost += outputCost;
          totals.cacheReadCost += cacheReadCost;
          totals.cacheWriteCost += cacheWriteCost;
          totals.totalCost += cost;

          threadTokens += total;
          threadCost += cost;
          threadInput += input;
          threadOutput += output;
          threadCacheRead += cacheRead;
          threadCacheWrite += cacheWrite;

          const dateKey = formatDateKey(msg.timestamp);
          const hourKey = getHourKey(msg.timestamp);
          const dayKey = getDayKey(msg.timestamp);

          // Daily aggregation
          const existingDaily = dailyMap.get(dateKey);
          if (existingDaily) {
            existingDaily.tokens += total;
            existingDaily.cost += cost;
            existingDaily.input += input;
            existingDaily.output += output;
            existingDaily.cacheRead += cacheRead;
            existingDaily.cacheWrite += cacheWrite;
            existingDaily.inputCost += inputCost;
            existingDaily.outputCost += outputCost;
            existingDaily.cacheReadCost += cacheReadCost;
            existingDaily.cacheWriteCost += cacheWriteCost;
            existingDaily.messageCount++;
          } else {
            dailyMap.set(dateKey, {
              date: dateKey,
              tokens: total,
              cost: cost,
              input,
              output,
              cacheRead,
              cacheWrite,
              inputCost,
              outputCost,
              cacheReadCost,
              cacheWriteCost,
              messageCount: 1,
              sessionCount: 1,
            });
          }

          // Thread daily breakdown
          const threadDaily = threadDailyMap.get(dateKey);
          if (threadDaily) {
            threadDaily.tokens += total;
            threadDaily.cost += cost;
          } else {
            threadDailyMap.set(dateKey, { tokens: total, cost: cost });
          }

          // Hourly aggregation
          const hourlyKey = `${dateKey}-${hourKey}`;
          const existingHourly = hourlyMap.get(hourlyKey);
          if (existingHourly) {
            existingHourly.tokens += total;
            existingHourly.cost += cost;
            existingHourly.sessionCount++;
          } else {
            hourlyMap.set(hourlyKey, {
              hour: hourKey,
              tokens: total,
              cost: cost,
              sessionCount: 1,
            });
          }

          // Heatmap aggregation
          const heatmapKey = `${dayKey}-${hourKey}`;
          const existingHeatmap = heatmapMap.get(heatmapKey);
          if (existingHeatmap) {
            existingHeatmap.value += total;
            existingHeatmap.count++;
          } else {
            heatmapMap.set(heatmapKey, { day: dayKey, hour: hourKey, value: total, count: 1 });
          }
        }

        if (msg.durationMs) {
          aggregates.durationSumMs += msg.durationMs;
          threadDuration += msg.durationMs;
        }
      }

      // Update session count for days
      for (const [dateKey, daily] of dailyMap) {
        if (threadDailyMap.has(dateKey)) {
          daily.sessionCount = Math.max(daily.sessionCount, 1);
        }
      }

      sessionSummaries.push({
        id: thread.id,
        title: thread.title,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        totalTokens: threadTokens,
        totalCost: threadCost,
        inputTokens: threadInput,
        outputTokens: threadOutput,
        cacheReadTokens: threadCacheRead,
        cacheWriteTokens: threadCacheWrite,
        messageCount: threadMessages.length,
        toolCallCount: threadToolCalls,
        errorCount: threadErrors,
        durationMs: threadDuration,
        firstActivity,
        lastActivity,
        dailyBreakdown: Array.from(threadDailyMap.entries()).map(([date, data]) => ({
          date,
          tokens: data.tokens,
          cost: data.cost,
        })),
      });
    }

    aggregates.activeDays = activeDaysSet.size;

    // Tool aggregation
    const sortedTools = Array.from(toolCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }));
    aggregates.tools = {
      totalCalls: sortedTools.reduce((sum, t) => sum + t.count, 0),
      uniqueTools: sortedTools.length,
      tools: sortedTools.slice(0, 20),
    };

    // Calculate heatmap intensity
    const heatmapValues = Array.from(heatmapMap.values());
    const maxHeatmapValue = Math.max(...heatmapValues.map((h) => h.value), 1);
    const heatmapData: HeatmapCell[] = heatmapValues.map((h) => ({
      day: h.day,
      hour: h.hour,
      value: h.value,
      intensity: h.value / maxHeatmapValue,
    }));

    // Sort daily data by date
    const dailyData = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));

    // Sort hourly data by hour
    const hourlyData = Array.from(hourlyMap.values()).sort((a, b) => a.hour - b.hour);

    // Sort sessions by total tokens descending
    const sessions = sessionSummaries.sort((a, b) => b.totalTokens - a.totalTokens);

    return {
      totals,
      aggregates,
      dailyData,
      hourlyData,
      heatmapData,
      sessions,
    };
  }, [messages, threads, filters]);
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
