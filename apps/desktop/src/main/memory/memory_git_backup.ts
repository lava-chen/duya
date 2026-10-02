import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

/**
 * Memory git backup. The memory root (~/.duya/memory) is not a git repo by
 * default, so we git-init it lazily and commit a snapshot before each
 * curation run. The commit acts as a rollback point if an agent corrupts the
 * memory store. Failures are non-fatal to the run (the dedicated
 * memory_write tool's format validation is the primary guard).
 */
export async function gitInitIfNeeded(memoryRoot: string): Promise<void> {
  if (fs.existsSync(path.join(memoryRoot, '.git'))) return;
  await execFileAsync('git', ['init'], { cwd: memoryRoot });
}

export async function gitCommitSnapshot(
  memoryRoot: string,
  runId: string,
  version = '',
): Promise<void> {
  await execFileAsync('git', ['add', '-A'], { cwd: memoryRoot });
  await execFileAsync('git', ['commit', '-m', `curation backup ${runId}${version ? ` (${version})` : ''}`], {
    cwd: memoryRoot,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'duya-memory',
      GIT_AUTHOR_EMAIL: 'memory@duya.local',
      GIT_COMMITTER_NAME: 'duya-memory',
      GIT_COMMITTER_EMAIL: 'memory@duya.local',
    },
  });
}

export async function backupMemoryBeforeRun(
  memoryRoot: string,
  runId: string,
): Promise<boolean> {
  try {
    await gitInitIfNeeded(memoryRoot);
    await gitCommitSnapshot(memoryRoot, runId);
    return true;
  } catch {
    // `git commit` rejects on "nothing to commit" — treat as a no-op success.
    return false;
  }
}
