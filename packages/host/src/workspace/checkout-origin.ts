/**
 * Immutable creation facts, separate from the transferable owner record.
 *
 * `createdAt` is recorded for cleanup ordering only. It is evidence, not a
 * lease: no deletion decision may be derived from it (plan 621 decision D4).
 * The field is optional so metadata written by earlier builds stays valid;
 * callers that need an order fall back to the checkout directory's mtime.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { CheckoutError } from './errors.js';
import { gitPathAbsolute } from './git.js';
import { OWNER_FILENAME } from './checkout-metadata.js';

export const ORIGIN_FILENAME = 'duya-checkout.json';

export async function writeCheckoutOrigin(
  root: string,
  baseSha: string,
  operationId?: string,
  createdAt: number = Date.now(),
): Promise<void> {
  const target = await gitPathAbsolute(root, ['--git-path', ORIGIN_FILENAME]);
  if (!target) throw new CheckoutError('resolve_failed', `Cannot resolve checkout metadata for ${root}`);
  writeFileSync(
    target,
    JSON.stringify({
      version: 1,
      baseSha,
      createdAt,
      ...(operationId ? { operationId } : {}),
    }),
    { encoding: 'utf8', flag: 'wx' },
  );
}

/** Missing legacy metadata means unknown; HEAD is never a substitute for base. */
export async function readCheckoutBase(root: string): Promise<string | null> {
  return (await readCheckoutOrigin(root))?.baseSha ?? null;
}

export interface CheckoutOrigin {
  readonly baseSha: string;
  readonly operationId?: string;
  /** Epoch milliseconds; absent for metadata written before the field existed. */
  readonly createdAt?: number;
}

export async function readCheckoutOrigin(root: string): Promise<CheckoutOrigin | null> {
  const target = await gitPathAbsolute(root, ['--git-path', ORIGIN_FILENAME]);
  if (!target) throw new CheckoutError('resolve_failed', `Cannot resolve checkout metadata for ${root}`);
  let raw: string;
  try {
    raw = readFileSync(target, 'utf8');
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return null;
    throw new CheckoutError('resolve_failed', `Cannot read checkout metadata for ${root}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CheckoutError('resolve_failed', `Invalid checkout metadata for ${root}`);
  }
  if (typeof parsed !== 'object' || parsed === null || !('version' in parsed) || parsed.version !== 1
    || !('baseSha' in parsed) || typeof parsed.baseSha !== 'string'
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(parsed.baseSha)) {
    throw new CheckoutError('resolve_failed', `Invalid checkout metadata for ${root}`);
  }
  if ('operationId' in parsed && typeof parsed.operationId !== 'string') {
    throw new CheckoutError('resolve_failed', `Invalid checkout operation metadata for ${root}`);
  }
  if ('createdAt' in parsed
    && (typeof parsed.createdAt !== 'number' || !Number.isFinite(parsed.createdAt) || parsed.createdAt <= 0)) {
    throw new CheckoutError('resolve_failed', `Invalid checkout creation time for ${root}`);
  }
  return {
    baseSha: parsed.baseSha,
    ...('operationId' in parsed ? { operationId: parsed.operationId as string } : {}),
    ...('createdAt' in parsed ? { createdAt: parsed.createdAt as number } : {}),
  };
}

/**
 * Whether this git directory carries a duya-managed marker.
 *
 * Existence only: a malformed marker still proves duya created the checkout,
 * and list/cleanup treat unreadable metadata as a reason to retain, not as
 * permission to ignore the directory. Owner and origin live in the same git
 * directory for a linked worktree.
 */
export function hasCheckoutIdentity(gitDir: string): boolean {
  return existsSync(path.join(gitDir, ORIGIN_FILENAME)) || existsSync(path.join(gitDir, OWNER_FILENAME));
}

function isErrorCode(error: unknown, code: string): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return (error as { code?: unknown }).code === code;
}
