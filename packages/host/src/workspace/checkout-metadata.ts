/**
 * Owner file: the single source of truth for "which session may write here".
 *
 * The shape is codex-compatible (`codex-thread.json`, `{version:1,ownerThreadId}`)
 * and lives in the checkout's git directory, not in a database. That is
 * decision D2: a second table would be a second truth that cannot be
 * reconciled with git after a crash. The file travels with the checkout, so
 * `git worktree list` plus this file are enough to answer "who owns it".
 *
 * Exclusive creation is real, not advisory. `existsSync` followed by
 * `writeFile` has a time-of-check/time-of-use window in which two sessions
 * both see "no owner" and both write. Instead the record is written to a
 * sibling temporary file and published with `linkSync`, which fails with
 * EEXIST when the target already exists. That is the same primitive as
 * codex's `persist_noclobber`, and the exclusion is enforced by the
 * filesystem rather than by this process.
 */

import { randomBytes } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { CheckoutOwner } from './types.js';
import { CheckoutOwnerError } from './errors.js';
import { gitPathAbsolute } from './git.js';

/** Codex Desktop reads this exact file name from the worktree git dir. Keep it. */
const OWNER_FILENAME = 'codex-thread.json';
const OWNER_VERSION = 1;

/** A malformed file must not be mistaken for "no owner". */
export type OwnerRead = CheckoutOwner | null | 'unreadable';

function errorCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null || !('code' in err)) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/**
 * The owner file is a git path, so it lands in `.git/worktrees/<name>/` for a
 * linked worktree; `path.join(root, rel)` is the documented fallback for git
 * builds that ignore `--path-format`.
 */
export async function ownerPath(root: string): Promise<string> {
  const resolved = await gitPathAbsolute(root, ['--git-path', OWNER_FILENAME]);
  if (resolved) return path.resolve(resolved);
  throw new CheckoutOwnerError(
    'owner_io',
    `cannot resolve the git path of ${OWNER_FILENAME} for ${root}`,
  );
}

interface OwnerRecord {
  version: number;
  ownerThreadId: string;
}

/**
 * Validate the record strictly: `version === 1`, a non-empty id, and NO extra
 * fields. Codex deserializes with `deny_unknown_fields`, so a file this code
 * accepts but codex rejects (or the reverse) would make two products disagree
 * about who owns a checkout.
 */
function parseOwnerRecord(raw: string): OwnerRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.includes('version') || !keys.includes('ownerThreadId')) return null;

  const version = record['version'];
  const ownerThreadId = record['ownerThreadId'];
  if (version !== OWNER_VERSION) return null;
  if (typeof ownerThreadId !== 'string' || ownerThreadId.trim().length === 0) return null;

  return { version, ownerThreadId };
}

export async function readOwner(root: string): Promise<OwnerRead> {
  let target: string;
  try {
    target = await ownerPath(root);
  } catch {
    return 'unreadable';
  }

  let raw: string;
  try {
    raw = readFileSync(target, 'utf8');
  } catch (err) {
    return errorCode(err) === 'ENOENT' ? null : 'unreadable';
  }

  const record = parseOwnerRecord(raw);
  if (!record) return 'unreadable';

  // `boundAt` is evidence, not a lease: a file mtime is what we have, and the
  // contract forbids deriving any decision from it.
  let boundAt = Date.now();
  try {
    boundAt = statSync(target).mtimeMs;
  } catch {
    boundAt = Date.now();
  }

  return { sessionId: record.ownerThreadId, boundAt };
}

export interface BindOwnerOptions {
  /**
   * Replace an existing owner instead of refusing. Only `bind(..., 'prove-dead')`
   * may ask for this, and only after `isSessionAlive` returned false.
   */
  replace?: boolean;
}

/**
 * Publish `sessionId` as the owner.
 *
 * Without `replace`, this is exclusive: the hard link fails if a target exists,
 * including when another process created it between our read and our write.
 * Binding the same id again succeeds (idempotent); a different id raises a
 * typed conflict.
 */
export async function bindOwner(
  root: string,
  sessionId: string,
  options: BindOwnerOptions = {},
): Promise<void> {
  const owner = sessionId.trim();
  if (!owner) {
    throw new CheckoutOwnerError('invalid_session', 'checkout owner session id cannot be empty');
  }

  const target = await ownerPath(root);
  const directory = path.dirname(target);
  mkdirSync(directory, { recursive: true });

  const temporary = path.join(
    directory,
    `${OWNER_FILENAME}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  const payload = JSON.stringify({ version: OWNER_VERSION, ownerThreadId: owner });
  writeFileSync(temporary, payload, { encoding: 'utf8', flag: 'wx' });

  try {
    if (options.replace === true) {
      // rename is atomic and leaves no window where the checkout looks unowned.
      renameSync(temporary, target);
      return;
    }

    try {
      linkSync(temporary, target);
      return;
    } catch (err) {
      if (errorCode(err) !== 'EEXIST') throw err;

      const existing = await readOwner(root);
      if (existing === 'unreadable') {
        throw new CheckoutOwnerError(
          'owner_unreadable',
          `checkout at ${root} has an owner file that cannot be read; refusing to guess`,
        );
      }
      if (existing === null) {
        // Owner was cleared between the link and the read: try once more.
        linkSync(temporary, target);
        return;
      }
      if (existing.sessionId === owner) return;
      throw new CheckoutOwnerError(
        'owner_conflict',
        `checkout at ${root} is already owned by ${existing.sessionId}`,
      );
    }
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // Already renamed into place, or the link never existed.
    }
  }
}

/**
 * Remove the owner file. Only `release` and `reclaim` may call this; a missing
 * file is success (release is idempotent).
 */
export async function clearOwner(root: string): Promise<void> {
  const target = await ownerPath(root);
  try {
    unlinkSync(target);
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return;
    throw new CheckoutOwnerError('owner_io', `cannot clear checkout owner at ${target}`);
  }
}
