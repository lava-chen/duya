/**
 * Contract tests for resolveAnthropicThinking.
 *
 * Verifies the Anthropic `thinking` parameter resolution from model
 * capabilities and user-requested effort level. Covers four branches:
 *  1. undefined / 'off' effort → undefined (provider default).
 *  2. forceAdaptiveThinking models → { type: 'adaptive' } (MiniMax M3).
 *  3. Standard reasoning models → { type: 'enabled', budget_tokens } with
 *     the budget clamped to maxTokens - 1.
 *  4. Non-reasoning models → undefined regardless of effort.
 */
import { describe, it, expect } from 'vitest';
import { resolveAnthropicThinking } from '../src/api/anthropic-messages.js';
import { anthropicModels } from '../src/providers/anthropic.js';
import { minimaxAnthropicModels } from '../src/providers/minimax-anthropic.js';

describe('resolveAnthropicThinking', () => {
  const claudeSonnet4 = anthropicModels[0]; // reasoning: true, maxTokens: 16000
  const claude35 = anthropicModels[1]; // reasoning: false
  const minimaxM3 = minimaxAnthropicModels[0]; // forceAdaptiveThinking: true

  describe('effort undefined or "off" → undefined', () => {
    it('returns undefined when effort is undefined', () => {
      expect(resolveAnthropicThinking(claudeSonnet4, undefined)).toBeUndefined();
    });

    it('returns undefined when effort is "off"', () => {
      expect(resolveAnthropicThinking(claudeSonnet4, 'off')).toBeUndefined();
    });

    it('returns undefined for "off" even on forceAdaptiveThinking models', () => {
      expect(resolveAnthropicThinking(minimaxM3, 'off')).toBeUndefined();
    });

    it('returns undefined for undefined effort on forceAdaptiveThinking models', () => {
      expect(resolveAnthropicThinking(minimaxM3, undefined)).toBeUndefined();
    });
  });

  describe('forceAdaptiveThinking → { type: "adaptive" }', () => {
    it('MiniMax M3 Anthropic preset has forceAdaptiveThinking: true', () => {
      expect(minimaxM3.compat?.forceAdaptiveThinking).toBe(true);
    });

    it('returns { type: "adaptive" } for "low"', () => {
      expect(resolveAnthropicThinking(minimaxM3, 'low')).toEqual({ type: 'adaptive' });
    });

    it('returns { type: "adaptive" } for "medium"', () => {
      expect(resolveAnthropicThinking(minimaxM3, 'medium')).toEqual({ type: 'adaptive' });
    });

    it('returns { type: "adaptive" } for "high"', () => {
      expect(resolveAnthropicThinking(minimaxM3, 'high')).toEqual({ type: 'adaptive' });
    });

    it('returns { type: "adaptive" } for "max"', () => {
      expect(resolveAnthropicThinking(minimaxM3, 'max')).toEqual({ type: 'adaptive' });
    });

    it('returns { type: "adaptive" } regardless of effort value (no budget mapping)', () => {
      // The adaptive branch short-circuits before the BUDGET map lookup,
      // so any non-off effort yields the same shape.
      expect(resolveAnthropicThinking(minimaxM3, 'minimal')).toEqual({ type: 'adaptive' });
      expect(resolveAnthropicThinking(minimaxM3, 'xhigh')).toEqual({ type: 'adaptive' });
    });
  });

  describe('standard reasoning models → { type: "enabled", budget_tokens }', () => {
    // Claude Sonnet 4: maxTokens = 16000, so budget is clamped to 15999.
    // BUDGET map: minimal=1024, low=1024, medium=4096, high=16384,
    //             xhigh=24576, max=32000.
    // Clamp rule: budget_tokens = Math.min(BUDGET[effort], maxTokens - 1).
    const maxBudget = claudeSonnet4.maxTokens - 1; // 15999

    it('Claude Sonnet 4 is a reasoning model without forceAdaptiveThinking', () => {
      expect(claudeSonnet4.reasoning).toBe(true);
      expect(claudeSonnet4.compat?.forceAdaptiveThinking).toBeFalsy();
    });

    it('returns budget_tokens 1024 for "minimal"', () => {
      expect(resolveAnthropicThinking(claudeSonnet4, 'minimal')).toEqual({
        type: 'enabled',
        budget_tokens: 1024,
      });
    });

    it('returns budget_tokens 1024 for "low"', () => {
      expect(resolveAnthropicThinking(claudeSonnet4, 'low')).toEqual({
        type: 'enabled',
        budget_tokens: 1024,
      });
    });

    it('returns budget_tokens 4096 for "medium"', () => {
      expect(resolveAnthropicThinking(claudeSonnet4, 'medium')).toEqual({
        type: 'enabled',
        budget_tokens: 4096,
      });
    });

    it('clamps "high" (16384) to maxTokens - 1 when maxTokens is smaller', () => {
      // 16384 > 15999 → clamped to 15999
      expect(resolveAnthropicThinking(claudeSonnet4, 'high')).toEqual({
        type: 'enabled',
        budget_tokens: maxBudget,
      });
    });

    it('clamps "xhigh" (24576) to maxTokens - 1', () => {
      expect(resolveAnthropicThinking(claudeSonnet4, 'xhigh')).toEqual({
        type: 'enabled',
        budget_tokens: maxBudget,
      });
    });

    it('clamps "max" (32000) to maxTokens - 1', () => {
      expect(resolveAnthropicThinking(claudeSonnet4, 'max')).toEqual({
        type: 'enabled',
        budget_tokens: maxBudget,
      });
    });

    it('never exceeds maxTokens - 1 for any effort', () => {
      const efforts = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
      for (const effort of efforts) {
        const result = resolveAnthropicThinking(claudeSonnet4, effort);
        expect(result).toBeDefined();
        if (result && result.type === 'enabled') {
          expect(result.budget_tokens).toBeLessThanOrEqual(maxBudget);
        }
      }
    });

    it('returns undefined for an unrecognized effort string', () => {
      // BUDGET has no entry for this → budget is falsy → undefined.
      expect(resolveAnthropicThinking(claudeSonnet4, 'bogus')).toBeUndefined();
    });
  });

  describe('non-reasoning models → undefined', () => {
    it('Claude 3.5 Sonnet has reasoning disabled', () => {
      expect(claude35.reasoning).toBe(false);
    });

    it('returns undefined regardless of effort', () => {
      expect(resolveAnthropicThinking(claude35, 'low')).toBeUndefined();
      expect(resolveAnthropicThinking(claude35, 'medium')).toBeUndefined();
      expect(resolveAnthropicThinking(claude35, 'high')).toBeUndefined();
      expect(resolveAnthropicThinking(claude35, 'max')).toBeUndefined();
    });

    it('returns undefined even when effort is a valid reasoning level', () => {
      // The reasoning guard short-circuits before the effort check.
      expect(resolveAnthropicThinking(claude35, 'xhigh')).toBeUndefined();
    });
  });
});
