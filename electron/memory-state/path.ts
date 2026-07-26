import * as path from 'path';

/**
 * Resolve the memory-state.db path from the boot.json database directory.
 *
 * The boot.json database directory is the same directory that holds
 * `duya-main.db` (resolved by `electron/config/boot-config.ts`). The
 * memory-state DB sits next to it as a peer file.
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
  return path.join(opts.bootJsonDatabaseDir, 'memory-state.db');
}
