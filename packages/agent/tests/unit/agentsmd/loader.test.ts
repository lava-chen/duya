import { describe, expect, it } from 'vitest';
import { buildAgentsMdPrompt, type AgentsFileInfo } from '../../../src/agentsmd/loader.js';

describe('buildAgentsMdPrompt (project instructions spec)', () => {
  it('wraps project instructions in a project_instructions_spec block', () => {
    const files: AgentsFileInfo[] = [
      {
        path: '/repo/AGENTS.md',
        type: 'Project',
        content: 'Use Conventional Commits.',
      },
    ];

    const prompt = buildAgentsMdPrompt(files);

    expect(prompt).toContain('<project_instructions_spec>');
    expect(prompt).toContain('Use Conventional Commits.');
    expect(prompt).toContain('</project_instructions_spec>');
    // Outer <system-reminder> wrapper is preserved for the strip guard.
    expect(prompt.startsWith('<system-reminder>')).toBe(true);
    expect(prompt.endsWith('</system-reminder>')).toBe(true);
  });
});