/**
 * Plan 621, scenarios 1 and 2 — identity survives a restart, and ownership is
 * exclusive.
 *
 * ## What these two scenarios are about
 *
 * Scenario 1: a session's checkout and its owner must be the SAME after the
 * Host restarts. The authority is the checkout's own owner file plus git's
 * registry — neither lives in the Host's database, so a Host that keeps a
 * mapping in memory would answer correctly until it restarted, and then
 * answer differently. The test restarts a REAL Host over the same data root
 * and asks again.
 *
 * Scenario 2: two sessions must not share one checkout. The second one has to
 * be refused with a typed reason, and no second owner may appear.
 *
 * ## Why the Host is started for real
 *
 * The claim under test is "the answer survives a restart". A Host that was
 * never really stopped cannot answer that. So the test opens a real Host,
 * creates a real checkout with a real owner file, closes the Host, opens a
 * second one over the same data root, and asks again.
 *
 * The session row is written through the same `duya-core.db` the Host serves,
 * because a session's working directory is what maps it to a checkout — the
 * Host resolves the checkout by asking git for the toplevel of that directory
 * and keeping it only when git still lists it as a registered linked worktree.
 *
 * ## Two answers that must not be confused
 *
 *   - a session in the user's OWN checkout resolves to `null`: it is not a
 *     managed checkout, so there is nothing to own;
 *   - a session inside a managed checkout owned by ANOTHER session resolves to
 *     that checkout with `isOwner: false` — read-only by construction (§4.5).
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CoreDataHost } from '@duya/data';
import { startLocalHost, type LocalHostHandle } from '../src/local-host.js';
import { createCheckoutProvider } from '../src/workspace/index.js';

const TOKEN = 'checkout-identity-test-token';
const roots: string[] = [];
const hosts: LocalHostHandle[] = [];
const dataHosts: CoreDataHost[] = [];
const restores: (() => void)[] = [];

afterEach(async () => {
  for (const restore of restores.splice(0)) restore();
  for (const host of hosts.splice(0)) await host.close();
  for (const dataHost of dataHosts.splice(0)) dataHost.close();
  for (const root of roots.splice(0)) {
    // The checkout is a git worktree, and Windows refuses to unlink a
    // directory git still holds. `maxRetries` waits that out; without it the
    // TEARDOWN fails and the test reads as "the contract broke" when nothing
    // broke.
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return await fs.realpath(dir);
}

async function makeRepo(): Promise<string> {
  const repo = await tempDir('duya-identity-repo-');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@duya.local');
  git(repo, 'config', 'user.name', 'duya test');
  await fs.writeFile(path.join(repo, 'README.md'), '# fixture\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'initial');
  return repo;
}

/**
 * Managed checkouts live under the app data root. Point that at a throwaway
 * directory so the test never creates a worktree inside the developer's real
 * `~/.duya`.
 */
async function isolateCheckoutStorage(): Promise<void> {
  const previous = process.env.DUYA_APP_DATA_PATH;
  const root = await tempDir('duya-identity-checkouts-');
  process.env.DUYA_APP_DATA_PATH = root;
  restores.push(() => {
    if (previous === undefined) delete process.env.DUYA_APP_DATA_PATH;
    else process.env.DUYA_APP_DATA_PATH = previous;
  });
}

/**
 * Open the same core database the Host serves, so a session written here is a
 * session the Host's resolver will find.
 */
function openCoreHost(dataRoot: string): CoreDataHost {
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
  return dataHost;
}

/** Open a Host over the given data root, like the product does. */
async function openHost(dataRoot: string): Promise<LocalHostHandle> {
  const host = await startLocalHost({ dataRoot, port: 0, token: TOKEN, ephemeral: true });
  hosts.push(host);
  return host;
}

function headers(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
}

interface ObservedCheckout {
  root: string;
  registered: boolean;
  ownerSessionId: string | null;
}

interface SessionCheckoutView {
  checkout: ObservedCheckout | null;
  isOwner: boolean;
}

/**
 * The route answers `{ checkout: <view> }` and the view itself carries a
 * `checkout` field — "not in a checkout" is `null` there, not an error.
 */
