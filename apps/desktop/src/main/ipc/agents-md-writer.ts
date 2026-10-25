/**
 * apps/desktop/src/main/ipc/agents-md-writer.ts
 *
 * Writing the repository-root `AGENTS.md` — the file `/init` creates.
 *
 * ## Idempotency
 *
 * The file is only rewritten when duya can tell that IT wrote it:
 *
 *   - no file            -> create
 *   - marker version >= current -> leave alone (the user may have edited it)
 *   - marker version <  current -> rewrite
 *   - no marker at all   -> treated as version 0, so it is rewritten
 *
 * The last row is the one worth arguing about. It is the rule the project
 * seeder uses (`ensureProjectAgentsMd`), and it is right THERE because that
 * directory is duya's own. In a user's repository a marker-less AGENTS.md is
 * almost certainly the user's, so `replacedUnmarked` is reported separately
 * and the caller can say so out loud.
 *
 * ## Atomicity
 *
 * The write goes to a temporary file in the same directory and is then
 * renamed over the target, so a reader never sees a half-written AGENTS.md.
 * Same shape as `ensureProjectAgentsMd`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  buildInitAgentsMdTemplate,
  INIT_AGENTS_MD_MARKER_REGEX,
  INIT_AGENTS_MD_VERSION,
  readInitAgentsMdVersion,
} from '@duya/host/agents-md/init-template';

/** What the write did. */
export interface AgentsMdWriteResult {
  /** Absolute path of the AGENTS.md. */
  readonly path: string;
  /** The file did not exist and was created. */
  readonly created: boolean;
  /** A file duya had written before was brought up to the current template. */
  readonly upgraded: boolean;
  /** The file was already current and was NOT touched. */
  readonly unchanged: boolean;
  /** A file WITHOUT a duya marker was overwritten. */
  readonly replacedUnmarked: boolean;
  /** The template version now recorded in the file. */
  readonly version: number;
}

/** The file name duya writes. Fixed — never derived from user input. */
export const REPO_AGENTS_MD_FILENAME = 'AGENTS.md';

/**
 * Write (or refresh) the AGENTS.md at the root of `root`.
 *
 * `root` must be an existing directory; the caller is responsible for the
 * boundary check that decides WHICH directory may be written.
 */
export function ensureRepoAgentsMd(root: string, now: Date = new Date()): AgentsMdWriteResult {
  const target = path.join(root, REPO_AGENTS_MD_FILENAME);
  const content = buildInitAgentsMdTemplate({
    repoName: path.basename(root) || root,
    createdAt: now.toISOString().slice(0, 10),
  });

  if (!fs.existsSync(target)) {
    writeAtomic(target, content);
    return {
      path: target,
      created: true,
      upgraded: false,
      unchanged: false,
      replacedUnmarked: false,
      version: INIT_AGENTS_MD_VERSION,
    };
  }

  const existing = fs.readFileSync(target, 'utf-8');
  const recorded = readInitAgentsMdVersion(existing);
  // A file with NO marker at all is the user's own; a file whose marker says
  // version 0 was written by duya and only needs an upgrade. The two look
  // identical to the version reader, so the marker is matched separately.
  const hasMarker = INIT_AGENTS_MD_MARKER_REGEX.test(existing);
  if (recorded >= INIT_AGENTS_MD_VERSION) {
    // The user may have edited this file. Never overwrite it.
    return {
      path: target,
      created: false,
      upgraded: false,
      unchanged: true,
      replacedUnmarked: false,
      version: recorded,
    };
  }

  writeAtomic(target, content);
  return {
    path: target,
    created: false,
    upgraded: true,
    unchanged: false,
    replacedUnmarked: !hasMarker,
    version: INIT_AGENTS_MD_VERSION,
  };
}

/**
 * Write through a temporary file in the same directory, then rename.
 *
 * The rename is the atomic step on both POSIX and Windows when the target
 * exists: `renameSync` replaces the destination in one filesystem operation.
 */
function writeAtomic(target: string, content: string): void {
  const temp = `${target}.tmp`;
  try {
    fs.writeFileSync(temp, content, 'utf-8');
    fs.renameSync(temp, target);
  } catch (error) {
    // Never leave the scratch file behind on failure.
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // The write already failed; a leftover temp file is the lesser problem.
    }
    throw error;
  }
}
