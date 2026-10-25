/**
 * The Host's `/init` write.
 *
 * ## Why the client sends a session id and never a path
 *
 * The repository-root `AGENTS.md` lives in a directory the CLIENT does not
 * own: the workspace may be on another machine, and the Host's own contract
 * deliberately never exposes a resolved filesystem path to a client (a
 * workspace binding carries a workspace id and a relative path, never the
 * absolute one). A path in a client request would therefore be a path the
 * client made up, and a path the client made up is a path an attacker
 * chooses.
 *
 * So the client names a SESSION, the Host looks up the session it owns, and
 * the Host resolves the working directory itself. The write lands in the
 * session's own checkout, and nowhere else.
 */

import type { HostAgentsMdApiV1, InitAgentsMdResult } from '@duya/agent-protocol/doctor';

import { resolveAgentsMdRoot, writeInitAgentsMd } from './agents-md/index.js';

/** The session row the Host needs: an id and the directory it runs in. */
export interface HostAgentsMdSession {
  readonly workingDirectory: string;
}

/** The slice of the session store this API reads. */
export interface HostAgentsMdSessionReader {
  get(sessionId: string): HostAgentsMdSession | null;
}

/** A failed write, with the reason. */
function failure(error: string): InitAgentsMdResult {
  return { ok: false, created: false, upgraded: false, unchanged: false, version: 0, error };
}

/**
 * The Host's AGENTS.md capability.
 *
 * `sessions` is the Host's own session store — the rows it owns, not rows a
 * client supplied.
 */
export function createHostLocalAgentsMdApi(sessions: HostAgentsMdSessionReader): HostAgentsMdApiV1 {
  return {
    async writeAgentsMd(input): Promise<InitAgentsMdResult> {
      const sessionId = input.sessionId.trim();
      if (!sessionId) return failure('A session id is required.');

      const session = sessions.get(sessionId);
      if (!session) return failure(`No session named "${sessionId}".`);

      const workingDirectory = session.workingDirectory?.trim();
      if (!workingDirectory) {
        return failure('This session has no working directory, so there is no repository root to write to.');
      }

      try {
        const root = await resolveAgentsMdRoot(workingDirectory);
        return await writeInitAgentsMd(root);
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
