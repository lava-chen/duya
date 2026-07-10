/**
 * verify-packaged-parity.mjs — Comprehensive packaged build verification
 *
 * Checks all critical artifacts exist in the packaged release directory.
 * Supports Windows, macOS, and Linux.
 *
 * Usage:
 *   node scripts/verify-packaged-parity.mjs                    # auto-detect platform
 *   node scripts/verify-packaged-parity.mjs --platform win     # force Windows
 *   node scripts/verify-packaged-parity.mjs --platform mac     # force macOS
 *   node scripts/verify-packaged-parity.mjs --platform linux   # force Linux
 *   node scripts/verify-packaged-parity.mjs --list             # list all expected files
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const forcePlatform = args.includes('--platform')
  ? args[args.indexOf('--platform') + 1]
  : null;
const listOnly = args.includes('--list');
const platform = forcePlatform || os.platform();

function getReleaseDir() {
  const base = path.join(PROJECT_ROOT, 'release');

  if (platform === 'win32' || platform === 'win') {
    return path.join(base, 'win-unpacked');
  }
  if (platform === 'darwin' || platform === 'mac') {
    return path.join(base, 'mac', 'DUYA.app', 'Contents');
  }
  if (platform === 'linux') {
    return path.join(base, 'linux-unpacked');
  }
  return path.join(base, 'win-unpacked');
}

function getResourcesPath() {
  const releaseDir = getReleaseDir();

  if (platform === 'darwin' || platform === 'mac') {
    return path.join(releaseDir, 'Resources');
  }
  return path.join(releaseDir, 'resources');
}

const RESOURCES = getResourcesPath();

const CHECKS = {
  'Release directory': [getReleaseDir(), true],
  'Resources directory': [RESOURCES, true],

  // Agent bundle (extraResources)
  'agent-bundle/agent-process-entry.js': [path.join(RESOURCES, 'agent-bundle', 'agent-process-entry.js'), false],
  'agent-bundle/literature-mcp-server.js': [path.join(RESOURCES, 'agent-bundle', 'literature-mcp-server.js'), false],
  'agent-bundle/BashTool/BashWorker.js': [path.join(RESOURCES, 'agent-bundle', 'BashTool', 'BashWorker.js'), false],

  // Agent skills (extraResources)
  'agent/skills/ directory': [path.join(RESOURCES, 'agent', 'skills'), true],

  // better-sqlite3 native module (extraResources)
  'better-sqlite3/build/Release/better_sqlite3.node': [path.join(RESOURCES, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'), false],

  // Assets (extraResources)
  'assets/ directory': [path.join(RESOURCES, 'assets'), true],

  // Public files (extraResources)
  'public/ directory': [path.join(RESOURCES, 'public'), true],

  // Extension (extraResources)
  'extension/ directory': [path.join(RESOURCES, 'extension'), true],

  // Document parser is OPTIONAL as of plan 106.
  // The main path uses NodeFileParser (in-process) — no sidecar shipped.
  // These checks tolerate missing artifacts to allow NodeFileParser-only
  // builds. To ship the legacy .doc fallback, run `npm run build:docparser`
  // before `electron:pack` and re-run this verifier.
  'document-parser/ directory': [path.join(RESOURCES, 'document-parser'), true],
  'document-parser/document-parser.exe': [path.join(RESOURCES, 'document-parser', 'document-parser.exe'), false],
  'document-parser/poppler/Library/bin/pdftoppm.exe': [path.join(RESOURCES, 'document-parser', 'poppler', 'Library', 'bin', 'pdftoppm.exe'), false],

  // Gateway bundle (extraResources)
  'gateway-bundle/ directory': [path.join(RESOURCES, 'gateway-bundle'), true],

  // app.asar payload
  'app.asar': [path.join(RESOURCES, 'app.asar'), false],
};

/**
 * Checks whose absence is non-fatal. Document parser artifacts are
 * optional post-plan 106 — the main path uses NodeFileParser. The
 * sidecar exists only as a legacy .doc fallback; missing artifacts
 * mean the operator chose not to ship it. See docs/exec-plans/active/
 * 106-node-file-parser-and-read-integration.md for rationale.
 */
const OPTIONAL_CHECKS = new Set([
  'document-parser/ directory',
  'document-parser/document-parser.exe',
  'document-parser/poppler/Library/bin/pdftoppm.exe',
]);

