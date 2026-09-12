/**
 * legacy-root-migration.ts — one-way merge of per-bot channel data from the
 * legacy Electron userData agents tree into the shared `~/.duya/agents` root
 * (plan 526).
 *
 * Before plan 526 the channels subsystem (connection.json, connector-secrets,
 * weixin gateway state, inbound attachments) lived under
 * `<userData>/agents/…`, which is namespaced per install mode
 * (`duya-dev` vs packaged). The shared root is `<configDir>/agents`
 * (`~/.duya/agents`) — the same tree bot identity already lives in.
 *
 * Merge semantics: per-file, target-exists wins. The legacy tree is never
 * deleted, so a reinstall of an older build keeps working, and re-running is
 * idempotent and cheap (legacy files only exist until they are copied once;
 * afterwards every file already exists at the target and the walk is a no-op).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';

import { getLogger, LogComponent } from '../logging/logger';
import { getSharedAgentsRoot } from '../config/agent-paths';

/** Subdirectories of an agent dir that belong to the channels subsystem. */
const MIGRATED_SUBDIRS = ['channels', 'connector-secrets', 'gateway', 'attachments'] as const;

/** Recursively list file paths under `dir` (relative to `dir`). */
function walkFiles(dir: string, base: string = dir): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full, base));
    } else if (entry.isFile()) {
      out.push(path.relative(base, full));
    }
  }
  return out;
}

export interface LegacyMigrationResult {
  /** Legacy root that was scanned (or null when nothing to migrate). */
  legacyRoot: string | null;
  /** Files actually copied into the shared root. */
  copied: number;
  /** Files already present at the target (skipped, target wins). */
  skipped: number;
}

/**
 * Merge legacy `<userData>/agents/*` channel data into the shared root.
 * Never throws — a failed copy is logged and skipped.
 */
export function migrateLegacyAgentChannelData(): LegacyMigrationResult {
  const logger = getLogger();
  const legacyRoot = path.join(app.getPath('userData'), 'agents');
  const sharedRoot = getSharedAgentsRoot();
  const result: LegacyMigrationResult = { legacyRoot: null, copied: 0, skipped: 0 };

  if (!fs.existsSync(legacyRoot)) return result;
  // Same tree (shouldn't happen, but never copy a directory onto itself).
  if (path.resolve(legacyRoot) === path.resolve(sharedRoot)) return result;
  result.legacyRoot = legacyRoot;

  let agentDirs: fs.Dirent[];
  try {
    agentDirs = fs.readdirSync(legacyRoot, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const agent of agentDirs) {
    if (!agent.isDirectory() || agent.name.startsWith('.')) continue;
    for (const subdir of MIGRATED_SUBDIRS) {
      const srcBase = path.join(legacyRoot, agent.name, subdir);
      if (!fs.existsSync(srcBase)) continue;
      for (const rel of walkFiles(srcBase)) {
        const src = path.join(srcBase, rel);
        const dest = path.join(sharedRoot, agent.name, subdir, rel);
        try {
          if (fs.existsSync(dest)) {
            result.skipped++;
            continue;
          }
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(src, dest);
          result.copied++;
        } catch (err) {
          logger.warn(
            `legacy-root-migration: failed to copy ${rel}`,
            { error: err instanceof Error ? err.message : String(err) },
            LogComponent.Gateway,
          );
        }
      }
    }
  }

  if (result.copied > 0) {
    logger.info(
      'legacy-root-migration: merged channel data into shared agents root',
      { legacyRoot, sharedRoot, copied: result.copied, skipped: result.skipped },
      LogComponent.Gateway,
    );
  }
  return result;
}
