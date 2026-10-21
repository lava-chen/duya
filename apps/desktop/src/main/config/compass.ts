/**
 * compass.ts — early-boot config resolver (replaces boot.json).
 *
 * Reads a FIXED path `~/.duya/config.toml` (or the test-namespace root)
 * for `storage.database_path` at the earliest stage of startup, before
 * the DB or logger are initialized. Because the config path is fixed and
 * does not depend on the DB path, there is no dependency cycle.
 *
 * Test-mode root resolution is inlined (mirrors resolveRolloutRoot in
 * boot-config.ts) so this module stays free of logger/bootstrap imports.
 */

import fs from 'fs';
import path from 'path';
import { parse } from '@iarna/toml';
import { resolveDataRoot } from '@duya/data/data-paths';

/** Config root: `~/.duya` (or `~/.duya/test-namespaces/<ns>` in test mode). */
export function resolveConfigRoot(): string {
  return resolveDataRoot();
}

export function resolveConfigTomlPath(): string {
  return path.join(resolveConfigRoot(), 'config.toml');
}

/** Read `storage.database_path`. Empty string = default. */
export function resolveDatabasePathFromConfigToml(cfgPath?: string): string {
  const target = cfgPath ?? resolveConfigTomlPath();
  try {
    if (!fs.existsSync(target)) return '';
    const raw = fs.readFileSync(target, 'utf-8');
    const doc = parse(raw) as { storage?: { database_path?: string } };
    return doc?.storage?.database_path ?? '';
  } catch {
    return '';
  }
}
