// Model data. Hand-curated as the base; generated (models.dev) fields fill gaps.
//
// Plan 451 Phase 6: Google GenerativeLanguage (Gemini) model catalog.
// Model ids are Gemini model IDs (`<family>-<size>-<variant>-<version>`).
// Pricing is per-million-tokens (USD) on the public GenerativeLanguage rate;
// see https://ai.google.dev/pricing for current values.
import type { Model } from '../types.js';

export const googleModels: Model<'gemini'>[] = [
  {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    api: 'gemini',
    providerId: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high' },
    input: ['text', 'image'],
    contextWindow: 1048576,
    maxTokens: 65536,
    cost: { input: 1.25, output: 10, cacheRead: 0.31, cacheWrite: 0 },
  },
  {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    api: 'gemini',
    providerId: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high' },
    input: ['text', 'image'],
    contextWindow: 1048576,
    maxTokens: 65536,
    cost: { input: 0.3, output: 2.5, cacheRead: 0.075, cacheWrite: 0 },
  },
  {
    id: 'gemini-2.0-flash',
    name: 'Gemini 2.0 Flash',
    api: 'gemini',
    providerId: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    reasoning: false,
    input: ['text', 'image'],
    contextWindow: 1048576,
    maxTokens: 8192,
    cost: { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0 },
  },
];