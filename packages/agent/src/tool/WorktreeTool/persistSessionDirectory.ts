/**
 * Best-effort persistence of the session's working directory (plan 441).
 *
 * Outside the agent worker (unit tests, standalone CLI) `process.send` is
 * absent and the db client throws on use — swallow and log: the in-memory
 * switch has already taken effect, persistence is a UI-convenience mirror.
 */

import { sessionDb } from '../../ipc/db-client.js';
import { logger } from '../../utils/logger.js';

export async function persistSessionWorkingDirectory(
  sessionId: string,
  directory: string,
): Promise<void> {
  try {
    await sessionDb.update(sessionId, { working_directory: directory, updated_at: Date.now() });
  } catch (err) {
    logger.warn('[Worktree] failed to persist session working directory', {
      sessionId,
      err,
    }, 'Worktree');
  }
}
