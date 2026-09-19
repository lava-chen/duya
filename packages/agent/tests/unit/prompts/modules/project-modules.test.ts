/**
 * Project module parity tests — Plan 551 Phase 2.
 *
 * Locks the module renders (`projectContinuity` / `projectInstructions` /
 * `project`) byte-for-byte against the legacy TS section functions before
 * the legacy section tree is swept. The AgentsMd manager singleton is
 * mocked so both the empty-index and populated-index states are covered.
 */

import { resolve } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HbsPromptSystem } from '../../../../src/prompts/hbs/HbsPromptSystem.js';
import type { PromptContext } from '../../../../src/prompts/types.js';
import { getProjectContinuitySection } from '../../../../src/prompts/sections/projectContinuity.js';
import { getProjectInstructionsSection, getProjectSection } from '../../../../src/prompts/general/sections/project.js';

const mocks = vi.hoisted(() => ({
  getAgentsMdManager: vi.fn(),
}));

vi.mock('../../../../src/agentsmd/index.js', () => ({
  getAgentsMdManager: mocks.getAgentsMdManager,
}));

const ASSETS_ROOT = resolve(__dirname, '../../../../src/prompts/assets');

function baseContext(): PromptContext {
  return {
    workingDirectory: 'E:\\Projects\\duya',
    platform: 'win32',
    shell: 'powershell',
    modelId: 'test-model',
    enabledTools: new Set(['Read', 'Edit', 'Bash']),
    sessionStartTime: 0,
  } as PromptContext;
}

describe('project modules parity vs legacy TS sections', () => {
  let system: HbsPromptSystem;

  beforeEach(() => {
    system = new HbsPromptSystem({ assetsRoot: ASSETS_ROOT });
  });

  it('renders continuity byte-identical to the legacy section', () => {
    expect(system.renderModule('projectContinuity', baseContext()).trim())
      .toBe(getProjectContinuitySection(baseContext()));
  });

  it('collapses the instructions module to empty when no files are loaded', () => {
    mocks.getAgentsMdManager.mockReturnValue({ getLoadedFiles: () => [] });
    expect(getProjectInstructionsSection()).toBeNull();
    expect(system.renderModule('projectInstructions', baseContext()).trim()).toBe('');
  });

  it('renders the instructions index byte-identical when files are loaded', () => {
    mocks.getAgentsMdManager.mockReturnValue({
      getLoadedFiles: () => [
        { type: 'user', path: 'C:/Users/me/.duya/AGENTS.md' },
        { type: 'project', path: 'E:/Projects/duya/AGENTS.md', globs: ['*.ts'] },
      ],
    });
    const legacy = getProjectInstructionsSection();
    expect(legacy).toContain('# Project instructions');
    expect(system.renderModule('projectInstructions', baseContext()).trim()).toBe(legacy);
  });

  it('renders the gateway composite byte-identical to the legacy project section', () => {
    mocks.getAgentsMdManager.mockReturnValue({
      getLoadedFiles: () => [
        { type: 'project', path: 'E:/Projects/duya/AGENTS.md' },
      ],
    });
    expect(system.renderModule('project', baseContext()).trim())
      .toBe(getProjectSection(baseContext()));
  });

  it('renders the gateway composite as continuity-only when the index is empty', () => {
    mocks.getAgentsMdManager.mockReturnValue({ getLoadedFiles: () => [] });
    expect(system.renderModule('project', baseContext()).trim())
      .toBe(getProjectSection(baseContext()));
  });
});
