/**
 * `aliveness.ts` — the real evidence behind the provider's fail-closed ports.
 *
 * These are pure unit tests on the factory and the containment helper: the
 * interesting properties are (a) answers come from run STATUS alone — no
 * timestamp is ever consulted (plan 621, decision D4) — and (b) the cwd
 * containment cannot be fooled by sibling prefixes, case spelling or
 * unresolved paths, because a wrong "in use" keeps a checkout forever and a
 * wrong "not in use" deletes a live one.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import { createAlivenessInputs, cwdInsideRoot, type AlivenessSources } from '../../src/workspace/aliveness.js';

function sourcesWith(
  runs: Array<{ sessionId: string; status: string }>,
  runningCwds: string[],
): AlivenessSources & { listRunsCalls: string[] } {
  const listRunsCalls: string[] = [];
  return {
    listRunsCalls,
    listRunsBySession(sessionId: string) {
      listRunsCalls.push(sessionId);
      return runs.filter((run) => run.sessionId === sessionId);
    },
    listRunningRunCwds: async () => runningCwds,
  };
}

describe('createAlivenessInputs.isSessionAlive', () => {
  it('is true only while the session has a running run row', async () => {
    const sources = sourcesWith(
      [
        { sessionId: 's1', status: 'completed' },
        { sessionId: 's1', status: 'running' },
        { sessionId: 's2', status: 'completed' },
        { sessionId: 's2', status: 'failed' },
      ],
      [],
    );
    const inputs = createAlivenessInputs(sources);

    expect(await inputs.isSessionAlive('s1')).toBe(true);
    expect(await inputs.isSessionAlive('s2')).toBe(false);
    expect(await inputs.isSessionAlive('s3')).toBe(false);
    expect(sources.listRunsCalls).toEqual(['s1', 's2', 's3']);
  });

  it('accepts the sync RunStore shape and an async source alike', async () => {
    const syncSource: AlivenessSources = {
      listRunsBySession: (sessionId) =>
        sessionId === 'live' ? [{ status: 'running' }] : [],
      listRunningRunCwds: async () => [],
    };
    const asyncSource: AlivenessSources = {
      listRunsBySession: async (sessionId) =>
        sessionId === 'live' ? [{ status: 'running' }] : [],
      listRunningRunCwds: async () => [],
    };

    expect(await createAlivenessInputs(syncSource).isSessionAlive('live')).toBe(true);
    expect(await createAlivenessInputs(asyncSource).isSessionAlive('dead')).toBe(false);
  });
});

describe('createAlivenessInputs.cwdInUse', () => {
  const root = path.join(os.tmpdir(), 'duya-aliveness-root');

  it('is true for a running cwd equal to the root or inside it', async () => {
    const inputs = createAlivenessInputs(
      sourcesWith([], [path.join(root, 'packages', 'host'), root]),
    );
    expect(await inputs.cwdInUse(root)).toBe(true);
  });

  it('is false when every running cwd lies outside the root', async () => {
    const elsewhere = path.join(os.tmpdir(), 'duya-aliveness-elsewhere');
    const inputs = createAlivenessInputs(sourcesWith([], [elsewhere]));
    expect(await inputs.cwdInUse(root)).toBe(false);
  });

  it('does not mistake a sibling directory with a shared prefix for the root', async () => {
    const sibling = root + '2';
    const inputs = createAlivenessInputs(sourcesWith([], [sibling]));
    expect(await inputs.cwdInUse(root)).toBe(false);
  });

  it('ignores case on Windows but not on POSIX', async () => {
    const inputs = createAlivenessInputs(
      sourcesWith([], [root.toUpperCase()]),
    );
    expect(await inputs.cwdInUse(root)).toBe(process.platform === 'win32');
  });

  it('is false with no running runs at all', async () => {
    const inputs = createAlivenessInputs(sourcesWith([], []));
    expect(await inputs.cwdInUse(root)).toBe(false);
  });
});

describe('cwdInsideRoot', () => {
  it('requires the separator boundary', () => {
    const root = path.join('base', 'repo');
    expect(cwdInsideRoot(root, path.join(root, 'child'))).toBe(true);
    expect(cwdInsideRoot(root, root + '2')).toBe(false);
    expect(cwdInsideRoot(root, path.join('base', 'other', 'repo'))).toBe(false);
  });

  it('resolves one directory spelled two ways to the same answer', () => {
    const root = path.join(os.tmpdir(), 'duya-aliveness-resolve');
    // Neither path exists, so canonicalPath falls back to path.resolve — the
    // dotted spelling must still be recognized as inside.
    expect(cwdInsideRoot(root, path.join(root, '..', 'duya-aliveness-resolve'))).toBe(true);
    expect(cwdInsideRoot(root, path.join(root, 'sub', '..'))).toBe(true);
  });
});
