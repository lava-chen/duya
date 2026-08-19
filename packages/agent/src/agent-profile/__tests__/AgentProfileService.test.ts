import { describe, it, expect } from 'vitest';
import {
  InMemoryAgentProfileService,
  profileToRow,
  rowToAgentProfile,
} from '../AgentProfileService.js';
import type { AgentProfile, AgentProfileDbRow } from '../types.js';

const BASE_ROW: AgentProfileDbRow = {
  id: 'custom-1',
  name: 'Custom',
  description: null,
  allowed_tools: null,
  disallowed_tools: null,
  default_model: null,
  prompt_system: null,
  prompt_profile: null,
  profile_kind: 'main',
  user_visible: 1,
  is_preset: 0,
  is_enabled: 1,
  created_at: 1,
  updated_at: 1,
};

describe('AgentProfileService prompt_profile persistence (Plan 420)', () => {
  it('rowToAgentProfile parses prompt_profile JSON into promptProfile', () => {
    const row: AgentProfileDbRow = {
      ...BASE_ROW,
      prompt_profile: JSON.stringify({ disableSections: ['memory'], enableSections: ['rules'] }),
    };
    const profile = rowToAgentProfile(row);
    expect(profile.promptProfile).toEqual({
      disableSections: ['memory'],
      enableSections: ['rules'],
    });
  });

  it('rowToAgentProfile treats null prompt_profile as undefined', () => {
    expect(rowToAgentProfile(BASE_ROW).promptProfile).toBeUndefined();
  });

  it('rowToAgentProfile tolerates malformed prompt_profile (fail-open)', () => {
    const row: AgentProfileDbRow = { ...BASE_ROW, prompt_profile: '{broken' };
    expect(rowToAgentProfile(row).promptProfile).toBeUndefined();
  });

  it('profileToRow serializes promptProfile back to JSON', () => {
    const profile: AgentProfile = {
      id: 'custom-1',
      name: 'Custom',
      promptProfile: { disableSections: ['memory'] },
    };
    const row = profileToRow(profile);
    expect(row.prompt_profile).toBe(JSON.stringify({ disableSections: ['memory'] }));
  });

  it('exportToRows → loadFromRows round-trips promptProfile for custom profiles', () => {
    const service = new InMemoryAgentProfileService();
    service.create({
      id: 'custom-1',
      name: 'Custom',
      promptProfile: { disableSections: ['memory', 'skills'], enableSections: ['rules'] },
    });
    const rows = service.exportToRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].prompt_profile).toBe(
      JSON.stringify({ disableSections: ['memory', 'skills'], enableSections: ['rules'] }),
    );

    const reloaded = new InMemoryAgentProfileService();
    reloaded.loadFromRows(rows);
    expect(reloaded.get('custom-1')?.promptProfile).toEqual({
      disableSections: ['memory', 'skills'],
      enableSections: ['rules'],
    });
  });
});
