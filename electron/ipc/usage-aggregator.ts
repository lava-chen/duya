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
 *  - Token VOLUMES (totals/daily/session/model "tokens") are cache-inclusive
 *    processed volume: exclusive input + cacheRead + cacheWrite + output.
 *    The old `total_tokens ?? input+output` semantics silently dropped the
 *    cached portion, which under a 95%-cache-hit workload reported ~5% of
 *    the volume the model actually processed.
 *  - Cost uses provider_model_capabilities pricing per (providerId, model).
 *    Sessions whose model has no pricing record contribute zero cost and
 *    set `costEstimated: true`.
 *
 * Structure: `extractSessionFacts` reduces a session's rows into a
 * cost-independent `SessionUsageFacts` snapshot; `aggregateUsageFromFacts`
 * combines facts + live pricing into the summary. The IPC handler caches
 * facts per session keyed by the rollout file's mtime/size stamp
 * (`UsageFactsCache`), so unchanged sessions skip the rollout read entirely.
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
}

function parseUsage(raw: string | null): ParsedUsage | null {
  if (!raw) return null;
  try {
    const u = JSON.parse(raw) as {
      input_tokens?: number;
      output_tokens?: number;
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
    return { input, output, cacheRead, cacheWrite };
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

// ============================================================================
// Per-session facts extraction (cacheable, pricing-independent)
// ============================================================================

/** Everything `aggregateUsageFromFacts` needs from one session's rows —
 *  derived purely from message content, so it can be cached until the
 *  session's rollout file changes. */
export interface SessionUsageFacts {
  messageTotal: number;
  userCount: number;
  assistantCount: number;
  toolCallCount: number;
  toolResultCount: number;
  errorCount: number;
  durationSumMs: number;
  toolCounts: Record<string, number>;
  /** Distinct local-day keys with any message activity. */
  activeDates: string[];
  /** Message count per local-day key (drives daily.messageCount). */
  messagesPerDate: Record<string, number>;
  /** One entry per usage-bearing message, buckets already exclusive. */
  usageRows: Array<{
    date: string;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    /** Cache-inclusive processed volume: exclusive input + cache + output. */
    volume: number;
  }>;
}

export function extractSessionFacts(rows: MessageRow[]): SessionUsageFacts {
  const facts: SessionUsageFacts = {
    messageTotal: 0,
    userCount: 0,
    assistantCount: 0,
    toolCallCount: 0,
    toolResultCount: 0,
    errorCount: 0,
    durationSumMs: 0,
    toolCounts: {},
    activeDates: [],
    messagesPerDate: {},
    usageRows: [],
  };
  const dates = new Set<string>();

  for (const row of rows) {
    facts.messageTotal++;
    if (row.role === 'user') facts.userCount++;
    if (row.role === 'assistant') facts.assistantCount++;
    if (row.msg_type === 'tool_use') {
      facts.toolCallCount++;
      if (row.tool_name) {
        facts.toolCounts[row.tool_name] = (facts.toolCounts[row.tool_name] ?? 0) + 1;
      }
    }
    if (row.msg_type === 'tool_result') facts.toolResultCount++;
    if (row.status === 'error') facts.errorCount++;
    if (row.duration_ms) facts.durationSumMs += row.duration_ms;

    const date = dayKey(row.created_at);
    dates.add(date);
    facts.messagesPerDate[date] = (facts.messagesPerDate[date] ?? 0) + 1;

    const usage = parseUsage(row.token_usage);
    if (usage) {
      const buckets = toExclusiveBuckets(usage);
      facts.usageRows.push({
        date,
        input: buckets.input,
        output: usage.output,
        cacheRead: buckets.cacheRead,
        cacheWrite: buckets.cacheWrite,
        volume: buckets.input + usage.output + buckets.cacheRead + buckets.cacheWrite,
      });
    }
  }

  facts.activeDates = Array.from(dates);
  return facts;
}

export interface SessionFactsInput {
  id: string;
  title: string;
  model: string;
  providerId: string;
  createdAt: number;
  updatedAt: number;
  facts: SessionUsageFacts;
}

// ============================================================================
// Aggregation (facts + live pricing → UsageSummary)
// ============================================================================

export function aggregateUsageFromFacts(
  sessions: SessionFactsInput[],
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

  const dailyFor = (date: string): DailyUsageEntry & { sessionIds: Set<string> } => {
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
    return daily;
  };

  for (const session of sessions) {
    const { facts } = session;
    if (facts.messageTotal === 0) continue;
    const pricing = pricingLookup(session.providerId, session.model);
    if (!pricing) totals.costEstimated = true;

    let sessionTokens = 0;
    let sessionCost = 0;
    let sessionInput = 0;
    let sessionOutput = 0;
    let sessionCacheRead = 0;
    let sessionCacheWrite = 0;
    const sessionDaily = new Map<string, { tokens: number; cost: number }>();

    aggregates.messages.total += facts.messageTotal;
    aggregates.messages.user += facts.userCount;
    aggregates.messages.assistant += facts.assistantCount;
    aggregates.messages.toolCalls += facts.toolCallCount;
    aggregates.messages.toolResults += facts.toolResultCount;
    aggregates.messages.errors += facts.errorCount;
    aggregates.durationSumMs += facts.durationSumMs;
    for (const [name, count] of Object.entries(facts.toolCounts)) {
      toolCounts.set(name, (toolCounts.get(name) ?? 0) + count);
    }
    for (const date of facts.activeDates) activeDaysSet.add(date);
    for (const [date, count] of Object.entries(facts.messagesPerDate)) {
      dailyFor(date).messageCount += count;
    }

    for (const usage of facts.usageRows) {
      const cost = computeCost(usage, pricing);
      const costTotal = cost.inputCost + cost.outputCost + cost.cacheReadCost + cost.cacheWriteCost;

      totals.input += usage.input;
      totals.output += usage.output;
      totals.cacheRead += usage.cacheRead;
      totals.cacheWrite += usage.cacheWrite;
      totals.totalTokens += usage.volume;
      totals.inputCost += cost.inputCost;
      totals.outputCost += cost.outputCost;
      totals.cacheReadCost += cost.cacheReadCost;
      totals.cacheWriteCost += cost.cacheWriteCost;
      totals.totalCost += costTotal;

      sessionTokens += usage.volume;
      sessionCost += costTotal;
      sessionInput += usage.input;
      sessionOutput += usage.output;
      sessionCacheRead += usage.cacheRead;
      sessionCacheWrite += usage.cacheWrite;

      const daily = dailyFor(usage.date);
      daily.sessionIds.add(session.id);
      daily.tokens += usage.volume;
      daily.input += usage.input;
      daily.output += usage.output;
      daily.cacheRead += usage.cacheRead;
      daily.cacheWrite += usage.cacheWrite;
      daily.inputCost += cost.inputCost;
      daily.outputCost += cost.outputCost;
      daily.cacheReadCost += cost.cacheReadCost;
      daily.cacheWriteCost += cost.cacheWriteCost;
      daily.cost += costTotal;

      const modelKey = session.model || 'unknown';
      daily.models[modelKey] = (daily.models[modelKey] ?? 0) + usage.volume;
      modelTokensMap.set(modelKey, (modelTokensMap.get(modelKey) ?? 0) + usage.volume);
      modelCostMap.set(modelKey, (modelCostMap.get(modelKey) ?? 0) + costTotal);

      const dayTokens = sessionDaily.get(usage.date);
      if (dayTokens) {
        dayTokens.tokens += usage.volume;
        dayTokens.cost += costTotal;
      } else {
        sessionDaily.set(usage.date, { tokens: usage.volume, cost: costTotal });
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
      messageCount: facts.messageTotal,
      toolCallCount: facts.toolCallCount,
      errorCount: facts.errorCount,
      durationMs: facts.durationSumMs,
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

/** Compose helper: extract facts from raw rows, then aggregate. Kept for
 *  callers/tests that work with raw rows; the IPC handler uses the split
 *  form so it can cache per-session facts. */
export function aggregateUsage(
  sessions: UsageSessionInput[],
  pricingLookup: UsagePricingLookup,
  now = Date.now(),
): UsageSummary {
  return aggregateUsageFromFacts(
    sessions.map((session) => ({
      id: session.id,
      title: session.title,
      model: session.model,
      providerId: session.providerId,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      facts: extractSessionFacts(session.rows),
    })),
    pricingLookup,
    now,
  );
}

// ============================================================================
// Facts cache (mtime/size-gated, used by the db:usage:summary handler)
// ============================================================================

/** Caches per-session facts keyed by a rollout-file stamp so unchanged
 *  sessions skip the rollout read on every dashboard refresh. */
export class UsageFactsCache {
  private entries = new Map<string, { stamp: string; facts: SessionUsageFacts }>();

  get(sessionId: string, stamp: string): SessionUsageFacts | undefined {
    const entry = this.entries.get(sessionId);
    return entry && entry.stamp === stamp ? entry.facts : undefined;
  }

  set(sessionId: string, stamp: string, facts: SessionUsageFacts): void {
    this.entries.set(sessionId, { stamp, facts });
  }

  /** Drop entries for sessions that no longer exist. */
  prune(aliveIds: Set<string>): void {
    for (const id of this.entries.keys()) {
      if (!aliveIds.has(id)) this.entries.delete(id);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
