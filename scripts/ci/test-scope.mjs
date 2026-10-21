#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DOCS_ONLY = /^(?:docs|docs-local)\/|\.(?:md|mdx|rst|txt)$/i;

/**
 * Manifest fields that can change what a build, a test run or a package
 * resolution does. A manifest edit that touches NONE of these is metadata
 * (description, keywords, author, license, homepage, repository, ...): it
 * cannot break a dependency graph, a build script or a resolved export, so it
 * must not escalate a docs PR into the full unit and E2E suites.
 *
 * `scripts` is on this list on purpose: a script change can change what CI
 * runs. The CI-router script edit is the one exception, and it is handled by
 * its own narrower rule below.
 */
const INFRA_MANIFEST_KEYS = [
  'dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies',
  'peerDependenciesMeta', 'bundleDependencies', 'bundledDependencies', 'overrides',
  'resolutions', 'engines', 'devEngines', 'packageManager', 'workspaces',
  'scripts', 'type', 'main', 'module', 'browser', 'types', 'typings', 'exports',
  'imports', 'bin', 'config', 'os', 'cpu', 'publishConfig', 'directories',
];

/** A manifest path is infrastructure-relevant when any infra key differs. */
export function manifestChangeIsInfrastructure(baseManifest, headManifest) {
  // Fail closed: an unreadable or unparseable manifest is not evidence of a
  // metadata-only edit, so it keeps the full suites.
  if (!baseManifest || !headManifest) return true;
  for (const key of INFRA_MANIFEST_KEYS) {
    const before = JSON.stringify(baseManifest[key] ?? null);
    const after = JSON.stringify(headManifest[key] ?? null);
    if (before !== after) return true;
  }
  return false;
}

