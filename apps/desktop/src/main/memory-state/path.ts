import { resolveDatabasePaths } from '@duya/data/data-paths';

/**
 * Resolve the shared application database path from the boot.json directory.
 *
 * The boot.json database directory is the same directory that holds
 * `duya-main.db` (resolved by `apps/desktop/src/main/config/boot-config.ts`). The
 * Memory state tables now live in the canonical main database.
 *
 * This function does NOT fall back to `~/.duya` if the directory is
 * missing — a user with a non-default data dir would silently lose
 * their memory state if we fell back. Throw so the caller can surface
 * a helpful error instead of corrupting state.
 */
export function resolveMemoryDbPath(opts?: {
  bootJsonDatabaseDir?: string;
}): string {
  if (!opts?.bootJsonDatabaseDir) {
    throw new Error(
      'memory-state: boot.json database directory is required — refusing to fall back to a default path'
    );
  }
  return resolveDatabasePaths({ dataRoot: opts.bootJsonDatabaseDir }).memoryStateDatabasePath;
}
