import { describe, it, expect } from 'vitest';
import { gatewayConfig } from '../gateway.js';
import { PromptsRegistry } from '../../PromptsRegistry.js';
import '../../registry.js'; // side-effect: register general/code/research/gateway configs

/**
 * Gateway config composition guards.
 *
 * The gateway prompt must stay a full-capability composition (parity with
 * the desktop general agent) while keeping its channel-unique sections.
 * These assertions lock the assembly list so regressions like
 * "section added to config but suppressed by profile disableSections" are
 * caught at the config layer. Plan 551: the static half is a staticModules
 * assembly list; the ref name (falling back to the module key) is the
 * profile-gating / cache-key surface.
 */
function moduleNames(): string[] {
  return (gatewayConfig.staticModules ?? []).map((ref) => ref.name ?? ref.module);
}
describe('gatewayConfig', () => {
  it('keeps the gateway-unique sections (intro / gatewayRole / toneAndStyle)', () => {
    const names = moduleNames();
    expect(names).toContain('intro');
    expect(names).toContain('gatewayRole');
    expect(names).toContain('toneAndStyle');
  });

  it('composes the full general static section set in order', () => {
    expect(moduleNames()).toEqual([
      'intro', 'gatewayRole',
      'communication', 'finalAnswer', 'toneAndStyle', 'system',
      'tasks', 'destructiveActions', 'configProtection', 'tools',
      'skillUsage', 'project',
    ]);
  });

  it('includes the full general dynamic section set (memory, vision, session guidance)', () => {
    expect(gatewayConfig.dynamicSections.map((s) => s.name)).toEqual([
      'language', 'outputStyle',
      'platform', 'environment', 'mcp', 'skills', 'scratchpad', 'memory',
      'sessionSearch', 'recentSessions',
      'sessionGuidance', 'visionGuidelines', 'visualVerification',
    ]);
  });

  it('excludes duyaDesktopContext (self-described as inapplicable to IM channels)', () => {
    const names = [
      ...moduleNames(),
      ...gatewayConfig.dynamicSections.map((s) => s.name),
    ];
    expect(names).not.toContain('duyaDesktopContext');
  });

  it('initializes AGENTS.md via preBuildHook like the desktop agents', () => {
    expect(typeof gatewayConfig.preBuildHook).toBe('function');
  });

  it('renders the memory section without the retired citation contract', async () => {
    const sys = PromptsRegistry.getOrCreate('gateway', {});
    const ctx = sys.buildContext({
      sessionId: 'test',
      workingDirectory: process.cwd(),
      omitAgentsMd: true,
      enabledTools: new Set(['read', 'write', 'edit', 'todo']),
      communicationPlatform: 'weixin',
    });
    const result = await sys.buildSystemPrompt(ctx);
    const text = result.join('\n');

    expect(text).toContain('## Memory');
    expect(text).not.toContain('<duya-mem-citation>');
    expect(text).not.toContain('citation_entries');
  });
});
