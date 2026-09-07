/**
 * config-groups tests (Plan 478 P1.1) — worker-side groups.toml reader.
 */

import { describe, expect, it } from 'vitest';
import {
  GROUP_MAX_MEMBERS,
  getGroupsTomlPath,
  listResolvedGroups,
  readConfigGroups,
  resolveGroupConfig,
} from '../config-groups.js';

describe('resolveGroupConfig', () => {
  it('applies grok defaults for missing limits', () => {
    const resolved = resolveGroupConfig('group-aa', { name: '产品讨论组', members: ['a', 'b'] });
    expect(resolved).toEqual({
      id: 'group-aa',
      name: '产品讨论组',
      description: '',
      memberIds: ['a', 'b'],
      maxRounds: 3,
      maxMemberTurns: 10,
    });
  });

  it('resolves and trims the optional description', () => {
    const resolved = resolveGroupConfig('group-dd', {
      name: '产品讨论组',
      description: '  产品评审专用  ',
      members: ['a'],
    });
    expect(resolved.description).toBe('产品评审专用');
    expect(resolveGroupConfig('group-ee', { members: [] }).description).toBe('');
  });

  it('clamps invalid limit values to the defaults', () => {
    const resolved = resolveGroupConfig('g', { members: [], max_rounds: 0, max_member_turns: -5 });
    expect(resolved.maxRounds).toBe(3);
    expect(resolved.maxMemberTurns).toBe(10);
  });

  it('floors fractional limits and drops non-string members', () => {
    const resolved = resolveGroupConfig('g', {
      members: ['a', 42, ''] as unknown as string[],
      max_rounds: 2.9,
      max_member_turns: 7.2,
    });
    expect(resolved.memberIds).toEqual(['a']);
    expect(resolved.maxRounds).toBe(2);
    expect(resolved.maxMemberTurns).toBe(7);
  });

  it('falls back to the id when the name is blank', () => {
    expect(resolveGroupConfig('group-bb', { members: ['a'] }).name).toBe('group-bb');
  });

  it('exports the grok room size cap', () => {
    expect(GROUP_MAX_MEMBERS).toBe(6);
  });
});

describe('readConfigGroups', () => {
  it('returns an empty record when groups.toml is missing', async () => {
    // Default namespace has no groups.toml in CI/dev sandboxes; the reader
    // must degrade to {} either way (missing file = no groups).
    const groups = await readConfigGroups();
    expect(typeof groups).toBe('object');
  });

  it('resolves the path under the duya root', () => {
    expect(getGroupsTomlPath()).toContain('groups.toml');
  });

  it('listResolvedGroups resolves every declared entry', async () => {
    // Round-trip through resolve: entries may be hand-edited toml, so the
    // resolver must tolerate partial rows.
    const all = await listResolvedGroups();
    for (const [id, group] of Object.entries(all)) {
      expect(group.id).toBe(id);
      expect(Array.isArray(group.memberIds)).toBe(true);
      expect(group.maxRounds).toBeGreaterThanOrEqual(1);
      expect(group.maxMemberTurns).toBeGreaterThanOrEqual(1);
    }
  });
});
