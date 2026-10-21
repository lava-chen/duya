/** Compatibility adapter for the Host-owned recent session directory. */
import { loadRecentSessionDirectory as loadHostRecentSessionDirectory } from '@duya/host/worker-session/recent-session-directory';
import { listSessionsAsync } from './db.js';
import type {
  RecentSessionDirectory,
  RecentSessionDirectoryOptions,
  RecentSessionRecord,
} from '@duya/host/worker-session/recent-session-directory';

export {
  buildRecentSessionDirectory,
  matchesSessionDirectoryScope,
  normalizeProjectDirectory,
  sanitizeSessionMetadata,
} from '@duya/host/worker-session/recent-session-directory';
export type {
  RecentSessionDirectory,
  RecentSessionDirectoryEntry,
  RecentSessionDirectoryOptions,
  RecentSessionRecord,
  SessionDirectoryScope,
} from '@duya/host/worker-session/recent-session-directory';

export function loadRecentSessionDirectory(
  options: RecentSessionDirectoryOptions,
): Promise<RecentSessionDirectory> {
  return loadHostRecentSessionDirectory(
    options,
    async () => (await listSessionsAsync()).map((session) => ({
      id: session.id,
      title: session.title,
      working_directory: session.working_directory,
      project_name: session.project_name,
      updated_at: session.updated_at,
      is_deleted: session.is_deleted,
      parent_id: session.parent_id,
      parent_session_id: session.parent_session_id,
      agent_type: session.agent_type,
    } satisfies RecentSessionRecord)),
  );
}
