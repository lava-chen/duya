/**
 * MiniMax M3 via Anthropic-compatible API.
 * Spec §9: M3 Anthropic defaults thinking OFF; forceAdaptiveThinking drives
 * { type: 'adaptive' } in resolveAnthropicThinking.
 */
import type { Model } from '../types.js';

export const minimaxAnthropicModels: Model<'anthropic'>[] = [
  {
    id: 'MiniMax-M3',
    name: 'MiniMax M3 (Anthropic)',
    api: 'anthropic',
    providerId: 'minimax-anthropic',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' },
    compat: { forceAdaptiveThinking: true },
    input: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 8192,
  },
  {
    id: 'MiniMax-M2.7',
    name: 'MiniMax M2.7 (Anthropic)',
    api: 'anthropic',
    providerId: 'minimax-anthropic',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' },
    compat: { forceAdaptiveThinking: true },
    input: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 8192,
  },
  {
    id: 'MiniMax-M2.5',
    name: 'MiniMax M2.5 (Anthropic)',
    api: 'anthropic',
    providerId: 'minimax-anthropic',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' },
    compat: { forceAdaptiveThinking: true },
    input: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 8192,
  },
  {
    id: 'MiniMax-M2.1',
    name: 'MiniMax M2.1 (Anthropic)',
    api: 'anthropic',
    providerId: 'minimax-anthropic',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' },
    compat: { forceAdaptiveThinking: true },
    input: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 8192,
  },
  {
    id: 'MiniMax-M2',
    name: 'MiniMax M2 (Anthropic)',
    api: 'anthropic',
    providerId: 'minimax-anthropic',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' },
    compat: { forceAdaptiveThinking: true },
    input: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 8192,
  },
];
