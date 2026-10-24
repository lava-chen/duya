/** Immutable creation facts, separate from the transferable owner record. */
import { readFileSync, writeFileSync } from 'node:fs';
import { CheckoutError } from './errors.js';
import { gitPathAbsolute } from './git.js';

const ORIGIN_FILENAME = 'duya-checkout.json';

export async function writeCheckoutOrigin(root: string, baseSha: string): Promise<void> {
  const target = await gitPathAbsolute(root, ['--git-path', ORIGIN_FILENAME]);
  if (!target) throw new CheckoutError('resolve_failed', `Cannot resolve checkout metadata for ${root}`);
  writeFileSync(target, JSON.stringify({ version: 1, baseSha }), { encoding: 'utf8', flag: 'wx' });
}

/** Missing legacy metadata means unknown; HEAD is never a substitute for base. */
export async function readCheckoutBase(root: string): Promise<string | null> {
  const target = await gitPathAbsolute(root, ['--git-path', ORIGIN_FILENAME]);
  if (!target) throw new CheckoutError('resolve_failed', `Cannot resolve checkout metadata for ${root}`);
  let raw: string;
  try {
    raw = readFileSync(target, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
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
  return parsed.baseSha;
}
