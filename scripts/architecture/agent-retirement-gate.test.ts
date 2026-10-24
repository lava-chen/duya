import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  collectAgentRetirementReport,
  compareRetirementBaseline,
  strictFailures,
} from './agent-retirement-gate.mjs';

let fixtureRoot = '';

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-agent-retirement-'));
});

afterEach(() => {
  if (!fixtureRoot) return;
  const absoluteRoot = path.resolve(fixtureRoot);
  const tempRoot = path.resolve(os.tmpdir()) + path.sep;
  if (!absoluteRoot.startsWith(tempRoot) || !path.basename(absoluteRoot).startsWith('duya-agent-retirement-')) {
    throw new Error('refusing to remove fixture outside generated temp directory: ' + absoluteRoot);
  }
  fs.rmSync(absoluteRoot, { recursive: true, force: true });
  fixtureRoot = '';
});

function writeFixture(relativePath: string, contents: string): void {
  const absolutePath = path.join(fixtureRoot, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, contents, 'utf8');
}

describe('agent-retirement-gate', () => {
  it('finds direct and dynamic package imports, including type-only imports', () => {
    // RETIREMENT_GATE_FIXTURE_CONTEXT_START
    writeFixture('packages/agent/package.json', '{"name":"@duya/agent"}');
    writeFixture(
      'packages/host/src/worker.ts',
      [
        "import type { LegacyEvent } from '@duya/agent/protocol';",
        "export const load = () => import('@duya/agent/process/agent-process-entry.js');",
        "export const loadLegacy = () => require('@duya/agent');",
        "const packageName = '@duya/agent';",
      ].join('\n'),
    );

    const report = collectAgentRetirementReport(fixtureRoot);
    const imports = report.findings.filter((finding) => finding.kind === 'package-import');

    expect(imports.map((finding) => finding.match)).toEqual(expect.arrayContaining([
      '@duya/agent/protocol',
      '@duya/agent/process/agent-process-entry.js',
      '@duya/agent',
    ]));
    expect(report.findings.some((finding) =>
      finding.file === 'packages/host/src/worker.ts'
      && finding.kind === 'package-reference'
      && finding.match === '@duya/agent',
    )).toBe(true);
    expect(report.legacyPackagePresent).toBe(true);
    expect(report.status).toBe('OPEN');
    expect(strictFailures(report)).not.toHaveLength(0);
    // RETIREMENT_GATE_FIXTURE_CONTEXT_END
  });

  it('finds deep relative source/dist loads and paths assembled from segments', () => {
    // RETIREMENT_GATE_FIXTURE_CONTEXT_START
    writeFixture(
      'apps/desktop/src/main/worker.ts',
      [
        "const worker = require('../../../../packages/agent/dist/process/agent-process-entry.js');",
        "const legacyAssets = path.join(root, 'packages', 'agent', 'bundle');",
      ].join('\n'),
    );

    const findings = collectAgentRetirementReport(fixtureRoot).findings;

    expect(findings.some((finding) => finding.kind === 'relative-package-import')).toBe(true);
    expect(findings.some((finding) => finding.kind === 'split-package-path')).toBe(true);
    expect(findings.some((finding) =>
      finding.kind === 'worker-artifact' && finding.match === 'agent-process-entry.js',
    )).toBe(true);
    // RETIREMENT_GATE_FIXTURE_CONTEXT_END
  });

  it('finds package metadata, TypeScript aliases, worker entries, assets, and active shell scripts', () => {
    // RETIREMENT_GATE_FIXTURE_CONTEXT_START
    writeFixture(
      'electron-builder.yml',
      [
        'extraResources:',
        '  - from: packages/agent/bundle/',
        '    to: agent-bundle/',
        '  - from: packages/agent/skills/',
        '    to: agent/skills/',
      ].join('\n'),
    );
    writeFixture(
      'apps/desktop/tsconfig.main.json',
      '{"compilerOptions":{"paths":{"@duya/agent/*":["../../packages/agent/dist/*"]}}}',
    );
    writeFixture('package.json', '{"scripts":{"bundle:agent":"node scripts/build-agent-bundle.mjs"}}');
    writeFixture('.architecture-baseline.json', '{"legacy":"packages/agent/src/old.ts"}');
    writeFixture(
      'scripts/packaging/verify-worker.ps1',
      [
        '# Historical reference: packages/agent/src/old-worker.ts',
        "$worker = 'packages/agent/bundle/agent-process-entry.js'",
      ].join('\n'),
    );

    const findings = collectAgentRetirementReport(fixtureRoot).findings;

    expect(findings.some((finding) => finding.kind === 'worker-artifact')).toBe(true);
    expect(findings.some((finding) => finding.kind === 'skill-asset')).toBe(true);
    expect(findings.some((finding) => finding.kind === 'legacy-agent-script')).toBe(true);
    expect(findings.some((finding) => finding.kind === 'package-reference')).toBe(true);
    expect(findings.some((finding) =>
      finding.file === '.architecture-baseline.json' && finding.scope === 'active-config',
    )).toBe(true);
    expect(findings.some((finding) =>
      finding.file === 'scripts/packaging/verify-worker.ps1'
      && finding.scope === 'build-tooling'
      && finding.line === 2,
    )).toBe(true);
    expect(findings.some((finding) =>
      finding.file === 'scripts/packaging/verify-worker.ps1' && finding.line === 1,
    )).toBe(false);
    expect(findings.some((finding) => finding.scope === 'active-config')).toBe(true);
    // RETIREMENT_GATE_FIXTURE_CONTEXT_END
  });

  it('separates test targets and evaluations from product code, and ignores historical docs', () => {
    // RETIREMENT_GATE_FIXTURE_CONTEXT_START
    writeFixture('packages/agent/package.json', '{"name":"@duya/agent"}');
    writeFixture(
      'apps/desktop/src/main/__tests__/retired-worker.test.ts',
      "import { oldEntry } from '../../../../packages/agent/src/process/entry.js';",
    );
    writeFixture(
      'evals/agent/matrix/rows.ts',
      "export const oldEntry = 'packages/agent/src/process/entry.js';",
    );
    writeFixture(
      'docs/exec-plans/completed/old-plan.md',
      'Historical note: packages/agent/bundle/agent-process-entry.js was used here.',
    );

    const report = collectAgentRetirementReport(fixtureRoot);

    expect([...new Set(report.findings.map((finding) => finding.file))].sort()).toEqual([
      'apps/desktop/src/main/__tests__/retired-worker.test.ts',
      'evals/agent/matrix/rows.ts',
    ]);
    expect(report.findings.find((finding) => finding.file ===
      'apps/desktop/src/main/__tests__/retired-worker.test.ts')?.scope).toBe('test-target');
    expect(report.findings.find((finding) => finding.file ===
      'evals/agent/matrix/rows.ts')?.scope).toBe('test-target');
    expect(report.findings.some((finding) => finding.file.includes('old-plan.md'))).toBe(false);
    // RETIREMENT_GATE_FIXTURE_CONTEXT_END
  });

  it('reports static closure only when the active scope is non-empty and the old directory is absent', () => {
    // RETIREMENT_GATE_FIXTURE_CONTEXT_START
    writeFixture('packages/host/src/index.ts', 'export const hostReady = true;');
    writeFixture('docs/old.md', 'packages/agent is mentioned only as history.');

    const report = collectAgentRetirementReport(fixtureRoot);

    expect(report.scannedFiles).toBeGreaterThan(0);
    expect(report.status).toBe('CLOSED');
    expect(report.runtimeVerificationRequired).toBe(true);
    expect(strictFailures(report)).toEqual([]);
    // RETIREMENT_GATE_FIXTURE_CONTEXT_END
  });

  it('treats an empty scan as unverified rather than a green retirement', () => {
    // RETIREMENT_GATE_FIXTURE_CONTEXT_START
    writeFixture('docs/only-history.md', 'packages/agent once owned the worker.');

    const report = collectAgentRetirementReport(fixtureRoot);

    expect(report.status).toBe('UNVERIFIED');
    expect(strictFailures(report)).toContain('the gate scanned no active source/config scope');
    // RETIREMENT_GATE_FIXTURE_CONTEXT_END
  });

  it('maps Host-produced worker artifacts without confusing their names with the old package', () => {
    // RETIREMENT_GATE_FIXTURE_CONTEXT_START
    writeFixture(
      'packages/host/src/worker.ts',
      [
        "const output = 'packages/host/bundle/agent-process-entry.js';",
        "const shellWorker = 'packages/host/bundle/BashTool/BashWorker.js';",
      ].join('\n'),
    );

    const report = collectAgentRetirementReport(fixtureRoot);
    const selectors = report.findings.filter((finding) => finding.selectorStatus !== null);

    expect(report.blockingReferenceCount).toBe(0);
    expect(report.hostMappedSelectorCount).toBe(2);
    expect(report.unverifiedSelectorCount).toBe(0);
    expect(selectors.every((finding) => finding.selectorStatus === 'host-mapped')).toBe(true);
    expect(report.status).toBe('CLOSED');
    expect(report.runtimeVerificationRequired).toBe(true);
    expect(strictFailures(report)).toEqual([]);
    // RETIREMENT_GATE_FIXTURE_CONTEXT_END
  });

  it('keeps artifact selectors without a proven producer unverified rather than treating them as package imports', () => {
    // RETIREMENT_GATE_FIXTURE_CONTEXT_START
    writeFixture('apps/desktop/src/main/worker.ts', "const workerEntry = 'agent-process-entry.js';");

    const report = collectAgentRetirementReport(fixtureRoot);

    expect(report.blockingReferenceCount).toBe(0);
    expect(report.unverifiedSelectorCount).toBe(1);
    expect(report.status).toBe('UNVERIFIED');
    expect(strictFailures(report)).toContain('1 artifact/build selectors still need producer mapping');
    // RETIREMENT_GATE_FIXTURE_CONTEXT_END
  });

  it('does not match the neighboring agent-runtime package as the retiring package', () => {
    // RETIREMENT_GATE_FIXTURE_CONTEXT_START
    writeFixture(
      'packages/agent-runtime/src/worker.ts',
      [
        "import { RunEngine } from '@duya/agent-runtime';",
        "const source = 'packages/agent-runtime/src/agent-process-entry.js';",
      ].join('\n'),
    );

    const report = collectAgentRetirementReport(fixtureRoot);

    expect(report.findings.some((finding) =>
      finding.kind === 'package-import' || finding.kind === 'relative-package-import'
        || finding.kind === 'source-or-dist-path',
    )).toBe(false);
    expect(report.blockingReferenceCount).toBe(0);
    expect(report.unverifiedSelectorCount).toBe(1);
    // RETIREMENT_GATE_FIXTURE_CONTEXT_END
  });

  it('keeps real old-package imports and read paths in ordinary test targets blocking', () => {
    // RETIREMENT_GATE_FIXTURE_CONTEXT_START
    writeFixture(
      'apps/desktop/src/main/__tests__/retired-worker.test.ts',
      [
        "import { worker } from '@duya/agent/process/entry';",
        "const source = readFileSync('../../../../../packages/agent/src/process/entry.js');",
      ].join('\n'),
    );

    const report = collectAgentRetirementReport(fixtureRoot);
    const actualTestFindings = report.findings.filter((finding) =>
      finding.file === 'apps/desktop/src/main/__tests__/retired-worker.test.ts',
    );

    expect(actualTestFindings.length).toBeGreaterThan(0);
    expect(actualTestFindings.every((finding) => finding.scope === 'test-target')).toBe(true);
    expect(actualTestFindings.every((finding) => finding.blocking)).toBe(true);
    expect(report.blockingReferenceCount).toBe(actualTestFindings.length);
    // RETIREMENT_GATE_FIXTURE_CONTEXT_END
  });

  it('blocks retirement-reference growth while allowing reductions in every scope', () => {
    const baseline = {
      version: 1,
      generatedFrom: 'fixture',
      referenceCount: 3,
      byScope: {
        'production-source': 1,
        'build-tooling': 1,
        'active-config': 0,
        'test-target': 1,
      },
    };

    const reduced = {
      referenceCount: 2,
      byScope: {
        'production-source': 1,
        'build-tooling': 1,
        'active-config': 0,
        'test-target': 0,
      },
    };
    const shifted = {
      referenceCount: 3,
      byScope: {
        'production-source': 2,
        'build-tooling': 0,
        'active-config': 0,
        'test-target': 1,
      },
    };

    expect(compareRetirementBaseline(reduced, baseline).newReferenceCount).toBe(0);
    expect(compareRetirementBaseline(shifted, baseline)).toMatchObject({
      newReferenceCount: 1,
      increasesByScope: { 'production-source': 1 },
    });
    expect(() => compareRetirementBaseline(reduced, { ...baseline, referenceCount: 4 }))
      .toThrow('counts do not add up');
  });

  it('ignores only references inside the gate test explicit fixture markers', () => {
    // RETIREMENT_GATE_FIXTURE_CONTEXT_START
    writeFixture(
      'scripts/architecture/agent-retirement-gate.test.ts',
      [
        '// RETIREMENT_GATE_FIXTURE_CONTEXT_START',
        "const specimen = '@duya/agent';",
        '// RETIREMENT_GATE_FIXTURE_CONTEXT_END',
        "const actualDependency = 'packages/agent/dist/index.js';",
      ].join('\n'),
    );

    const report = collectAgentRetirementReport(fixtureRoot);
    const markerFindings = report.findings.filter((finding) =>
      finding.file === 'scripts/architecture/agent-retirement-gate.test.ts',
    );

    expect(report.fixtureReferenceCount).toBeGreaterThan(0);
    expect(markerFindings.some((finding) => finding.fixtureContext)).toBe(true);
    expect(markerFindings.some((finding) => finding.blocking && !finding.fixtureContext)).toBe(true);
    expect(report.blockingReferenceCount).toBeGreaterThan(0);
    // RETIREMENT_GATE_FIXTURE_CONTEXT_END
  });
});
