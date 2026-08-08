/**
 * compass.ts — early-boot config resolver (replaces boot.json).
 *
 * Reads a FIXED path `~/.duya/config.yaml` (or the test-namespace root)
 * for `storage.database_path` at the earliest stage of startup, before
 * the DB or logger are initialized. Because the config path is fixed and
 * does not depend on the DB path, there is no dependency cycle.
 *
 * Test-mode root resolution is inlined (mirrors resolveRolloutRoot in
 * boot-config.ts) so this module stays free of logger/bootstrap imports.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { parse } from 'yaml';

function readTestNamespace(): string | null {
  for (const arg of process.argv) {
    if (arg.startsWith('--duya-namespace=')) {
      const ns = arg.slice('--duya-namespace='.length);
      return ns && /^[a-zA-Z0-9_-]+$/.test(ns) ? ns : null;
    }
  }
  const idx = process.argv.indexOf('--duya-namespace');
  if (idx >= 0 && idx + 1 < process.argv.length) {
    const ns = process.argv[idx + 1];
    return ns && /^[a-zA-Z0-9_-]+$/.test(ns) ? ns : null;
  }
  return null;
}

/** Config root: `~/.duya` (or `~/.duya/test-namespaces/<ns>` in test mode). */
export function resolveConfigRoot(): string {
  const base = path.join(os.homedir(), '.duya');
  if (process.env.DUYA_TEST === '1') {
    const ns = readTestNamespace();
    if (ns) return path.join(base, 'test-namespaces', ns);
  }
  return base;
}

export function resolveConfigYamlPath(): string {
  return path.join(resolveConfigRoot(), 'config.yaml');
}

/** Read `storage.database_path`. Empty string = default. */
export function resolveDatabasePathFromConfigYaml(cfgPath?: string): string {
  const target = cfgPath ?? resolveConfigYamlPath();
  try {
    if (!fs.existsSync(target)) return '';
    const raw = fs.readFileSync(target, 'utf-8');
    const doc = parse(raw) as { storage?: { database_path?: string } };
    return doc?.storage?.database_path ?? '';
  } catch {
    return '';
  }
}