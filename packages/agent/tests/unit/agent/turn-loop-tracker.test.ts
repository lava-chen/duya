/**
 * DeadLoopTracker unit tests — Plan 550 step 2e (TurnPreparer).
 *
 * The tracker encapsulates the consecutive-identical-tool-call streak
 * that used to be four inline `let` bindings inside `streamChat`.
 * Tests pin the behaviour that callers downstream of `streamChat`
 * depend on:
 *
 *   - identical (name + JSON input) increments the streak; a different
 *     name or a different input resets it back to 1
 *   - the stats snapshot uses U+0001 as a separator that cannot
 *     appear in a tool name or in JSON input
 *   - `shouldHardStop` only fires when enabled AND the count reaches
 *     `hardStopAt`
 *   - `reset` clears the streak without altering the configured
 *     thresholds (so a stream replay does not poison the next attempt)
 *   - the default config matches the pre-extraction inline defaults
 *     (nudgeAt=8, hardNudgeAt=12, hardStopAt=16)
 *
 * @see docs/exec-plans/active/550-prompt-hbs-and-agent-decomposition.md
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULTS,
  DeadLoopTracker,
  resolveDeadLoopConfig,
  toolCallSignature,
} from '../../../src/agent/TurnLoopTracker.js';

describe('DeadLoopTracker (Plan 550 2e — TurnPreparer)', () => {
  describe('toolCallSignature', () => {
    it('uses U+0001 as a name/input separator', () => {
      expect(toolCallSignature('read', { path: '/a.md' })).toBe('read\u0001{"path":"/a.md"}');
    });

    it('falls back to "{}" for undefined input', () => {
      // `JSON.stringify(input ?? {})` preserves the pre-extraction
      // behaviour: undefined → "{}" (the fallback). The signature
      // string MUST stay bit-identical with the legacy inline
      // implementation so streak comparisons match across the
      // migration.
      expect(toolCallSignature('read', undefined)).toBe('read\u0001{}');
    });
  });

  describe('resolveDeadLoopConfig', () => {
    it('returns the documented defaults when no config is supplied', () => {
      expect(resolveDeadLoopConfig(undefined)).toEqual(DEFAULTS);
      expect(DEFAULTS).toEqual({ enabled: true, nudgeAt: 8, hardNudgeAt: 12, hardStopAt: 16 });
    });

    it('overrides only the supplied fields', () => {
      const cfg = resolveDeadLoopConfig({ nudgeAt: 4 });
      expect(cfg.nudgeAt).toBe(4);
      expect(cfg.hardNudgeAt).toBe(DEFAULTS.hardNudgeAt);
      expect(cfg.hardStopAt).toBe(DEFAULTS.hardStopAt);
      expect(cfg.enabled).toBe(true);
    });

    it('lets the caller disable the streak entirely', () => {
      const cfg = resolveDeadLoopConfig({ enabled: false });
      expect(cfg.enabled).toBe(false);
    });
  });

  describe('DeadLoopTracker', () => {
    it('returns undefined stats before any tool call is recorded', () => {
      const tracker = new DeadLoopTracker(resolveDeadLoopConfig(undefined));
      expect(tracker.stats()).toBeUndefined();
      expect(tracker.shouldHardStop()).toBe(false);
    });

    it('increments the streak on identical (name + input) calls', () => {
      const tracker = new DeadLoopTracker(resolveDeadLoopConfig(undefined));
      tracker.record('read', { path: '/a.md' });
      tracker.record('read', { path: '/a.md' });
      const stats = tracker.stats();
      expect(stats?.count).toBe(2);
      expect(stats?.toolName).toBe('read');
    });

    it('resets the streak when the input changes', () => {
      const tracker = new DeadLoopTracker(resolveDeadLoopConfig(undefined));
      tracker.record('read', { path: '/a.md' });
      tracker.record('read', { path: '/a.md' });
      tracker.record('read', { path: '/b.md' });
      expect(tracker.stats()?.count).toBe(1);
      expect(tracker.stats()?.toolName).toBe('read');
    });

    it('resets the streak when the tool name changes', () => {
      const tracker = new DeadLoopTracker(resolveDeadLoopConfig(undefined));
      tracker.record('read', { path: '/a.md' });
      tracker.record('read', { path: '/a.md' });
      tracker.record('write', { path: '/a.md' });
      expect(tracker.stats()?.count).toBe(1);
      expect(tracker.stats()?.toolName).toBe('write');
    });

    it('surfaces the configured nudgeAt / hardNudgeAt in the stats snapshot', () => {
      const tracker = new DeadLoopTracker(resolveDeadLoopConfig({ nudgeAt: 2, hardNudgeAt: 4 }));
      tracker.record('read', { path: '/a.md' });
      const stats = tracker.stats();
      expect(stats?.nudgeAt).toBe(2);
      expect(stats?.hardNudgeAt).toBe(4);
    });

    it('fires shouldHardStop only when enabled AND count >= hardStopAt', () => {
      const tracker = new DeadLoopTracker(
        resolveDeadLoopConfig({ enabled: true, hardStopAt: 3 }),
      );
      tracker.record('read', { path: '/a.md' });
      tracker.record('read', { path: '/a.md' });
      expect(tracker.shouldHardStop()).toBe(false);
      tracker.record('read', { path: '/a.md' });
      expect(tracker.shouldHardStop()).toBe(true);
    });

    it('never hard-stops when the streak is disabled', () => {
      const tracker = new DeadLoopTracker(
        resolveDeadLoopConfig({ enabled: false, hardStopAt: 1 }),
      );
      tracker.record('read', { path: '/a.md' });
      expect(tracker.shouldHardStop()).toBe(false);
    });

    it('reset() clears the streak without altering the configured thresholds', () => {
      const tracker = new DeadLoopTracker(
        resolveDeadLoopConfig({ nudgeAt: 2, hardNudgeAt: 4, hardStopAt: 6 }),
      );
      tracker.record('read', { path: '/a.md' });
      tracker.record('read', { path: '/a.md' });
      expect(tracker.stats()?.count).toBe(2);
      tracker.reset();
      expect(tracker.stats()).toBeUndefined();
      expect(tracker.shouldHardStop()).toBe(false);
      // Re-record to confirm thresholds survived the reset.
      tracker.record('read', { path: '/a.md' });
      const stats = tracker.stats();
      expect(stats?.nudgeAt).toBe(2);
      expect(stats?.hardNudgeAt).toBe(4);
    });
  });
});