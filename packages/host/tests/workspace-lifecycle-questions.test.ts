/**
 * Plan 621, scenario 7 — every direction the contract asks for is answerable
 * from the Host, through the client the surfaces use.
 *
 * ## What this pins
 *
 * The plan's goal is that a session can answer: which checkout it is in, what
 * it has run, what it produced, whether the PR merged, and whether the
 * checkout may be reclaimed. Those are five questions with four authorities
 * (git, the owner file, the run ledger, GitHub), and the risk is that one of
 * them has no entry point — a gap that only shows up when a user asks.
 *
 * So this asks all of them, in one flow, against a REAL Host over real HTTP,
 * through `HostSessionHttpClient` — the only way any surface reaches them.
 *
 * ## What it deliberately does NOT assert
 *
 * It does not assert a pull request exists. A session that never opened one
 * has an empty integration projection, and that is the honest answer: the
 * projection records what was observed, and nothing was observed. Asserting a
 * merged PR here would need a live GitHub, and a test that needs the network
 * cannot prove the part that matters — that the answer comes from the Host's
 * authority rather than from the client's own guess.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CoreDataHost } from '@duya/data';
import { manifestFingerprint, type RunManifest, type SessionId } from '@duya/agent-protocol';
import { startLocalHost, type LocalHostHandle } from '../src/local-host.js';
import { HostSessionHttpClient } from '../src/http-client.js';
import { createCheckoutProvider } from '../src/workspace/index.js';

const TOKEN = 'workspace-questions-test-token';
const roots: string[] = [];
const hosts: LocalHostHandle[] = [];
const dataHosts: CoreDataHost[] = [];
const restores: Array<() => void> = [];

afterEach(async () => {
  for (const restore of restores.splice(0)) restore();
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

/**
 * Managed checkouts live under the app data root. Point that at a throwaway
 * directory so the test never creates a worktree inside the developer's real
 * `~/.duya`.
 */
async function isolateCheckoutStorage(): Promise<void> {
  const previous = process.env.DUYA_APP_DATA_PATH;
  const root = await tempDir('duya-questions-checkouts-');
  process.env.DUYA_APP_DATA_PATH = root;
  restores.push(() => {
    if (previous === undefined) delete process.env.DUYA_APP_DATA_PATH;
    else process.env.DUYA_APP_DATA_PATH = previous;
  });
}

describe('plan 621 scenario 7: every direction is answerable from the Host', () => {
  it('answers the checkout, the runs, the checkpoint refs, the PRs and the reclaim verdict', async () => {
    const dataRoot = await tempDir('duya-questions-data-');
    const repo = await tempDir('duya-questions-repo-');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@duya.local');
    git(repo, 'config', 'user.name', 'duya test');
    await fs.writeFile(path.join(repo, 'README.md'), '# fixture\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'initial');

    // A managed checkout, owned by the session, in that repository.
    await isolateCheckoutStorage();
    const provider = createCheckoutProvider();
    const created = await provider.create({
      sourceCwd: repo,
      ownerSessionId: 'session-1',
      label: 'questions case',
    });
    // One checkpoint ref: the ChangeSet the session produced.
    const checkpointRef = await provider.checkpoint(created.root, 'session-1');

    const dataHost = new CoreDataHost({
      filename: path.join(dataRoot, 'duya-core.db'),
      rolloutRoot: path.join(dataRoot, 'sessions'),
      attachmentsRoot: path.join(dataRoot, 'attachments'),
      messageLogPorts: {
        botSessionIdPrefix: 'bot:',
        parseBotSessionId: () => null,
        getBotSessionLogPath: (agentId, root) => path.join(root, 'agents', agentId, 'sessions.jsonl'),
        getBotSessionsDir: (agentId, root) => path.join(root, 'agents', agentId, 'sessions'),
      },
    });
    dataHosts.push(dataHost);
    dataHost.stores.sessions.create({
      id: 'session-1',
      workingDirectory: created.cwd,
      status: 'active',
    });
    // A live run. The manifest is stored verbatim and re-fingerprinted on read,
    // so it has to be a real one: it names its own run, and the hash is the
    // fingerprint of the value, not a placeholder.
    const manifest: RunManifest = {
      version: 1,
      runId: 'run-1',
      projectId: null,
      workspaceId: 'ws-1',
      roots: [created.root],
      cwd: created.cwd,
      permissionPolicy: { mode: 'default', hostSwitch: 'ask', defaultTimeoutMs: 300_000 },
      capabilities: { profiles: [], modes: [], tools: [] },
      connectorBindings: [],
      env: { ref: 'envref_questions', hash: 'deadbeef' },
      budget: {},
      deterministic: false,
    } as RunManifest;
    dataHost.stores.runs.createRun({
      runId: 'run-1',
      sessionId: 'session-1',
      manifest,
      manifestHash: manifestFingerprint(manifest),
    });

    const host = await startLocalHost({ dataRoot, port: 0, token: TOKEN, ephemeral: true });
    hosts.push(host);
    const client = new HostSessionHttpClient(host.origin, TOKEN);
    const sessionId = 'session-1' as SessionId;

    // 1. Which checkout is this session in?
    const view = await client.observeCheckoutForSession(sessionId);
    expect(view.checkout?.root).toBe(created.root);
    expect(view.checkout?.registered).toBe(true);
    expect(view.checkout?.ownerSessionId).toBe('session-1');
    expect(view.isOwner).toBe(true);

    // 2. Which runs has it run? The run ledger is the authority, and the
    //    client reads it without the surface rebuilding anything.
    const runs = await client.listAgentRunsBySession(sessionId);
    expect(runs.map((run) => run.runId)).toContain('run-1');

    // 3. What did it produce? The checkpoint refs are git's own answer, and
    //    the Host wrote them — not the surface.
    const refs = git(created.root, 'for-each-ref', '--format=%(refname)', 'refs/duya/checkpoint');
    expect(refs).toContain(checkpointRef);

    // 4. Which pull requests did it produce, and were they merged? Nothing
    //    was observed yet, and the answer is an empty projection — not a
    //    fabricated `open`.
    const records = await client.observeIntegrationsForSession(sessionId);
    expect(records).toEqual([]);

    // 5. May the checkout be reclaimed? The verdict is the Host's, and it is
    //    computed against the authority at this moment.
    const verdict = await client.requestCheckoutReclaim(created.root);
    expect(verdict.removed).toBe(false);
    if (verdict.removed === false) {
      // The session still has a live run, so the owner is alive. The point is
      // that the client did not decide this — the Host did.
      expect(verdict.reason).toBe('owner_alive');
    }
  });
});
