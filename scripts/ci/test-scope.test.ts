import { classifyChangedFiles, getScopesForEvent } from './test-scope.mjs';

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
