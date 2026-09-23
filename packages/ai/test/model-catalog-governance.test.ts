/**
 * Model catalog governance (pi-mono check-model-data parity).
 *
 * These invariants keep every checked-in model entry "fully capable by
 * default": a model that declares reasoning must carry (or have detectable)
 * thinking configuration, and the numeric caps must be sane. A sync run
 * (`sync-models.mjs --write/--merge`) re-emits compat via provider defaults,
 * so a regression here means the pipeline — not a single entry — broke.
 *
 * Invariants:
 *  1. contextWindow > 0 and maxTokens > 0 for every entry.
 *  2. maxTokens <= contextWindow (output cannot exceed the window).
 *  3. openai-chat reasoning models must resolve an openAIThinkingFormat —
 *     from explicit compat OR the per-provider detect defaults layer.
 *  4. anthropic reasoning models must declare thinkingLevelMap (the UI
 *     effort selector and level mapping read it).
 *  5. Duplicate (api, id) pairs must agree on reasoning/maxTokens so
 *     findModelCompat / findModelById cannot pick a conflicting twin.
 */
import { describe, it, expect } from 'vitest';
import { allProviderModels } from '../src/providers/index.js';
import { detectOpenAICompatDefaults } from '../src/api/openai-completions.js';
import { findModelCompat } from '../src/models.js';
import type { Model } from '../src/types.js';

const models = allProviderModels as readonly Model<never>[];

describe('model catalog governance', () => {
  it('every entry declares positive contextWindow and maxTokens', () => {
    const bad = models.filter(
      m =>
        !Number.isFinite(m.contextWindow) ||
        m.contextWindow <= 0 ||
        !Number.isFinite(m.maxTokens) ||
        m.maxTokens <= 0,
    );
    expect(
      bad.map(m => `${m.id}: ctx=${m.contextWindow} out=${m.maxTokens}`),
    ).toEqual([]);
  });

  it('maxTokens never exceeds contextWindow', () => {
    const bad = models.filter(m => m.maxTokens > m.contextWindow);
    expect(bad.map(m => `${m.id}: ${m.maxTokens} > ${m.contextWindow}`)).toEqual([]);
  });

  it('openai-chat reasoning models resolve a thinking format (compat or detect layer)', () => {
    const bad = models
      .filter(m => m.api === 'openai-chat' && m.reasoning === true)
      .filter(m => {
        const explicit = (m as Model<'openai-chat'>).compat?.openAIThinkingFormat;
        if (explicit) return false;
        const detected = detectOpenAICompatDefaults(m as never);
        return !detected.openAIThinkingFormat;
      });
    expect(bad.map(m => m.id)).toEqual([]);
  });

  it('anthropic reasoning models declare thinkingLevelMap', () => {
    const bad = models.filter(
      m => m.api === 'anthropic' && m.reasoning === true && !m.thinkingLevelMap,
    );
    expect(bad.map(m => m.id)).toEqual([]);
  });

  it('duplicate (api, id) pairs do not disagree on reasoning/maxTokens', () => {
    const seen = new Map<string, { reasoning?: boolean; maxTokens?: number }>();
    const conflicts: string[] = [];
    for (const m of models) {
      const key = `${m.api}::${m.id}`;
      const prev = seen.get(key);
      if (prev && (prev.reasoning !== m.reasoning || prev.maxTokens !== m.maxTokens)) {
        conflicts.push(
          `${key}: reasoning ${prev.reasoning}/${m.reasoning}, maxTokens ${prev.maxTokens}/${m.maxTokens}`,
        );
      }
      seen.set(key, { reasoning: m.reasoning, maxTokens: m.maxTokens });
    }
    expect(conflicts).toEqual([]);
  });

  it('findModelCompat derives maxOutputTokens from the catalog ceiling', () => {
    // Claude Sonnet 5 has no explicit compat.maxOutputTokens — the catalog
    // maxTokens (128000) must flow through so the agent does not fall back
    // to the 8192 protocol default.
    const compat = findModelCompat('anthropic', 'claude-sonnet-5');
    expect(compat?.maxOutputTokens).toBe(128000);
    // An explicit compat.maxOutputTokens (MiniMax M3) is preserved as-is.
    const m3 = findModelCompat('anthropic', 'MiniMax-M3');
    expect(m3?.maxOutputTokens).toBe(128000);
  });
});