const UNIT_INFRA = [
  /^vitest\.config\./,
  /^vitest\.workspace\./,
  /(^|\/)(?:package|package-lock)\.json$/,
  /(^|\/)(?:pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /^test-setup\.ts$/,
  /^scripts\/check-test-coverage(?:\/|\.|$)/,
];
const E2E_INFRA = [
  /(^|\/)(?:package|package-lock)\.json$/,
  /(^|\/)(?:pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/,
  /^scripts\/(?:build-electron|ensure-sqlite-abi|fetch-ripgrep)\.mjs$/,
  /^(?:vite|electron-builder)\.config\./,
  /^electron-builder\.yml$/,
];

function normalizePath(file) {
  return file.replaceAll('\\', '/').replace(/^\.\//, '');
}

function matchesAny(files, patterns) {
  return files.some((file) => patterns.some((pattern) => pattern.test(file)));
}

/** Classify a PR's changed paths without silently treating unknown files as docs. */
export function classifyChangedFiles(changedPaths, options = {}) {
  return classifyChangedFilesWithOptions(changedPaths, options);
}

function classifyChangedFilesWithOptions(changedPaths, { ciRoutingManifestOnly = false, metadataOnlyManifests = [] } = {}) {
  const allFiles = [...new Set(changedPaths.map(normalizePath).filter(Boolean))].sort();
  // A metadata-only manifest edit cannot change a build, a dependency graph or
  // a resolved export, so it is removed from the change set entirely. What is
  // left is judged exactly as before.
  const metadataOnly = new Set(metadataOnlyManifests.map(normalizePath));
  const files = allFiles
    .filter((file) => !(ciRoutingManifestOnly && file === 'package.json'))
    .filter((file) => !metadataOnly.has(file));
  if (allFiles.length === 0) {
    return { unitScope: 'full', e2eScope: 'full', buildScope: 'run', e2eFiles: [], unitFiles: [] };
  }
  if (files.length === 0) {
    // Every change was a metadata-only manifest edit: there is nothing to
    // build, test or verify. This is NOT the fail-closed case above, which is
    // "the diff could not be read at all".
    return { unitScope: 'skip', e2eScope: 'skip', buildScope: 'skip', e2eFiles: [], unitFiles: [] };
  }

  if (files.every((file) => DOCS_ONLY.test(file))) {
    return { unitScope: 'skip', e2eScope: 'skip', buildScope: 'skip', e2eFiles: [], unitFiles: [] };
  }

  const unitPaths = files.filter((file) => !DOCS_ONLY.test(file) && !file.startsWith('e2e/'));
  const workspaceManifestChanged = unitPaths.some((file) => file !== 'package.json' && /(^|\/)package\.json$/.test(file));
  const unitInfrastructureChanged = matchesAny(unitPaths.filter((file) => file !== 'package.json'), UNIT_INFRA)
    || workspaceManifestChanged
    || (files.includes('package.json') && !ciRoutingManifestOnly);
  const unitScope = unitPaths.length === 0
    ? 'skip'
    : unitInfrastructureChanged
      ? 'full'
      : unitPaths.some((file) => /^(?:apps|packages|scripts|evals|tests|\.github\/workflows)\//.test(file)) || unitPaths.includes('package.json') || fileIsRootTestInput(unitPaths)
        ? 'changed'
        : 'full';

  const e2ePaths = files.filter((file) => file.startsWith('e2e/'));
  const desktopAppChanged = files.some((file) => /^(?:apps\/desktop|packages\/ui)\//.test(file));
  const e2eInfraChanged = (!ciRoutingManifestOnly && files.includes('package.json'))
    || desktopAppChanged
    || matchesAny(files, E2E_INFRA)
    || e2ePaths.some((file) => file === 'e2e/playwright.config.ts' || file === 'e2e/helpers.ts' || !/\.spec\.[cm]?[jt]sx?$/.test(file));
  const e2eFiles = e2ePaths.filter((file) => /\.spec\.[cm]?[jt]sx?$/.test(file));
  const e2eScope = e2eInfraChanged ? 'full' : e2eFiles.length > 0 ? 'changed' : 'skip';
  const ciOnlyChanges = files.every((file) => DOCS_ONLY.test(file)
    || file.startsWith('.github/workflows/')
    || file.startsWith('scripts/ci/'));
  const unitFiles = unitScope === 'changed'
    ? [...new Set(unitFilesFor(files, ciOnlyChanges))].sort()
    : [];

  return {
    unitScope,
    e2eScope,
    buildScope: ciOnlyChanges ? 'skip' : 'run',
    e2eFiles: e2eScope === 'changed' ? e2eFiles : [],
    unitFiles,
  };
}

function unitFilesFor(files, ciOnlyChanges) {
  const sourceOrTest = files.filter((file) => /^(?:apps|packages|scripts|evals|tests)\/.+\.[cm]?[jt]sx?$/.test(file));
  if (ciOnlyChanges) {
    const changedTests = sourceOrTest.filter((file) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file));
    return changedTests.length > 0 ? changedTests : ['scripts/ci/test-scope.test.ts'];
  }
  return sourceOrTest;
}

function isCiRoutingManifestOnly(baseSha, headSha) {
  try {
    const diff = execFileSync('git', [
      'diff', '--unified=0', `${baseSha}...${headSha}`, '--', 'package.json',
    ], { encoding: 'utf8' });
    const changedLines = diff.split(/\r?\n/).filter((line) => /^[+-]/.test(line) && !/^(?:\+\+\+|---)/.test(line));
    return changedLines.length === 1
      && /^\+\s*"ci:test-scope":\s*"node scripts\/ci\/test-scope\.mjs",?$/.test(changedLines[0]);
  } catch {
    return false;
  }
}

function fileIsRootTestInput(files) {
  return files.some((file) => file === 'test-setup.ts' || /^tests\//.test(file));
}

function readManifestAt(sha, manifestPath) {
  try {
    const raw = execFileSync('git', ['show', `${sha}:${manifestPath}`], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(raw);
  } catch {
    // Added, deleted, renamed or unreadable: not evidence of a metadata-only
    // edit, so the caller keeps the full suites.
    return null;
  }
}

/**
 * Manifests whose diff only touches metadata (description, keywords, author,
 * license, homepage, ...). A renamed manifest is treated as an infrastructure
 * change: its content at the new path is compared against the old path only
 * when both exist, and anything else fails closed.
 */
export function findMetadataOnlyManifests(baseSha, headSha, changedPaths) {
  const manifests = [...new Set(changedPaths.map(normalizePath).filter(Boolean))]
    .filter((file) => /(^|\/)package\.json$/.test(file))
    .sort();
  const metadataOnly = [];
  for (const manifestPath of manifests) {
    const baseManifest = readManifestAt(baseSha, manifestPath);
    const headManifest = readManifestAt(headSha, manifestPath);
    if (!baseManifest || !headManifest) continue;
    if (!manifestChangeIsInfrastructure(baseManifest, headManifest)) {
      metadataOnly.push(manifestPath);
    }
  }
  return metadataOnly;
}

export function getScopesForEvent(eventName, env = process.env) {
  if (eventName === 'schedule' || eventName === 'workflow_dispatch') {
    // The manual trigger and the nightly both mean "run everything, on every
    // platform". The nightly has been handled since the schedule trigger
    // existed; the manual trigger was added to the workflow at the same time
    // the Electron E2E suite moved OFF the pull-request path, so that the
    // suite could still be run on demand — and it never could, because this
    // function threw on any event it did not name. The scope job failed, so
    // every job that depends on it was skipped, including the one the manual
    // trigger exists to run.
    //
    // Measured on run 39642411510 (a manual dispatch on master): the scope
    // job failed after 7 seconds with `Unsupported workflow event:
    // workflow_dispatch`, and the typecheck, test and build jobs all went to
    // `skipped`. The escape hatch was a door that opened onto a wall.
    return { unitScope: 'full', e2eScope: 'full', buildScope: 'run', e2eFiles: [], unitFiles: [] };
  }
  if (eventName === 'push') {
    return { unitScope: 'skip', e2eScope: 'skip', buildScope: 'skip', e2eFiles: [], unitFiles: [] };
  }
  if (eventName !== 'pull_request') {
    throw new Error(`Unsupported workflow event: ${eventName || '(missing)'}`);
  }

  const { BASE_SHA: baseSha, HEAD_SHA: headSha } = env;
  if (!baseSha || !headSha) {
    process.stderr.write('PR base/head SHA unavailable; selecting full unit and E2E suites.\n');
    return { unitScope: 'full', e2eScope: 'full', buildScope: 'run', e2eFiles: [], unitFiles: [] };
  }

  try {
    const output = execFileSync('git', ['diff', '--name-only', `${baseSha}...${headSha}`], { encoding: 'utf8' });
    const paths = output.split(/\r?\n/);
    return classifyChangedFilesWithOptions(paths, {
      ciRoutingManifestOnly: paths.includes('package.json') && isCiRoutingManifestOnly(baseSha, headSha),
      metadataOnlyManifests: findMetadataOnlyManifests(baseSha, headSha, paths),
    });
  } catch (error) {
    process.stderr.write(`Could not resolve PR changes; selecting full suites: ${String(error)}\n`);
    return { unitScope: 'full', e2eScope: 'full', buildScope: 'run', e2eFiles: [], unitFiles: [] };
  }
}

function writeOutputs(scopes, outputPath = process.env.GITHUB_OUTPUT) {
  const lines = [
    `unit_scope=${scopes.unitScope}`,
    `e2e_scope=${scopes.e2eScope}`,
    `build_scope=${scopes.buildScope}`,
    `e2e_files=${JSON.stringify(scopes.e2eFiles)}`,
    `unit_files=${JSON.stringify(scopes.unitFiles)}`,
  ].join('\n') + '\n';
  if (outputPath) appendFileSync(outputPath, lines, 'utf8');
  else process.stdout.write(lines);
}

function main() {
  const scopes = getScopesForEvent(process.env.GITHUB_EVENT_NAME);
  process.stdout.write(
    `Selected scopes: unit=${scopes.unitScope}, e2e=${scopes.e2eScope}, build=${scopes.buildScope}\n`,
  );
  writeOutputs(scopes);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
