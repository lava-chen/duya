/**
 * Bot memory authorization + recall gate (framework plan S5).
 *
 * Named acceptance cases for the slice:
 *   - explicit grants, fail closed: a bot recalls the legacy shared roots,
 *     its own user shard, granted peer shards and joined projects — never
 *     every peer shard on disk;
 *   - revocation lands on the next turn: a new grant set (or a forget)
 *     produces a new `recallRevision`, which re-renders volatile memory
 *     sections mid-epoch while ordinary writes stay frozen;
 *   - path safety: ids from state files are validated before they become
 *     path segments.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BotPromptAssembly,
  botVolatileSectionCacheKey,
  loadBotMemoryContext,
  memoryAccessPath,
  readJoinedProjects,
  readMemoryAccessGrant,
  readProjectTierEntries,
  readUserTierEntries,
} from '../../src/worker-prompts/bot/index.js';
import { buildBotContextSnapshot, parseMemoryAccessGrant } from '@duya/bot';
import { recordForgetSync } from '@duya/memory/forget_ledger';

function writeTierFact(
  root: string,
  relPath: string,
  dedupeKey: string,
  body: string,
  writer: string,
  projectId?: string,
): void {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const frontmatter = [
    '---',
    `memory_id: ${dedupeKey.replace(/[^a-z0-9]+/g, '-')}`,
    `canonical_key: ${dedupeKey}`,
    'claim_type: note',
    `scope: ${projectId ? 'project' : 'user'}`,
    `scope_id: ${writer}`,
    `project_id: ${projectId ?? 'null'}`,
    'status: active',
    'importance: normal',
    'updated_at: 2026-10-26T00:00:00.000Z',
    '---',
    '',
    body,
    '',
  ].join('\n');
  fs.writeFileSync(full, frontmatter, 'utf8');
}

function writeLegacyFact(root: string, canonicalKey: string, body: string): void {
  const full = path.join(root, 'memory', 'items', 'legacy', `${canonicalKey.replace(/[^a-z0-9]+/g, '-')}.md`);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(
    full,
    [
      '---',
      'memory_id: legacy',
      `canonical_key: ${canonicalKey}`,
      'claim_type: preference',
      'scope: global',
      'scope_id: null',
      'project_id: null',
      'status: active',
      'importance: normal',
      'updated_at: 2026-10-26T00:00:00.000Z',
      '---',
      '',
      body,
      '',
    ].join('\n'),
    'utf8',
  );
}

describe('bot memory authorization (S5)', () => {
  let root: string;
  const previousMemoryRoot = process.env.DUYA_MEMORY_ROOT;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-bot-memory-s5-'));
    process.env.DUYA_MEMORY_ROOT = path.join(root, 'memory');
    // Three bots with user shards on disk; alpha may only see its own by
    // default.
    writeTierFact(root, 'agents/alpha/user/alpha.md', 'fact:alpha', 'Alpha fact', 'alpha');
    writeTierFact(root, 'agents/beta/user/beta.md', 'fact:beta', 'Beta fact', 'beta');
    writeTierFact(root, 'agents/gamma/user/gamma.md', 'fact:gamma', 'Gamma fact', 'gamma');
    writeLegacyFact(root, 'preference:legacy', 'Legacy shared fact');
  });

  afterEach(() => {
    if (previousMemoryRoot === undefined) delete process.env.DUYA_MEMORY_ROOT;
    else process.env.DUYA_MEMORY_ROOT = previousMemoryRoot;
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  function writeStateFile(relPath: string, value: unknown): void {
    const full = path.join(root, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, JSON.stringify(value), 'utf8');
  }

  it('recalls legacy roots and the own shard without any grant', async () => {
    const grant = await readMemoryAccessGrant(root, 'alpha');
    expect(grant).toEqual({ userShards: [] });

    const user = readUserTierEntries(root, ['alpha']);
    expect(user.map((e) => e.dedupeKey).sort()).toEqual(['fact:alpha', 'preference:legacy']);
  });

  it('never scans ungranted peer shards', () => {
    const user = readUserTierEntries(root, ['alpha']);
    expect(user.some((e) => e.dedupeKey === 'fact:beta')).toBe(false);
    expect(user.some((e) => e.dedupeKey === 'fact:gamma')).toBe(false);

    const granted = readUserTierEntries(root, ['alpha', 'beta']);
    expect(granted.map((e) => e.dedupeKey).sort()).toEqual([
      'fact:alpha',
      'fact:beta',
      'preference:legacy',
    ]);
    expect(granted.find((e) => e.dedupeKey === 'fact:beta')?.writerId).toBe('beta');
  });

  it('reads a grant and fails closed on malformed or unsafe ids', async () => {
    expect(memoryAccessPath(root, '../escape')).toBeNull();
    expect(await readMemoryAccessGrant(root, '../escape')).toEqual({ userShards: [] });

    // All-or-nothing: one invalid entry rejects the whole grant.
    writeStateFile('agents/alpha/state/memory-access.json', { userShards: ['beta', '../escape', 7] });
    expect(await readMemoryAccessGrant(root, 'alpha')).toEqual({ userShards: [] });

    writeStateFile('agents/alpha/state/memory-access.json', { userShards: ['beta'] });
    expect(await readMemoryAccessGrant(root, 'alpha')).toEqual({ userShards: ['beta'] });

    writeStateFile('agents/alpha/state/memory-access.json', { userShards: 'beta' });
    expect(await readMemoryAccessGrant(root, 'alpha')).toEqual({ userShards: [] });

    fs.writeFileSync(path.join(root, 'agents', 'alpha', 'state', 'memory-access.json'), '{oops');
    expect(await readMemoryAccessGrant(root, 'alpha')).toEqual({ userShards: [] });
  });

  it('drops unsafe project ids before they become path segments', () => {
    writeStateFile('agents/alpha/state/projects.json', ['web', '../escape', 'bad/segment', 'api']);
    expect(readJoinedProjects(root, 'alpha')).toEqual(['web', 'api']);
    expect(readJoinedProjects(root, '../escape')).toEqual([]);
  });

  it('recalls project entries only for joined, safe projects', () => {
    writeTierFact(root, 'projects/web/agents/alpha/web.md', 'fact:web', 'Web fact', 'alpha', 'web');
    writeTierFact(root, 'projects/api/agents/beta/api.md', 'fact:api', 'Api fact', 'beta', 'api');

    const entries = readProjectTierEntries(root, ['web', '../escape']);
    expect(entries.map((e) => e.dedupeKey)).toEqual(['fact:web']);
  });

  it('revokes a peer shard on the next turn while an ordinary write stays frozen', async () => {
    writeStateFile('agents/alpha/state/memory-access.json', { userShards: ['beta'] });
    writeStateFile('agents/alpha/state/projects.json', ['web']);

    const turn = async () => {
      const grant = await readMemoryAccessGrant(root, 'alpha');
      const snapshot = buildBotContextSnapshot({
        botId: 'alpha',
        joinedProjects: readJoinedProjects(root, 'alpha'),
        grant,
        forgetRevision: 0,
      });
      const memory = loadBotMemoryContext('alpha', new Map(), snapshot.memory);
      return { snapshot, memory };
    };

    const first = await turn();
    expect(first.memory?.user.map((e) => e.dedupeKey).sort()).toEqual([
      'fact:alpha',
      'fact:beta',
      'preference:legacy',
    ]);

    // Ordinary memory writes change section content but not the gate.
    writeTierFact(root, 'agents/alpha/user/extra.md', 'fact:extra', 'Extra', 'alpha');
    const second = await turn();
    expect(second.snapshot.recallRevision).toBe(first.snapshot.recallRevision);

    // Revocation: beta is dropped, gamma becomes visible, gate moves.
    writeStateFile('agents/alpha/state/memory-access.json', { userShards: ['gamma'] });
    const third = await turn();
    expect(third.snapshot.recallRevision).not.toBe(first.snapshot.recallRevision);
    expect(third.memory?.user.map((e) => e.dedupeKey).sort()).toEqual([
      'fact:alpha',
      'fact:extra',
      'fact:gamma',
      'preference:legacy',
    ]);
  });

  it('bumps the recall revision when a fact is forgotten', async () => {
    const before = buildBotContextSnapshot({
      botId: 'alpha',
      joinedProjects: [],
      grant: parseMemoryAccessGrant({ userShards: [] }),
      forgetRevision: 0,
    });
    recordForgetSync(path.join(root, 'memory'), [{ key: 'fact:alpha' }]);
    const after = buildBotContextSnapshot({
      botId: 'alpha',
      joinedProjects: [],
      grant: parseMemoryAccessGrant({ userShards: [] }),
      forgetRevision: 1,
    });
    expect(after.recallRevision).not.toBe(before.recallRevision);
  });

  it('hides a tombstoned file that a crash left un-retired', () => {
    // The crash window: the forget ledger is written (naming the file) but
    // the process dies before the file is retired, so the file on disk is
    // still `status: active`.
    const relPath = 'agents/alpha/user/alpha.md';
    recordForgetSync(path.join(root, 'memory'), [{ key: 'fact:alpha', path: relPath }]);
    const onDisk = fs.readFileSync(path.join(root, relPath), 'utf8');
    expect(onDisk).toContain('status: active');

    // The tombstoned path is not recallable, even though the file is active.
    const user = readUserTierEntries(root, ['alpha']);
    expect(user.some((e) => e.dedupeKey === 'fact:alpha')).toBe(false);
    expect(user.map((e) => e.dedupeKey)).toContain('preference:legacy');
  });
});

describe('volatile section frozen snapshot (S5)', () => {
  function makeAssembly() {
    const volatileCompute = vi.fn(() => 'MEMORY');
    const stableCompute = vi.fn(() => 'IDENTITY');
    const assembly = new BotPromptAssembly('BASE');
    assembly.register({ name: 'memory', volatile: true, compute: volatileCompute });
    assembly.register({ name: 'identity', compute: stableCompute });
    return { assembly, volatileCompute, stableCompute };
  }

  const ctx = { botAgentId: 'alpha' };

  it('reuses both sections while nothing changes', async () => {
    const { assembly, volatileCompute, stableCompute } = makeAssembly();
    const snapshot = { botId: 'alpha', contentHash: 'h1', summaryEpoch: 0, recallRevision: 'r1' };
    await assembly.renderSections(ctx, { snapshot });
    await assembly.renderSections(ctx, { snapshot });

    expect(volatileCompute).toHaveBeenCalledTimes(1);
    expect(stableCompute).toHaveBeenCalledTimes(1);
  });

  it('re-renders the volatile section immediately when the recall gate moves', async () => {
    const { assembly, volatileCompute, stableCompute } = makeAssembly();
    await assembly.renderSections(ctx, {
      snapshot: { botId: 'alpha', contentHash: 'h1', summaryEpoch: 0, recallRevision: 'r1' },
    });
    await assembly.renderSections(ctx, {
      snapshot: { botId: 'alpha', contentHash: 'h1', summaryEpoch: 0, recallRevision: 'r2' },
    });

    expect(volatileCompute).toHaveBeenCalledTimes(2);
    // Stable sections are untouched by an authorization change.
    expect(stableCompute).toHaveBeenCalledTimes(1);
  });

  it('keeps the volatile freeze when only content changes', async () => {
    const { assembly, volatileCompute, stableCompute } = makeAssembly();
    await assembly.renderSections(ctx, {
      snapshot: { botId: 'alpha', contentHash: 'h1', summaryEpoch: 0, recallRevision: 'r1' },
    });
    await assembly.renderSections(ctx, {
      snapshot: { botId: 'alpha', contentHash: 'h2', summaryEpoch: 0, recallRevision: 'r1' },
    });

    expect(volatileCompute).toHaveBeenCalledTimes(1);
    expect(stableCompute).toHaveBeenCalledTimes(2);
  });

  it('re-renders both sections at a compaction boundary', async () => {
    const { assembly, volatileCompute, stableCompute } = makeAssembly();
    await assembly.renderSections(ctx, {
      snapshot: { botId: 'alpha', contentHash: 'h1', summaryEpoch: 0, recallRevision: 'r1' },
    });
    await assembly.renderSections(ctx, {
      snapshot: { botId: 'alpha', contentHash: 'h1', summaryEpoch: 1, recallRevision: 'r1' },
    });

    expect(volatileCompute).toHaveBeenCalledTimes(2);
    expect(stableCompute).toHaveBeenCalledTimes(2);
  });

  it('namespaces the volatile cache key on the recall revision', () => {
    expect(botVolatileSectionCacheKey('alpha', 'r1', 2, 'memory')).toBe(
      'bot:alpha:v:r1:2:memory',
    );
    expect(botVolatileSectionCacheKey('alpha', undefined, 2, 'memory')).toBe(
      'bot:alpha:v:-:2:memory',
    );
  });
});
