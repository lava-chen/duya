/**
 * apps/desktop/src/main/ipc/agents-md-handlers.ts
 *
 * The `workspace:init-agents-md` channel — the Desktop's `/init`.
 *
 * codex's `/init` creates an `AGENTS.md` at the root of the code repository so
 * that every agent that opens the checkout reads the same instructions. This
 * handler does that for the Desktop.
 *
 * ## What comes from the Host layer
 *
 * The WRITE itself is the Host's: `@duya/host/agents-md` owns the template,
 * the marker, the repository-root resolution and the idempotent atomic write,
 * so the CLI and the Desktop write byte-identical files. This file is the
 * Desktop's half: it resolves the session, decides WHICH directory may be
 * written, and hands the root to the Host.
 *
 * ## Why the channel takes a SESSION ID and not a path
 *
 * The file NAME is fixed (`AGENTS.md`) — it is not user input. The DIRECTORY
 * is the repository the session sits in, and a renderer-supplied path would
 * let a compromised frame point the write at any directory on the machine. So
 * the handler accepts the session id, resolves the session's working directory
 * from the store the Desktop owns, and narrows that to the repository root.
 *
 * The narrowing is `resolveAgentsMdRoot`: the git toplevel when the directory
 * is inside a checkout, the directory itself otherwise. It never WIDENS the
 * session's directory — a git root is an ANCESTOR of it — and the check below
 * proves that: the session's directory must still be inside the root.
 *
 * ## Trust
 *
 * `assertTrustedSender` is the FIRST statement, before the session id is
 * read, and it fails CLOSED.
 */

import { ipcMain } from 'electron';
import * as path from 'node:path';

import { isPathWithinRoots } from '@duya/sandbox';
import { resolveAgentsMdRoot, writeInitAgentsMd } from '@duya/host/agents-md';
import type { InitAgentsMdResult } from '@duya/agent-protocol';

import { assertTrustedSender } from './trusted-sender';
import { getCoreStoresOrNull } from '../db/core-connection';

/** The channel the renderer invokes. */
export const INIT_AGENTS_MD_CHANNEL = 'workspace:init-agents-md';

/** A failed write, with the reason. */
function failure(error: string): InitAgentsMdResult {
  return { ok: false, created: false, upgraded: false, unchanged: false, version: 0, error };
}

/**
 * Resolve the working directory of a session.
 *
 * Returns the reason on failure rather than throwing, so the renderer gets a
 * message it can show instead of a rejected promise.
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
    return { error: 'This session has no working directory, so there is no repository to write to.' };
  }
  if (!path.isAbsolute(workingDirectory)) {
    return { error: 'The session working directory is not an absolute path.' };
  }
  return { path: workingDirectory };
}

/**
 * The directory the AGENTS.md goes into, and the file itself.
 *
 * Exported so the boundary decision can be exercised without an Electron
 * event: the root has to CONTAIN the session's working directory, and the
 * target has to be the fixed file name inside that root.
 */
export async function resolveAgentsMdTarget(
  workingDirectory: string,
): Promise<{ root: string; target: string } | { error: string }> {
  const root = await resolveAgentsMdRoot(workingDirectory);
  // The root must contain the session's directory. `isPathWithinRoots` does
  // the lexical check (resolve + relative) AND the symlink-escape check
  // (realpath against realpath); a root it cannot anchor is skipped, which
  // makes the check fail rather than pass by accident.
  if (!isPathWithinRoots(workingDirectory, [root])) {
    return { error: 'The session working directory is not inside the resolved repository root.' };
  }
  return { root, target: path.join(root, 'AGENTS.md') };
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

    const target = await resolveAgentsMdTarget(resolved.path);
    if ('error' in target) return failure(target.error);

    return writeInitAgentsMd(target.root);
  });
}
