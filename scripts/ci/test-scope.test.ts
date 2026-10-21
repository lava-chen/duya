import { classifyChangedFiles, getScopesForEvent, manifestChangeIsInfrastructure } from './test-scope.mjs';

describe('classifyChangedFiles', () => {
  it('skips tests and build only when every change is documentation', () => {
    expect(classifyChangedFiles(['docs/guide.md', 'README.md'])).toEqual({
      unitScope: 'skip',
      e2eScope: 'skip',
      buildScope: 'skip',
      e2eFiles: [],
      unitFiles: [],
    });
  });

  it('runs related unit tests and the application build for package source changes', () => {
    expect(classifyChangedFiles(['packages/host/src/run.ts'])).toEqual({
      unitScope: 'changed',
      e2eScope: 'skip',
      buildScope: 'run',
      e2eFiles: [],
      unitFiles: ['packages/host/src/run.ts'],
    });
  });

  it('runs only the changed Playwright spec for a focused E2E test edit', () => {
    expect(classifyChangedFiles(['e2e/smoke/smoke.spec.ts'])).toEqual({
      unitScope: 'skip',
      e2eScope: 'changed',
      buildScope: 'run',
      e2eFiles: ['e2e/smoke/smoke.spec.ts'],
      unitFiles: [],
    });
  });

  it('runs the full E2E suite when shared Playwright support changes', () => {
    expect(classifyChangedFiles(['e2e/helpers.ts'])).toEqual({
      unitScope: 'skip',
      e2eScope: 'full',
      buildScope: 'run',
      e2eFiles: [],
      unitFiles: [],
    });
  });

  it('runs unit and focused E2E tests for mixed implementation and spec changes', () => {
    expect(classifyChangedFiles([
      'packages/desktop/src/main/ipc-handler.ts',
      'e2e/ipc/system.spec.ts',
    ])).toEqual({
      unitScope: 'changed',
      e2eScope: 'changed',
      buildScope: 'run',
      e2eFiles: ['e2e/ipc/system.spec.ts'],
      unitFiles: ['packages/desktop/src/main/ipc-handler.ts'],
    });
  });

  it.each([
    'vitest.config.ts',
    'packages/host/package.json',
    'package-lock.json',
    'tsconfig.json',
  ])('falls back to full unit tests for test infrastructure change: %s', (file) => {
    expect(classifyChangedFiles([file]).unitScope).toBe('full');
  });

  it('keeps full suites when an infrastructure edit is mixed with source changes', () => {
    expect(classifyChangedFiles([
      'packages/host/src/run.ts',
      'package-lock.json',
      'e2e/smoke/smoke.spec.ts',
    ])).toEqual({
      unitScope: 'full',
      e2eScope: 'full',
      buildScope: 'run',
      e2eFiles: [],
      unitFiles: [],
    });
  });

  it.each(['.github/workflows/test.yml', 'scripts/ci/test-scope.mjs'])('runs the focused unit scope for CI resolver and workflow changes: %s', (file) => {
    expect(classifyChangedFiles([file]).unitScope).toBe('changed');
  });

  it('skips product build and E2E for CI-only wiring changes', () => {
    expect(classifyChangedFiles([
      '.github/workflows/test.yml',
      'scripts/ci/test-scope.mjs',
      'scripts/ci/test-scope.test.ts',
    ])).toMatchObject({
      unitScope: 'changed',
      e2eScope: 'skip',
      buildScope: 'skip',
      unitFiles: ['scripts/ci/test-scope.test.ts'],
    });
  });

  it('treats only the CI resolver npm script manifest edit as CI-only', () => {
    expect(classifyChangedFiles([
      '.github/workflows/test.yml',
      'package.json',
      'scripts/ci/test-scope.mjs',
      'scripts/ci/test-scope.test.ts',
    ], { ciRoutingManifestOnly: true })).toMatchObject({
      unitScope: 'changed',
      e2eScope: 'skip',
      buildScope: 'skip',
      unitFiles: ['scripts/ci/test-scope.test.ts'],
    });
  });

  it('runs full unit, build and E2E validation for general root manifest changes', () => {
    expect(classifyChangedFiles(['package.json'])).toMatchObject({
      unitScope: 'full',
      e2eScope: 'full',
      buildScope: 'run',
    });
  });

  it('runs the full E2E suite for build and dependency infrastructure changes', () => {
    expect(classifyChangedFiles(['scripts/build-electron.mjs'])).toMatchObject({
      unitScope: 'changed',
      e2eScope: 'full',
      buildScope: 'run',
    });
  });

  it.each([
    'apps/desktop/src/main/ipc/system-handlers.ts',
    'apps/desktop/src/preload/index.ts',
    'packages/ui/src/components/chat/ChatView.tsx',
  ])('runs Electron smoke tests for Desktop and shared UI changes: %s', (file) => {
    expect(classifyChangedFiles([file]).e2eScope).toBe('full');
  });

  it('fails closed to full suites when the PR diff has no paths', () => {
    expect(classifyChangedFiles([])).toEqual({
      unitScope: 'full',
      e2eScope: 'full',
      buildScope: 'run',
      e2eFiles: [],
      unitFiles: [],
    });
  });

  it('fails closed to full suites when pull request SHAs are unavailable', () => {
    expect(getScopesForEvent('pull_request', {})).toEqual({
      unitScope: 'full',
      e2eScope: 'full',
      buildScope: 'run',
      e2eFiles: [],
      unitFiles: [],
    });
  });

  it('runs full unit and E2E suites plus the cross-platform build matrix on schedule', () => {
    expect(getScopesForEvent('schedule', {})).toEqual({
      unitScope: 'full',
      e2eScope: 'full',
      buildScope: 'run',
      e2eFiles: [],
      unitFiles: [],
    });
  });

  it('skips product tests for master pushes because PRs and the schedule own them', () => {
    expect(getScopesForEvent('push', {})).toEqual({
      unitScope: 'skip',
      e2eScope: 'skip',
      buildScope: 'skip',
      e2eFiles: [],
      unitFiles: [],
    });
  });
});

