/**
 * apps/desktop/src/main/ipc/agents-md-handlers.ts
 *
 * The `workspace:init-agents-md` channel — the Desktop's `/init`.
 *
 * codex's `/init` creates an `AGENTS.md` at the root of the code repository
 * so that every agent that opens the checkout reads the same instructions.
 * This handler does that for the Desktop.
 *
 * ## Why the channel takes a SESSION ID and not a path
 *
 * The file NAME is fixed (`AGENTS.md`) — it is not user input. The
 * DIRECTORY is: the working directory of the session the command was typed
 * in. A renderer-supplied path would let a compromised frame point the write
 * at any directory on the machine, so the handler accepts the session id
 * instead and resolves the directory itself, from the session row it owns.
 *
 * The resolved directory is then checked with the same root-boundary
 * primitive the sandboxed file tools use (`isPathWithinRoots`): a lexical
 * check (resolve + relative) AND a symlink-escape check (realpath against
 * realpath). The target does not exist yet on the create path, so the
 * lexical check is the best available guarantee — and it is a guarantee,
 * because the target is always `AGENTS.md` inside the root.
 *
 * ## Trust
 *
 * `assertTrustedSender` is the FIRST statement, before the session id is
 * read, and it fails CLOSED.
 */

import { ipcMain } from 'electron';
import * as path from 'node:path';

import { isPathWithinRoots } from '@duya/sandbox';

import { assertTrustedSender } from './trusted-sender';
import { ensureRepoAgentsMd } from './agents-md-writer';
import { getCoreStoresOrNull } from '../db/core-connection';

import type { InitAgentsMdResult } from '../../contracts/doctor';

/** The channel the renderer invokes. */
export const INIT_AGENTS_MD_CHANNEL = 'workspace:init-agents-md';

/** A failed write, with the reason. */
function failure(error: string): InitAgentsMdResult {
  return { ok: false, created: false, upgraded: false, unchanged: false, version: 0, error };
}

/**
 * Resolve the working directory of a session.
 *
 * Returns the reason on failure rather than throwing, so the renderer gets
 * a message it can show instead of a rejected promise.
 */
function resolveSessionWorkingDirectory(sessionId: string): { path?: string; error?: string } {
  const stores = getCoreStoresOrNull();
  if (!stores) {
    return { error: 'The core database is not initialized, so the session cannot be resolved.' };
  }
  let session;
  try {
    session = stores.sessions.get(sessionId);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (!session) return { error: `No session named "${sessionId}".` };

  const workingDirectory = session.workingDirectory?.trim();
  if (!workingDirectory) {
    return { error: 'This session has no working directory, so there is no repository root to write to.' };
  }
  if (!path.isAbsolute(workingDirectory)) {
    return { error: 'The session working directory is not an absolute path.' };
  }
  return { path: workingDirectory };
}

/** Register the workspace AGENTS.md channels. */
export function registerAgentsMdHandlers(): void {
  ipcMain.handle(INIT_AGENTS_MD_CHANNEL, async (event, rawSessionId: unknown) => {
    // Guard first, before the argument is read.
    assertTrustedSender(event, {}, INIT_AGENTS_MD_CHANNEL);

    const sessionId = typeof rawSessionId === 'string' ? rawSessionId.trim() : '';
    if (!sessionId) return failure('A session id is required.');

    const resolved = resolveSessionWorkingDirectory(sessionId);
    if (!resolved.path) return failure(resolved.error ?? 'The session could not be resolved.');

    const root = resolved.path;
    const target = path.join(root, 'AGENTS.md');
    // The root must contain the target, and the root must be readable: the
    // boundary primitive silently skips a root it cannot anchor, so a root
    // that cannot be resolved fails the check instead of passing it.
    if (!isPathWithinRoots(target, [root])) {
      return failure('The session working directory does not contain the target file.');
    }

    try {
      const result = ensureRepoAgentsMd(root);
      return {
        ok: true,
        path: result.path,
        created: result.created,
        upgraded: result.upgraded,
        unchanged: result.unchanged,
        version: result.version,
        ...(result.replacedUnmarked ? { replacedUnmarked: true } : {}),
      } satisfies InitAgentsMdResult;
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error));
    }
  });
}
