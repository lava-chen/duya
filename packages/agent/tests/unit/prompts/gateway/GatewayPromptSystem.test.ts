import { describe, expect, it, vi } from 'vitest';
import { PromptsRegistry } from '../../../../src/prompts/registry.js';

vi.mock('../../../../src/prompts/sections/dynamic/recentSessionsSection.js', () => ({
  getRecentSessionsSection: async () => null,
}));

describe('GatewayPromptSystem (config-driven)', () => {
  it('teaches direct tool use, truthful capability checks, and native media delivery', async () => {
    const system = PromptsRegistry.getOrCreate('gateway')!;
    const context = system.buildContext({
      sessionId: 'gw-weixin-test',
      workingDirectory: 'C:\\Users\\tester\\.duya\\workspace',
      modelId: 'test-model',
      communicationPlatform: 'weixin',
      enabledTools: new Set(['bash', 'powershell', 'MessageSession', 'SessionSearch']),
    });
    const prompt = [...await system.buildSystemPrompt(context)].join('\n');

    expect(prompt).toContain('Act before explaining');
    expect(prompt).toContain('Never claim that a path, shell, media attachment, or session is unavailable');
    expect(prompt).toContain('MEDIA:<absolute-path>');
    expect(prompt).toContain('does not need to be under the workspace');
    expect(prompt).toContain('Do not choose an arbitrary session');
    expect(prompt).not.toContain('You are a relay, not a worker');
  });

  it('keeps the explicitly-provided working directory without falling back to cwd', () => {
    const system = PromptsRegistry.getOrCreate('gateway')!;
    const explicit = 'C:\\Users\\tester\\.duya\\workspace';
    const context = system.buildContext({
      modelId: 'test-model',
      workingDirectory: explicit,
    });

    expect(context.workingDirectory).toBe(explicit);
    expect(context.workingDirectory).not.toBe(process.cwd());
  });
});