describe('manifestChangeIsInfrastructure', () => {
  const base = {
    name: 'duya',
    description: 'local-first agent workbench',
    keywords: ['agent'],
    dependencies: { react: '19.0.0' },
    devDependencies: { vitest: '3.0.0' },
    scripts: { test: 'vitest run' },
    workspaces: ['packages/*'],
    type: 'module',
    exports: { '.': './src/index.ts' },
  };

  it('treats a metadata-only edit as non-infrastructure', () => {
    expect(manifestChangeIsInfrastructure(base, {
      ...base,
      description: 'a local-first agent workbench for many agents',
      keywords: ['agent', 'cli'],
    })).toBe(false);
  });

  it.each([
    ['dependencies', { dependencies: { react: '19.1.0' } }],
    ['devDependencies', { devDependencies: { vitest: '3.1.0' } }],
    ['scripts', { scripts: { test: 'vitest run --coverage' } }],
    ['workspaces', { workspaces: ['packages/*', 'apps/*'] }],
    ['type', { type: 'commonjs' }],
    ['exports', { exports: { '.': './src/main.ts' } }],
  ])('treats a %s edit as infrastructure', (key, patch) => {
    expect(manifestChangeIsInfrastructure(base, { ...base, ...patch })).toBe(true);
  });

  it('fails closed when a manifest cannot be read', () => {
    expect(manifestChangeIsInfrastructure(null, base)).toBe(true);
    expect(manifestChangeIsInfrastructure(base, null)).toBe(true);
  });
});

describe('metadata-only manifest edits', () => {
  it('skips build, unit and E2E for a metadata-only root manifest edit', () => {
    expect(classifyChangedFiles(['package.json'], { metadataOnlyManifests: ['package.json'] })).toEqual({
      unitScope: 'skip',
      e2eScope: 'skip',
      buildScope: 'skip',
      e2eFiles: [],
      unitFiles: [],
    });
  });

  it('keeps a documentation PR cheap when it also edits the manifest description', () => {
    expect(classifyChangedFiles(['docs/guide.md', 'package.json'], {
      metadataOnlyManifests: ['package.json'],
    })).toEqual({
      unitScope: 'skip',
      e2eScope: 'skip',
      buildScope: 'skip',
      e2eFiles: [],
      unitFiles: [],
    });
  });

  it('still runs the affected unit tests for a source change next to a metadata-only manifest edit', () => {
    expect(classifyChangedFiles(['packages/host/src/run.ts', 'package.json'], {
      metadataOnlyManifests: ['package.json'],
    })).toEqual({
      unitScope: 'changed',
      e2eScope: 'skip',
      buildScope: 'run',
      e2eFiles: [],
      unitFiles: ['packages/host/src/run.ts'],
    });
  });

  it('still runs the full suites when the same manifest edit also changes a dependency', () => {
    expect(classifyChangedFiles(['package.json'], { metadataOnlyManifests: [] })).toMatchObject({
      unitScope: 'full',
      e2eScope: 'full',
      buildScope: 'run',
    });
  });

  it('keeps a workspace manifest metadata edit out of the infrastructure path', () => {
    expect(classifyChangedFiles(['packages/host/package.json'], {
      metadataOnlyManifests: ['packages/host/package.json'],
    })).toEqual({
      unitScope: 'skip',
      e2eScope: 'skip',
      buildScope: 'skip',
      e2eFiles: [],
      unitFiles: [],
    });
  });
});
