import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { getLogger, LogComponent } from '../logging/logger';
import { normalizePath } from './pathUtils';

/**
 * Workspace overrides — user-editable pin of a workspace path to a
 * stable project UUID (Plan 301 §Phase B).
 *
 * Overrides live at `~/.duya/workspace-overrides.json` so users can
 * pin a project to a stable UUID even across directory moves. The
 * file is read at resolver time, NOT imported into the memory DB —
 * the resolver does the matching and registration.
 *
 * Shape: `{ "overrides": WorkspaceOverride[] }`
 *
 * D3: resolution order is `override → working_directory → cwd`. An
 * override wins over a working directory match; an explicit override
 * in the input wins over a file-based override only if the explicit
 * override matches a longer prefix (longest-match rule).
 */

export interface WorkspaceOverride {
  project_id: string; // UUID v4
  canonical_root: string; // normalized absolute path
  created_at: number; // INTEGER ms
  last_seen_at: number; // INTEGER ms
}

interface OverridesFile {
  overrides: WorkspaceOverride[];
}

const DEFAULT_CONFIG_FILENAME = 'workspace-overrides.json';

/**
 * Default config file path: `~/.duya/workspace-overrides.json`.
 *
 * Matches the convention used by `electron/import/writer/memory-writer.ts`
 * for the user-level `.duya` directory.
 */
function defaultConfigPath(): string {
  return path.join(os.homedir(), '.duya', DEFAULT_CONFIG_FILENAME);
}

/**
 * Load workspace overrides from the JSON file.
 *
 * Returns an empty array if the file does not exist or is empty —
 * a missing file is the normal first-run state, not an error. A
 * corrupt file (invalid JSON) IS an error: we log and return an
 * empty array rather than crashing the resolver, but the user is
 * expected to fix the file.
 *
 * The file is read on every call (not cached) so user edits are
 * picked up without a process restart.
 */
export function loadWorkspaceOverrides(opts?: {
  configPath?: string;
}): WorkspaceOverride[] {
  const configPath = opts?.configPath ?? defaultConfigPath();
  const logger = getLogger();

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // First run — no overrides yet. Normal path.
      return [];
    }
    logger.warn(
      'memory-state: failed to read workspace-overrides.json; treating as empty',
      { configPath, error: err instanceof Error ? err.message : String(err) },
      LogComponent.DB
    );
    return [];
  }

  if (raw.trim() === '') {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.error(
      'memory-state: workspace-overrides.json is corrupt; treating as empty',
      err instanceof Error ? err : new Error(String(err)),
      { configPath },
      LogComponent.DB
    );
    return [];
  }

  if (!isOverridesFile(parsed)) {
    logger.warn(
      'memory-state: workspace-overrides.json has invalid shape; treating as empty',
      { configPath },
      LogComponent.DB
    );
    return [];
  }

  return parsed.overrides;
}

function isOverridesFile(value: unknown): value is OverridesFile {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.overrides)) return false;
  for (const entry of obj.overrides) {
    if (!isWorkspaceOverride(entry)) return false;
  }
  return true;
}

function isWorkspaceOverride(value: unknown): value is WorkspaceOverride {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.project_id === 'string' &&
    typeof obj.canonical_root === 'string' &&
    typeof obj.created_at === 'number' &&
    typeof obj.last_seen_at === 'number'
  );
}

/**
 * Add a workspace override. Reads the current file, appends the new
 * override, and writes atomically (write to temp file, then rename).
 *
 * If `canonical_root` already exists in the file, the existing entry
 * is replaced (updated in place) to keep the file idempotent.
 *
 * `canonical_root` is normalized via the same `normalizePath()` rule
 * used by the project resolver so file-based and DB-based paths match.
 */
export function addWorkspaceOverride(
  input: {
    canonical_root: string;
    project_id?: string;
  },
  opts?: { configPath?: string; platform?: string }
): WorkspaceOverride {
  const configPath = opts?.configPath ?? defaultConfigPath();
  const now = Date.now();
  const normalized = normalizePath(input.canonical_root, opts?.platform).absolute_normalized_path;

  const overrides = loadWorkspaceOverrides({ configPath });

  // Replace any existing entry at the same canonical_root.
  const filtered = overrides.filter((o) => o.canonical_root !== normalized);

  const newOverride: WorkspaceOverride = {
    project_id: input.project_id ?? randomUUID(),
    canonical_root: normalized,
    created_at: now,
    last_seen_at: now,
  };

  filtered.push(newOverride);
  writeOverridesFile(configPath, { overrides: filtered });
  return newOverride;
}

/**
 * Remove a workspace override by canonical_root. Returns true if an
 * entry was removed, false if no matching entry existed.
 *
 * The `canonical_root` argument is normalized before matching so
 * callers can pass either form.
 */
export function removeWorkspaceOverride(
  canonical_root: string,
  opts?: { configPath?: string; platform?: string }
): boolean {
  const configPath = opts?.configPath ?? defaultConfigPath();
  const normalized = normalizePath(canonical_root, opts?.platform).absolute_normalized_path;

  const overrides = loadWorkspaceOverrides({ configPath });
  const next = overrides.filter((o) => o.canonical_root !== normalized);
  if (next.length === overrides.length) {
    return false;
  }
  writeOverridesFile(configPath, { overrides: next });
  return true;
}

/**
 * Atomic write: serialize to JSON, write to a temp file in the same
 * directory, then rename. The rename is atomic on POSIX; on Windows
 * it is atomic when the destination does not exist or when both
 * files are on the same volume (which they always are here).
 *
 * Creates the parent directory if it does not exist (first run).
 */
function writeOverridesFile(configPath: string, data: OverridesFile): void {
  const logger = getLogger();
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });

  const json = JSON.stringify(data, null, 2) + '\n';
  const tmpPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;

  try {
    fs.writeFileSync(tmpPath, json, 'utf8');
    fs.renameSync(tmpPath, configPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // best-effort
    }
    logger.error(
      'memory-state: failed to write workspace-overrides.json',
      err instanceof Error ? err : new Error(String(err)),
      { configPath },
      LogComponent.DB
    );
    throw err;
  }
}
