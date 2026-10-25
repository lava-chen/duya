#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ARCHITECTURE_BASELINE = '.architecture-baseline.json';
const RETIREMENT_BASELINE = 'scripts/architecture/agent-retirement-gate-baseline.json';
const RETIREMENT_SCOPES = ['production-source', 'build-tooling', 'active-config', 'test-target'];

function validateFingerprintBaseline(value, label) {
  if (!value || !Array.isArray(value.violations)
      || value.violations.some((fingerprint) => typeof fingerprint !== 'string')) {
    throw new Error(`${label} must contain a string violations array`);
  }
  if (new Set(value.violations).size !== value.violations.length) {
    throw new Error(`${label} contains duplicate fingerprints`);
  }
  return value.violations;
}

export function compareArchitectureBaselines(previous, current) {
  const previousSet = new Set(validateFingerprintBaseline(previous, 'base architecture baseline'));
  const currentSet = new Set(validateFingerprintBaseline(current, 'current architecture baseline'));
  return {
    added: [...currentSet].filter((fingerprint) => !previousSet.has(fingerprint)).sort(),
    removed: [...previousSet].filter((fingerprint) => !currentSet.has(fingerprint)).sort(),
  };
}

function validateRetirementBaseline(value, label) {
  if (!value || value.version !== 1 || !Number.isInteger(value.referenceCount)
      || value.referenceCount < 0 || !value.byScope || typeof value.byScope !== 'object') {
    throw new Error(`${label} is not a version 1 retirement baseline`);
  }
  let total = 0;
  for (const scope of RETIREMENT_SCOPES) {
    const count = value.byScope[scope];
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`${label} has an invalid ${scope} count`);
    }
    total += count;
  }
  if (total !== value.referenceCount) {
    throw new Error(`${label} scope counts sum to ${total}, not ${value.referenceCount}`);
  }
  return value;
}

export function compareRetirementBaselineGrowth(previous, current) {
  const next = validateRetirementBaseline(current, 'current retirement baseline');
  if (previous === null) {
    return { initialized: true, newReferenceCount: 0, increasesByScope: {} };
  }
  const prior = validateRetirementBaseline(previous, 'base retirement baseline');
  const increasesByScope = Object.fromEntries(RETIREMENT_SCOPES.map((scope) => [
    scope,
    Math.max(0, next.byScope[scope] - prior.byScope[scope]),
  ]));
  const scopeIncrease = Object.values(increasesByScope).reduce((sum, count) => sum + count, 0);
  const totalIncrease = Math.max(0, next.referenceCount - prior.referenceCount);
  return {
    initialized: false,
    newReferenceCount: Math.max(scopeIncrease, totalIncrease),
    increasesByScope,
  };
}

function gitFileExists(ref, relativePath) {
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}:${relativePath}`], {
      cwd: ROOT,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function readGitJson(ref, relativePath) {
  const raw = execFileSync('git', ['show', `${ref}:${relativePath}`], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(raw);
}

function main(baseRef) {
  try {
    execFileSync('git', ['rev-parse', '--verify', `${baseRef}^{commit}`], {
      cwd: ROOT,
      stdio: 'ignore',
    });

    const previousArchitecture = readGitJson(baseRef, ARCHITECTURE_BASELINE);
    const currentArchitecture = JSON.parse(fs.readFileSync(
      path.join(ROOT, ARCHITECTURE_BASELINE), 'utf8',
    ));
    const architecture = compareArchitectureBaselines(previousArchitecture, currentArchitecture);

    const currentRetirement = JSON.parse(fs.readFileSync(
      path.join(ROOT, RETIREMENT_BASELINE), 'utf8',
    ));
    const previousRetirement = gitFileExists(baseRef, RETIREMENT_BASELINE)
      ? readGitJson(baseRef, RETIREMENT_BASELINE)
      : null;
    const retirement = compareRetirementBaselineGrowth(previousRetirement, currentRetirement);

    if (architecture.added.length > 0 || retirement.newReferenceCount > 0) {
      process.stderr.write(
        `baseline ratchet: FAIL — architecture additions=${architecture.added.length}, `
        + `retirement additions=${retirement.newReferenceCount}\n`,
      );
      if (architecture.added.length > 0) {
        process.stderr.write(`new architecture fingerprints: ${architecture.added.slice(0, 10).join(', ')}\n`);
      }
      for (const [scope, count] of Object.entries(retirement.increasesByScope)) {
        if (count > 0) process.stderr.write(`new retirement ${scope} references: ${count}\n`);
      }
      process.exitCode = 1;
      return;
    }

    process.stdout.write(
      `baseline ratchet: PASS — architecture ${previousArchitecture.violations.length} -> `
      + `${currentArchitecture.violations.length} (${architecture.removed.length} removed, 0 added); `
      + (retirement.initialized
        ? `retirement baseline initialized at ${currentRetirement.referenceCount}`
        : `retirement ${previousRetirement.referenceCount} -> ${currentRetirement.referenceCount} (no growth)`)
      + '\n',
    );
  } catch (error) {
    process.stderr.write(`baseline ratchet: could not verify against ${baseRef}: ${error.message}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2] ?? 'HEAD');
}
