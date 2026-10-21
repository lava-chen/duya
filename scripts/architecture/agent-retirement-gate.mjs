/**
 * Agent retirement gate for plan 610 A7 / the coordinated retirement slice.
 *
 * This gate inventories active source, package/build configuration, worker
 * artifacts, and test targets OUTSIDE packages/agent. It deliberately ignores
 * documentation (including this migration inventory) and the retiring package
 * itself. Test targets are reported in their own scope and still block strict
 * closure when they import/read the old package. Explicitly bounded negative
 * fixture regions in this gate's own tests are counted separately.
 *
 * Static limits: literal package/path references are detectable; computed
 * module specifiers and runtime-only filesystem paths require production worker
 * and package verification as a separate acceptance check.
 *
 * Usage:
 *   node scripts/architecture/agent-retirement-gate.mjs
 *   node scripts/architecture/agent-retirement-gate.mjs --json
 *   node scripts/architecture/agent-retirement-gate.mjs --strict
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMPORT_RE, stripComments } from './import-graph.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '../..');

const SCAN_DIRS = ['apps', 'packages', 'scripts', 'evals', '.github'];
const ROOT_CONFIG_FILES = [
  '.architecture-baseline.json',
  '.gitignore',
  'package.json',
  'package-lock.json',
  'electron-builder.yml',
  'electron-builder.yaml',
  'tsconfig.json',
  'architecture-policy.yaml',
  'postcss.config.mjs',
  'test-setup.ts',
  'vite.config.ts',
  'vitest.config.501.mts',
  'vitest.config.ts',
];
const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
]);
const CONFIG_EXTENSIONS = new Set(['.json', '.jsonc', '.yml', '.yaml', '.toml']);
const ROOT_CONFIG_FILE_SET = new Set(ROOT_CONFIG_FILES);
const SCRIPT_EXTENSIONS = new Set(['.sh', '.bash', '.ps1', '.bat', '.cmd', '.py']);
const SCANNED_EXTENSIONS = new Set([...SOURCE_EXTENSIONS, ...CONFIG_EXTENSIONS, ...SCRIPT_EXTENSIONS]);
const GENERATED_DIRS = new Set([
  '.git', '.codegraph', '.claude', 'node_modules', 'dist', 'dist-electron',
  'bundle', 'release', 'coverage', 'storybook-static', '.e2e-userdata',
]);
const SELF_FILES = new Set(['scripts/architecture/agent-retirement-gate.mjs']);

const DIRECT_PACKAGE_RE = /@duya\/agent(?![\w-])/gi;
const LEGACY_PACKAGE_PATH_RE = /\bpackages[\\/]+agent(?![\w-])(?:[\\/]+(?:src|dist|bundle|skills))?/gi;
const SPLIT_PACKAGE_PATH_RE = /["'`]packages["'`]\s*,\s*["'`]agent["'`]/gi;
const WORKER_ARTIFACT_RE = /\b(?:agent-bundle|agent-process-entry\.js|BashTool[\\/]BashWorker\.js)\b/gi;
const LEGACY_AGENT_SCRIPT_RE = /\b(?:build|bundle|rebuild|typecheck):agent\b/gi;
const SKILL_ASSET_RE = /\b(?:packages[\\/]+agent[\\/]+skills|agent[\\/]+skills)\b/gi;
const SELECTOR_KINDS = new Set(['worker-artifact', 'legacy-agent-script', 'skill-asset']);
const HOST_WORKER_PRODUCER_RE = /packages[\\/]+host[\\/]+(?:src|dist|bundle)(?:[\\/]|$)/i;
const FIXTURE_TEST_FILE = 'scripts/architecture/agent-retirement-gate.test.ts';
const FIXTURE_START = '// RETIREMENT_GATE_FIXTURE_CONTEXT_START';
const FIXTURE_END = '// RETIREMENT_GATE_FIXTURE_CONTEXT_END';
const SIDE_EFFECT_IMPORT_RE = /\bimport\s*["']([^"'\r\n]+)["']/g;
const TEST_PATH_RE = /^(?:evals\/)|(?:^|\/)(?:__tests__|tests?|e2e)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const TEST_TARGET_RE = /(?:^|[\\/])(?:__tests__|tests?|e2e)(?:[\\/]|$)|\.(?:test|spec)\.[cm]?[jt]sx?(?:$|["'`])/i;

function normalizeRelative(root, absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join('/');
}

function isRetiringPackagePath(relativePath) {
  return relativePath === 'packages/agent' || relativePath.startsWith('packages/agent/');
}

function shouldSkipDirectory(root, absolutePath, name) {
  if (GENERATED_DIRS.has(name)) return true;
  return isRetiringPackagePath(normalizeRelative(root, absolutePath));
}

function walkActiveFiles(root, absoluteDir, files) {
  if (!fs.existsSync(absoluteDir)) return;
  for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
    const absolutePath = path.join(absoluteDir, entry.name);
    if (entry.isDirectory()) {
      if (!shouldSkipDirectory(root, absolutePath, entry.name)) {
        walkActiveFiles(root, absolutePath, files);
      }
      continue;
    }
    if (!entry.isFile() || !SCANNED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      continue;
    }
    files.push(absolutePath);
  }
}

function activeText(relativePath, raw) {
  const extension = path.extname(relativePath).toLowerCase();
  if (SOURCE_EXTENSIONS.has(extension) || extension === '.json' || extension === '.jsonc') {
    const stripped = stripComments(raw);
    return stripped.unterminated ? raw : stripped.text;
  }
  if (extension === '.yml' || extension === '.yaml') {
    // YAML full-line comments are prose; active scalar values remain visible.
    return raw.replace(/^[\t ]*#.*$/gm, '');
  }
  if (SCRIPT_EXTENSIONS.has(extension)) {
    const withoutHashComments = raw.replace(/^[\t ]*#.*$/gm, '');
    return extension === '.bat' || extension === '.cmd'
      ? withoutHashComments.replace(/^[\t ]*(?:::|rem\b).*$/gim, '')
      : withoutHashComments;
  }
  return raw;
}

function scopeFor(relativePath, target) {
  if (TEST_PATH_RE.test(relativePath) || TEST_TARGET_RE.test(target)) return 'test-target';
  if (relativePath.startsWith('evals/')) return 'test-target';
  if (relativePath.startsWith('scripts/')) return 'build-tooling';
  if (ROOT_CONFIG_FILE_SET.has(relativePath)) return 'active-config';
  if (!SOURCE_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) return 'active-config';
  return 'production-source';
}

function lineForOffset(text, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function isBoundedFixtureContext(relativePath, raw, offset) {
  if (relativePath !== FIXTURE_TEST_FILE) return false;
  const markerPattern = /^[\t ]*\/\/ RETIREMENT_GATE_FIXTURE_CONTEXT_(START|END)[\t ]*$/gm;
  let inside = false;
  let match;
  while ((match = markerPattern.exec(raw)) !== null && match.index < offset) {
    inside = match[1] === 'START';
  }
  return inside;
}

function collectFileFindings(root, absolutePath) {
  const relativePath = normalizeRelative(root, absolutePath);
  if (SELF_FILES.has(relativePath) || isRetiringPackagePath(relativePath)) return [];

  const raw = fs.readFileSync(absolutePath, 'utf8');
  const text = activeText(relativePath, raw);
  const lines = raw.split(/\r?\n/);
  const findings = [];
  const seen = new Set();
  const hostWorkerProducer = HOST_WORKER_PRODUCER_RE.test(text);

  const add = (kind, match, offset, target = match) => {
    const line = lineForOffset(text, offset);
    const excerpt = (lines[line - 1] ?? '').trim().slice(0, 200);
    const scope = scopeFor(relativePath, target);
    const key = [relativePath, line, scope, kind, match].join('\u0000');
    if (seen.has(key)) return;
    seen.add(key);
    const fixtureContext = isBoundedFixtureContext(relativePath, raw, offset);
    const selector = SELECTOR_KINDS.has(kind);
    findings.push({
      file: relativePath,
      line,
      scope,
      kind,
      match,
      excerpt,
      fixtureContext,
      blocking: !fixtureContext && !selector,
      selectorStatus: selector
        ? hostWorkerProducer ? 'host-mapped' : 'unverified'
        : null,
    });
  };

  // Reuse the repository's CR/LF-safe import-specifier scanner. Literal
  // dynamic imports, require(), side-effect imports, and type imports count.
  IMPORT_RE.lastIndex = 0;
  let importMatch;
  while ((importMatch = IMPORT_RE.exec(text)) !== null) {
    const specifier = importMatch[1];
    if (DIRECT_PACKAGE_RE.test(specifier)) {
      add('package-import', specifier, importMatch.index, specifier);
    } else if (LEGACY_PACKAGE_PATH_RE.test(specifier)) {
      add('relative-package-import', specifier, importMatch.index, specifier);
    }
    DIRECT_PACKAGE_RE.lastIndex = 0;
    LEGACY_PACKAGE_PATH_RE.lastIndex = 0;
  }

  SIDE_EFFECT_IMPORT_RE.lastIndex = 0;
  let sideEffectMatch;
  while ((sideEffectMatch = SIDE_EFFECT_IMPORT_RE.exec(text)) !== null) {
    const specifier = sideEffectMatch[1];
    if (DIRECT_PACKAGE_RE.test(specifier)) {
      add('package-import', specifier, sideEffectMatch.index, specifier);
    } else if (LEGACY_PACKAGE_PATH_RE.test(specifier)) {
      add('relative-package-import', specifier, sideEffectMatch.index, specifier);
    }
    DIRECT_PACKAGE_RE.lastIndex = 0;
    LEGACY_PACKAGE_PATH_RE.lastIndex = 0;
  }

  const scans = [
    ['package-reference', DIRECT_PACKAGE_RE],
    ['source-or-dist-path', LEGACY_PACKAGE_PATH_RE],
    ['split-package-path', SPLIT_PACKAGE_PATH_RE],
    ['worker-artifact', WORKER_ARTIFACT_RE],
    ['legacy-agent-script', LEGACY_AGENT_SCRIPT_RE],
    ['skill-asset', SKILL_ASSET_RE],
  ];
  for (const [kind, expression] of scans) {
    expression.lastIndex = 0;
    let match;
    while ((match = expression.exec(text)) !== null) {
      add(kind, match[0], match.index, match[0]);
    }
  }

  return findings;
}

function sortedFindings(findings) {
  return findings.sort((left, right) =>
    left.file.localeCompare(right.file)
    || left.line - right.line
    || left.kind.localeCompare(right.kind)
    || left.match.localeCompare(right.match));
}

export function collectAgentRetirementReport(root = REPO_ROOT) {
  const absoluteRoot = path.resolve(root);
  const files = [];
  const rootsPresent = [];

  for (const relativeDir of SCAN_DIRS) {
    const absoluteDir = path.join(absoluteRoot, relativeDir);
    if (fs.existsSync(absoluteDir) && fs.statSync(absoluteDir).isDirectory()) {
      rootsPresent.push(relativeDir);
      walkActiveFiles(absoluteRoot, absoluteDir, files);
    }
  }
  for (const relativeFile of ROOT_CONFIG_FILES) {
    const absolutePath = path.join(absoluteRoot, relativeFile);
    if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) {
      files.push(absolutePath);
    }
  }

  const uniqueFiles = [...new Set(files)].sort();
  const findings = sortedFindings(uniqueFiles.flatMap((file) => collectFileFindings(absoluteRoot, file)));
  const legacyPackagePresent = fs.existsSync(path.join(absoluteRoot, 'packages', 'agent'));
  const activeFindings = findings.filter((finding) => !finding.fixtureContext);
  const blockingReferenceCount = activeFindings.filter((finding) => finding.blocking).length;
  const unverifiedSelectorCount = activeFindings.filter((finding) =>
    finding.selectorStatus === 'unverified',
  ).length;
  const hostMappedSelectorCount = activeFindings.filter((finding) =>
    finding.selectorStatus === 'host-mapped',
  ).length;
  const fixtureReferenceCount = findings.length - activeFindings.length;
  const byScope = Object.fromEntries(
    ['production-source', 'build-tooling', 'active-config', 'test-target'].map((scope) => [
      scope,
      activeFindings.filter((finding) => finding.scope === scope).length,
    ]),
  );
  let status = 'CLOSED';
  if (uniqueFiles.length === 0 || rootsPresent.length === 0) {
    status = 'UNVERIFIED';
  } else if (blockingReferenceCount > 0 || legacyPackagePresent) {
    status = 'OPEN';
  } else if (unverifiedSelectorCount > 0) {
    status = 'UNVERIFIED';
  }

  return {
    root: absoluteRoot,
    status,
    scannedFiles: uniqueFiles.length,
    scannedRoots: rootsPresent,
    legacyPackagePresent,
    runtimeVerificationRequired: true,
    referenceCount: activeFindings.length,
    blockingReferenceCount,
    unverifiedSelectorCount,
    hostMappedSelectorCount,
    fixtureReferenceCount,
    byScope,
    findings,
  };
}

export function strictFailures(report) {
  const failures = [];
  if (report.scannedFiles === 0 || report.scannedRoots.length === 0) {
    failures.push('the gate scanned no active source/config scope');
  }
  if (report.legacyPackagePresent) {
    failures.push('packages/agent still exists; retire it only after all consumers are moved');
  }
  if (report.blockingReferenceCount > 0) {
    failures.push(`${report.blockingReferenceCount} confirmed old-package source/build/test references remain`);
  }
  if (report.unverifiedSelectorCount > 0) {
    failures.push(`${report.unverifiedSelectorCount} artifact/build selectors still need producer mapping`);
  }
  return failures;
}

export function formatAgentRetirementReport(report) {
  const scopeSummary = Object.entries(report.byScope)
    .map(([scope, count]) => `${scope}=${count}`)
    .join(', ');
  const lines = [
    `agent-retirement: ${report.status}`,
    `scope: ${report.scannedFiles} active source/config files across [${report.scannedRoots.join(', ')}]`,
    `legacy package directory: ${report.legacyPackagePresent ? 'present' : 'absent'}`,
    `references: ${report.referenceCount} (${report.blockingReferenceCount} confirmed old-package, ${scopeSummary})`,
    `artifact/build selectors: ${report.hostMappedSelectorCount} mapped to Host, ${report.unverifiedSelectorCount} unverified`,
    `bounded synthetic fixture references: ${report.fixtureReferenceCount}`,
    'runtime acceptance remains separate: production worker must build and load with packages/agent absent',
  ];
  for (const finding of report.findings) {
    if (finding.fixtureContext) continue;
    const classification = finding.blocking
      ? 'blocking'
      : finding.selectorStatus === 'host-mapped' ? 'host-mapped selector' : 'unverified selector';
    lines.push(`- ${classification}: ${finding.scope} ${finding.kind} ${finding.file}:${finding.line} — ${finding.match}`);
  }
  if (report.status === 'UNVERIFIED') {
    lines.push('The static result is unverified; unresolved selectors or an empty scan are not a pass.');
  }
  return lines.join('\n');
}

function parseArgs(args) {
  const options = { strict: false, json: false, root: REPO_ROOT };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--strict') options.strict = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--root' && args[index + 1]) {
      options.root = path.resolve(args[index + 1]);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function main(args) {
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    process.stderr.write(`${error.message}\nusage: node scripts/architecture/agent-retirement-gate.mjs [--strict] [--json] [--root <repo>]\n`);
    process.exitCode = 2;
    return;
  }

  const report = collectAgentRetirementReport(options.root);
  process.stdout.write(options.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : `${formatAgentRetirementReport(report)}\n`);
  if (options.strict) {
    const failures = strictFailures(report);
    if (failures.length > 0) {
      process.stderr.write(`\nstrict static dependency gate failed:\n  ${failures.join('\n  ')}\n`);
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
