/**
 * subagent-transcript-migration.ts — one-time legacy transcript relocation.
 *
 * Commit 28c8c8bb (2026-08-17) moved OutputFileWriter's transcript root from
 * the OS app-data directory (%APPDATA%/DUYA on Windows,
 * ~/Library/Application Support/DUYA on macOS, ~/.local/share/DUYA on Linux)
 * to ~/.duya/subagent-transcripts. Two leftovers make the roots disagree:
 *
 *  1. Transcript files written before that commit still live in the legacy
 *     directory.
 *  2. Completion notifications persisted in session history (agent_mailbox
 *     rows) still carry the legacy `<output-file>` paths.
 *
 * This migration COPIES (never moves) legacy transcript files into
 * ~/.duya/subagent-transcripts/ so the canonical root holds every transcript.
 * Originals are kept so historical notification paths keep resolving.
 *
 * Idempotent: files already present at the target are skipped. Safe to run
 * on every app launch. Skipped entirely when DUYA_APP_DATA_PATH is set (the
 * agent root would not be ~/.duya then) or in test mode (DUYA_TEST=1) so e2e
 * runs never touch real user files.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getLogger, LogComponent } from '../logging/logger';

const logger = getLogger();

export interface SubagentTranscriptMigrationResult {
  /** Files copied from the legacy directory into ~/.duya. */
  migrated: number;
  /** Files already present at the target (idempotent skip). */
  skipped: number;
  /** Files that failed to copy. */
  failed: number;
  /** Legacy directory resolved for this platform, or null when unknown. */
  legacyDir: string | null;
  /** Canonical target directory (~/.duya/subagent-transcripts). */
  targetDir: string;
}

/**
 * Resolve the pre-28c8c8bb transcript directory, mirroring the old
 * `getAppDataDir()` logic in packages/agent/src/lifecycle/OutputFileWriter.ts.
 */
export function resolveLegacyTranscriptDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  switch (platform) {
    case 'win32':
      return path.join(
        env.APPDATA ?? path.join(env.USERPROFILE ?? os.homedir(), 'AppData', 'Roaming'),
        'DUYA',
        'subagent-transcripts',
      );
    case 'darwin':
      return path.join(env.HOME ?? os.homedir(), 'Library', 'Application Support', 'DUYA', 'subagent-transcripts');
    case 'linux':
      return path.join(
        env.XDG_DATA_HOME ?? path.join(env.HOME ?? os.homedir(), '.local', 'share'),
        'DUYA',
        'subagent-transcripts',
      );
    default:
      return null;
  }
}

/** Resolve the canonical transcript directory (current OutputFileWriter root). */
export function resolveCurrentTranscriptDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  // When the agent's root is overridden the migration is a no-op anyway
  // (see migrateSubagentTranscripts), but resolving the target mirrors the
  // agent's own fallback exactly (os.homedir() reads USERPROFILE on Windows,
  // HOME on POSIX).
  const home = platform === 'win32' ? env.USERPROFILE : env.HOME;
  return path.join(home ?? os.homedir(), '.duya', 'subagent-transcripts');
}

export function migrateSubagentTranscripts(opts?: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): SubagentTranscriptMigrationResult {
  const env = opts?.env ?? process.env;
  const platform = opts?.platform ?? process.platform;
  const legacyDir = resolveLegacyTranscriptDir(env, platform);
  const targetDir = resolveCurrentTranscriptDir(env, platform);
  const result: SubagentTranscriptMigrationResult = {
    migrated: 0,
    skipped: 0,
    failed: 0,
    legacyDir,
    targetDir,
  };

  // The agent writes elsewhere (DUYA_APP_DATA_PATH override) or test mode
  // isolates namespaces — migrating would move files to the wrong root or
  // touch real user data from e2e runs.
  if (!legacyDir || env.DUYA_APP_DATA_PATH || env.DUYA_TEST === '1') {
    return result;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(legacyDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn(
        'Subagent transcript migration: cannot read legacy directory',
        { legacyDir, error: err instanceof Error ? err.message : String(err) },
        LogComponent.Main,
      );
    }
    return result;
  }

  const jsonlFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.jsonl'));
  if (jsonlFiles.length === 0) return result;

  try {
    fs.mkdirSync(targetDir, { recursive: true });
  } catch (err) {
    logger.warn(
      'Subagent transcript migration: cannot create target directory',
      { targetDir, error: err instanceof Error ? err.message : String(err) },
      LogComponent.Main,
    );
    return result;
  }

  for (const entry of jsonlFiles) {
    const src = path.join(legacyDir, entry.name);
    const dst = path.join(targetDir, entry.name);
    if (fs.existsSync(dst)) {
      result.skipped += 1;
      continue;
    }
    try {
      fs.copyFileSync(src, dst);
      result.migrated += 1;
    } catch (err) {
      result.failed += 1;
      logger.warn(
        'Subagent transcript migration: copy failed',
        { src, dst, error: err instanceof Error ? err.message : String(err) },
        LogComponent.Main,
      );
    }
  }

  if (result.migrated > 0) {
    logger.info(
      'Subagent transcript migration complete',
      { migrated: result.migrated, skipped: result.skipped, failed: result.failed, legacyDir, targetDir },
      LogComponent.Main,
    );
  }
  return result;
}
