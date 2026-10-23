/**
 * Plan 619 Phase 1 — the AGENTS.md index versus the AGENTS.md bodies.
 *
 * The index of instruction files and the bodies themselves both sat in the
 * system prompt, repeating every file (plan 619 defect e).
 */

import { describe, expect, it } from 'vitest';

import { codeConfig } from '@duya/host/worker-prompts/configs/code';
import { researchConfig } from '@duya/host/worker-prompts/configs/research';
import { buildAgentsMdPrompt } from '@duya/host/worker-agents-md/loader';
import type { AgentsFileInfo } from '@duya/host/worker-agents-md/types';

describe('plan 619 phase 1 — AGENTS.md index vs bodies', () => {
  it('no longer renders an instruction-file index alongside the bodies', () => {
    for (const config of [codeConfig, researchConfig]) {
      const names = config.sections.map((def) => def.name ?? def.module ?? 'anonymous');
      expect(names).not.toContain('projectInstructions');
    }
  });

  it('carries the glob scope in the file heading, since the index is gone', () => {
    const files: AgentsFileInfo[] = [
      {
        path: 'E:\\repo\\AGENTS.md',
        type: 'project',
        content: 'Follow the commit rules.',
        globs: ['**/*.ts'],
      },
    ];
    const prompt = buildAgentsMdPrompt(files);
    expect(prompt).toContain('# AGENTS.md instructions for E:\\repo\\AGENTS.md; applies to **/*.ts');
    expect(prompt).toContain('Follow the commit rules.');
  });

  it('leaves the heading plain for files without globs', () => {
    const files: AgentsFileInfo[] = [
      { path: 'E:\\repo\\AGENTS.md', type: 'project', content: 'Body.' },
    ];
    expect(buildAgentsMdPrompt(files)).toContain(
      '# AGENTS.md instructions for E:\\repo\\AGENTS.md\n',
    );
  });
});
