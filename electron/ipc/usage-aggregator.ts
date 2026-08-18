/**
 * usage-aggregator.ts — pure aggregation for the usage dashboard.
 *
 * Turns per-session message rows (projected from core-db rollout files via
 * `storedEventsToIpcMessages`) plus a per-model pricing lookup into the
 * `UsageSummary` DTO served by the `db:usage:summary` IPC handler.
 *
 * Token conventions (mirrors agent-process-entry live-usage handling):
 *  - Persisted `token_usage.input_tokens` INCLUDES cache tokens when the
 *    provider reports cache fields (Anthropic convention). When
 *    `input >= cacheRead + cacheWrite` we net the cache out so the
 *    input/output/cacheRead/cacheWrite buckets are exclusive — stacked
 *    charts add up and cost does not double-bill cache.
 *  - `total_tokens` is taken verbatim when the provider reports it;
 *    otherwise input + output (both already cover cache).
 *  - Cost uses provider_model_capabilities pricing per (providerId, model).
 *    Sessions whose model has no pricing record contribute zero cost and
 *    set `costEstimated: true`.
 */

import type { MessageRow } from './core-db-adapters';
import {
  MODEL_PALETTE,
  type UsageSummary,
  type UsageTotals,
  type UsageAggregates,
  type DailyUsageEntry,
  type UsageSessionSummary,
  type ModelUsageEntry,
} from '../../src/types/usage';

export interface UsageSessionInput {
  id: string;
  title: string;
  model: string;
  providerId: string;
  createdAt: number;
  updatedAt: number;
  rows: MessageRow[];
}

export interface UsagePricing {
  inputPerMillion?: number | null;
  outputPerMillion?: number | null;
  cacheReadPerMillion?: number | null;
  cacheWritePerMillion?: number | null;
}

export type UsagePricingLookup = (providerId: string, model: string) => UsagePricing | undefined;

interface ParsedUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

