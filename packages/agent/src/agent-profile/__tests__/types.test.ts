import { describe, it, expect } from 'vitest';
import { PRESET_AGENT_PROFILES } from '../types.js';
import { resolveAllowedTools } from '../ToolFilter.js';

describe('PRESET_AGENT_PROFILES', () => {
  it('includes the memory-curator preset', () => {
    const curator = PRESET_AGENT_PROFILES.find((p) => p.id === 'memory-curator');
    expect(curator).toBeDefined();
    expect(curator!.isPreset).toBe(true);
    expect(curator!.userVisible).toBe(false);
    expect(curator!.isEnabled).toBe(true);
    expect(curator!.allowedTools).toEqual(['read', 'write', 'edit', 'grep', 'glob']);
  });

  it('memory-curator denies shell, subagent, canvas, and self-management tools', () => {
    const curator = PRESET_AGENT_PROFILES.find((p) => p.id === 'memory-curator')!;
    expect(curator.disallowedTools).toContain('bash');
    expect(curator.disallowedTools).toContain('powershell');
    expect(curator.disallowedTools).toContain('task');
    expect(curator.disallowedTools).toContain('canvas:*');
    expect(curator.disallowedTools).toContain('duya_cli');
    expect(curator.disallowedTools).toContain('tool_search');
    expect(curator.disallowedTools).toContain('skill');
  });

  it('memory-curator disables volatile prompt sections', () => {
    const curator = PRESET_AGENT_PROFILES.find((p) => p.id === 'memory-curator')!;
    const disabled = curator.promptProfile?.disableSections ?? [];
    expect(disabled).toContain('memory');
    expect(disabled).toContain('memoryContent');
    expect(disabled).toContain('skills');
    expect(disabled).toContain('agentsMd');
    expect(disabled).toContain('rules');
  });

  it('general-purpose enableSections whitelists the skills catalog (plan 535 A-6)', () => {
    // The desktop General sessions run on this preset. Its enableSections
    // is a strict whitelist (isSectionEnabled), so a missing entry means
    // the section never renders — this regression is what silently dropped
    // the <available_skills> catalog and made the model answer skill
    // inventory questions via `duya skill list` CLI discovery.
    const general = PRESET_AGENT_PROFILES.find((p) => p.id === 'general-purpose')!;
    const enabled = general.promptProfile?.enableSections ?? [];
    expect(enabled).toContain('skills');
    expect(enabled).toContain('skillUsage');
  });

  it('resolveAllowedTools whitelists exactly the 5 file tools for memory-curator', () => {
    const curator = PRESET_AGENT_PROFILES.find((p) => p.id === 'memory-curator')!;
    const allTools = [
      'read', 'write', 'edit', 'grep', 'glob',
      'bash', 'powershell', 'task', 'browser', 'canvas_create',
      'show_widget', 'AskUserQuestion', 'duya_cli', 'tool_search',
      'skill', 'todo', 'vision_analyze',
    ];
    const result = resolveAllowedTools(curator, allTools);
    expect(result.allowed.sort()).toEqual(['edit', 'glob', 'grep', 'read', 'write']);
    expect(result.denied).toContain('bash');
    expect(result.denied).toContain('task');
    expect(result.isValid).toBe(true);
  });

  it('memory-curator is distinct from the explore preset (different toolset)', () => {
    const curator = PRESET_AGENT_PROFILES.find((p) => p.id === 'memory-curator')!;
    const explore = PRESET_AGENT_PROFILES.find((p) => p.id === 'explore')!;
    expect(curator.allowedTools).not.toEqual(explore.allowedTools);
    expect(curator.allowedTools).toContain('write');
    expect(explore.disallowedTools).toContain('write');
  });

  it('gateway profile keeps full tooling (write/edit/todo/duya_cli/vision)', () => {
    const gateway = PRESET_AGENT_PROFILES.find((p) => p.id === 'gateway');
    expect(gateway).toBeDefined();
    expect(gateway!.promptSystem).toBe('gateway');
    const allTools = [
      'read', 'write', 'edit', 'grep', 'glob', 'bash', 'powershell',
      'todo', 'duya_cli', 'vision_analyze', 'send_artifact', 'skill',
    ];
    const result = resolveAllowedTools(gateway!, allTools);
    for (const t of allTools) {
      expect(result.allowed).toContain(t);
    }
  });

  it('gateway profile still denies desktop-only, recursive, and mode-switching tools', () => {
    const gateway = PRESET_AGENT_PROFILES.find((p) => p.id === 'gateway')!;
    const allTools = [
      'read', 'write', 'edit', 'todo', 'duya_cli', 'vision_analyze',
      'canvas:create', 'show_widget', 'AskUserQuestion', 'task', 'memory',
      'read_module', 'EnterPlanMode', 'ExitPlanMode', 'SwitchMode',
    ];
    const result = resolveAllowedTools(gateway, allTools);
    for (const t of ['canvas:create', 'show_widget', 'AskUserQuestion', 'task', 'memory', 'read_module', 'EnterPlanMode', 'ExitPlanMode', 'SwitchMode']) {
      expect(result.denied).toContain(t);
    }
  });

  it('gateway profile re-enables memory/sessionGuidance/skills/tasks prompt sections', () => {
    const gateway = PRESET_AGENT_PROFILES.find((p) => p.id === 'gateway')!;
    const disabled = gateway.promptProfile?.disableSections ?? [];
    expect(disabled).not.toContain('memory');
    expect(disabled).not.toContain('sessionGuidance');
    expect(disabled).not.toContain('skills');
    expect(disabled).not.toContain('generalTaskGuidance');
  });
});