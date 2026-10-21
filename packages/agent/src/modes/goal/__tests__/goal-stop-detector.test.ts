/**
 * Goal premature-stop detector tests (grok goal_stop_detector.rs, duya-ized).
 *
 * Verifies the bail-signal panel: each pattern fires on its surrender /
 * hand-off phrasing, mid-turn prose is ignored, user-deflection
 * ("I'll check back with you") is NOT a bail, and the nudge templates
 * produce pattern-specific guidance.
 */

import { describe, it, expect } from 'vitest';
import {
  matchedStopPattern,
  looksLikePrematureStop,
  prematureStopNudge,
} from '../goal-stop-detector.js';

describe('matchedStopPattern', () => {
  it('detects unable_to_proceed / giving_up', () => {
    expect(matchedStopPattern('I cannot proceed with this task.')).toBe('unable_to_proceed');
    expect(matchedStopPattern('Giving up on this approach.')).toBe('giving_up');
    expect(matchedStopPattern('The task is not actionable in this environment.')).toBe('giving_up');
  });

  it('detects stopping_here / parked', () => {
    expect(matchedStopPattern('Stopping here for now.')).toBe('stopping_here');
    expect(matchedStopPattern("I've stopped here; review needed.")).toBe('stopping_here');
    expect(matchedStopPattern('Parked the branch until tomorrow.')).toBe('stopping_here');
  });

  it('detects hand-off signals (commit/push/PR/ready-for-review)', () => {
    expect(matchedStopPattern('Pushed to `abc1234`.')).toBe('commit_push_pr');
    expect(matchedStopPattern('Opened PR #12.')).toBe('commit_push_pr');
    expect(matchedStopPattern('Ready for review.')).toBe('ready_for_review');
  });

  it('detects user-deflection "Please do X for me"', () => {
    expect(matchedStopPattern('Please provide the API key.')).toBe('please_deflection');
  });

  it('detects check-back-later when the deferral is NOT to the user', () => {
    expect(matchedStopPattern('I will retry in a few minutes.')).toBe('check_back_later');
    expect(matchedStopPattern("I'll poll again shortly.")).toBe('check_back_later');
    expect(matchedStopPattern('Will check back when the build finishes.')).toBe('check_back_later');
  });

  it('does NOT flag a deferral back to the user as a bail', () => {
    expect(matchedStopPattern("I'll check back with you once you provide the key.")).toBeUndefined();
    expect(matchedStopPattern('I will retry when you are ready.')).toBeUndefined();
  });

  it('ignores mid-turn prose — only the final paragraph is judged', () => {
    const text =
      "I cannot proceed without your input.\n\nI've completed the migration and verified the tests pass.";
    expect(matchedStopPattern(text)).toBeUndefined();
  });

  it('returns undefined for a normal completion summary', () => {
    expect(
      matchedStopPattern('Migrated auth module. All 42 tests pass, typecheck clean.'),
    ).toBeUndefined();
  });
});

describe('looksLikePrematureStop', () => {
  it('wraps matchedStopPattern', () => {
    expect(looksLikePrematureStop('Stopping here.')).toBe(true);
    expect(looksLikePrematureStop('All done, verified.')).toBe(false);
  });
});

describe('prematureStopNudge', () => {
  it('produces a pattern-specific continuation nudge for every pattern', () => {
    const labels = [
      'unable_to_proceed',
      'giving_up',
      'stopping_here',
      'agents_in_flight',
      'check_back_later',
      'verdict_line',
      'commit_push_pr',
      'ready_for_review',
      'please_deflection',
    ] as const;
    for (const label of labels) {
      const nudge = prematureStopNudge(label);
      expect(nudge.length).toBeGreaterThan(20);
      expect(nudge).not.toContain('undefined');
    }
  });
});