function parseUsage(raw: string | null): ParsedUsage | null {
  if (!raw) return null;
  try {
    const u = JSON.parse(raw) as {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
      cache_hit_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    const input = u.input_tokens ?? 0;
    const output = u.output_tokens ?? 0;
    const cacheRead = u.cache_hit_tokens ?? u.cache_read_input_tokens ?? 0;
    const cacheWrite = u.cache_creation_tokens ?? u.cache_creation_input_tokens ?? 0;
    if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return null;
    return {
      input,
      output,
      cacheRead,
      cacheWrite,
      total: u.total_tokens ?? input + output,
    };
  } catch {
    return null;
  }
}

/** Exclusive buckets: net cache out of input when input already covers it. */
function toExclusiveBuckets(u: ParsedUsage): { input: number; cacheRead: number; cacheWrite: number } {
  if (u.input >= u.cacheRead + u.cacheWrite) {
    return { input: u.input - u.cacheRead - u.cacheWrite, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite };
  }
  // Gateway reports input excluding cache — keep as-is so nothing is lost.
  return { input: u.input, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite };
}

function dayKey(timestamp: number): string {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function computeCost(
  buckets: { input: number; output: number; cacheRead: number; cacheWrite: number },
  pricing: UsagePricing | undefined,
): { inputCost: number; outputCost: number; cacheReadCost: number; cacheWriteCost: number } {
  if (!pricing) return { inputCost: 0, outputCost: 0, cacheReadCost: 0, cacheWriteCost: 0 };
  return {
    inputCost: (buckets.input * (pricing.inputPerMillion ?? 0)) / 1_000_000,
    outputCost: (buckets.output * (pricing.outputPerMillion ?? 0)) / 1_000_000,
    cacheReadCost: (buckets.cacheRead * (pricing.cacheReadPerMillion ?? 0)) / 1_000_000,
    cacheWriteCost: (buckets.cacheWrite * (pricing.cacheWritePerMillion ?? 0)) / 1_000_000,
  };
}

export function aggregateUsage(
  sessions: UsageSessionInput[],
  pricingLookup: UsagePricingLookup,
  now = Date.now(),
): UsageSummary {
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
    costEstimated: false,
  };

  const aggregates: UsageAggregates = {
    messages: { total: 0, user: 0, assistant: 0, toolCalls: 0, toolResults: 0, errors: 0 },
    tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
    durationSumMs: 0,
    sessionCount: 0,
    activeDays: 0,
    currentStreak: 0,
  };

  const dailyMap = new Map<
    string,
    DailyUsageEntry & { sessionIds: Set<string> }
  >();
  const activeDaysSet = new Set<string>();
  const toolCounts = new Map<string, number>();
  const modelTokensMap = new Map<string, number>();
  const modelCostMap = new Map<string, number>();
  const sessionSummaries: UsageSessionSummary[] = [];

  for (const session of sessions) {
    if (session.rows.length === 0) continue;
    const pricing = pricingLookup(session.providerId, session.model);
    if (!pricing) totals.costEstimated = true;

    let sessionTokens = 0;
    let sessionCost = 0;
    let sessionInput = 0;
    let sessionOutput = 0;
    let sessionCacheRead = 0;
    let sessionCacheWrite = 0;
    let sessionToolCalls = 0;
    let sessionErrors = 0;
    let sessionDuration = 0;
    const sessionDaily = new Map<string, { tokens: number; cost: number }>();

    for (const row of session.rows) {
      aggregates.messages.total++;
      if (row.role === 'user') aggregates.messages.user++;
      if (row.role === 'assistant') aggregates.messages.assistant++;
      if (row.msg_type === 'tool_use') {
        aggregates.messages.toolCalls++;
        sessionToolCalls++;
        if (row.tool_name) {
          toolCounts.set(row.tool_name, (toolCounts.get(row.tool_name) ?? 0) + 1);
        }
      }
      if (row.msg_type === 'tool_result') aggregates.messages.toolResults++;
      if (row.status === 'error') {
        aggregates.messages.errors++;
        sessionErrors++;
      }
      if (row.duration_ms) {
        aggregates.durationSumMs += row.duration_ms;
        sessionDuration += row.duration_ms;
      }

      const ts = row.created_at;
      const date = dayKey(ts);
      activeDaysSet.add(date);

      let daily = dailyMap.get(date);
      if (!daily) {
        daily = {
          date,
          tokens: 0,
          cost: 0,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          inputCost: 0,
          outputCost: 0,
          cacheReadCost: 0,
          cacheWriteCost: 0,
          messageCount: 0,
          sessionCount: 0,
          sessionIds: new Set(),
          models: {},
        };
        dailyMap.set(date, daily);
      }
      daily.messageCount++;
      daily.sessionIds.add(session.id);

      const usage = parseUsage(row.token_usage);
      if (usage) {
        const buckets = toExclusiveBuckets(usage);
        const cost = computeCost({ ...buckets, output: usage.output }, pricing);

        totals.input += buckets.input;
        totals.output += usage.output;
        totals.cacheRead += buckets.cacheRead;
        totals.cacheWrite += buckets.cacheWrite;
        totals.totalTokens += usage.total;
        totals.inputCost += cost.inputCost;
        totals.outputCost += cost.outputCost;
        totals.cacheReadCost += cost.cacheReadCost;
        totals.cacheWriteCost += cost.cacheWriteCost;
        totals.totalCost += cost.inputCost + cost.outputCost + cost.cacheReadCost + cost.cacheWriteCost;

        sessionTokens += usage.total;
        sessionCost += cost.inputCost + cost.outputCost + cost.cacheReadCost + cost.cacheWriteCost;
        sessionInput += buckets.input;
        sessionOutput += usage.output;
        sessionCacheRead += buckets.cacheRead;
        sessionCacheWrite += buckets.cacheWrite;

        daily.tokens += usage.total;
        daily.input += buckets.input;
        daily.output += usage.output;
        daily.cacheRead += buckets.cacheRead;
        daily.cacheWrite += buckets.cacheWrite;
        daily.inputCost += cost.inputCost;
        daily.outputCost += cost.outputCost;
        daily.cacheReadCost += cost.cacheReadCost;
        daily.cacheWriteCost += cost.cacheWriteCost;
        daily.cost += cost.inputCost + cost.outputCost + cost.cacheReadCost + cost.cacheWriteCost;

        const modelKey = session.model || 'unknown';
        daily.models[modelKey] = (daily.models[modelKey] ?? 0) + usage.total;
        modelTokensMap.set(modelKey, (modelTokensMap.get(modelKey) ?? 0) + usage.total);
        modelCostMap.set(modelKey, (modelCostMap.get(modelKey) ?? 0) + cost.inputCost + cost.outputCost + cost.cacheReadCost + cost.cacheWriteCost);

        const dayTokens = sessionDaily.get(date);
        if (dayTokens) {
          dayTokens.tokens += usage.total;
          dayTokens.cost += cost.inputCost + cost.outputCost + cost.cacheReadCost + cost.cacheWriteCost;
        } else {
          sessionDaily.set(date, {
            tokens: usage.total,
            cost: cost.inputCost + cost.outputCost + cost.cacheReadCost + cost.cacheWriteCost,
          });
        }
      }
    }

    aggregates.sessionCount++;
    sessionSummaries.push({
      id: session.id,
      title: session.title,
      model: session.model,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      totalTokens: sessionTokens,
      totalCost: sessionCost,
      inputTokens: sessionInput,
      outputTokens: sessionOutput,
      cacheReadTokens: sessionCacheRead,
      cacheWriteTokens: sessionCacheWrite,
      messageCount: session.rows.length,
      toolCallCount: sessionToolCalls,
      errorCount: sessionErrors,
      durationMs: sessionDuration,
      dailyBreakdown: Array.from(sessionDaily.entries())
        .map(([date, data]) => ({ date, tokens: data.tokens, cost: data.cost }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    });
  }

  aggregates.activeDays = activeDaysSet.size;

  // Current streak: consecutive days with activity ending today (local time).
  let streak = 0;
  if (activeDaysSet.size > 0) {
    const todayDate = new Date(now);
    for (let i = 0; i <= 365; i++) {
      const d = new Date(todayDate);
      d.setDate(d.getDate() - i);
      const key = dayKey(d.getTime());
      if (activeDaysSet.has(key)) {
        streak++;
      } else if (i === 0) {
        // No activity today -> streak is 0 regardless of past activity.
        streak = 0;
        break;
      } else {
        break;
      }
    }
  }
  aggregates.currentStreak = streak;

  const sortedTools = Array.from(toolCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));
  aggregates.tools = {
    totalCalls: sortedTools.reduce((sum, t) => sum + t.count, 0),
    uniqueTools: sortedTools.length,
    tools: sortedTools.slice(0, 20),
  };

  const dailyData = Array.from(dailyMap.values())
    .map(({ sessionIds, ...entry }) => {
      entry.sessionCount = sessionIds.size;
      return entry;
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  const sessionList = sessionSummaries.sort((a, b) => b.totalTokens - a.totalTokens);

  const totalModelTokens = Math.max(
    Array.from(modelTokensMap.values()).reduce((sum, v) => sum + v, 0),
    1,
  );
  const modelUsage: ModelUsageEntry[] = Array.from(modelTokensMap.entries())
    .map(([model, tokens]) => ({
      model,
      tokens,
      cost: modelCostMap.get(model) ?? 0,
      percentage: tokens / totalModelTokens,
      colorIndex: 0,
    }))
    .sort((a, b) => b.tokens - a.tokens)
    .map((entry, index) => ({
      ...entry,
      colorIndex: index % MODEL_PALETTE.length,
    }));

  return {
    totals,
    aggregates,
    dailyData,
    modelUsage,
    sessions: sessionList,
    generatedAt: now,
  };
}