const results = [];
let totalChecks = 0;
let passed = 0;
let failed = 0;
let skipped = 0;

function checkExists(filePath, isDir = false) {
  if (!fs.existsSync(filePath)) {
    return { status: 'MISSING', detail: 'not found' };
  }

  try {
    const stat = fs.statSync(filePath);
    if (isDir && !stat.isDirectory()) {
      return { status: 'WRONG_TYPE', detail: 'expected directory, got file' };
    }
    if (!isDir && !stat.isFile()) {
      return { status: 'WRONG_TYPE', detail: 'expected file, got directory' };
    }

    if (isDir) {
      const count = fs.readdirSync(filePath).length;
      return { status: 'OK', detail: `${count} entries` };
    }
    const sizeKB = (stat.size / 1024).toFixed(1);
    return { status: 'OK', detail: `${sizeKB} KB` };
  } catch (err) {
    return { status: 'ERROR', detail: `stat failed: ${err.message}` };
  }
}

console.log('\n' + '='.repeat(80));
console.log('  DUYA Packaged Build Verification');
console.log(`  Platform: ${platform}`);
console.log(`  Release Dir: ${getReleaseDir()}`);
console.log(`  Resources: ${RESOURCES}`);
console.log('='.repeat(80) + '\n');

if (!fs.existsSync(RESOURCES)) {
  console.error(`  ERROR: Resources directory not found at:\n  ${RESOURCES}\n`);
  console.error('  Run npm run electron:pack or npm run electron:pack:win first.\n');
  process.exit(1);
}

let currentCategory = '';

for (const [label, [filePath, isDir]] of Object.entries(CHECKS)) {
  totalChecks++;

  // Extract category for grouping
  const parent = label.includes('/') ? label.split('/')[0] : 'root';

  if (currentCategory !== parent) {
    currentCategory = parent;
    console.log(`  ▸ ${parent}`);
  }

  if (listOnly) {
    console.log(`    - ${label}: ${filePath}`);
    skipped++;
    continue;
  }

  const result = checkExists(filePath, isDir);
  results.push({ label, ...result });

  const icon = result.status === 'OK' ? '✓' : result.status === 'MISSING' ? '✗' : '⚠';
  console.log(`    ${icon} ${path.basename(label) ? label : label}`);

  if (result.status === 'OK') {
    passed++;
  } else if (result.status === 'MISSING') {
    if (OPTIONAL_CHECKS.has(label)) {
      console.log(`      → (optional, missing — see plan 106)`);
    } else {
      failed++;
      console.error(`      → Expected at: ${filePath}`);
    }
  } else {
    failed++;
  }
}

// Summary
console.log('\n' + '='.repeat(80));
console.log('  SUMMARY');
console.log('='.repeat(80));

// Missing items that are optional do not count as failures — they
// are informational only (e.g. document-parser post-plan-106).
const missingItems = results.filter(
  r => (r.status === 'MISSING' || r.status !== 'OK') && !OPTIONAL_CHECKS.has(r.label)
);
const optionalMissing = results.filter(
  r => (r.status === 'MISSING' || r.status !== 'OK') && OPTIONAL_CHECKS.has(r.label)
);

if (listOnly) {
  console.log(`  Listed ${totalChecks} expected artifacts.`);
  console.log('  Run without --list to verify.');
} else if (missingItems.length === 0) {
  console.log(`  ✓ All ${totalChecks} checks passed.`);
  if (optionalMissing.length > 0) {
    console.log(`  ℹ ${optionalMissing.length} optional item(s) missing (non-fatal):`);
    for (const item of optionalMissing) {
      console.log(`    - ${item.label}`);
    }
  }
  console.log('');
  console.log('  The packaged build is complete and ready for testing.');
} else {
  console.log(`  ✗ ${missingItems.length} issues found out of ${totalChecks} checks:`);
  console.log('');
  for (const item of missingItems) {
    console.log(`  [${item.status}] ${item.label}`);
  }
  if (optionalMissing.length > 0) {
    console.log('');
    console.log(`  ℹ ${optionalMissing.length} optional item(s) also missing (non-fatal):`);
    for (const item of optionalMissing) {
      console.log(`    - ${item.label}`);
    }
  }
  console.log('');
}

console.log(`  Passed: ${passed} | Failed: ${failed} | Skipped: ${skipped}`);
console.log('='.repeat(80) + '\n');

if (!listOnly && failed > 0) {
  process.exit(1);
}
