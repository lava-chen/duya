/**
 * Plan 621 — the aliveness wiring, against the REAL composition.
 *
 * `createCheckoutProvider` ships two fail-closed ports: "the owner is alive"
 * and "the directory is in use" both default to the conservative answer
 * (`true` / `false` respectively). That default is correct for a Host that
 * cannot see the run ledger, but it means an owned checkout can never be
 * reclaimed: every attempt is refused with `owner_alive`, forever.
 *
 * This file pins the wiring that fixes it: the ports read the run ledger
 * (`workspace/aliveness.ts`), so a session with a live `running` run keeps its
 * checkout and a session whose runs are all terminal no longer does.
 *
 * The whole point is the DIFFERENCE between the two states, so the case is
 * written as one flow that flips the same checkout from refused to reclaimable
 * rather than as two unrelated assertions.
 *
 * The checkout is real (a linked worktree with an owner file) because the
 * verdict under test is produced by git, not by a stub. The run ledger is real
 * too: the external `CoreDataHost` opens the same `duya-core.db` the Host
 * serves, which is exactly how the product reads the ledger.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CoreDataHost } from '@duya/data';
import { startLocalHost, type LocalHostHandle } from '../src/local-host.js';
import { createCheckoutProvider } from '../src/workspace/index.js';

const TOKEN = 'checkout-aliveness-wiring-test-token';
const roots: string[] = [];
const hosts: LocalHostHandle[] = [];
const dataHosts: CoreDataHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const dataHost of dataHosts.splice(0)) dataHost.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return await fs.realpath(dir);
}

/** A repository with one commit, and one linked worktree created from it. */
async function makeRepoWithCheckout(): Promise<{ repo: string; checkout: string }> {
  const repo = await tempDir('duya-aliveness-repo-');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@duya.local');
  git(repo, 'config', 'user.name', 'duya test');
  await fs.writeFile(path.join(repo, 'README.md'), '# fixture\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'initial');

  const checkout = path.join(repo, '.claude-worktrees', 'wt-1');
  git(repo, 'worktree', 'add', '--detach', checkout, 'HEAD');
  return { repo, checkout };
}

/**
 * Open the same core database the Host serves, so a run written here is a run
 * the Host's aliveness ports will read.
 */
function openCoreHost(dataRoot: string): CoreDataHost {
  const dataHost = new CoreDataHost({
    filename: path.join(dataRoot, 'duya-core.db'),
    rolloutRoot: path.join(dataRoot, 'sessions'),
    attachmentsRoot: path.join(dataRoot, 'attachments'),
    messageLogPorts: {
      botSessionIdPrefix: 'bot:',
      parseBotSessionId: () => null,
      getBotSessionLogPath: (agentId, dataRoot) => path.join(dataRoot, 'agents', agentId, 'sessions.jsonl'),
      getBotSessionsDir: (agentId, dataRoot) => path.join(dataRoot, 'agents', agentId, 'sessions'),
    },
  });
  dataHosts.push(dataHost);
  return dataHost;
}

function headers(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
}

async function reclaim(
  host: LocalHostHandle,
  root: string,
): Promise<{ status: number; body: { result?: { removed: boolean; reason?: string } } }> {
  const response = await fetch(`${host.origin}/v1/checkouts/reclaim`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ root }),
  });
  return { status: response.status, body: (await response.json()) as { result?: { removed: boolean; reason?: string } } };
}

describe('the aliveness ports are wired to the run ledger', () => {
  it('refuses an owned checkout while its owner has a live run, and releases it once the run is terminal', async () => {
    const dataRoot = await tempDir('duya-aliveness-data-');
    const { repo, checkout } = await makeRepoWithCheckout();

    const dataHost = openCoreHost(dataRoot);
    dataHost.stores.sessions.create({
      id: 'session-owner',
      workingDirectory: repo,
      status: 'active',
    });

    // The checkout is born owned by that session — the owner file is the
    // authority, so the reclaim route has something to reason about.
    const provider = createCheckoutProvider({
      isSessionAlive: async () => false,
      cwdInUse: async () => false,
    });
    await provider.bind(checkout, 'session-owner', 'fresh');

    const host = await startLocalHost({ dataRoot, port: 0, token: TOKEN, ephemeral: true });
    hosts.push(host);

    // A live run keeps the owner alive. The default port would ALSO refuse
    // here, so this state alone does not prove the wiring — the terminal
    // state below is the one that does.
    dataHost.stores.runs.createRun({
      runId: 'run-1',
      sessionId: 'session-owner',
      manifest: { goal: 'x' },
      manifestHash: 'hash-1',
    });

    const whileAlive = await reclaim(host, checkout);
    expect(whileAlive.status).toBe(200);
    expect(whileAlive.body.result?.removed).toBe(false);
    expect(whileAlive.body.result?.reason).toBe('owner_alive');

    // The run reaches its terminal state. The owner is now provably dead, so
    // the ONLY reason the reclaim can succeed is that the port reads the
    // ledger — the default port would still answer `owner_alive`.
    dataHost.stores.runs.completeRun('run-1', { status: 'completed' });

    const afterTerminal = await reclaim(host, checkout);
    expect(afterTerminal.status).toBe(200);
    expect(afterTerminal.body.result?.removed).toBe(true);
  });
});
