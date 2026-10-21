/**
 * packages/agent/src/skills/scanFilter.ts
 *
 * Shared scan-skip rules for skill directory traversal. Used by both
 * `loadSkillsFromDirectory` (discovery) and `fingerprintDir` (snapshot
 * fingerprints) so the two always agree on what constitutes noise.
 *
 * Dot-directories are skipped wholesale (`.git`, `.svn`, caches); the
 * explicit list covers common dependency/build noise that can appear
 * inside project skill trees. System skills (`<bundled>/.system`) are
 * unaffected: `loadSystemSkills` enumerates the *contents* of `.system`,
 * not `.system` itself.
 */

const SKIP_SCAN_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
]);

export function shouldSkipScanDir(entryName: string): boolean {
  return entryName.startsWith('.') || SKIP_SCAN_DIR_NAMES.has(entryName);
}
