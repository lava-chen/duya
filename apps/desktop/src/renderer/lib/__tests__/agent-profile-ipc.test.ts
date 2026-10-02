/**
 * Tests for agent-profile IPC client (Plan 424): listMainAgentProfiles merges
 * DB main profiles with config-driven custom agents.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  listMainAgentProfiles,
  listCustomAgents,
  createConfigAgent,
  updateConfigAgent,
} from '../agent-profile-ipc';

describe('agent-profile-ipc (Plan 424)', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      electronAPI: {
        agentProfile: {
          list: vi.fn(),
        },
        configAgents: {
          list: vi.fn(),
          create: vi.fn(),
          update: vi.fn(),
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('listCustomAgents returns the raw config agents map', async () => {
    const agents = { 'frontend-expert': { name: 'Frontend Expert', model: 'anthropic/claude' } };
    (window.electronAPI.configAgents.list as ReturnType<typeof vi.fn>).mockResolvedValue(agents);
    await expect(listCustomAgents()).resolves.toEqual(agents);
  });

  it('listMainAgentProfiles merges DB main profiles with custom agents', async () => {
    (window.electronAPI.agentProfile.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'general-purpose',
        name: 'General',
        profile_kind: 'main',
        user_visible: 1,
        is_preset: 1,
        is_enabled: 1,
        created_at: 0,
        updated_at: 0,
      },
      {
        id: 'explore',
        name: 'Explore',
        profile_kind: 'subagent',
        user_visible: 0,
        is_preset: 1,
        is_enabled: 1,
        created_at: 0,
        updated_at: 0,
      },
    ]);
    (window.electronAPI.configAgents.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      'frontend-expert': {
        name: 'Frontend Expert',
        description: 'React/TS expert',
        model: 'anthropic/claude-sonnet-4-20250514',
        tools: { allow: ['file:*'], deny: ['browser'] },
      },
    });

    const profiles = await listMainAgentProfiles();
    // Main (general-purpose) + custom (frontend-expert); subagent (explore) filtered out.
    expect(profiles.map((p) => p.id)).toEqual(['general-purpose', 'frontend-expert']);

    const custom = profiles.find((p) => p.id === 'frontend-expert')!;
    expect(custom.kind).toBe('main');
    expect(custom.isPreset).toBe(false);
    expect(custom.isEnabled).toBe(true);
    expect(custom.userVisible).toBe(true);
    expect(custom.defaultModel).toBe('anthropic/claude-sonnet-4-20250514');
    expect(custom.allowedTools).toEqual(['file:*']);
  });

  describe('createConfigAgent / updateConfigAgent model passthrough', () => {
    it('forwards the raw model to configAgents.create', async () => {
      (window.electronAPI.configAgents.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'my-bot' });
      const result = await createConfigAgent('my-bot', {
        name: 'My Bot',
        model: 'glm-4',
      });
      expect(result.id).toBe('my-bot');
      expect(window.electronAPI.configAgents.create).toHaveBeenCalledWith('my-bot', {
        name: 'My Bot',
        model: 'glm-4',
      });
    });

    it('forwards an unset model as undefined to configAgents.update', async () => {
      (window.electronAPI.configAgents.update as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      await updateConfigAgent('my-bot', {
        name: 'My Bot',
        model: undefined,
      });
      expect(window.electronAPI.configAgents.update).toHaveBeenCalledWith('my-bot', {
        name: 'My Bot',
        model: undefined,
      });
    });
  });
});