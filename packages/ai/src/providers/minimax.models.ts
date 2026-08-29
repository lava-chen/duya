// Model data. MiniMax M3/M2.x via Anthropic-compatible API (Global region).
// Spec §9: M3 Anthropic defaults thinking OFF; forceAdaptiveThinking drives
// { type: 'adaptive' } in resolveAnthropicThinking.
//
// contextWindow notes:
// - M3 advertises a 1M total context (input + output), per the upstream docs
//   referenced in `packages/ai/src/api/anthropic-messages.ts:62-65`. The price
//   tier `inputTokensAbove: 512000` in the catalog also implies the model can
//   accept prompts well past 200K. Earlier catalogs listed M3 at 200K which
//   caused premature auto-compaction (duya treated it as a 200K model, so
//   `shouldCompact()` fired at 156K while the real window allowed 780K).
// - M2.x families advertise 200K (input + output) total context; their
//   max_tokens ceiling is 204_800 per the API contract noted in
//   `packages/ai/src/api/anthropic-messages.ts:67-68`.
//
// max_tokens ceiling notes (applied here as the model's hard `maxTokens`):
// - M3: 524_288 (line 69 of anthropic-messages.ts). The runtime ceiling is
//   the larger of this or the configured max; duya will let the request go
//   up to 524K output, and MiniMax itself will reject beyond that.
// - M2.7-highspeed: 196_608. Listed below to cover the highspeed branch in
//   `getMiniMaxAnthropicMaxTokens` (anthropic-messages.ts:213-218), which
//   checks `highspeed` before the generic `minimax-m` prefix and would
//   otherwise return MINIMAX_DEFAULT_MAX_TOKENS (204_800) — overshooting the
//   real ceiling and triggering MiniMax 2013 rejections.
import type { Model } from '../types.js';

export const minimaxModels: Model<'anthropic'>[] = [
  {
    id: 'MiniMax-M3',
    name: 'MiniMax M3',
    api: 'anthropic',
    providerId: 'minimax',
    baseUrl: 'https://api.minimax.io/anthropic',
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' },
    compat: { forceAdaptiveThinking: true },
    input: ['text', 'image'],
    contextWindow: 1000000,
    maxTokens: 8192,
    cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0, tiers: [{ inputTokensAbove: 512000, input: 0.6, output: 2.4, cacheRead: 0.12, cacheWrite: 0 }] },
  },
  {
    id: 'MiniMax-M2.7',
    name: 'MiniMax M2.7',
    api: 'anthropic',
    providerId: 'minimax',
    baseUrl: 'https://api.minimax.io/anthropic',
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' },
    compat: { forceAdaptiveThinking: true },
    input: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 8192,
    cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 },
  },
  {
    id: 'MiniMax-M2.7-highspeed',
    name: 'MiniMax M2.7 Highspeed',
    api: 'anthropic',
    providerId: 'minimax',
    baseUrl: 'https://api.minimax.io/anthropic',
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' },
    compat: { forceAdaptiveThinking: true },
    input: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 8192,
    cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 },
  },
  {
    id: 'MiniMax-M2.5',
    name: 'MiniMax M2.5',
    api: 'anthropic',
    providerId: 'minimax',
    baseUrl: 'https://api.minimax.io/anthropic',
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' },
    compat: { forceAdaptiveThinking: true },
    input: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 8192,
    cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.375 },
  },
  {
    id: 'MiniMax-M2.1',
    name: 'MiniMax M2.1',
    api: 'anthropic',
    providerId: 'minimax',
    baseUrl: 'https://api.minimax.io/anthropic',
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' },
    compat: { forceAdaptiveThinking: true },
    input: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 8192,
    cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.375 },
  },
  {
    id: 'MiniMax-M2',
    name: 'MiniMax M2',
    api: 'anthropic',
    providerId: 'minimax',
    baseUrl: 'https://api.minimax.io/anthropic',
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' },
    compat: { forceAdaptiveThinking: true },
    input: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 8192,
    cost: { input: 0.3, output: 1.2, cacheRead: 0, cacheWrite: 0 },
  },
];