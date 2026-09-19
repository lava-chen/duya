/**
 * Recent-sessions section .hbs byte-level parity test — Plan 550 1d-rest.
 *
 * The legacy TS path runs `loadRecentSessionDirectory` synchronously
 * per `buildSystemPrompt` call and joins the entries with
 * ` - ${entry}\n`. The .hbs path uses the `recentSessions` preBuildHook
 * to populate two `string[]` slots (`recentSessionsSameProject` /
 * `recentSessionsOtherProjects`) and the mapper joins them with the
 * same helper. Tests stub `loadDirectory` so the parity comparison
 * stays deterministic.
 *
 * Five cases:
 *   1. Both scopes populated (full house).
 *   2. Same project populated, other projects empty (`- none`).
 *   3. Both scopes empty (section omitted, returns `null`).
 *   4. `MessageSession` available — `messaging_guidance` includes the
 *      `MessageSession with one focused question` paragraph.
 *   5. `MessageSession` unavailable — guidance uses the
 *      "tool is unavailable" line.
 */
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HbsPromptSystem } from '../../../../src/prompts/hbs/HbsPromptSystem.js';
import { createRecentSessionsPreBuildHook } from '../../../../src/prompts/sections/dynamic/recentSessionsPreBuildHook.js';
import { getRecentSessionsSection } from '../../../../src/prompts/sections/dynamic/recentSessionsSection.js';
import type { PromptContext } from '../../../../src/prompts/types.js';
import type { RecentSessionDirectory } from '../../../../src/session/recent-session-directory.js';

const ASSETS_ROOT = resolve(__dirname, '../../../../src/prompts/assets');

function ctxWith(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    sessionId: 'sess-current',
    workingDirectory: 'E:\\Projects\\duya',
    platform: 'win32',
    shell: 'powershell',
    modelId: 'test-model',
    enabledTools: new Set<string>(['Read', 'Edit', 'Write', 'SessionSearch']),
    sessionStartTime: 0,
    ...overrides,
  } as PromptContext;
}

describe('recent-sessions hbs byte-level parity (Plan 550 1d-rest)', () => {
  const system = new HbsPromptSystem({ assetsRoot: ASSETS_ROOT });

  async function checkWithStub(directory: RecentSessionDirectory | null) {
    const loadDirectory = async () => {
      if (directory === null) throw new Error('recent-session-directory stub: forced failure');
      return directory;
    };

    const recentHook = createRecentSessionsPreBuildHook({ loadDirectory });
    const extension = await recentHook(ctxWith());
    const enrichedCtx = extension?.promptContextExtension
      ? { ...ctxWith(), ...extension.promptContextExtension }
      : ctxWith();

    const ts = await getRecentSessionsSection(enrichedCtx, loadDirectory);
    const hbs = system.renderStaticTemplate('dynamic/recent-sessions.hbs', enrichedCtx).trim();
    const hbsNorm = hbs === '' ? null : hbs;
    expect(hbsNorm).toBe(ts);
  }

  it('matches when both scopes have entries', async () => {
    await checkWithStub({
      sameProject: [
        {
          sessionId: 'a',
          title: 'A',
          projectName: 'duya',
          updatedAt: Date.UTC(2026, 0, 10, 12, 0, 0),
          childCount: 0,
          agentType: 'general',
        },
      ],
      otherProjects: [
        {
          sessionId: 'b',
          title: 'B',
          projectName: 'ime-router',
          updatedAt: Date.UTC(2026, 0, 8, 12, 0, 0),
          childCount: 1,
          agentType: 'general',
        },
      ],
    });
  });

  it('matches when other projects are empty (- none)', async () => {
    await checkWithStub({
      sameProject: [
        {
          sessionId: 'a',
          title: 'A',
          projectName: 'duya',
          updatedAt: Date.UTC(2026, 0, 10, 12, 0, 0),
          childCount: 0,
          agentType: 'general',
        },
      ],
      otherProjects: [],
    });
  });

  it('matches when both scopes are empty (section omitted)', async () => {
    await checkWithStub({ sameProject: [], otherProjects: [] });
  });

  it('matches when MessageSession is enabled (full messaging guidance)', async () => {
    const ctx = ctxWith({
      enabledTools: new Set<string>(['Read', 'Edit', 'Write', 'SessionSearch', 'MessageSession']),
    });
    const loadDirectory = async () => ({
      sameProject: [
        {
          sessionId: 'a',
          title: 'A',
          projectName: 'duya',
          updatedAt: Date.UTC(2026, 0, 10, 12, 0, 0),
          childCount: 0,
          agentType: 'general',
        },
      ],
      otherProjects: [],
    });
    const recentHook = createRecentSessionsPreBuildHook({ loadDirectory });
    const extension = await recentHook(ctx);
    const enrichedCtx = extension?.promptContextExtension
      ? { ...ctx, ...extension.promptContextExtension }
      : ctx;

    const ts = await getRecentSessionsSection(enrichedCtx, loadDirectory);
    const hbs = system.renderStaticTemplate('dynamic/recent-sessions.hbs', enrichedCtx).trim();
    expect(hbs === '' ? null : hbs).toBe(ts);
    expect(ts).toContain('MessageSession` with one focused question');
  });

  it('matches when MessageSession is unavailable (fallback guidance)', async () => {
    const ctx = ctxWith({
      enabledTools: new Set<string>(['Read', 'Edit', 'Write', 'SessionSearch']),
    });
    const loadDirectory = async () => ({
      sameProject: [
        {
          sessionId: 'a',
          title: 'A',
          projectName: 'duya',
          updatedAt: Date.UTC(2026, 0, 10, 12, 0, 0),
          childCount: 0,
          agentType: 'general',
        },
      ],
      otherProjects: [],
    });
    const recentHook = createRecentSessionsPreBuildHook({ loadDirectory });
    const extension = await recentHook(ctx);
    const enrichedCtx = extension?.promptContextExtension
      ? { ...ctx, ...extension.promptContextExtension }
      : ctx;

    const ts = await getRecentSessionsSection(enrichedCtx, loadDirectory);
    const hbs = system.renderStaticTemplate('dynamic/recent-sessions.hbs', enrichedCtx).trim();
    expect(hbs === '' ? null : hbs).toBe(ts);
    expect(ts).toContain('`MessageSession` tool is unavailable');
  });
});