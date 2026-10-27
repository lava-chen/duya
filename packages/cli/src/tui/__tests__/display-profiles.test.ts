/**
 * The display profiles `/display` offers, and the fact that they are DERIVED.
 *
 * Two failure modes these pin:
 *
 *  - a profile row that reports a name the vector does not match — the menu
 *    lying about the screen, which is the exact bug shape the shared
 *    Desktop/TUI settings keys make loud;
 *  - a profile applied as a delta, leaving an old fourth key in place so the
 *    same word means two transcripts.
 */

import { describe, expect, it } from 'vitest';

import {
  DISPLAY_PROFILES,
  displayProfilePatch,
  displayProfileSettings,
  profileById,
  resolveDisplayProfile,
} from '../display-profiles.js';
import {
  DEFAULT_TUI_PREFERENCES,
  parseTuiPreferences,
  TUI_EXPAND_BLOCKS_SETTING,
  TUI_SHOW_THINKING_SETTING,
  TUI_SHOW_TOOL_RESULTS_SETTING,
  TUI_TOOL_GROUP_MODE_SETTING,
} from '../preferences.js';

describe('resolveDisplayProfile', () => {
  it('names each profile by its own vector', () => {
    for (const profile of DISPLAY_PROFILES) {
      expect(resolveDisplayProfile(profile)).toBe(profile.id);
    }
  });

  it('reports custom for a hand-tuned transcript instead of the nearest match', () => {
    expect(resolveDisplayProfile({
      showThinking: true,
      expandBlocks: false,
      showToolResults: true,
      toolGroupMode: 'names',
    })).toBe('custom');
  });

  it('starts a fresh install on a named profile', () => {
    const vector = {
      showThinking: DEFAULT_TUI_PREFERENCES.showThinking,
      expandBlocks: DEFAULT_TUI_PREFERENCES.expandBlocks,
      showToolResults: DEFAULT_TUI_PREFERENCES.showToolResults,
      toolGroupMode: DEFAULT_TUI_PREFERENCES.toolGroupMode,
    };
    expect(resolveDisplayProfile(vector)).toBe('standard');
  });
});

describe('displayProfileSettings', () => {
  it('writes all four keys, every time', () => {
    expect(Object.keys(displayProfileSettings('running')).sort()).toEqual([
      TUI_EXPAND_BLOCKS_SETTING,
      TUI_SHOW_THINKING_SETTING,
      TUI_SHOW_TOOL_RESULTS_SETTING,
      TUI_TOOL_GROUP_MODE_SETTING,
    ].sort());
  });

  it('round-trips through the settings parser', () => {
    for (const profile of DISPLAY_PROFILES) {
      const parsed = parseTuiPreferences(displayProfileSettings(profile.id));
      expect(parsed.showThinking).toBe(profile.showThinking);
      expect(parsed.expandBlocks).toBe(profile.expandBlocks);
      expect(parsed.showToolResults).toBe(profile.showToolResults);
      expect(parsed.toolGroupMode).toBe(profile.toolGroupMode);
    }
  });

  it('gives the renderer the same vector it gives the settings table', () => {
    for (const profile of DISPLAY_PROFILES) {
      expect(displayProfilePatch(profile.id)).toEqual({
        showThinking: profile.showThinking,
        expandBlocks: profile.expandBlocks,
        showToolResults: profile.showToolResults,
        toolGroupMode: profile.toolGroupMode,
      });
    }
  });

  it('differs from its neighbour by the axis the name promises', () => {
    // Compact and Live only are the pair a reader is most likely to confuse, so
    // they may only differ in how many call rows the trail lists.
    expect(profileById('compact').toolGroupMode).toBe('names');
    expect(profileById('running').toolGroupMode).toBe('running');
    expect(profileById('compact').showThinking).toBe(profileById('running').showThinking);
  });

  it('refuses an id that is not in the list', () => {
    expect(() => profileById('quiet' as never)).toThrow(/Unknown display profile/);
  });
});
