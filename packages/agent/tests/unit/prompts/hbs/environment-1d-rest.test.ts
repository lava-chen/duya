/**
 * Environment section .hbs byte-level parity test — Plan 550 1d-rest.
 *
 * Mirrors the pattern used by the memory / session-guidance parity tests.
 * The legacy TS path (`getEnvironmentSection`) joins items with `\n` and
 * prefixes each with ` - `; the .hbs path renders the same array via
 * `{{#each env_items}} - {{this}}\n{{/each}}` and the test confirms the
 * trimmed output matches TS exactly.
 *
 * The async `fs.access(<cwd>/.git)` detection is supplied via the
 * `createEnvironmentPreBuildHook` `isGitRepo` option so the test never
 * touches the real filesystem. `nowMs` is fixed at a deterministic epoch
 * so the locale-formatted date string is stable across machines.
 *
 * Five cases:
 *   1. Windows PowerShell session inside a git repo (full house).
 *   2. Unix bash session outside a git repo (git line dropped).
 *   3. Empty working directory (the "no project folder" branch).
 *   4. Worktree session (worktree line emitted).
 *   5. Session with multiple additional working directories (sub-list).
 */
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HbsPromptSystem } from '../../../../src/prompts/hbs/HbsPromptSystem.js';
import { createEnvironmentPreBuildHook } from '../../../../src/prompts/sections/dynamic/environmentPreBuildHook.js';
import { getEnvironmentSection } from '../../../../src/prompts/sections/dynamic/environment.js';
import type { PromptContext } from '../../../../src/prompts/types.js';

const ASSETS_ROOT = resolve(__dirname, '../../../../src/prompts/assets');

// Deterministic epoch for `now_ms` so the locale-formatted timestamp
// is identical across machines and CI runs. 2026-01-15T12:34:56Z is
// arbitrary; we only need it to stay stable for snapshot stability.
const FIXED_NOW_MS = Date.UTC(2026, 0, 15, 12, 34, 56);

function ctxWith(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    workingDirectory: 'E:\\Projects\\duya',
    platform: 'win32',
    shell: 'powershell',
    modelId: 'test-model',
    enabledTools: new Set<string>(['Read', 'Edit', 'Write']),
    sessionStartTime: 0,
    ...overrides,
  } as PromptContext;
}

describe('environment-section hbs byte-level parity (Plan 550 1d-rest)', () => {
  const system = new HbsPromptSystem({ assetsRoot: ASSETS_ROOT });

  async function checkWithStub(
    overrides: Partial<PromptContext>,
    isGitRepoValue: boolean,
  ) {
    const envHook = createEnvironmentPreBuildHook({
      isGitRepo: async () => isGitRepoValue,
      nowMs: () => FIXED_NOW_MS,
    });
    const extension = await envHook(ctxWith(overrides));
    const enrichedCtx = extension?.promptContextExtension
      ? { ...ctxWith(overrides), ...extension.promptContextExtension }
      : ctxWith(overrides);
    const ts = await getEnvironmentSection(enrichedCtx);
    const hbs = system.renderStaticTemplate('dynamic/environment.hbs', enrichedCtx).trim();
    const hbsNorm = hbs === '' ? null : hbs;
    expect(hbsNorm).toBe(ts);
  }

  it('matches when Windows PowerShell session is inside a git repo', async () => {
    await checkWithStub({ platform: 'win32', shell: 'powershell' }, true);
  });

  it('matches when Unix bash session is outside a git repo', async () => {
    await checkWithStub(
      {
        platform: 'linux',
        shell: 'bash',
        workingDirectory: '/home/runner/work',
      },
      false,
    );
  });

  it('matches when there is no working directory', async () => {
    await checkWithStub(
      {
        workingDirectory: '',
        platform: 'darwin',
        shell: 'zsh',
      },
      false,
    );
  });

  it('matches when the session is a git worktree', async () => {
    await checkWithStub({ isWorktree: true }, true);
  });

  it('matches when there are multiple additional working directories', async () => {
    await checkWithStub(
      {
        additionalWorkingDirectories: ['/tmp/extra-a', '/tmp/extra-b'],
        location: {
          locale: 'en-US',
          localeCountryCode: 'US',
          timezone: 'America/New_York',
        },
        modelId: 'claude-sonnet-4-6',
        modelName: 'Claude Sonnet 4.6',
      },
      true,
    );
  });
});