/**
 * The turn review domain of the standalone Host's worker db bridge.
 *
 * ## Why this file exists
 *
 * The worker snapshots the files a turn changed and hands them to the Host
 * after every turn. On the standalone Host that write used to fail with
 * `unimplemented_domain`, and the failure was swallowed by the caller's
 * catch — so the turn review simply never existed.
 *
 * The Desktop renders those snapshots in its code-review panel. The
 * standalone Host keeps them for its own review surface, and the write
 * itself is the same one.
 *
 * These assertions pin the payload the bridge assembles: the required
 * fields, the file list, the counters, and the fact that a payload missing
 * the session, the turn or the working directory is rejected rather than
 * stored half-empty.
 */
import { describe, expect, it } from 'vitest';
import type { HostLocalTurnReviewApiV1, TurnReviewWriteInput } from '@duya/agent-protocol/turn-review';
import type { MainDatabase } from '@duya/data/main-database';
import type { MainSettingsStore } from '@duya/data/main-settings-store';
import type { SessionStore } from '@duya/data/session-store';
import type { RunRepository } from '../src/repository-port.js';
import { createHostWorkerDbBridge, WorkerDbBridgeError } from '../src/worker-db-bridge.js';

function bridge(turnReviewApi?: HostLocalTurnReviewApiV1) {
  return createHostWorkerDbBridge({
    runs: {} as RunRepository,
    sessions: {} as SessionStore,
    settings: {} as MainSettingsStore,
    mainDatabase: { db: {} } as MainDatabase,
    ...(turnReviewApi === undefined ? {} : { turnReviewApi }),
  });
}

/** A turn review API that records what the bridge handed it. */
function recordingTurnReviewApi(): { api: HostLocalTurnReviewApiV1; saved: TurnReviewWriteInput[] } {
  const saved: TurnReviewWriteInput[] = [];
  const api: HostLocalTurnReviewApiV1 = {
    async saveTurnReview(input) {
      saved.push(input);
    },
    async getLatestTurnReview() {
      return null;
    },
    async listTurnReviewHistory() {
      return [];
    },
    async getTurnReviewById() {
      return null;
    },
    async getTurnReviewByTurnId() {
      return null;
    },
  };
  return { api, saved };
}

describe('the standalone Host turn review domain', () => {
  it('saves the turn snapshot with the fields the bridge mapped', async () => {
    const { api, saved } = recordingTurnReviewApi();
    const host = bridge(api);

    await expect(host.dispatch('turn-review:save', {
      id: 'review-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      workingDirectory: '/tmp/project',
      files: [{ path: 'a.ts', status: 'modified', additions: 3, removals: 1 }],
      patch: '@@ -1 +1 @@',
      additions: 3,
      removals: 1,
      truncated: false,
      binary: false,
      capturedAt: 1700,
    })).resolves.toBe(true);

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      id: 'review-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      workingDirectory: '/tmp/project',
      patch: '@@ -1 +1 @@',
      additions: 3,
      removals: 1,
      truncated: false,
      binary: false,
      capturedAt: 1700,
    });
    expect(saved[0].files).toHaveLength(1);
  });

  it('defaults the counters and the capture time', async () => {
    const { api, saved } = recordingTurnReviewApi();
    const host = bridge(api);

    await host.dispatch('turn-review:save', {
      sessionId: 'session-1',
      turnId: 'turn-1',
      workingDirectory: '/tmp/project',
    });

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      additions: 0,
      removals: 0,
      truncated: false,
      binary: false,
      patch: '',
    });
    expect(saved[0].files).toEqual([]);
    expect(saved[0].id).toBeTruthy();
    expect(typeof saved[0].capturedAt).toBe('number');
  });

  it('rejects a snapshot without a session, a turn or a working directory', async () => {
    const { api, saved } = recordingTurnReviewApi();
    const host = bridge(api);

    await expect(host.dispatch('turn-review:save', { turnId: 'turn-1' }))
      .rejects.toMatchObject<Partial<WorkerDbBridgeError>>({ code: 'invalid_payload' });
    expect(saved).toHaveLength(0);
  });

  it('fails fast when the Host has not composed the turn review API', async () => {
    await expect(bridge().dispatch('turn-review:save', {
      sessionId: 'session-1',
      turnId: 'turn-1',
      workingDirectory: '/tmp/project',
    })).rejects.toMatchObject<Partial<WorkerDbBridgeError>>({ code: 'unimplemented_domain' });
  });
});
