/**
 * archive-paths.ts — Plan 549 (Track A): rollout archive path resolution.
 *
 * Single source of truth for where archived rollout JSONL files live on
 * disk. Mirrors codex's `archived_sessions/` convention but lives inside
 * the existing rollout root so a partial migration or downgrade keeps the
 * data on the same volume.
 *
 * Layout:
 *   <rolloutRoot>/sessions/<YYYY>/<MM>/<DD>/rollout-<stamp>-<id>.jsonl  (active)
 *   <rolloutRoot>/agents/<agentId>/sessions/active.jsonl                (active bot)
 *   <rolloutRoot>/archived/<YYYY-MM-DD>/<basename>                      (archived)
 *
 * `archivedPath` stored on the session row is *relative to the rollout
 * root* — the same convention `MessageLog` already uses for `rollout_path`
 * (see resolvePath in message-log.ts). Callers join it with the resolved
 * rollout root to get an absolute path.
 */

import path from 'node:path';

/** YYYY-MM-DD prefix used in the archived/ bucket. */
export function formatArchiveDate(unixMs: number): string {
  const d = new Date(unixMs);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Compute the archived rollout-relative path for a session whose rollout
 * currently lives at `currentRel` (also rollout-relative). The basename is
 * preserved so the file identity is stable across archive/unarchive cycles;
 * the date bucket groups archives by archive-time so a single session that
 * is archived and unarchived multiple times does not collide with itself.
 *
 * The bucket date uses `nowMs` (default `Date.now()`); tests pass an
 * explicit value to keep the assertion deterministic.
 */
export function resolveArchivedPath(
  currentRel: string,
  nowMs: number = Date.now(),
): string {
  const bucket = formatArchiveDate(nowMs);
  // POSIX join keeps the stored path portable — the active path is also
  // POSIX-style (see MessageLog.resolvePath).
  return path.posix.join('archived', bucket, path.posix.basename(currentRel));
}

/** Inverse: archived-relative path back to a sensible active-relative path. */
export function resolveUnarchivedPath(archivedRel: string): string {
  // Drop the `archived/<date>/` prefix; the basename keeps its identity.
  const parts = archivedRel.split('/');
  // Expect ['archived', '<date>', '<basename>'] — fall back to original.
  if (parts.length >= 3 && parts[0] === 'archived') {
    return path.posix.join('sessions', parts.slice(2).join('/'));
  }
  return archivedRel;
}
