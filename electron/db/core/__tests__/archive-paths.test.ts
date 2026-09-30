import { describe, expect, it } from 'vitest';
import {
  archivedDirFor,
  formatArchiveDate,
  resolveArchivedPath,
  resolveUnarchivedPath,
} from '../archive-paths';

describe('archive-paths (Plan 549, corrected by Plan 582 G1)', () => {
  describe('formatArchiveDate', () => {
    it('formats unix-ms as YYYY-MM-DD in UTC', () => {
      const utcMidnight = Date.UTC(2026, 8, 18, 0, 0, 0);
      expect(formatArchiveDate(utcMidnight)).toBe('2026-09-18');
    });

    it('zero-pads single-digit months and days', () => {
      const feb3 = Date.UTC(2026, 1, 3, 12, 0, 0);
      expect(formatArchiveDate(feb3)).toBe('2026-02-03');
    });
  });

  describe('resolveArchivedPath', () => {
    const fixedNow = Date.UTC(2026, 8, 18, 14, 30, 0);

    it('mirrors a bot active.jsonl, keeping the agent directory', () => {
      // Plan 549 collapsed this to archived/<date>/active.jsonl, which made
      // every bot session share one destination path.
      const rel = 'agents/bot-1/sessions/active.jsonl';
      expect(resolveArchivedPath(rel, fixedNow)).toBe(
        'archived/2026-09-18/agents/bot-1/sessions/active.jsonl',
      );
    });

    it('mirrors a date-bucketed human rollout, keeping the date tree', () => {
      const rel = 'sessions/2026/09/18/rollout-stamp-s-42.jsonl';
      expect(resolveArchivedPath(rel, fixedNow)).toBe(
        'archived/2026-09-18/sessions/2026/09/18/rollout-stamp-s-42.jsonl',
      );
    });

    it('mirrors a rotated session directory, keeping the session-private dir', () => {
      // The G1 regression: the generation layout lives in a session-private
      // directory whose siblings all have to move together.
      const rel = 'sessions/2026/09/18/s-abc/active.jsonl';
      expect(resolveArchivedPath(rel, fixedNow)).toBe(
        'archived/2026-09-18/sessions/2026/09/18/s-abc/active.jsonl',
      );
      expect(resolveArchivedPath('sessions/2026/09/18/s-abc/archive-0.jsonl', fixedNow)).toBe(
        'archived/2026-09-18/sessions/2026/09/18/s-abc/archive-0.jsonl',
      );
    });

    it('gives two bots archived on the same day distinct destinations', () => {
      expect(resolveArchivedPath('agents/bot-1/sessions/active.jsonl', fixedNow)).not.toBe(
        resolveArchivedPath('agents/bot-2/sessions/active.jsonl', fixedNow),
      );
    });

    it('is idempotent for an already-archived path', () => {
      const once = resolveArchivedPath('sessions/2026/09/18/rollout.jsonl', fixedNow);
      expect(resolveArchivedPath(once, fixedNow)).toBe(once);
    });

    it('defaults to Date.now() when no timestamp is provided', () => {
      const archived = resolveArchivedPath('sessions/2026/09/18/rollout.jsonl');
      expect(archived.startsWith('archived/')).toBe(true);
      expect(archived.endsWith('/sessions/2026/09/18/rollout.jsonl')).toBe(true);
    });
  });

  describe('resolveUnarchivedPath', () => {
    // The whole point of mirroring: unarchive is a pure prefix strip, so it
    // is an exact inverse for every layout instead of a reconstruction.
    it.each([
      ['agents/bot-1/sessions/active.jsonl'],
      ['agents/bot-1/sessions/archive-0.jsonl'],
      ['sessions/2026/09/18/rollout-stamp-s-42.jsonl'],
      ['sessions/2026/09/18/s-abc/active.jsonl'],
      ['sessions/2026/09/18/s-abc/archive-7.jsonl'],
    ])('round-trips %s exactly', (rel) => {
      const fixedNow = Date.UTC(2026, 8, 18, 14, 30, 0);
      expect(resolveUnarchivedPath(resolveArchivedPath(rel, fixedNow))).toBe(rel);
    });

    it('leaves non-archived-prefixed paths unchanged (safety net)', () => {
      expect(resolveUnarchivedPath('agents/bot-1/sessions/active.jsonl')).toBe(
        'agents/bot-1/sessions/active.jsonl',
      );
    });

    it('does not treat an unrelated two-segment path as archived', () => {
      expect(resolveUnarchivedPath('agents/bot-1')).toBe('agents/bot-1');
      // The date segment must actually look like a date.
      expect(resolveUnarchivedPath('archived/not-a-date/x.jsonl')).toBe(
        'archived/not-a-date/x.jsonl',
      );
    });
  });

  describe('archivedDirFor', () => {
    const fixedNow = Date.UTC(2026, 8, 18, 14, 30, 0);

    it('returns the shared destination directory for a rotated session', () => {
      const active = resolveArchivedPath('sessions/2026/09/18/s-abc/active.jsonl', fixedNow);
      const segment = resolveArchivedPath('sessions/2026/09/18/s-abc/archive-0.jsonl', fixedNow);
      // Both segments land in the same directory, which is what the row records.
      expect(archivedDirFor(active)).toBe(archivedDirFor(segment));
    });

    it('gives two bots separate directories', () => {
      const a = archivedDirFor(resolveArchivedPath('agents/bot-1/sessions/active.jsonl', fixedNow));
      const b = archivedDirFor(resolveArchivedPath('agents/bot-2/sessions/active.jsonl', fixedNow));
      expect(a).not.toBe(b);
    });
  });
});
