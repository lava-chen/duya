/**
 * Plan 621, scenario 7 — the surfaces reach ONE Host, and they get one answer.
 *
 * ## What this pins
 *
 * Scenario 7 asks that a Task / Session / Run / Checkout / PR be queryable from
 * any surface. The risk it names is not a wrong answer but a SECOND answer:
 * each surface re-deriving the session -> checkout -> pull-request mapping
 * instead of asking the Host, so that two surfaces disagree and nobody can say
 * which one is right.
 *
 * So this drives two transports against ONE real Host and holds them to the
 * same answer:
 *
 *   - the TUI transport, which is the typed `HostSessionHttpClient` the slash
 *     commands already hold (`TuiSlashContext.client`);
 *   - the Web transport, which is the real BFF over the real Host, reached
 *     through the real browser adapter.
 *
 * The checkout is a genuinely registered linked worktree with a tracked edit,
 * because a plain directory would answer `not_registered` and prove nothing
 * about the mapping: the interesting answer is the one that has to be carried
 * intact — `worktree: 'dirty_tracked'`, `reclaimable: false`, and the reason
 * the Host refuses to delete it.
 *
 * ## What it deliberately does NOT cover
 *
 * The Desktop reaches the Host IN PROCESS, over IPC, not over HTTP, so it
 * cannot be driven from here. Its transport is covered by the Desktop's own
 * test (`apps/desktop/src/main/cli/__tests__/`), which asserts the same Host
 * APIs answer the same questions behind the IPC boundary. This file covers
 * the two HTTP-shaped transports; the Desktop's file covers the third.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostCheckoutObserved } from '@duya/agent-protocol';
import { HostSessionHttpClient } from '@duya/host/http-client';
import { startLocalHost, type LocalHostHandle } from '@duya/host/local-host';
import { createWebBff, type WebBffHandle } from '../../src/server/web-bff.js';
import { createWebWorkspaceLifecycle } from '../../src/client/ui-services-adapter.js';
import type { FetchLike } from '../../src/client/api.js';

const HOST_TOKEN = 'workspace-lifecycle-connectivity-token';
const roots: string[] = [];
const hosts: LocalHostHandle[] = [];
const bffs: WebBffHandle[] = [];

afterEach(async () => {
  for (const bff of bffs.splice(0)) await bff.close();
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return await fs.realpath(dir);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * A registered linked worktree with a tracked edit.
 *
 * Registration is what makes it a checkout at all: a linked worktree is a
 * directory git still lists, with a `.git` FILE and a different common dir.
 * The tracked edit is what makes the Host's answer worth comparing — it has to
 * carry the retain reason, not just a boolean.
 */
async function dirtyCheckout(): Promise<string> {
  const repo = await tempDir('duya-connectivity-repo-');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@duya.local');
  git(repo, 'config', 'user.name', 'duya test');
  await fs.writeFile(path.join(repo, 'README.md'), '# fixture\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'initial');

  const parent = await tempDir('duya-connectivity-worktrees-');
  const root = path.join(parent, 'task-1');
  git(repo, 'worktree', 'add', '--detach', root);

  await fs.writeFile(path.join(root, 'README.md'), '# fixture\nedited\n');
  git(root, 'add', 'README.md');
  return root;
}

async function startHost(): Promise<LocalHostHandle> {
  const dataRoot = await tempDir('duya-connectivity-data-');
  const host = await startLocalHost({
    dataRoot,
    rolloutRoot: path.join(dataRoot, 'sessions'),
    attachmentsRoot: path.join(dataRoot, 'attachments'),
    runtimeFilePath: path.join(dataRoot, 'runtime', 'host-api.json'),
    port: 0,
    token: HOST_TOKEN,
    ephemeral: true,
  });
  hosts.push(host);
  return host;
}

/**
 * The browser's transport, in Node.
 *
 * A browser sends `Origin` on its own for anything that mutates, and the BFF
 * gates mutations on it, so the fake browser has to say it too. The URL is
 * resolved against the BFF origin because the adapter asks for same-origin
 * relative paths.
 */
function browserFetch(origin: string): FetchLike {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('origin', origin);
    return await fetch(new URL(input, origin), { ...init, headers });
  };
}

/**
 * The facts of an observation, without the moment it was taken.
 *
 * `observedAt` is the time of the reading, and the Host re-reads on every
 * request, so two readings of one unchanged state carry two timestamps. What
 * has to be identical is the state itself.
 */
function withoutObservedAt(observed: HostCheckoutObserved): Omit<HostCheckoutObserved, 'observedAt'> {
  const { observedAt: _observedAt, ...facts } = observed;
  return facts;
}

describe('plan 621 scenario 7: every surface reaches the same Host', () => {
  it('gives the TUI transport and the Web transport the same answer', async () => {
    const root = await dirtyCheckout();
    const host = await startHost();

    // The TUI transport: the typed client the slash commands already hold.
    const tui = new HostSessionHttpClient(host.origin, HOST_TOKEN);

    // The Web transport: the real BFF over the real Host, through the real
    // browser adapter.
    const bff = await createWebBff({ hostOrigin: host.origin, hostToken: HOST_TOKEN });
    bffs.push(bff);
    const web = createWebWorkspaceLifecycle({ fetchImpl: browserFetch(bff.origin) });
    const webCheckouts = web.checkouts;
    if (webCheckouts === undefined) {
      throw new Error('the Web adapter must provide the checkout namespace');
    }

    const viaTui = await tui.observeCheckoutByRoot(root);
    const viaWeb = await webCheckouts.observeCheckout(root);

    // One Host, one answer. A transport that re-derived the mapping would
    // differ here, and the difference would be the whole bug.
    //
    // `observedAt` is excluded on purpose: it is "as of when", and two
    // separate observations of one unchanged state have two timestamps. The
    // FACTS are what must match — the worktree state, the verdict, the reason.
    expect(withoutObservedAt(viaWeb)).toEqual(withoutObservedAt(viaTui));
    expect(typeof viaTui.observedAt).toBe('number');
    expect(typeof viaWeb.observedAt).toBe('number');

    // And the answer is a real one: a registered checkout that is dirty, and
    // therefore not reclaimable, with the reason that says why.
    expect(viaTui.registered).toBe(true);
    expect(viaTui.worktree).toBe('dirty_tracked');
    expect(viaTui.reclaimable).toBe(false);
    expect(viaTui.retainReason).toBe('dirty_tracked');
  }, 60_000);

  it('gives both transports the same reclaim verdict, and deletes nothing', async () => {
    const root = await dirtyCheckout();
    const host = await startHost();

    const tui = new HostSessionHttpClient(host.origin, HOST_TOKEN);
    const bff = await createWebBff({ hostOrigin: host.origin, hostToken: HOST_TOKEN });
    bffs.push(bff);
    const web = createWebWorkspaceLifecycle({ fetchImpl: browserFetch(bff.origin) });
    const webCheckouts = web.checkouts;
    if (webCheckouts === undefined) {
      throw new Error('the Web adapter must provide the checkout namespace');
    }

    const viaTui = await tui.requestCheckoutReclaim(root);
    const viaWeb = await webCheckouts.requestReclaim(root);

    // The refusal is the Host's answer, and it travels as an answer.
    expect(viaWeb).toEqual(viaTui);
    expect(viaTui).toEqual({ removed: false, reason: 'dirty_tracked' });

    // A refusal deleted nothing. This is the fail-closed half of the contract:
    // the tree was dirty, so the checkout is still there.
    expect((await fs.stat(root)).isDirectory()).toBe(true);
  }, 60_000);
});
