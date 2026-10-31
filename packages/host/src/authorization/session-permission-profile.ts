import { sessionDb } from '@duya/host/worker-db-client';

/**
 * The permission profile a session row carries, in the row's own spelling
 * (`default` / `auto` / `full_access`).
 */
export type SessionRowPermissionProfile = string | null;

/**
 * Read the session row's permission profile.
 *
 * ## Why this is a function and not an inline read
 *
 * `sessionDb.get` is an IPC call, so it answers with a Promise. Reading
 * `permission_profile` off that Promise without awaiting it yields
 * `undefined`, the caller falls back to `default`, and the mode a person
 * picked in the composer silently never reaches the agent. That is exactly
 * what happened: the worker asked for the row, never awaited the answer, and
 * every session started as `default` no matter what the row said.
 *
 * The read lives here so it can be tested on its own. The worker entry that
 * needs it cannot be imported without booting a worker process.
 *
 * ## Why a failure is not an error
 *
 * A row that cannot be read means "no profile to honour", which is `default`.
 * The permission gate asks the person when in doubt, so an unreadable row
 * must not fail the turn.
 */
export async function readSessionPermissionProfile(
  sessionId: string,
): Promise<SessionRowPermissionProfile> {
  try {
    const row = await sessionDb.get(sessionId) as
      | { permission_profile?: string | null }
      | null
      | undefined;
    return row?.permission_profile ?? null;
  }
  catch {
    return null;
  }
}
