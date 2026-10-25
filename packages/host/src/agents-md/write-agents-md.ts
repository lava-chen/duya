/**
 * packages/host/src/agents-md/write-agents-md.ts
 *
 * Writing the repository-root `AGENTS.md`.
 *
 * ## The write is idempotent
 *
 * `/init` may be run twice, on a file duya wrote, on a file the user edited,
 * or on a file the user wrote from scratch. The three are different facts and
 * they get different answers:
 *
 *  - a file duya wrote at the CURRENT version is left alone — the user may
 *    have edited it, and overwriting their edits would be rude;
 *  - a file duya wrote at an OLDER version is rewritten with the new
 *    template — that file carries no user intent, because duya wrote all of
 *    it;
 *  - a file with NO duya marker is the user's own. It counts as version 0 and
 *    is overwritten, but the result says so (`replacedUnmarked`), because
 *    silently replacing a hand-written contract is not something to do
 *    quietly.
 *
 * ## The write is atomic
 *
 * The file is written to a temporary path and renamed over the target, so a
 * reader — an agent reading the repository while `/init` runs — never sees a
 * half-written `AGENTS.md`.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { InitAgentsMdResult } from '@duya/agent-protocol/doctor';

import {
  buildInitAgentsMdTemplate,
  INIT_AGENTS_MD_VERSION,
  readInitAgentsMdVersion,
} from './init-template.js';

/** The file `/init` writes. A fixed name, never user input. */
export const AGENTS_MD_FILENAME = 'AGENTS.md';

/** `YYYY-MM-DD` in local time — the date the scaffold was seeded. */
function today(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/** Read a file, treating "not there" as an empty body. */
async function readIfPresent(target: string): Promise<string | null> {
  try {
    return await fs.readFile(target, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Write the repository-root `AGENTS.md` under `root`.
 *
 * The caller has already decided that `root` is the repository root (see
 * `root.ts`); this function does not look at git, and it does not decide where
 * the file goes beyond joining the fixed name onto `root`.
 */
export async function writeInitAgentsMd(root: string): Promise<InitAgentsMdResult> {
  const target = path.join(root, AGENTS_MD_FILENAME);
  const existing = await readIfPresent(target);

  if (existing !== null) {
    const recorded = readInitAgentsMdVersion(existing);
    if (recorded >= INIT_AGENTS_MD_VERSION) {
      return {
        ok: true,
        path: target,
        created: false,
        upgraded: false,
        unchanged: true,
        version: recorded,
      };
    }
  }

  const content = buildInitAgentsMdTemplate({
    repoName: path.basename(path.resolve(root)),
    createdAt: today(),
  });

  // Temp + rename: a reader never sees a half-written file.
  const tempPath = `${target}.tmp`;
  try {
    await fs.writeFile(tempPath, content, 'utf8');
    await fs.rename(tempPath, target);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    return {
      ok: false,
      path: target,
      created: false,
      upgraded: false,
      unchanged: false,
      version: existing === null ? 0 : readInitAgentsMdVersion(existing),
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const marked = existing !== null && readInitAgentsMdVersion(existing) > 0;
  return {
    ok: true,
    path: target,
    created: existing === null,
    upgraded: existing !== null && marked,
    unchanged: false,
    version: INIT_AGENTS_MD_VERSION,
    // A file with no duya marker was the user's own; say so out loud.
    ...(existing !== null && !marked ? { replacedUnmarked: true } : {}),
  };
}
