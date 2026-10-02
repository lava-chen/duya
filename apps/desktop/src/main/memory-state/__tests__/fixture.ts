import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Test fixture: create a temp directory for a file-based SQLite DB.
 *
 * `:memory:` DBs cannot test WAL mode (they return 'memory' for
 * `journal_mode`) or cross-handle concurrency. File-based temp DBs
 * support both. Each test gets its own directory; `cleanup()` removes
 * all files including WAL/shm sidecars.
 */
export interface TempDbDir {
  dir: string;
  cleanup: () => void;
}

export function createTempDbDir(): TempDbDir {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-state-test-'));
  return {
    dir,
    cleanup: () => {
      try {
        const entries = fs.readdirSync(dir);
        for (const entry of entries) {
          fs.unlinkSync(path.join(dir, entry));
        }
        fs.rmdirSync(dir);
      } catch {
        // Best-effort cleanup — OS temp dir reaper handles the rest.
      }
    },
  };
}
