/** Host-owned checkout ownership checks at tool dispatch, independent of approval mode. */
import { lstatSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import { parseCodexPatch } from '@duya/capabilities/ApplyPatchTool/ApplyPatchTool';
import { expandPath } from '@duya/capabilities/utils/path';
import { createCheckoutProvider } from './checkout-provider.js';
import { readOwner } from './checkout-metadata.js';
import { readCheckoutBase } from './checkout-origin.js';
import { hasLinkedGitFile } from './fs-utils.js';
import { gitOrNull } from './git.js';
import { isManagedCheckoutPath } from './paths.js';

const provider = createCheckoutProvider();

export interface CheckoutWriteDenial {
  code: 'checkout_write_denied';
  reason: 'unowned' | 'not_owner' | 'outside_checkout' | 'unreadable';
  root: string;
  message: string;
}

function denied(root: string, reason: CheckoutWriteDenial['reason']): CheckoutWriteDenial {
  const message = reason === 'not_owner'
    ? `Checkout access denied (${reason}) at ${root}. This session does not own this managed checkout. Bash and PowerShell are blocked here even for read-only commands because shell input can write. Do not retry shell; use Read, Grep, or Glob to inspect files. To run shell commands or make changes, resume the owning session or create a checkout for this session with enter_worktree. Permission approval does not transfer checkout ownership.`
    : reason === 'unowned'
      ? `Checkout access denied (${reason}) at ${root}. This managed checkout has no verifiable owner binding, so shell commands and writes are blocked. Use Read, Grep, or Glob for inspection, or create a checkout for this session with enter_worktree. Do not try to claim it through permission approval.`
      : reason === 'outside_checkout'
        ? `Checkout write denied (${reason}) at ${root}. The target is outside this session's owned checkout. Write under the owned checkout or switch to a workspace where this session has write access.`
        : `Checkout access denied (${reason}) at ${root}. The checkout ownership could not be verified, so shell commands and writes are blocked. Use Read, Grep, or Glob for inspection, or resume the owning session. Do not bypass the owner check with permission approval.`;
  return {
    code: 'checkout_write_denied', reason, root,
    message,
  };
}

/** Resolve missing descendants through their existing ancestors; never follow a broken link. */
function canonicalTarget(target: string): string {
  const suffix: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(realpathSync.native(current), ...suffix);
    } catch (error) {
      // A dangling link is not an ordinary missing file we may create.
      let isLink = false;
      try {
        isLink = lstatSync(current).isSymbolicLink();
      } catch (probeError) {
        if (!(probeError instanceof Error && 'code' in probeError && probeError.code === 'ENOENT')) throw probeError;
      }
      if (isLink) throw error;
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Only local file writers and shell commands are covered; arbitrary command paths need OS isolation. */
export async function checkCheckoutToolWrite(input: {
  toolName: string;
  input: Record<string, unknown>;
  workingDirectory?: string | undefined;
  sessionId?: string | undefined;
}): Promise<CheckoutWriteDenial | null> {
  const name = input.toolName.toLowerCase();
  const fileWriter = name === 'write' || name === 'edit' || name === 'apply_patch';
  const shell = name === 'bash' || name === 'powershell';
  if (!fileWriter && !shell) return null;
  // Shell is a write-capable interpreter even when its first command looks
  // read-only. Keep Read/Grep/Glob available rather than trusting heuristics.

  const cwd = input.workingDirectory || process.cwd();
  const checked = new Map<string, { root: string | null; denial: CheckoutWriteDenial | null }>();
  const checkDirectory = async (directory: string) => {
    let probe = directory;
    for (;;) {
      try {
        lstatSync(probe);
        break;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        const parent = path.dirname(probe);
        if (parent === probe) throw error;
        probe = parent;
      }
    }
    const toplevel = (await gitOrNull(probe, ['rev-parse', '--show-toplevel']))?.trim();
    if (!toplevel) {
      return { root: null, denial: isManagedCheckoutPath(directory) ? denied(directory, 'unreadable') : null };
    }
    const root = canonicalTarget(toplevel);
    const cached = checked.get(root);
    if (cached) return cached;
    let result: { root: string | null; denial: CheckoutWriteDenial | null } = { root: null, denial: null };
    if (hasLinkedGitFile(root)) {
      const owner = await readOwner(root);
      if (owner === 'unreadable') return { root, denial: denied(root, 'unreadable') };
      const managed = owner !== null || isManagedCheckoutPath(root) || await readCheckoutBase(root) !== null;
      if (managed) {
        const permission = await provider.assertWritable(probe, input.sessionId ?? '');
        result = {
          root,
          denial: permission.ok ? null : denied(root, permission.reason === 'not_a_checkout' ? 'unreadable' : permission.reason),
        };
      }
    }
    checked.set(root, result);
    return result;
  };

  try {
    const source = await checkDirectory(cwd);
    if (source.denial) return source.denial;
    if (!fileWriter) return null;

    const targets = name === 'apply_patch'
      ? (typeof input.input.patch === 'string' ? parseCodexPatch(input.input.patch).map((op) => path.resolve(cwd, op.path)) : [])
      : (typeof input.input.file_path === 'string' ? [expandPath(input.input.file_path, cwd)] : []);
    // Validate every target before the executor can mutate the first file.
    for (const target of targets) {
      const canonical = canonicalTarget(target);
      if (source.root) {
        if (!inside(source.root, canonical)) return denied(source.root, 'outside_checkout');
      } else {
        const destination = await checkDirectory(path.dirname(canonical));
        if (destination.denial) return destination.denial;
      }
    }
    return null;
  } catch {
    return denied(cwd, 'unreadable');
  }
}
