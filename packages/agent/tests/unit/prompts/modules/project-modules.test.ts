/**
 * Project module tests — Plan 551 Phase 2.
 *
 * The legacy TS sections are swept; these tests now lock the module
 * composition itself: the instructions index builder (mapper, fed by the
 * AgentsMd manager mock), the instructions module's empty-collapse, and
 * the gateway composite (continuity + '\n\n' + index).
 */

import { resolve } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HbsPromptSystem } from '../../../../src/prompts/hbs/HbsPromptSystem.js';
import type { PromptContext } from '../../../../src/prompts/types.js';

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

describe('project modules', () => {
  let system: HbsPromptSystem;

  beforeEach(() => {
    system = new HbsPromptSystem({ assetsRoot: ASSETS_ROOT });
  });

  it('renders the continuity module with its canonical content', () => {
    const out = system.renderModule('projectContinuity', baseContext()).trim();
    expect(out).toContain('# Long-horizon project continuity');
    expect(out).toContain('one canonical execution plan');
    expect(out).toContain('not raw terminal output');
    expect(out).toContain('report unresolved gaps faithfully');
  });

  it('collapses the instructions module to empty when no files are loaded', () => {
    mocks.getAgentsMdManager.mockReturnValue({ getLoadedFiles: () => [] });
    expect(system.renderModule('projectInstructions', baseContext()).trim()).toBe('');
  });

  it('renders the instruction-file index when files are loaded', () => {
    mocks.getAgentsMdManager.mockReturnValue({
      getLoadedFiles: () => [
        { type: 'user', path: 'C:/Users/me/.duya/AGENTS.md' },
        { type: 'project', path: 'E:/Projects/duya/AGENTS.md' }, // duplicate path dedupes
        { type: 'project', path: 'E:/Projects/duya/AGENTS.md', globs: ['*.ts'] },
      ],
    });
    const out = system.renderModule('projectInstructions', baseContext()).trim();
    expect(out).toContain('# Project instructions');
    expect(out).toContain('read the relevant file in full');
    expect(out).toContain('## Available files');
    expect(out).toContain('- [user] `C:/Users/me/.duya/AGENTS.md`');
    expect(out).toContain('- [project] `E:/Projects/duya/AGENTS.md`; applies to *.ts');
    expect(out.match(/AGENTS\.md/g)).toHaveLength(2);
  });

  it('composites the gateway project module as continuity + index', () => {
    mocks.getAgentsMdManager.mockReturnValue({
      getLoadedFiles: () => [
        { type: 'project', path: 'E:/Projects/duya/AGENTS.md' },
      ],
    });
    const continuity = system.renderModule('projectContinuity', baseContext()).trim();
    const instructions = system.renderModule('projectInstructions', baseContext()).trim();
    expect(system.renderModule('project', baseContext()).trim())
      .toBe([continuity, instructions].join('\n\n'));
  });

  it('composites the gateway project module as continuity-only when the index is empty', () => {
    mocks.getAgentsMdManager.mockReturnValue({ getLoadedFiles: () => [] });
    const continuity = system.renderModule('projectContinuity', baseContext()).trim();
    expect(system.renderModule('project', baseContext()).trim()).toBe(continuity);
  });
});
