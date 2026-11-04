import { describe, it, expect } from 'vitest';
import { PRESET_AGENT_PROFILES } from '../../src/worker-profiles/types.js';
import {
  PROJECT_COORDINATOR_ALLOWED_TOOLS,
  PROJECT_COORDINATOR_PROFILE_ID,
} from '../../src/project/identity.js';
import { isToolVisible, resolveAllowedTools } from '@duya/agent-runtime/authorization/tool-filter';
import { DUYA_APP_TOOL_NAMES } from '@duya/capabilities/AppServer/app-tool-namespace';

describe('PRESET_AGENT_PROFILES', () => {
  it('project-coordinator runs on the dedicated project prompt system', () => {
    const coordinator = PRESET_AGENT_PROFILES.find((p) => p.id === PROJECT_COORDINATOR_PROFILE_ID)!;
    expect(coordinator.allowedTools).toEqual([...PROJECT_COORDINATOR_ALLOWED_TOOLS]);
    expect(coordinator.promptSystem).toBe('project');
    expect(coordinator.suppressIdentityBlock).toBe(true);
    expect(coordinator.identityPrompt).toBeUndefined();
    expect(coordinator.userVisible).toBe(false);
    const result = resolveAllowedTools(
      coordinator,
      [
        'session_spawn', 'session_get', 'session_reply', 'session_read', 'session_rename',
        'session_list', 'session_send', 'session_status', 'session_cancel', 'session_control',
        'session_fork', 'session_search',
        'project', 'todo', 'read', 'write', 'bash', 'task', 'memory',
      ],
    );
    expect(result.allowed.sort()).toEqual([
      'project', 'session_cancel', 'session_control', 'session_get', 'session_list',
      'session_read', 'session_rename', 'session_reply', 'session_send', 'session_spawn',
      'session_status', 'todo',
    ]);
    expect(result.isValid).toBe(true);
  });

  it('project-coordinator allowlist names tools the app layer actually serves', () => {
    // The whitelist used to name a single `session` tool. When #579 moved the
    // Session tools into the `duya_app` MCP and split that one tool into
    // per-action ones, the literal stopped matching anything — and nothing
    // failed: the Coordinator simply lost its whole Session surface, because
    // an allowlist that matches no tool is not an error. Checking the names
    // against the authoritative list is what makes that drift loud.
    const served = new Set<string>(DUYA_APP_TOOL_NAMES);
    for (const name of PROJECT_COORDINATOR_ALLOWED_TOOLS) {
      if (!name.startsWith('session_')) continue;
      expect(served.has(name)).toBe(true);
    }
    // The bare `session` this replaces was NOT a `session_` name, so the
    // prefix guard above would skip it and the drift would pass silently.
    // Assert the exact names the allowlist must contain, so a regression to
    // a name the app layer never served fails here.
    for (const name of PROJECT_COORDINATOR_ALLOWED_TOOLS) {
      expect(served.has(name) || name === 'project' || name === 'todo').toBe(true);
    }
  });

  it('project-coordinator promotes its session tools to direct calls', () => {
    // The app tools are deferred by default (MCP exposure `search`), and a
    // deferred tool only becomes directly callable when the profile allowlist
    // names it EXACTLY — a wildcard would leave it behind a catalog lookup.
    // The model sees `mcp_duya_app_session_spawn`, so the filter has to
    // resolve the original name before the exact hit counts. This is the path
    // that silently broke when the allowlist said `session`.
    const coordinator = PRESET_AGENT_PROFILES.find((p) => p.id === PROJECT_COORDINATOR_PROFILE_ID)!;
    const constraints = { profileAllowedPatterns: coordinator.allowedTools };
    for (const name of [
      'session_spawn', 'session_get', 'session_reply', 'session_read', 'session_rename',
      'session_list', 'session_send', 'session_status', 'session_cancel', 'session_control',
    ]) {
      expect(isToolVisible(`mcp_duya_app_${name}`, 'deferred', new Set(), constraints)).toBe(true);
    }
    expect(isToolVisible('mcp_duya_app_session_fork', 'deferred', new Set(), constraints)).toBe(false);
    expect(isToolVisible('mcp_duya_app_session_search', 'deferred', new Set(), constraints)).toBe(false);
  });

  it('project-coordinator keeps its session lifecycle surface and nothing more', () => {
    // The contract grants the Coordinator the Session lifecycle (spawn, get,
    // read, rename, send, status, cancel, control) and the tools its prompt
    // tells it to reach for (`session list`, `session reply`). It explicitly
    // declines to grant every Session tool #579 registered — `session_fork`
    // and `session_search` stay out of its hand — and it has no device tools.
    const coordinator = PRESET_AGENT_PROFILES.find((p) => p.id === PROJECT_COORDINATOR_PROFILE_ID)!;
    const result = resolveAllowedTools(
      coordinator,
      [
        'session_spawn', 'session_get', 'session_reply', 'session_read', 'session_rename',
        'session_list', 'session_send', 'session_status', 'session_cancel', 'session_control',
        'session_fork', 'session_search',
        'project', 'todo', 'read', 'write', 'bash', 'task', 'memory', 'send_message',
      ],
    );
    for (const granted of [
      'session_spawn', 'session_get', 'session_reply', 'session_read', 'session_rename',
      'session_list', 'session_send', 'session_status', 'session_cancel', 'session_control',
      'project', 'todo',
    ]) {
      expect(result.allowed).toContain(granted);
    }
    for (const denied of ['session_fork', 'session_search', 'read', 'write', 'bash', 'task', 'send_message']) {
      expect(result.denied).toContain(denied);
    }
    expect(result.isValid).toBe(true);
  });
  it('includes the memory-curator preset', () => {
    const curator = PRESET_AGENT_PROFILES.find((p) => p.id === 'memory-curator');
    expect(curator).toBeDefined();
    expect(curator!.isPreset).toBe(true);
    expect(curator!.userVisible).toBe(false);
    expect(curator!.isEnabled).toBe(true);
    expect(curator!.allowedTools).toEqual(['read', 'write', 'edit', 'grep', 'glob']);
  });

  it('memory-curator denies shell, subagent, vision, and self-management tools', () => {
    const curator = PRESET_AGENT_PROFILES.find((p) => p.id === 'memory-curator')!;
    expect(curator.disallowedTools).toContain('bash');
    expect(curator.disallowedTools).toContain('powershell');
    expect(curator.disallowedTools).toContain('task');
    expect(curator.disallowedTools).toContain('vision_analyze');
    expect(curator.disallowedTools).toContain('duya_cli');
    expect(curator.disallowedTools).toContain('tool_catalog');
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

  it('general-purpose cuts volatile sections via denylist, not a whitelist (plan 557 phase 2)', () => {
    // The desktop General sessions run on this preset. The old
    // enableSections whitelist silently dropped the skills catalog for its
    // entire lifetime (plan 535 A-6); the preset now uses a denylist so new
    // sections default to visible.
    const general = PRESET_AGENT_PROFILES.find((p) => p.id === 'general-purpose')!;
    const disabled = general.promptProfile?.disableSections ?? [];
    expect(disabled).toEqual(expect.arrayContaining([
      'configProtection', 'outputStyle', 'mcp', 'scratchpad',
      'sessionSearch', 'sessionGuidance',
      'visionGuidelines', 'visualVerification',
    ]));
    // Whitelist removed — it must never come back for main presets.
    expect(general.promptProfile?.enableSections).toBeUndefined();
  });

  it('resolveAllowedTools whitelists exactly the 5 file tools for memory-curator', () => {
    const curator = PRESET_AGENT_PROFILES.find((p) => p.id === 'memory-curator')!;
    const allTools = [
      'read', 'write', 'edit', 'grep', 'glob',
      'bash', 'powershell', 'task', 'browser',
      'show_widget', 'AskUserQuestion', 'duya_cli', 'tool_catalog',
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
      'mcp_duya_app_vision_analyze', 'show_widget', 'AskUserQuestion', 'task', 'memory',
      'read_module', 'EnterPlanMode', 'ExitPlanMode', 'SwitchMode',
    ];
    const result = resolveAllowedTools(gateway, allTools);
    for (const t of ['show_widget', 'AskUserQuestion', 'task', 'memory', 'read_module', 'EnterPlanMode', 'ExitPlanMode', 'SwitchMode']) {
      expect(result.denied).toContain(t);
    }
    expect(result.allowed).toContain('mcp_duya_app_vision_analyze');
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
