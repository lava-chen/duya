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
    expect(curator.disallowedTools).toContain('Agent');
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

  it('resolveAllowedTools whitelists exactly the 5 file tools for memory-curator', () => {
    const curator = PRESET_AGENT_PROFILES.find((p) => p.id === 'memory-curator')!;
    const allTools = [
      'read', 'write', 'edit', 'grep', 'glob',
      'bash', 'powershell', 'Agent', 'browser', 'canvas_create',
      'show_widget', 'AskUserQuestion', 'duya_cli', 'tool_search',
      'skill', 'task', 'vision_analyze',
    ];
    const result = resolveAllowedTools(curator, allTools);
    expect(result.allowed.sort()).toEqual(['edit', 'glob', 'grep', 'read', 'write']);
    expect(result.denied).toContain('bash');
    expect(result.denied).toContain('Agent');
    expect(result.isValid).toBe(true);
  });

  it('memory-curator is distinct from the explore preset (different toolset)', () => {
    const curator = PRESET_AGENT_PROFILES.find((p) => p.id === 'memory-curator')!;
    const explore = PRESET_AGENT_PROFILES.find((p) => p.id === 'explore')!;
    expect(curator.allowedTools).not.toEqual(explore.allowedTools);
    expect(curator.allowedTools).toContain('write');
    expect(explore.disallowedTools).toContain('write');
  });
});