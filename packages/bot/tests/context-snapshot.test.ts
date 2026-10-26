/**
 * Bot recall snapshot (framework plan S5).
 *
 * The snapshot is the prompt layer's *authorization* input: it names the
 * user shards and projects a bot may read, and folds every recall gate into
 * one revision string. These cases pin the two product decisions:
 *
 *   - explicit grants, fail closed: no grant file / malformed grant reads as
 *     the own shard only, never as "every shard";
 *   - revision key on recall gate: a change to identity revision, grants,
 *     membership or the forget counter MUST move `recallRevision`, while an
 *     identical durable state MUST produce the identical string.
 */

import { describe, expect, it } from 'vitest';
import {
  buildBotContextSnapshot,
  isSafeMemorySegment,
  parseMemoryAccessGrant,
} from '../src/index.js';

describe('parseMemoryAccessGrant', () => {
  it('keeps a valid grant, sorted and deduped', () => {
    expect(parseMemoryAccessGrant({ userShards: ['beta', 'alpha', 'alpha'] })).toEqual({
      userShards: ['alpha', 'beta'],
    });
  });

  it('fails closed on every malformed shape', () => {
    for (const raw of [null, [], 'alpha', 42, {}, { userShards: 'alpha' }, { userShards: [1, null] }]) {
      expect(parseMemoryAccessGrant(raw)).toEqual({ userShards: [] });
    }
  });

  it('rejects the whole grant when one entry is invalid (all-or-nothing)', () => {
    // A partially applied grant is not a grant: the valid half must not ride
    // along with an entry the user never wrote (or a crafted one).
    expect(
      parseMemoryAccessGrant({ userShards: ['alpha', '../escape', 'beta'] }),
    ).toEqual({ userShards: [] });
    expect(parseMemoryAccessGrant({ userShards: ['alpha', 'beta/../gamma'] })).toEqual({
      userShards: [],
    });
    expect(parseMemoryAccessGrant({ userShards: ['alpha', 'has space'] })).toEqual({
      userShards: [],
    });
    expect(parseMemoryAccessGrant({ userShards: ['alpha', 7] })).toEqual({ userShards: [] });
  });
});

describe('isSafeMemorySegment', () => {
  it('accepts slug-shaped ids and rejects traversal shapes', () => {
    expect(isSafeMemorySegment('alpha')).toBe(true);
    expect(isSafeMemorySegment('team_one')).toBe(true);
    for (const bad of ['', '../escape', 'a/b', 'a\\b', '.', '..', 'a b', 42, null]) {
      expect(isSafeMemorySegment(bad)).toBe(false);
    }
  });
});

describe('buildBotContextSnapshot', () => {
  const base = {
    botId: 'alpha',
    botRevision: 3,
    joinedProjects: ['web', 'api'],
    grant: { userShards: ['beta', 'alpha'] },
    forgetRevision: 2,
  };

  it('authorizes own + granted shards and joined projects', () => {
    const snapshot = buildBotContextSnapshot(base);
    expect(snapshot.botId).toBe('alpha');
    expect(snapshot.botRevision).toBe(3);
    expect(snapshot.memory).toEqual({
      legacyUserRoots: true,
      ownUserShard: 'alpha',
      userShards: ['beta'],
      projects: ['api', 'web'],
    });
  });

  it('is deterministic for identical durable facts', () => {
    expect(buildBotContextSnapshot(base).recallRevision).toBe(
      buildBotContextSnapshot({ ...base, joinedProjects: ['api', 'web', 'api'] }).recallRevision,
    );
  });

  it('moves recallRevision when any recall gate changes', () => {
    const revision = buildBotContextSnapshot(base).recallRevision;
    expect(buildBotContextSnapshot({ ...base, botRevision: 4 }).recallRevision).not.toBe(revision);
    expect(buildBotContextSnapshot({ ...base, forgetRevision: 3 }).recallRevision).not.toBe(revision);
    expect(buildBotContextSnapshot({ ...base, joinedProjects: ['web'] }).recallRevision).not.toBe(revision);
    expect(
      buildBotContextSnapshot({ ...base, grant: { userShards: ['gamma'] } }).recallRevision,
    ).not.toBe(revision);
  });

  it('drops unsafe project ids instead of authorizing them', () => {
    const snapshot = buildBotContextSnapshot({
      ...base,
      joinedProjects: ['web', '../escape', 'ok_id', ''],
    });
    expect(snapshot.memory.projects).toEqual(['ok_id', 'web']);
  });

  it('authorizes no peer shard when the grant carries an invalid id', () => {
    const snapshot = buildBotContextSnapshot({
      ...base,
      grant: { userShards: ['beta', '../escape'] },
    });
    expect(snapshot.memory.userShards).toEqual([]);
    expect(snapshot.recallRevision).toContain('user:-');
  });

  it('authorizes no peer shard when the grant is absent', () => {
    const snapshot = buildBotContextSnapshot({
      botId: 'alpha',
      joinedProjects: [],
    });
    expect(snapshot.memory.userShards).toEqual([]);
  });

  it('treats absent or invalid revisions as zero', () => {
    const snapshot = buildBotContextSnapshot({
      botId: 'alpha',
      botRevision: -1,
      joinedProjects: [],
      grant: { userShards: [] },
    });
    expect(snapshot.botRevision).toBe(0);
    expect(snapshot.recallRevision).toBe('bot:0|forget:0|project:-|user:-');
  });
});
