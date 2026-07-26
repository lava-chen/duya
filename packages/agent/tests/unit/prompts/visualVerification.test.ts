import { describe, expect, it } from 'vitest';
import { PromptsRegistry } from '../../../src/prompts/registry.js';
import { isSectionEnabled, DEFAULT_PROMPT_PROFILE } from '../../../src/prompts/modes/index.js';
import { TOOL_NAMES } from '../../../src/prompts/types.js';

describe('visual verification prompt guidance', () => {
  it('is enabled by default and respects explicit disableSections', () => {
    expect(isSectionEnabled(DEFAULT_PROMPT_PROFILE, 'visualVerification')).toBe(true);
    expect(
      isSectionEnabled({ disableSections: ['visualVerification'] }, 'visualVerification'),
    ).toBe(false);
    // enableSections overrides disableSections
    expect(
      isSectionEnabled(
        { enableSections: ['visualVerification'], disableSections: ['visualVerification'] },
        'visualVerification',
      ),
    ).toBe(true);
  });

  it('loads visual verification into the code prompt system with vision guidance', async () => {
    const promptSystem = PromptsRegistry.getOrCreate('code')!;
    const context = promptSystem.buildContext({
      workingDirectory: 'E:\\Projects\\duya',
      modelId: 'MiniMax-M3',
      enabledTools: new Set([TOOL_NAMES.VISION]),
    });

    const prompt = [...await promptSystem.buildSystemPrompt(context)].join('\n\n');

    expect(prompt).toContain('# Visual Verification');
    expect(prompt).toContain('Use a render-check-fix loop whenever practical');
    expect(prompt).toContain(`use \`${TOOL_NAMES.VISION}\` to analyze the visual result`);
  });

  it('loads visual verification into the general prompt system without replacing vision guidelines', async () => {
    const promptSystem = PromptsRegistry.getOrCreate('general')!;
    const context = promptSystem.buildContext({
      workingDirectory: 'E:\\Projects\\duya',
      modelId: 'MiniMax-M3',
      enabledTools: new Set(),
    });

    const prompt = [...await promptSystem.buildSystemPrompt(context)].join('\n\n');

    expect(prompt).toContain('# Visual Verification');
    expect(prompt).toContain('visual fidelity was not confirmed by image analysis');
    expect(prompt).not.toContain('# Vision Tool Guidelines');
  });
});
