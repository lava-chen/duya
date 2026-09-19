import { describe, expect, it } from 'vitest';
import {
  formatArchiveDate,
  resolveArchivedPath,
  resolveUnarchivedPath,
} from '../archive-paths';

describe('archive-paths (Plan 549)', () => {
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

    it('places a bot active.jsonl under archived/<date>/', () => {
      const rel = 'agents/bot-1/sessions/active.jsonl';
      const archived = resolveArchivedPath(rel, fixedNow);
      expect(archived).toBe('archived/2026-09-18/active.jsonl');
    });

    it('preserves basename for a date-bucketed human rollout', () => {
      const rel = 'sessions/2026/09/18/rollout-stamp-s-42.jsonl';
      const archived = resolveArchivedPath(rel, fixedNow);
      expect(archived).toBe('archived/2026-09-18/rollout-stamp-s-42.jsonl');
    });

    it('defaults to Date.now() when no timestamp is provided', () => {
      const rel = 'sessions/2026/09/18/rollout.jsonl';
      const archived = resolveArchivedPath(rel);
      // Default Date.now() — verify shape, not exact value.
      expect(archived.startsWith('archived/')).toBe(true);
      expect(archived.endsWith('/rollout.jsonl')).toBe(true);
    });
  });

  describe('resolveUnarchivedPath', () => {
    it('drops archived/<date>/ and routes to sessions/<basename>', () => {
      expect(
        resolveUnarchivedPath('archived/2026-09-18/rollout-stamp-s-42.jsonl'),
      ).toBe('sessions/rollout-stamp-s-42.jsonl');
    });

    it('passes through bot active.jsonl restoring to sessions/active.jsonl', () => {
      expect(resolveUnarchivedPath('archived/2026-09-18/active.jsonl')).toBe(
        'sessions/active.jsonl',
      );
    });

    it('leaves non-archived-prefixed paths unchanged (safety net)', () => {
      expect(resolveUnarchivedPath('agents/bot-1/sessions/active.jsonl')).toBe(
        'agents/bot-1/sessions/active.jsonl',
      );
    });
  });
});
