/**
 * Contract tests for MiniMax M3 dual-protocol model presets.
 *
 * MiniMax M3 is exposed through two API presets with deliberately different
 * thinking wire-shapes:
 *  - Anthropic preset (minimax-anthropic.ts): forceAdaptiveThinking drives
 *    { type: 'adaptive' } via resolveAnthropicThinking.
 *  - OpenAI preset (minimax-openai.ts): think-tag-fallback format is passive —
 *    resolveOpenAIThinking returns undefined and reasoning arrives inside
 *    <think>...</think> tags in the content field of the response.
 *
 * These tests verify the capability flags are mutually exclusive and that
 * each resolver produces the contract-correct shape for the corresponding
 * preset.
 */
import { describe, it, expect } from 'vitest';
import { minimaxAnthropicModels } from '../src/providers/minimax-anthropic.js';
import { minimaxOpenAIModels } from '../src/providers/minimax-openai.js';
import { resolveAnthropicThinking } from '../src/api/anthropic-messages.js';
import { resolveOpenAIThinking } from '../src/api/openai-completions.js';

describe('MiniMax M3 dual-protocol presets', () => {
  const minimaxAnthropic = minimaxAnthropicModels[0];
  const minimaxOpenAI = minimaxOpenAIModels[0];

  describe('preset capability flags are mutually exclusive', () => {
    it('MiniMax Anthropic preset has forceAdaptiveThinking: true', () => {
      expect(minimaxAnthropic.compat?.forceAdaptiveThinking).toBe(true);
    });

    it('MiniMax Anthropic preset has NO openAIThinkingFormat', () => {
      expect(minimaxAnthropic.compat?.openAIThinkingFormat).toBeUndefined();
    });

    it('MiniMax OpenAI preset has openAIThinkingFormat: "think-tag-fallback"', () => {
      expect(minimaxOpenAI.compat?.openAIThinkingFormat).toBe('think-tag-fallback');
    });

    it('MiniMax OpenAI preset has NO forceAdaptiveThinking', () => {
      expect(minimaxOpenAI.compat?.forceAdaptiveThinking).toBeUndefined();
    });

    it('both presets share the same model id', () => {
      // Same underlying model, different API surface.
      expect(minimaxAnthropic.id).toBe('MiniMax-M3');
      expect(minimaxOpenAI.id).toBe('MiniMax-M3');
    });

    it('both presets are reasoning-capable', () => {
      expect(minimaxAnthropic.reasoning).toBe(true);
      expect(minimaxOpenAI.reasoning).toBe(true);
    });

    it('both presets share the same thinkingLevelMap (off/low/medium/high/max)', () => {
      const expected = { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' };
      expect(minimaxAnthropic.thinkingLevelMap).toEqual(expected);
      expect(minimaxOpenAI.thinkingLevelMap).toEqual(expected);
    });
  });

  describe('resolveAnthropicThinking with MiniMax Anthropic preset', () => {
    // thinkingLevelMap keys (excluding 'off') → all must resolve to adaptive.
    const efforts = ['low', 'medium', 'high', 'max'];

    it('returns undefined for "off" (provider default)', () => {
      expect(resolveAnthropicThinking(minimaxAnthropic, 'off')).toBeUndefined();
    });

    it('returns { type: "adaptive" } for undefined effort (auto defaults to adaptive)', () => {
      expect(resolveAnthropicThinking(minimaxAnthropic, undefined)).toEqual({
        type: 'adaptive',
      });
    });

    for (const effort of efforts) {
      it(`returns { type: "adaptive" } for "${effort}"`, () => {
        expect(resolveAnthropicThinking(minimaxAnthropic, effort)).toEqual({
          type: 'adaptive',
        });
      });
    }

    it('never returns a budget_tokens shape (adaptive has no budget)', () => {
      for (const effort of efforts) {
        const result = resolveAnthropicThinking(minimaxAnthropic, effort);
        expect(result).toEqual({ type: 'adaptive' });
        expect(result).not.toHaveProperty('budget_tokens');
      }
    });
  });

  describe('resolveOpenAIThinking with MiniMax OpenAI preset', () => {
    // think-tag-fallback format is passive: no request parameter is sent;
    // reasoning is parsed from <think>...</think> tags in the content field.
    const efforts = ['low', 'medium', 'high', 'max'];

    it('returns undefined for "off"', () => {
      expect(resolveOpenAIThinking(minimaxOpenAI, 'off')).toBeUndefined();
    });

    it('returns undefined for undefined effort', () => {
      expect(resolveOpenAIThinking(minimaxOpenAI, undefined)).toBeUndefined();
    });

    for (const effort of efforts) {
      it(`returns undefined for "${effort}" (think-tag-fallback is passive)`, () => {
        expect(resolveOpenAIThinking(minimaxOpenAI, effort)).toBeUndefined();
      });
    }

    it('returns undefined for "minimal" (not in thinkingLevelMap but accepted by resolver)', () => {
      // resolveOpenAIThinking accepts any effort string; minimal maps to
      // 'low' in EFFORT_MAP, but think-tag-fallback still returns undefined.
      expect(resolveOpenAIThinking(minimaxOpenAI, 'minimal')).toBeUndefined();
    });

    it('returns undefined for "xhigh" (maps to high, but think-tag-fallback still passive)', () => {
      expect(resolveOpenAIThinking(minimaxOpenAI, 'xhigh')).toBeUndefined();
    });

    it('never emits a reasoning_effort / enable_thinking / thinking parameter', () => {
      // The think-tag-fallback branch must not produce any of the other
      // format-specific wire shapes.
      for (const effort of efforts) {
        const result = resolveOpenAIThinking(minimaxOpenAI, effort);
        expect(result).toBeUndefined();
      }
    });
  });

  describe('cross-protocol isolation', () => {
    it('resolveAnthropicThinking ignores openAIThinkingFormat and uses forceAdaptiveThinking', () => {
      // The Anthropic resolver only reads compat.forceAdaptiveThinking.
      // Passing the OpenAI preset (which has openAIThinkingFormat but no
      // forceAdaptiveThinking) would fall through to the budget branch —
      // but the OpenAI preset is not an anthropic-typed model, so this is
      // a conceptual guard, not a runtime path. Here we only assert the
      // Anthropic preset's behavior is driven solely by forceAdaptiveThinking.
      const result = resolveAnthropicThinking(minimaxAnthropic, 'high');
      expect(result).toEqual({ type: 'adaptive' });
    });

    it('resolveOpenAIThinking ignores forceAdaptiveThinking and uses openAIThinkingFormat', () => {
      // The OpenAI resolver only reads compat.openAIThinkingFormat.
      // think-tag-fallback → undefined regardless of effort.
      const result = resolveOpenAIThinking(minimaxOpenAI, 'high');
      expect(result).toBeUndefined();
    });

    it('the two presets produce different resolver outputs for the same effort', () => {
      // Same model id, same effort, different wire shape — the core
      // contract of dual-protocol support.
      const anthropicResult = resolveAnthropicThinking(minimaxAnthropic, 'high');
      const openAIResult = resolveOpenAIThinking(minimaxOpenAI, 'high');
      expect(anthropicResult).toEqual({ type: 'adaptive' });
      expect(openAIResult).toBeUndefined();
      expect(anthropicResult).not.toEqual(openAIResult);
    });
  });
});
