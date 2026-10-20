#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DOCS_ONLY = /^(?:docs|docs-local)\/|\.(?:md|mdx|rst|txt)$/i;
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
export function classifyChangedFiles(changedPaths) {
  const files = [...new Set(changedPaths.map(normalizePath).filter(Boolean))].sort();
  if (files.length === 0) {
    return { unitScope: 'full', e2eScope: 'full', buildScope: 'run', e2eFiles: [] };
  }

  if (files.every((file) => DOCS_ONLY.test(file))) {
    return { unitScope: 'skip', e2eScope: 'skip', buildScope: 'skip', e2eFiles: [] };
  }

  const unitFiles = files.filter((file) => !DOCS_ONLY.test(file) && !file.startsWith('e2e/'));
  const workspaceManifestChanged = unitFiles.some((file) => file !== 'package.json' && /(^|\/)package\.json$/.test(file));
  const unitInfrastructureChanged = matchesAny(unitFiles.filter((file) => file !== 'package.json'), UNIT_INFRA)
    || workspaceManifestChanged;
  const unitScope = unitFiles.length === 0
    ? 'skip'
    : unitInfrastructureChanged
      ? 'full'
      : unitFiles.some((file) => /^(?:apps|packages|scripts|evals|tests|\.github\/workflows)\//.test(file)) || unitFiles.includes('package.json') || fileIsRootTestInput(unitFiles)
        ? 'changed'
        : 'full';

  const e2ePaths = files.filter((file) => file.startsWith('e2e/'));
  const desktopAppChanged = files.some((file) => /^(?:apps\/desktop|packages\/ui)\//.test(file));
  const e2eInfraChanged = desktopAppChanged
    || matchesAny(files, E2E_INFRA)
    || e2ePaths.some((file) => file === 'e2e/playwright.config.ts' || file === 'e2e/helpers.ts' || !/\.spec\.[cm]?[jt]sx?$/.test(file));
  const e2eFiles = e2ePaths.filter((file) => /\.spec\.[cm]?[jt]sx?$/.test(file));
  const e2eScope = e2eInfraChanged ? 'full' : e2eFiles.length > 0 ? 'changed' : 'skip';
  const ciOnlyChanges = files.every((file) => DOCS_ONLY.test(file)
    || file.startsWith('.github/workflows/')
    || file.startsWith('scripts/ci/'));

  return {
    unitScope,
    e2eScope,
    buildScope: ciOnlyChanges ? 'skip' : 'run',
    e2eFiles: e2eScope === 'changed' ? e2eFiles : [],
  };
}

function fileIsRootTestInput(files) {
  return files.some((file) => file === 'test-setup.ts' || /^tests\//.test(file));
}

export function getScopesForEvent(eventName, env = process.env) {
  if (eventName === 'schedule') {
    return { unitScope: 'full', e2eScope: 'full', buildScope: 'run', e2eFiles: [] };
  }
  if (eventName === 'push') {
    return { unitScope: 'skip', e2eScope: 'skip', buildScope: 'skip', e2eFiles: [] };
  }
  if (eventName !== 'pull_request') {
    throw new Error(`Unsupported workflow event: ${eventName || '(missing)'}`);
  }

  const { BASE_SHA: baseSha, HEAD_SHA: headSha } = env;
  if (!baseSha || !headSha) {
    process.stderr.write('PR base/head SHA unavailable; selecting full unit and E2E suites.\n');
    return { unitScope: 'full', e2eScope: 'full', buildScope: 'run', e2eFiles: [] };
  }

  try {
    const output = execFileSync('git', ['diff', '--name-only', `${baseSha}...${headSha}`], { encoding: 'utf8' });
    return classifyChangedFiles(output.split(/\r?\n/));
  } catch (error) {
    process.stderr.write(`Could not resolve PR changes; selecting full suites: ${String(error)}\n`);
    return { unitScope: 'full', e2eScope: 'full', buildScope: 'run', e2eFiles: [] };
  }
}

function writeOutputs(scopes, outputPath = process.env.GITHUB_OUTPUT) {
  const lines = [
    `unit_scope=${scopes.unitScope}`,
    `e2e_scope=${scopes.e2eScope}`,
    `build_scope=${scopes.buildScope}`,
    `e2e_files=${JSON.stringify(scopes.e2eFiles)}`,
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
