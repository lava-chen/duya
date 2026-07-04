import { describe, expect, it } from 'vitest';
import { CodePromptSystem } from '../../../src/prompts/code/index.js';
import { resolveEnabledSections } from '../../../src/prompts/modes/index.js';

describe('prompt language and user-visible progress guidance', () => {
  it('enables language guidance for every default profile', () => {
    expect(resolveEnabledSections({ base: 'full' }).has('language')).toBe(true);
    expect(resolveEnabledSections({ base: 'minimal' }).has('language')).toBe(true);
    expect(resolveEnabledSections({ base: 'bare' }).has('language')).toBe(true);
  });

  it('turns zh into a Simplified Chinese hard requirement', async () => {
    const promptSystem = new CodePromptSystem();
    const context = promptSystem.buildContext({
      workingDirectory: 'E:\\Projects\\duya',
      modelId: 'MiniMax-M3',
      enabledTools: new Set(),
      language: 'zh',
      communicationPlatform: 'duya-app',
    });

    const prompt = [...await promptSystem.buildSystemPrompt(context)].join('\n\n');

    expect(prompt).toContain('Always respond in Simplified Chinese.');
    expect(prompt).toContain('If the user writes in Chinese');
    expect(prompt).toContain('Keep user-visible progress separate from execution details.');
    expect(prompt).toContain('avoid phrases like "Let me trace", "Now I have", "Excellent", "Very interesting"');
  });
});
