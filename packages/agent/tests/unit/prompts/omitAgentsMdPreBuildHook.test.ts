/**
 * Plan 408 Phase 2 — preBuildHook omitAgentsMd short-circuit.
 *
 * Built-in read-only sub-agents (Explore / Plan / CodeReview / Research) set
 * `omitClaudeMd: true`. runAgent propagates that as `omitAgentsMd` on the
 * PromptContext; the three main configs' preBuildHook must skip the AGENTS.md
 * refresh walk when it is set, so a sub-agent never triggers a disk traversal
 * (cwd → root) just to build its prompt.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const initSpy = vi.hoisted(() => ({
  fn: vi.fn(async () => false),
}));

vi.mock('../../../src/prompts/dynamic/agentsMdSection.js', () => ({
  initializeAgentsMd: initSpy.fn,
}));

import { generalConfig } from '../../../src/prompts/configs/general.js';
import { codeConfig } from '../../../src/prompts/configs/code.js';
import { researchConfig } from '../../../src/prompts/configs/research.js';
import type { PromptContext } from '../../../src/prompts/types.js';

const baseCtx = {
  workingDirectory: '/tmp',
  platform: 'darwin',
  shell: 'zsh',
  modelId: 'test-model',
  enabledTools: new Set<string>(),
  sessionStartTime: 0,
} as PromptContext;

const configs = [
  ['general', generalConfig],
  ['code', codeConfig],
  ['research', researchConfig],
] as const;

describe('Plan 408 Phase 2 — preBuildHook omitAgentsMd short-circuit', () => {
  beforeEach(() => {
    initSpy.fn.mockClear();
  });

  for (const [name, cfg] of configs) {
    describe(name, () => {
      it('skips initializeAgentsMd when omitAgentsMd=true', async () => {
        await cfg.preBuildHook!({ ...baseCtx, omitAgentsMd: true });

        expect(initSpy.fn).not.toHaveBeenCalled();
      });

      it('still refreshes AGENTS.md when omitAgentsMd is unset', async () => {
        await cfg.preBuildHook!({ ...baseCtx });

        // initializeAgentsMd(workingDirectory, projectHome) — projectHome
        // is optional (undefined when cwd is outside any registered duya
        // project), so the test baseCtx only supplies the first arg.
        expect(initSpy.fn).toHaveBeenCalledWith('/tmp', undefined);
      });
    });
  }
});
