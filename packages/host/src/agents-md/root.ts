/**
 * packages/host/src/agents-md/root.ts
 *
 * Where the repository-root `AGENTS.md` goes.
 *
 * ## Why the root is not the session's working directory
 *
 * A session usually starts in a subdirectory — `packages/cli`, `apps/desktop`.
 * Writing the repository's `AGENTS.md` there would put a repository-wide
 * contract in a subdirectory, where no agent that opens the repository root
 * would read it. The file belongs at the root of the checkout.
 *
 * `git rev-parse --show-toplevel` answers that question exactly, and exactly
 * for a git checkout. A directory that is not a git checkout has no root to
 * find, so the working directory itself is the root there.
 *
 * ## Why the answer is not trusted blindly
 *
 * The caller has already decided that this working directory belongs to the
 * session (the Host resolved it from its own store; the desktop validated it
 * against the session's roots). This function only narrows it to the
 * repository root, and it never widens it: a git root is an ancestor of the
 * working directory, and the fallback is the working directory itself.
 */

import * as path from 'node:path';

import { gitOrNull } from '../workspace/git.js';

/**
 * The repository root for a working directory.
 *
 * Returns the git toplevel when the directory is inside a checkout, and the
 * working directory itself otherwise. Never returns an empty string: a
 * directory the caller resolved is the answer when there is nothing better.
 */
export async function resolveAgentsMdRoot(workingDirectory: string): Promise<string> {
  const absolute = path.resolve(workingDirectory);
  const toplevel = await gitOrNull(absolute, ['rev-parse', '--show-toplevel']);
  const trimmed = toplevel?.trim();
  if (trimmed) return path.resolve(trimmed);
  return absolute;
}
