/**
 * Plan 621 slice E — session-level integration sync (`scm/sync.ts`).
 *
 * The git side is real: every case builds a throwaway repository under the OS
 * temp directory (same discipline as `tests/workspace/fixtures.ts`), so the
 * `remote get-url` / `for-each-ref` plumbing runs for real. Only the process
 * boundaries that are expensive or flaky are injected: the session directory
 * lookup and the `gh` runner (a stub object, never `vi.mock` — see
 * docs/development/testing.md).
 *
 * Pinned here: the four distinguishable outcomes (`synced`,
 * `no_origin_remote`, `no_checkpoints`, `observation_failed`), the rule that a
 * ref without a PR writes nothing, and the rule that a failed observation
 * never overwrites the previous projection row.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CoreDataHost, type IntegrationStore } from '@duya/data';
import { GhError, type GhRunner } from '../../src/scm/gh-cli.js';
import { createIntegrationSync, repoFromOriginUrl } from '../../src/scm/sync.js';

const hosts: CoreDataHost[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const host of hosts.splice(0)) host.close();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function openStore(): IntegrationStore {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-integration-sync-test-'));
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

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * Throwaway repository with one commit. `withOrigin` names the remote (pass
 * `null` to leave it absent, which is the "no origin" case).
 */
function makeRepo(withOrigin: string | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-sync-repo-'));
  directories.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@duya.local');
  git(dir, 'config', 'user.name', 'duya test');
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'initial');
  if (withOrigin !== null) {
    git(dir, 'remote', 'add', 'origin', withOrigin);
  }
  return dir;
}

/** Pin one checkpoint ref for the session, the way slice A's runs would. */
function checkpoint(cwd: string, sessionId: string, n: number): string {
  const sha = git(cwd, 'rev-parse', 'HEAD');
  git(cwd, 'update-ref', `refs/duya/checkpoint/${sessionId}/${n}`, sha);
  return sha;
}

/** A `GhRunner` answering from fixtures, recording every invocation. */
function stubRunner(respond: (args: string[]) => unknown): { runner: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: GhRunner = {
    resolvePath: () => '/fake/gh',
    async run(args: string[]): Promise<string> {
      calls.push(args);
      return JSON.stringify(respond(args));
    },
    async runJson<T>(args: string[], parse: (value: unknown) => T): Promise<T> {
      calls.push(args);
      return parse(respond(args));
    },
  };
  return { runner, calls };
}

function failingRunner(error: unknown): GhRunner {
  return {
    resolvePath: () => '/fake/gh',
    async run(): Promise<string> {
      throw error;
    },
    async runJson<T>(): Promise<T> {
      throw error;
    },
  };
}

/** The `pr list` / `pr view` fixtures for one PR owned by `sha`. */
function onePrFixture(sha: string, prNumber: number, overrides: Record<string, unknown> = {}) {
  const listEntry = { number: prNumber, headRefName: 'feature', headRefOid: sha, state: 'OPEN' };
  const view = {
    state: 'OPEN',
    isDraft: false,
    headRefOid: sha,
    baseRefName: 'main',
    url: `https://github.com/owner/name/pull/${prNumber}`,
    reviewDecision: null,
    statusCheckRollup: [],
    ...overrides,
  };
  return stubRunner((args) => {
    if (args[0] === 'pr' && args[1] === 'list') return [listEntry];
    if (args[0] === 'pr' && args[1] === 'view') return view;
    throw new Error(`unexpected gh args: ${args.join(' ')}`);
  }).runner;
}

describe('repoFromOriginUrl', () => {
  it('accepts the https, ssh:// and scp-like origin forms', () => {
    expect(repoFromOriginUrl('https://github.com/owner/name.git')).toBe('owner/name');
    expect(repoFromOriginUrl('https://github.com/owner/name')).toBe('owner/name');
    expect(repoFromOriginUrl('git@github.com:owner/name.git')).toBe('owner/name');
    expect(repoFromOriginUrl('ssh://git@github.com/owner/name.git')).toBe('owner/name');
    expect(repoFromOriginUrl('ssh://git@github.com:22/owner/name.git')).toBe('owner/name');
  });

  it('rejects anything that does not name a two-segment repository', () => {
    expect(repoFromOriginUrl('/srv/git/name.git')).toBeNull();
    expect(repoFromOriginUrl('https://github.com/only-one-segment')).toBeNull();
    expect(repoFromOriginUrl('https://github.com/a/b/c')).toBeNull();
    expect(repoFromOriginUrl('')).toBeNull();
    expect(repoFromOriginUrl('   ')).toBeNull();
  });
});

