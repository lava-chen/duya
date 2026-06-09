/**
 * useContextUsage.ts
 *
 * Aggregate context-usage hook used by both the ring trigger (popover) and
 * the breakdown modal. Returns the same shape the legacy inline
 * useContextUsage produced, so existing call sites keep working.
 */
import { useMemo } from 'react';
import type { Message } from '@/types/message';
import {
  extractSources,
  normalizeAndBuildGrid,
  type ContextBreakdown,
} from '@/lib/context-usage-utils';

export type ContextState = 'normal' | 'warning' | 'critical';

export interface ContextUsage {
  hasData: boolean;
  modelName: string;
  contextWindow: number;
  used: number;
  ratio: number;
  estimatedNextTurn: number;
  estimatedNextRatio: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  /** 0..1 — actual / contextWindow */
  cacheHitRate: number;
  state: ContextState;
}

const DEFAULT_CONTEXT_WINDOW = 200_000;

export function getContextWindowForModel(modelName?: string): number {
  if (!modelName) return DEFAULT_CONTEXT_WINDOW;
  const lower = modelName.toLowerCase();
  if (lower.includes('claude-3-opus')) return 200_000;
  if (lower.includes('claude-3-sonnet')) return 200_000;
  if (lower.includes('claude-3-haiku')) return 200_000;
  if (lower.includes('claude-3-5-sonnet')) return 200_000;
  if (lower.includes('gpt-4-turbo')) return 128_000;
  if (lower.includes('gpt-4o')) return 128_000;
  if (lower.includes('gpt-4')) return 8192;
  if (lower.includes('gpt-3.5')) return 16385;
  if (lower.includes('minimax')) return 200_000;
  return DEFAULT_CONTEXT_WINDOW;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

export function useContextUsage(
  messages: Message[],
  modelName?: string,
): ContextUsage {
  return useMemo(() => {
    const contextWindow = getContextWindowForModel(modelName);
    const noData: ContextUsage = {
      modelName: modelName || 'unknown',
      contextWindow,
      used: 0,
      ratio: 0,
      estimatedNextTurn: 0,
      estimatedNextRatio: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      cacheHitRate: 0,
      hasData: false,
      state: 'normal',
    };

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== 'assistant' || !msg.tokenUsage) continue;
      try {
        const usage = msg.tokenUsage;
        const inputTokens = usage.input_tokens || 0;
        const cacheRead = usage.cache_hit_tokens || 0;
        const cacheCreation = usage.cache_creation_tokens || 0;
        const outputTokens = usage.output_tokens || 0;
        const used = inputTokens + cacheRead + cacheCreation;
        const ratio = contextWindow ? used / contextWindow : 0;

        const estimatedNextTurn = used + outputTokens + 200;
        const estimatedNextRatio = contextWindow
          ? estimatedNextTurn / contextWindow
          : 0;

        const effectiveRatio = Math.max(ratio, estimatedNextRatio);
        let state: ContextState = 'normal';
        if (effectiveRatio >= 0.95) state = 'critical';
        else if (effectiveRatio >= 0.8) state = 'warning';

        const cacheHitRate =
          cacheRead + cacheCreation > 0
            ? cacheRead / (cacheRead + cacheCreation)
            : 0;

        return {
          modelName: modelName || 'unknown',
          contextWindow,
          used,
          ratio,
          estimatedNextTurn,
          estimatedNextRatio,
          cacheReadTokens: cacheRead,
          cacheCreationTokens: cacheCreation,
          outputTokens,
          cacheHitRate,
          hasData: true,
          state,
        };
      } catch {
        continue;
      }
    }

    return noData;
  }, [messages, modelName]);
}

/** Per-message source breakdown for the popover grid + detail modal.
 *  Falls back to an empty breakdown when there's no tokenUsage yet. */
export function useContextBreakdown(
  messages: Message[],
  usage: ContextUsage,
  narrow = false,
): ContextBreakdown {
  return useMemo(() => {
    if (!usage.hasData) {
      return normalizeAndBuildGrid(
        [],
        0,
        usage.contextWindow,
        'normal',
        narrow,
      );
    }
    const raw = extractSources(messages);
    return normalizeAndBuildGrid(
      raw,
      usage.used,
      usage.contextWindow,
      usage.state,
      narrow,
    );
  }, [messages, usage, narrow]);
}
