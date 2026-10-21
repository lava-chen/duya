/**
 * Preference parsing: what a settings endpoint says, and what the TUI makes of it.
 *
 * The new keys are booleans and bounded numbers rather than enums, which is
 * where a parser usually gets lazy — `parseInt('abc')` is `NaN` and a `NaN`
 * row count would quietly make every popup one row tall. The clamps are the
 * point of these tests.
 */

import { describe, expect, it } from 'vitest';

import {
  COMPLETION_ROWS_RANGE,
  DEFAULT_TUI_PREFERENCES,
  describeOnOff,
  effortForModel,
  INPUT_ROWS_RANGE,
  parseEffortByModel,
  parseTuiPreferences,
  resolveEffectiveTuiPreferences,
  serializeEffortByModel,
  TUI_COMPLETION_ROWS_SETTING,
  TUI_EFFORT_BY_MODEL_SETTING,
  TUI_EFFORT_SETTING,
  TUI_INPUT_ROWS_SETTING,
  TUI_SHOW_THINKING_SETTING,
  TUI_STARTUP_BANNER_SETTING,
} from '../preferences.js';

describe('parseTuiPreferences', () => {
  it('defaults every new preference when nothing was saved', () => {
    const parsed = parseTuiPreferences({});
    expect(parsed.showThinking).toBe(true);
    expect(parsed.expandBlocks).toBe(false);
    expect(parsed.showToolResults).toBe(false);
    expect(parsed.startupBanner).toBe(true);
    expect(parsed.completionRows).toBe(DEFAULT_TUI_PREFERENCES.completionRows);
    expect(parsed.inputRows).toBe(DEFAULT_TUI_PREFERENCES.inputRows);
  });

  it('reads every spelling of a boolean a settings endpoint can hold', () => {
    for (const no of ['false', '0', 'off', 'no', 'FALSE']) {
      expect(parseTuiPreferences({ [TUI_SHOW_THINKING_SETTING]: no }).showThinking).toBe(false);
      expect(parseTuiPreferences({ [TUI_STARTUP_BANNER_SETTING]: no }).startupBanner).toBe(false);
    }
    for (const yes of ['true', '1', 'on', 'yes']) {
      expect(parseTuiPreferences({ [TUI_SHOW_THINKING_SETTING]: yes }).showThinking).toBe(true);
    }
  });

  it('falls back on a value it does not recognise instead of guessing', () => {
    expect(parseTuiPreferences({ [TUI_SHOW_THINKING_SETTING]: 'maybe' }).showThinking).toBe(true);
    expect(parseTuiPreferences({ [TUI_STARTUP_BANNER_SETTING]: 'perhaps' }).startupBanner).toBe(true);
  });

  it('clamps a row count instead of trusting it', () => {
    const low = parseTuiPreferences({ [TUI_COMPLETION_ROWS_SETTING]: '1' });
    expect(low.completionRows).toBe(COMPLETION_ROWS_RANGE.min);
    const high = parseTuiPreferences({ [TUI_COMPLETION_ROWS_SETTING]: '99' });
    expect(high.completionRows).toBe(COMPLETION_ROWS_RANGE.max);
    const junk = parseTuiPreferences({ [TUI_INPUT_ROWS_SETTING]: 'tall' });
    expect(junk.inputRows).toBe(DEFAULT_TUI_PREFERENCES.inputRows);
    expect(INPUT_ROWS_RANGE.min).toBeLessThan(DEFAULT_TUI_PREFERENCES.inputRows);
  });
});

/**
 * Per-model effort: the map, its one key, and how a lookup falls through.
 *
 * The interesting failures here are all "silently accepted something wrong":
 * a malformed JSON object becoming an empty map is fine, becoming a throw is
 * not, and an `auto` entry surviving is a stored value that never applies.
 */
describe('per-model effort', () => {
  const parseMap = (raw: string | undefined) => parseEffortByModel(raw);

  it('defaults to no overrides', () => {
    expect(parseMap(undefined)).toEqual({});
    expect(parseMap('')).toEqual({});
  });

  it('degrades to no overrides instead of throwing on junk', () => {
    // A preference read from a remote endpoint: bad data must cost the user
    // their defaults, never their session.
    for (const junk of ['{', 'null', '[]', '"high"', '42', '{"gpt-x":42}']) {
      expect(parseMap(junk)).toEqual({});
    }
  });

  it('drops an unknown level rather than storing one the worker will reject', () => {
    expect(parseMap('{"gpt-x":"turbo"}')).toEqual({});
    expect(parseMap('{"gpt-x":"xhigh"}')).toEqual({ 'gpt-x': 'xhigh' });
  });

  it('drops `auto` — absence is the only spelling of "no override"', () => {
    expect(parseMap('{"gpt-x":"auto","gpt-y":"high"}')).toEqual({ 'gpt-y': 'high' });
  });

  it('writes a stable string so a rewrite does not churn the stored value', () => {
    const one = serializeEffortByModel({ 'gpt-y': 'low', 'gpt-x': 'high', 'gpt-z': 'auto' });
    expect(one).toBe('{"gpt-x":"high","gpt-y":"low"}');
    const same = serializeEffortByModel({ 'gpt-y': 'low', 'gpt-x': 'high' });
    expect(same).toBe(one);
  });

  it('resolves a lookup: the model wins, then the global value', () => {
    const prefs = parseTuiPreferences({
      [TUI_EFFORT_SETTING]: 'low',
      [TUI_EFFORT_BY_MODEL_SETTING]: '{"gpt-x":"high"}',
    });
    expect(effortForModel(prefs, 'gpt-x')).toBe('high');
    expect(effortForModel(prefs, 'gpt-y')).toBe('low');
    // An unknown model id must not match a stored entry: absence is the
    // override here, not a licence to guess.
    expect(effortForModel(prefs, '')).toBe('low');
    expect(effortForModel(prefs, undefined)).toBe('low');
  });
});

describe('resolveEffectiveTuiPreferences', () => {
  it('carries the non-overridable preferences through unchanged', () => {
    const effective = resolveEffectiveTuiPreferences(
      parseTuiPreferences({ [TUI_SHOW_THINKING_SETTING]: 'false', [TUI_COMPLETION_ROWS_SETTING]: '5' }),
      {},
    );
    // The menu reads the effective object, so a preference missing here would
    // show the saved value while the renderer used the default.
    expect(effective.showThinking).toBe(false);
    expect(effective.completionRows).toBe(5);
    expect(effective.theme).toBe('dark');
  });
});

describe('describeOnOff', () => {
  it('spells a boolean the way a menu row reads', () => {
    expect(describeOnOff(true)).toBe('Shown');
    expect(describeOnOff(false)).toBe('Hidden');
  });
});