describe('createIntegrationSync — syncSession', () => {
  it('reports no_checkpoints when the session has no working directory', async () => {
    const sync = createIntegrationSync({
      store: openStore(),
      getSessionWorkingDirectory: async () => null,
    });
    await expect(sync.syncSession('s-1')).resolves.toEqual({
      status: 'no_checkpoints',
      written: [],
      failed: [],
    });
  });

  it('reports no_origin_remote when the repository has no origin', async () => {
    const repo = makeRepo(null);
    const sync = createIntegrationSync({
      store: openStore(),
      getSessionWorkingDirectory: async () => repo,
    });
    await expect(sync.syncSession('s-1')).resolves.toEqual({
      status: 'no_origin_remote',
      written: [],
      failed: [],
    });
  });

  it('reports no_origin_remote when origin does not name a GitHub repository', async () => {
    const repo = makeRepo('/srv/git/name.git');
    const sync = createIntegrationSync({
      store: openStore(),
      getSessionWorkingDirectory: async () => repo,
    });
    const result = await sync.syncSession('s-1');
    expect(result.status).toBe('no_origin_remote');
    expect(result.written).toEqual([]);
  });

  it('reports no_checkpoints when origin resolves but no checkpoint refs exist', async () => {
    const repo = makeRepo('https://github.com/owner/name.git');
    const sync = createIntegrationSync({
      store: openStore(),
      getSessionWorkingDirectory: async () => repo,
    });
    const result = await sync.syncSession('s-1');
    expect(result.status).toBe('no_checkpoints');
    expect(result.written).toEqual([]);
  });

  it('syncs a checkpoint ref into an observation, session link and first event', async () => {
    const repo = makeRepo('git@github.com:owner/name.git');
    const sha = checkpoint(repo, 's-1', 1);
    const store = openStore();
    const sync = createIntegrationSync({
      store,
      getSessionWorkingDirectory: async () => repo,
      observeDeps: { runner: onePrFixture(sha, 21), now: () => 1_700_000_000_000 },
    });

    const result = await sync.syncSession('s-1');
    expect(result.status).toBe('synced');
    expect(result.written).toEqual([{ repo: 'owner/name', prNumber: 21 }]);
    expect(result.failed).toEqual([]);

    const row = store.get('owner/name', 21);
    expect(row?.observed_state).toBe('open');
    expect(row?.observed_head_sha).toBe(sha);
    expect(row?.observed_at).toBe(1_700_000_000_000);
    expect(store.listSessionsFor('owner/name', 21).map((link) => link.session_id)).toEqual(['s-1']);
    expect(store.listEvents('owner/name', 21).map((event) => [event.from_state, event.to_state])).toEqual([
      [null, 'open'],
    ]);
  });

  it('writes nothing for a ref with no PR (none never lands in the tables)', async () => {
    const repo = makeRepo('https://github.com/owner/name.git');
    const sha = checkpoint(repo, 's-1', 1);
    const store = openStore();
    const runner = stubRunner((args) => {
      if (args[0] === 'pr' && args[1] === 'list') return [];
      throw new Error(`unexpected gh args: ${args.join(' ')}`);
    }).runner;
    const sync = createIntegrationSync({
      store,
      getSessionWorkingDirectory: async () => repo,
      observeDeps: { runner },
    });

    const result = await sync.syncSession('s-1');
    expect(result.status).toBe('synced');
    expect(result.written).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(store.listForSession('s-1')).toEqual([]);
    expect(store.listEvents('owner/name', 1)).toEqual([]);
  });

  it('reports observation_failed on gh failure and leaves the previous row untouched', async () => {
    const repo = makeRepo('https://github.com/owner/name.git');
    const sha = checkpoint(repo, 's-1', 1);
    const store = openStore();

    // A previous good observation exists; a failed sync must not clobber it.
    store.upsertObservation({ repo: 'owner/name', prNumber: 21, state: 'checks_passing', observedAt: 100 });
    store.linkSession({ repo: 'owner/name', prNumber: 21, sessionId: 's-1', at: 100 });

    const sync = createIntegrationSync({
      store,
      getSessionWorkingDirectory: async () => repo,
      observeDeps: {
        runner: failingRunner(new GhError('gh_not_found', 'GitHub CLI (gh) was not found.')),
      },
    });

    const result = await sync.syncSession('s-1');
    expect(result.status).toBe('observation_failed');
    expect(result.written).toEqual([]);
    expect(result.failed).toEqual([{ ref: sha, reason: 'GitHub CLI (gh) was not found.' }]);

    const row = store.get('owner/name', 21);
    expect(row?.observed_state).toBe('checks_passing');
    expect(row?.observed_at).toBe(100);
  });

  it('reports partial success honestly when some PRs fail and others land', async () => {
    const repo = makeRepo('https://github.com/owner/name.git');
    const firstSha = checkpoint(repo, 's-1', 1);
    // A second, distinct commit: two checkpoints must not collapse onto one sha.
    fs.writeFileSync(path.join(repo, 'SECOND.md'), '# second\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'second');
    const secondSha = checkpoint(repo, 's-1', 2);
    const store = openStore();
    const runner = stubRunner((args) => {
      if (args[0] === 'pr' && args[1] === 'list') {
        return [
          { number: 21, headRefName: 'a', headRefOid: firstSha, state: 'OPEN' },
          { number: 22, headRefName: 'b', headRefOid: secondSha, state: 'OPEN' },
        ];
      }
      if (args[0] === 'pr' && args[1] === 'view' && args[2] === '21') {
        return {
          state: 'MERGED',
          isDraft: false,
          headRefOid: firstSha,
          baseRefName: 'main',
          url: 'https://github.com/owner/name/pull/21',
          reviewDecision: null,
          statusCheckRollup: [],
        };
      }
      throw new GhError('timeout', 'GitHub CLI did not answer.');
    }).runner;
    const sync = createIntegrationSync({
      store,
      getSessionWorkingDirectory: async () => repo,
      observeDeps: { runner },
    });

    const result = await sync.syncSession('s-1');
    expect(result.status).toBe('observation_failed');
    expect(result.written).toEqual([{ repo: 'owner/name', prNumber: 21 }]);
    expect(result.failed).toEqual([{ ref: secondSha, reason: 'GitHub CLI did not answer.' }]);
    expect(store.get('owner/name', 21)?.observed_state).toBe('merged');
    expect(store.get('owner/name', 22)).toBeNull();
  });
});