async function observeForSession(host: LocalHostHandle, sessionId: string): Promise<SessionCheckoutView> {
  const response = await fetch(`${host.origin}/v1/checkouts?sessionId=${encodeURIComponent(sessionId)}`, {
    headers: headers(),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    checkout: { sessionId: string; checkout: ObservedCheckout | null; isOwner: boolean };
  };
  expect(body.checkout.sessionId).toBe(sessionId);
  return { checkout: body.checkout.checkout, isOwner: body.checkout.isOwner };
}

describe('plan 621 scenario 1: the same checkout and the same owner after a restart', () => {
  it('answers the same path and the same owner after the Host restarts', async () => {
    await isolateCheckoutStorage();
    const dataRoot = await tempDir('duya-identity-data-');
    const repo = await makeRepo();

    // A real managed checkout, owned by the session, in the repository the
    // session works in.
    const provider = createCheckoutProvider();
    const created = await provider.create({
      sourceCwd: repo,
      ownerSessionId: 'session-1',
      label: 'restart case',
    });

    // The session's working directory points INTO the checkout — that is how
    // an isolated sub-agent runs, and it is what the resolver maps back to the
    // checkout root.
    const dataHost = openCoreHost(dataRoot);
    dataHost.stores.sessions.create({
      id: 'session-1',
      workingDirectory: created.cwd,
      status: 'active',
    });

    const first = await openHost(dataRoot);
    const before = await observeForSession(first, 'session-1');
    expect(before.checkout).not.toBeNull();
    expect(before.checkout?.root).toBe(created.root);
    expect(before.checkout?.registered).toBe(true);
    expect(before.checkout?.ownerSessionId).toBe('session-1');
    expect(before.isOwner).toBe(true);

    // Restart the Host over the same data root. The checkout's owner file
    // and git's registry are what must carry the answer across.
    await first.close();
    hosts.splice(hosts.indexOf(first), 1);
    // The first Host is really gone. A "restart" that kept serving on the
    // same process would prove nothing about where the answer comes from.
    await expect(
      fetch(`${first.origin}/v1/checkouts?sessionId=session-1`, { headers: headers() }),
    ).rejects.toThrow();
    const second = await openHost(dataRoot);

    const after = await observeForSession(second, 'session-1');
    expect(after.checkout).not.toBeNull();
    // The same path — not merely "a checkout".
    expect(after.checkout?.root).toBe(before.checkout?.root);
    // The same owner — the identity did not change with the process.
    expect(after.checkout?.ownerSessionId).toBe('session-1');
    expect(after.isOwner).toBe(true);
  }, 60_000);

  it('reports no checkout for a session that was never in one', async () => {
    await isolateCheckoutStorage();
    const dataRoot = await tempDir('duya-identity-plain-');
    const repo = await makeRepo();

    const dataHost = openCoreHost(dataRoot);
    dataHost.stores.sessions.create({
      id: 'plain-session',
      workingDirectory: repo,
      status: 'active',
    });

    const host = await openHost(dataRoot);
    const view = await observeForSession(host, 'plain-session');
    // "Not in a checkout" is an answer, not an error — and it is a different
    // answer from "this Host cannot observe checkouts". The user's own
    // checkout is not a managed one, so there is no owner to report.
    expect(view.checkout).toBeNull();
    expect(view.isOwner).toBe(false);
  }, 60_000);
});

describe('plan 621 scenario 2: two sessions cannot share one checkout', () => {
  it('refuses the second owner with a typed reason and leaves the first owner in place', async () => {
    await isolateCheckoutStorage();
    const dataRoot = await tempDir('duya-identity-contention-');
    const repo = await makeRepo();

    const provider = createCheckoutProvider();
    const created = await provider.create({
      sourceCwd: repo,
      ownerSessionId: 'session-a',
      label: 'contention case',
    });

    // The second session must be refused, and the refusal must name the
    // owner that holds it.
    await expect(provider.bind(created.root, 'session-b', 'fresh')).rejects.toMatchObject({
      code: 'owner_conflict',
    });

    // The first owner is still the only owner. A failed takeover must not
    // have produced a second owner file, nor replaced the first.
    const observed = await provider.observe(created.root);
    expect(observed.owner).toEqual({ sessionId: 'session-a', boundAt: expect.any(Number) });

    const dataHost = openCoreHost(dataRoot);
    for (const id of ['session-a', 'session-b']) {
      dataHost.stores.sessions.create({ id, workingDirectory: created.cwd, status: 'active' });
    }
    const host = await openHost(dataRoot);

    // And the second session is read-only for it — the API says so without
    // granting anything.
    const secondView = await observeForSession(host, 'session-b');
    expect(secondView.checkout?.ownerSessionId).toBe('session-a');
    expect(secondView.isOwner).toBe(false);

    // The first session still owns it.
    const firstView = await observeForSession(host, 'session-a');
    expect(firstView.checkout?.ownerSessionId).toBe('session-a');
    expect(firstView.isOwner).toBe(true);
  }, 60_000);
});
