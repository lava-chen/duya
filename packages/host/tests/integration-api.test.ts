/**
 * Plan 621 slice B — Host `HostIntegrationApiV1` over the real projection store.
 *
 * The store is real (a temporary core database) because the question these
 * tests answer is "does a refresh land in the table and come back out", not
 * "does a fake record round-trip". The GitHub read itself is slice C's and is
 * injected here as a plain callback.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CoreDataHost, type IntegrationStore } from '@duya/data';
import type { HostIntegrationRecord } from '@duya/agent-protocol';
import {
  INTEGRATION_OBSERVER_UNAVAILABLE,
  createHostIntegrationApi,
} from '../src/integration-api.js';

const hosts: CoreDataHost[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const host of hosts.splice(0)) host.close();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function openStore(): IntegrationStore {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-integration-api-test-'));
  directories.push(directory);
  const host = new CoreDataHost({
    filename: path.join(directory, 'duya-core.db'),
    rolloutRoot: path.join(directory, 'sessions'),
    attachmentsRoot: path.join(directory, 'attachments'),
    messageLogPorts: {
      botSessionIdPrefix: 'bot:',
      parseBotSessionId: () => null,
      getBotSessionLogPath: (agentId, dataRoot) => path.join(dataRoot, 'agents', agentId, 'sessions.jsonl'),
      getBotSessionsDir: (agentId, dataRoot) => path.join(dataRoot, 'agents', agentId, 'sessions'),
    },
  });
  hosts.push(host);
  return host.stores.integrations;
}

function record(overrides: Partial<HostIntegrationRecord> = {}): HostIntegrationRecord {
  return {
    repo: 'duya/duya',
    prNumber: 21,
    state: 'checks_passing',
    headSha: 'd'.repeat(40),
    baseRef: 'master',
    url: 'https://example.test/pr/21',
    observedAt: 1_700_000_000_000,
    observedError: null,
    ...overrides,
  };
}

describe('HostIntegrationApiV1 — refresh', () => {
  it('answers unknown with a reason when no observer is configured, and persists it', async () => {
    const store = openStore();
    const api = createHostIntegrationApi({ store });

    const observed = await api.observeForPr('duya/duya', 21);
    expect(observed.state).toBe('unknown');
    expect(observed.observedError).toBe(INTEGRATION_OBSERVER_UNAVAILABLE);
    // Not folded into `open`, and not held only in memory.
    expect(store.get('duya/duya', 21)).toMatchObject({
      observed_state: 'unknown',
      observed_error: INTEGRATION_OBSERVER_UNAVAILABLE,
    });
  });

  it('writes a successful observation over the previous one', async () => {
    const store = openStore();
    const api = createHostIntegrationApi({ store, observePr: async () => record() });

    const observed = await api.observeForPr('duya/duya', 21);
    expect(observed.state).toBe('checks_passing');
    expect(store.get('duya/duya', 21)).toMatchObject({
      observed_state: 'checks_passing',
      observed_head_sha: 'd'.repeat(40),
      observed_error: null,
    });

    const failing = createHostIntegrationApi({
      store,
      observePr: async () => record({ state: 'checks_failing', observedAt: 1_700_000_100_000 }),
    });
    await failing.observeForPr('duya/duya', 21);
    expect(store.get('duya/duya', 21)?.observed_state).toBe('checks_failing');
    expect(store.get('duya/duya', 21)?.observed_at).toBe(1_700_000_100_000);
  });

  it('keeps the requested key when an observer echoes a different PR', async () => {
    const store = openStore();
    const api = createHostIntegrationApi({
      store,
      observePr: async () => record({ repo: 'someone/else', prNumber: 999 }),
    });

    await api.observeForPr('duya/duya', 21);
    expect(store.get('duya/duya', 21)).not.toBeNull();
    expect(store.get('someone/else', 999)).toBeNull();
  });

  it('refuses an observer that reports unknown without a reason', async () => {
    const store = openStore();
    const api = createHostIntegrationApi({
      store,
      observePr: async () => record({ state: 'unknown', observedError: null }),
    });

    await expect(api.observeForPr('duya/duya', 21)).rejects.toThrow(/observedError/);
    expect(store.get('duya/duya', 21)).toBeNull();
  });

  it('rejects an empty repo or a non-positive PR number', async () => {
    const api = createHostIntegrationApi({ store: openStore() });
    await expect(api.observeForPr('', 21)).rejects.toThrow(/repo/);
    await expect(api.observeForPr('duya/duya', 0)).rejects.toThrow(/prNumber/);
    await expect(api.linkSession('duya/duya', 21, ' ')).rejects.toThrow(/sessionId/);
  });
});

describe('HostIntegrationApiV1 — read and link', () => {
  it('returns every PR linked to a session and nothing else', async () => {
    const store = openStore();
    const api = createHostIntegrationApi({ store, observePr: async (repo, prNumber) => record({ repo, prNumber }) });

    await api.observeForPr('duya/duya', 21);
    await api.observeForPr('duya/duya', 22);
    await api.observeForPr('other/repo', 23);
    await api.linkSession('duya/duya', 21, 's-1');
    await api.linkSession('duya/duya', 22, 's-1');
    await api.linkSession('other/repo', 23, 's-2');

    expect((await api.observeForSession('s-1')).map((row) => row.prNumber)).toEqual([21, 22]);
    expect((await api.observeForSession('s-2')).map((row) => row.repo)).toEqual(['other/repo']);
    expect(await api.observeForSession('s-unknown')).toEqual([]);
  });

  it('links idempotently so a repeated report does not create a second row', async () => {
    const store = openStore();
    const api = createHostIntegrationApi({ store });
    await api.observeForPr('duya/duya', 30);

    await api.linkSession('duya/duya', 30, 's-1');
    await api.linkSession('duya/duya', 30, 's-1');
    expect(store.listSessionsFor('duya/duya', 30)).toHaveLength(1);
    expect((await api.observeForSession('s-1')).map((row) => row.prNumber)).toEqual([30]);
  });
});
