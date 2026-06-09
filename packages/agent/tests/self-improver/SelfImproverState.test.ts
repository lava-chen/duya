/**
 * packages/agent/tests/self-improver/SelfImproverState.test.ts
 *
 * Tests for the persistent counter storage backing the SelfImprover.
 *
 * Storage location: ~/.duya/self-improver-state.json
 * The tests redirect `homedir()` to a tmp dir so they never touch
 * the developer's real state.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';

// `vi.mock` is hoisted, so the tmp dir must be created via
// `vi.hoisted` to avoid the TDZ error. We don't depend on
// `os.tmpdir()` (which we mock) or `process.tmpdir()` (which
// behaves oddly when called from the hoisted callback).
const tmpHome = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  const base = process.env.TMPDIR || process.env.TEMP || '/tmp';
  return mkdtempSync(`${base}/duya-selfimprover-state-`);
});

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: () => tmpHome,
  };
});

import { readFileSync, existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import {
  loadSelfImproverState,
  saveSelfImproverState,
  clearSelfImproverState,
  getSelfImproverStatePath,
} from '../../src/self-improver/SelfImproverState.js';

describe('SelfImproverState', () => {
  beforeEach(() => {
    // Start every test from a clean slate.
    try {
      rmSync(join(tmpHome, '.duya', 'self-improver-state.json'), { force: true });
    } catch {
      // ignore
    }
  });

  afterEach(() => {
    try {
      rmSync(join(tmpHome, '.duya'), { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('getSelfImproverStatePath', () => {
    it('returns a path under the (mocked) home directory', () => {
      const p = getSelfImproverStatePath();
      // On Windows, `path.join` uses `\` while `tmpHome` (built via
      // template strings) uses `/`. Normalize separators before
      // checking containment.
      const normalize = (s: string) => s.replace(/\\/g, '/');
      expect(normalize(p)).toContain(normalize(tmpHome));
      expect(p).toMatch(/self-improver-state\.json$/);
    });
  });

  describe('loadSelfImproverState', () => {
    it('returns defaults when file does not exist', async () => {
      const state = await loadSelfImproverState();
      expect(state).toEqual({
        itersSinceSkill: 0,
        toolCallsSinceSkill: 0,
        lastResetAt: 0,
        lastReviewAt: null,
      });
    });

    it('returns defaults when file is malformed JSON', async () => {
      // Write garbage and confirm the loader falls back gracefully.
      mkdirSync(join(tmpHome, '.duya'), { recursive: true });
      writeFileSync(
        join(tmpHome, '.duya', 'self-improver-state.json'),
        'this is not json {',
        'utf-8',
      );
      const state = await loadSelfImproverState();
      expect(state.itersSinceSkill).toBe(0);
      expect(state.toolCallsSinceSkill).toBe(0);
    });

    it('clamps negative counters to 0', async () => {
      mkdirSync(join(tmpHome, '.duya'), { recursive: true });
      writeFileSync(
        join(tmpHome, '.duya', 'self-improver-state.json'),
        JSON.stringify({ itersSinceSkill: -5, toolCallsSinceSkill: -3 }),
        'utf-8',
      );
      const state = await loadSelfImproverState();
      expect(state.itersSinceSkill).toBe(0);
      expect(state.toolCallsSinceSkill).toBe(0);
    });

    it('rounds down non-integer counters', async () => {
      mkdirSync(join(tmpHome, '.duya'), { recursive: true });
      writeFileSync(
        join(tmpHome, '.duya', 'self-improver-state.json'),
        JSON.stringify({ itersSinceSkill: 3.7, toolCallsSinceSkill: 9.99 }),
        'utf-8',
      );
      const state = await loadSelfImproverState();
      expect(state.itersSinceSkill).toBe(3);
      expect(state.toolCallsSinceSkill).toBe(9);
    });

    it('preserves valid persisted counters', async () => {
      mkdirSync(join(tmpHome, '.duya'), { recursive: true });
      writeFileSync(
        join(tmpHome, '.duya', 'self-improver-state.json'),
        JSON.stringify({
          itersSinceSkill: 7,
          toolCallsSinceSkill: 21,
          lastResetAt: 1234,
          lastReviewAt: 5678,
        }),
        'utf-8',
      );
      const state = await loadSelfImproverState();
      expect(state).toEqual({
        itersSinceSkill: 7,
        toolCallsSinceSkill: 21,
        lastResetAt: 1234,
        lastReviewAt: 5678,
      });
    });
  });

  describe('saveSelfImproverState', () => {
    it('writes a valid JSON file', async () => {
      await saveSelfImproverState({
        itersSinceSkill: 5,
        toolCallsSinceSkill: 12,
        lastResetAt: 1000,
        lastReviewAt: 2000,
      });
      const raw = readFileSync(
        join(tmpHome, '.duya', 'self-improver-state.json'),
        'utf-8',
      );
      const parsed = JSON.parse(raw);
      expect(parsed).toEqual({
        itersSinceSkill: 5,
        toolCallsSinceSkill: 12,
        lastResetAt: 1000,
        lastReviewAt: 2000,
      });
    });

    it('is round-trip safe', async () => {
      const original = {
        itersSinceSkill: 9,
        toolCallsSinceSkill: 27,
        lastResetAt: 111,
        lastReviewAt: null as number | null,
      };
      await saveSelfImproverState(original);
      const loaded = await loadSelfImproverState();
      expect(loaded).toEqual(original);
    });
  });

  describe('clearSelfImproverState', () => {
    it('creates the file with defaults when it does not exist', async () => {
      expect(existsSync(join(tmpHome, '.duya', 'self-improver-state.json'))).toBe(false);
      await clearSelfImproverState();
      const loaded = await loadSelfImproverState();
      // lastResetAt is set to "now" by clearSelfImproverState, so we
      // can't assert it's 0. The other fields must be defaults.
      expect(loaded.itersSinceSkill).toBe(0);
      expect(loaded.toolCallsSinceSkill).toBe(0);
      expect(loaded.lastReviewAt).toBe(null);
    });

    it('overwrites a previously saved state', async () => {
      await saveSelfImproverState({
        itersSinceSkill: 5,
        toolCallsSinceSkill: 12,
        lastResetAt: 1000,
        lastReviewAt: 2000,
      });
      await clearSelfImproverState();
      const loaded = await loadSelfImproverState();
      expect(loaded.itersSinceSkill).toBe(0);
      expect(loaded.toolCallsSinceSkill).toBe(0);
    });
  });
});
