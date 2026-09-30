/**
 * archive-paths.ts — Plan 549 (Track A), corrected by Plan 582 (G1).
 *
 * Single source of truth for where archived rollout JSONL files live on
 * disk. Mirrors codex's `archived_sessions/` convention but stays inside the
 * existing rollout root so a partial migration or downgrade keeps the data on
 * the same volume.
 *
 * Layout:
 *   <rolloutRoot>/sessions/<YYYY>/<MM>/<DD>/rollout-<stamp>-<id>.jsonl   (human, single file)
 *   <rolloutRoot>/sessions/<YYYY>/<MM>/<DD>/<sanitized-id>/             (rotated human session)
 *       active.jsonl + archive-<g>.jsonl …
 *   <rolloutRoot>/agents/<agentId>/sessions/active.jsonl                (bot, generation layout)
 *   <rolloutRoot>/archived/<YYYY-MM-DD>/<full mirrored rel path>         (archived)
 *
 * `archivedPath` stored on the session row is *relative to the rollout root*
 * — the same convention `MessageLog` already uses for `rollout_path`. The
 * archive destination MIRRORS the source path under an `archived/<date>/`
 * prefix, which makes the mapping lossless: unarchive is a pure prefix strip,
 * with no need to reconstruct the date tree or the bot's agent directory.
 *
 * That property is what Plan 549 got wrong. The old implementation collapsed
 * the destination to `archived/<date>/<basename>`, so:
 *   - a rotated session's `archive-<g>.jsonl` siblings were left behind as
 *     orphans and the session's visible history silently truncated, and
 *   - every bot session shares the basename `active.jsonl`, so two bots
 *     archived on the same day collided on one destination path.
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

/** Number of leading segments that make up the `archived/<date>/` prefix. */
const ARCHIVE_PREFIX_SEGMENTS = 2;

function isArchivedRel(rel: string): boolean {
  const parts = rel.split('/');
  return parts.length > ARCHIVE_PREFIX_SEGMENTS && parts[0] === 'archived' && /^\d{4}-\d{2}-\d{2}$/.test(parts[1]);
}

/**
 * Compute the archived path for a rollout-relative file path.
 *
 * The whole source path is mirrored under `archived/<date>/` so that
 * `resolveUnarchivedPath` is an exact inverse for every layout, including
 * bot sessions and session-private generation directories. The bucket date
 * uses `nowMs` (default `Date.now()`) so a session archived and unarchived
 * repeatedly never collides with its own earlier archive.
 *
 * Already-archived paths are returned unchanged, which keeps the operation
 * idempotent at the path level.
 */
export function resolveArchivedPath(currentRel: string, nowMs: number = Date.now()): string {
  if (isArchivedRel(currentRel)) return currentRel;
  return path.posix.join('archived', formatArchiveDate(nowMs), currentRel);
}

/**
 * Inverse: strip the `archived/<date>/` prefix to recover the original
 * rollout-relative path. Paths without that prefix are returned unchanged.
 */
export function resolveUnarchivedPath(archivedRel: string): string {
  if (!isArchivedRel(archivedRel)) return archivedRel;
  return archivedRel.split('/').slice(ARCHIVE_PREFIX_SEGMENTS).join('/');
}

/**
 * The archived *directory* that holds a given archived file path.
 *
 * This is what the session row stores in `archived_path`: a session's
 * generation layout spans several sibling files that must move together, so
 * the row records the shared destination directory rather than a single file.
 */
export function archivedDirFor(archivedRel: string): string {
  if (!isArchivedRel(archivedRel)) return archivedRel;
  const dir = path.posix.dirname(archivedRel);
  // Never report the bare `archived/<date>` bucket as a session directory —
  // that would be shared by every session archived that day.
  const segments = dir.split('/');
  if (segments.length <= ARCHIVE_PREFIX_SEGMENTS) return dir;
  return dir;
}

/**
 * The `archived/<date>/` prefix a session's files were mirrored under, so a
 * caller can enumerate sibling segments (`archive-<g>.jsonl`) that were
 * archived alongside the recorded path.
 */
export function archivedPrefixFor(archivedRel: string): string {
  const dir = archivedDirFor(archivedRel);
  const segments = dir.split('/');
  return segments.slice(0, ARCHIVE_PREFIX_SEGMENTS).join('/');
}
