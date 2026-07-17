import { describe, expect, it, vi } from 'vitest';
import { GatewayPromptSystem } from '../../../../src/prompts/gateway/GatewayPromptSystem.js';

vi.mock('../../../../src/prompts/sections/dynamic/recentSessionsSection.js', () => ({
  getRecentSessionsSection: async () => null,
}));

describe('GatewayPromptSystem', () => {
  it('teaches direct tool use, truthful capability checks, and native media delivery', async () => {
    const system = new GatewayPromptSystem();
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

  it('never falls back to the host process cwd', () => {
    const context = new GatewayPromptSystem().buildContext({ modelId: 'test-model' });

    expect(context.workingDirectory).toMatch(/[\\/]\.duya[\\/]workspace$/);
    expect(context.workingDirectory).not.toBe(process.cwd());
  });
});
