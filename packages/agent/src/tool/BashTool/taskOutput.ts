import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Per-session task output directory. Memoized so that /clear (which
 * regenerates session ids in some flows) does not silently change the
 * path of already-running background tasks.
 *
 * Resolution order:
 * 1. `<projectTemp>/<sessionId>/tasks/` (preferred - survives restarts)
 * 2. `os.tmpdir()/duya-tasks/<sessionId>/` (fallback when projectTemp unavailable)
 */
const _dirCache = new Map<string, string>();

let _projectTempDirResolver: (() => string | undefined) | null = null;

/**
 * Allow the host application to register a resolver for the project
 * temp directory. Typically wired up once during bootstrap.
 */
export function registerProjectTempDirResolver(resolver: () => string | undefined): void {
  _projectTempDirResolver = resolver;
}

function resolveBaseDir(): string {
  try {
    const resolved = _projectTempDirResolver?.();
    if (resolved) return resolved;
  } catch {
    // ignore
  }
  return join(tmpdir(), 'duya-tasks');
}

export function getTaskOutputDir(sessionId: string): string {
  let dir = _dirCache.get(sessionId);
  if (dir === undefined) {
    dir = join(resolveBaseDir(), sessionId, 'tasks');
    _dirCache.set(sessionId, dir);
  }
  return dir;
}

export function getTaskOutputPath(sessionId: string, taskId: string): string {
  return join(getTaskOutputDir(sessionId), `${taskId}.output`);
}

export function _resetTaskOutputDirForTest(): void {
  _dirCache.clear();
  _projectTempDirResolver = null;
}
