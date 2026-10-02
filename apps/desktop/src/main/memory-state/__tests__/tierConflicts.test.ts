import { describe, it, expect } from 'vitest';
import {
  newestWins,
  resolveShardConflicts,
  dedupeAcrossShards,
  mergeTierRecall,
  type ConflictAccessors,
} from '../tierConflicts';

/**
 * Pure conflict-rule tests (Plan 479 Phase 1, P1.2).
 * Semantics under test (plan 479 §3.1/§3.2):
 *   - same shard + same key → newest-wins
 *   - cross shard, same tier + same key → keep earliest (最早 via)
 *   - tier precedence: agent > project > user
 */

interface Fact {
  key: string;
  shard: string;
  updatedAt: number;
  createdAt: number;
  label: string;
}

const accessors: ConflictAccessors<Fact> = {
  keyOf: (f) => f.key,
  timeOf: (f) => f.updatedAt,
  bornOf: (f) => f.createdAt,
  shardOf: (f) => f.shard,
};

function fact(key: string, shard: string, updatedAt: number, createdAt = updatedAt, label = `${key}@${shard}@${updatedAt}`): Fact {
  return { key, shard, updatedAt, createdAt, label };
}

describe('newestWins', () => {
  it('keeps the incumbent on tie', () => {
    const a = fact('k', 's', 100);
    const b = fact('k', 's', 100);
    expect(newestWins(a, b, (f) => f.updatedAt)).toBe(a);
  });

  it('takes the strictly newer entry', () => {
    const a = fact('k', 's', 100);
    const b = fact('k', 's', 200);
    expect(newestWins(a, b, (f) => f.updatedAt)).toBe(b);
    expect(newestWins(b, a, (f) => f.updatedAt)).toBe(b);
  });
});

describe('resolveShardConflicts', () => {
  it('keeps the newest per key within one shard', () => {
    const entries = [
      fact('pref:style', 'agent:botA', 100),
      fact('pref:style', 'agent:botA', 300, 100, 'rewritten'),
      fact('pref:style', 'agent:botA', 200),
    ];
    const resolved = resolveShardConflicts(entries, accessors);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].updatedAt).toBe(300);
  });

  it('keeps distinct keys independently and preserves first-appearance order', () => {
    const entries = [
      fact('a', 's', 100),
      fact('b', 's', 90),
      fact('a', 's', 200),
      fact('c', 's', 50),
    ];
    const resolved = resolveShardConflicts(entries, accessors);
    expect(resolved.map((r) => r.key)).toEqual(['a', 'b', 'c']);
    expect(resolved[0].updatedAt).toBe(200);
    expect(resolved[1].updatedAt).toBe(90);
    expect(resolved[2].updatedAt).toBe(50);
  });

  it('keeps the first occurrence when timestamps tie', () => {
    const entries = [fact('k', 's', 100, 100, 'first'), fact('k', 's', 100, 100, 'second')];
    const resolved = resolveShardConflicts(entries, accessors);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].label).toBe('first');
  });
});

describe('dedupeAcrossShards', () => {
  it('keeps the earliest statement and attributes its shard as via', () => {
    const entries = [
      fact('person:alice', 'user:botB', 300, 300), // later re-statement
      fact('person:alice', 'user:botA', 100, 100), // earliest — wins via
    ];
    const { resolved, suppressed } = dedupeAcrossShards(entries, accessors);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].viaShard).toBe('user:botA');
    expect(resolved[0].entry.updatedAt).toBe(100);
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0].shard).toBe('user:botB');
  });

  it('breaks creation-time ties deterministically by shard id', () => {
    const entries = [
      fact('k', 'user:zeta', 100, 100),
      fact('k', 'user:alpha', 100, 100),
    ];
    const { resolved, suppressed } = dedupeAcrossShards(entries, accessors);
    expect(resolved[0].viaShard).toBe('user:alpha');
    expect(suppressed[0].shard).toBe('user:zeta');
  });

  it('keeps keys that appear in only one shard', () => {
    const entries = [
      fact('a', 'user:one', 100),
      fact('b', 'user:two', 200),
    ];
    const { resolved, suppressed } = dedupeAcrossShards(entries, accessors);
    expect(resolved.map((r) => r.viaShard)).toEqual(['user:one', 'user:two']);
    expect(suppressed).toHaveLength(0);
  });

  it('defaults bornOf to timeOf when omitted', () => {
    const entries = [
      fact('k', 'user:late', 300),
      fact('k', 'user:early', 100),
    ];
    const { resolved } = dedupeAcrossShards(entries, {
      keyOf: accessors.keyOf,
      timeOf: accessors.timeOf,
      shardOf: accessors.shardOf,
    });
    expect(resolved[0].viaShard).toBe('user:early');
  });
});

describe('mergeTierRecall', () => {
  it('applies tier precedence agent > project > user per key', () => {
    const own = [fact('pref:style', 'agent:botA', 100)];
    const project = [fact('pref:style', 'project:p1/botB', 500)];
    const user = [fact('pref:style', 'user:botC', 900)];
    const { resolved, suppressed } = mergeTierRecall({ own, project, user }, accessors);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].tier).toBe('agent');
    expect(resolved[0].viaShard).toBe('agent:botA');
    expect(suppressed.map((s) => s.tier)).toEqual(['project', 'user']);
  });

  it('surfaces lower-tier keys absent from higher tiers', () => {
    const own = [fact('own:only', 'agent:botA', 100)];
    const project = [fact('proj:fact', 'project:p1/botB', 100)];
    const user = [fact('user:fact', 'user:botC', 100)];
    const { resolved } = mergeTierRecall({ own, project, user }, accessors);
    expect(resolved.map((r) => [r.tier, r.entry.key])).toEqual([
      ['agent', 'own:only'],
      ['project', 'proj:fact'],
      ['user', 'user:fact'],
    ]);
  });

  it('applies precedence after in-tier cross-shard dedupe (project > user)', () => {
    const user = [
      fact('person:alice', 'user:botA', 100, 100), // earliest in-tier → via
      fact('person:alice', 'user:botB', 300, 300), // suppressed in-tier
    ];
    const project = [fact('person:alice', 'project:p1/botC', 500, 500)];
    const { resolved, suppressed } = mergeTierRecall({ own: [], project, user }, accessors);
    expect(resolved).toHaveLength(1);
    // Tier precedence (§3.2 project > user) decides after each tier's
    // internal cross-shard dedupe: the project-tier entry wins the key.
    expect(resolved[0].tier).toBe('project');
    expect(resolved[0].viaShard).toBe('project:p1/botC');
    // one in-tier suppression (user botB) + one precedence suppression (user botA)
    expect(suppressed.map((s) => s.tier)).toEqual(['user', 'user']);
  });

  it('handles empty tiers', () => {
    const { resolved, suppressed } = mergeTierRecall<Fact>(
      { own: [], project: [], user: [] },
      accessors
    );
    expect(resolved).toHaveLength(0);
    expect(suppressed).toHaveLength(0);
  });
});
