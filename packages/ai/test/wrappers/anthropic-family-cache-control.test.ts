/**
 * packages/ai/test/wrappers/anthropic-family-cache-control.test.ts
 *
 * Plan 451 Phase 1: anthropic-family cache-control eligibility decision.
 *
 * Phase 1 ships this as a utility module (not a stream wrapper) because
 * applyCacheControl operates on Anthropic's wire-format MessageParam[] —
 * wire-payload hooks are planned for a later phase.
 *
 * These tests pin the eligibility decision so that when the wrapper form
 * lands, the decision function is unchanged.
 */

import { describe, it, expect } from 'vitest';
import { checkCacheEligibility } from '../../src/providers/wrappers/anthropic-family-cache-control.js';

describe('anthropic-family cache-control eligibility (utility)', () => {
  it('marks Claude models on api.anthropic.com eligible', () => {
    const r = checkCacheEligibility('anthropic', 'claude-sonnet-4-20250514', 'https://api.anthropic.com');
    expect(r.eligible).toBe(true);
    expect(r.provider).toBe('anthropic');
    expect(r.maxBreakpoints).toBe(4);
    expect(r.nativeLayout).toBe(true);
  });

  it('marks non-Claude Anthropic models ineligible', () => {
    const r = checkCacheEligibility('anthropic', 'some-other-model', 'https://api.anthropic.com');
    expect(r.eligible).toBe(false);
  });

  it('marks Claude via Vertex AI eligible', () => {
    const r = checkCacheEligibility(
      'anthropic-vertex',
      'claude-sonnet-4',
      'https://us-central1-aiplatform.googleapis.com',
    );
    expect(r.eligible).toBe(true);
  });

  it('marks Claude on OpenRouter eligible (envelope layout)', () => {
    const r = checkCacheEligibility('openrouter', 'anthropic/claude-3.5-sonnet', 'https://openrouter.ai/api/v1');
    expect(r.eligible).toBe(true);
    expect(r.nativeLayout).toBe(false);
  });

  it('marks Gemini 2.5+ eligible', () => {
    const r = checkCacheEligibility('google', 'gemini-2.5-pro');
    expect(r.eligible).toBe(true);
  });

  it('marks pre-2.5 Gemini ineligible', () => {
    const r = checkCacheEligibility('google', 'gemini-2.0-pro');
    expect(r.eligible).toBe(false);
  });

  it('is case-insensitive on provider + model id', () => {
    const a = checkCacheEligibility('Anthropic', 'Claude-Sonnet-4', 'https://api.anthropic.com');
    const b = checkCacheEligibility('anthropic', 'claude-sonnet-4', 'https://api.anthropic.com');
    expect(a.eligible).toBe(b.eligible);
  });
});