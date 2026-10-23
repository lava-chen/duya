/**
 * Plan 621 — the Host client's checkout and integration methods.
 *
 * These five methods are the ONLY way a surface reaches the Host's checkout
 * and integration namespaces. Desktop, TUI and Web all go through them, so a
 * shape mistake here is a shape mistake on every surface at once.
 *
 * The test runs against a REAL Host over real HTTP: the point is that the
 * client reads the Host's envelopes correctly, which a fake would not prove.
 *
 * The Host's envelopes are nested one level deeper than the payloads they
 * carry — `{ checkout: { sessionId, checkout, isOwner } }` for a session view,
 * `{ result: … }` for a reclaim — and reading the wrong level is exactly the
 * mistake that would make every surface render "no checkout" for a session
 * that has one. Each case below pins the level it reads.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionId } from '@duya/agent-protocol';
import { startLocalHost, type LocalHostHandle } from '../src/local-host.js';
import { HostSessionHttpClient } from '../src/http-client.js';

const TOKEN = 'checkout-client-test-token';
const roots: string[] = [];
const hosts: LocalHostHandle[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function openClient(): Promise<HostSessionHttpClient> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-checkout-client-'));
  roots.push(dataRoot);
  const host = await startLocalHost({ dataRoot, port: 0, token: TOKEN, ephemeral: true });
  hosts.push(host);
  return new HostSessionHttpClient(host.origin, TOKEN);
}

describe('the checkout methods over real HTTP', () => {
  it('reads the session view out of the envelope', async () => {
    const client = await openClient();

    const view = await client.observeCheckoutForSession('s-1' as SessionId);

    // The envelope is `{ checkout: { sessionId, checkout, isOwner } }`. A
    // client that read one level too shallow would hand back the inner view
    // and every surface would render "no checkout".
    expect(view.sessionId).toBe('s-1');
    expect(view.checkout).toBeNull();
    expect(view.isOwner).toBe(false);
  });

  it('observes a path that is not a checkout as unregistered', async () => {
    const client = await openClient();

    const observed = await client.observeCheckoutByRoot(path.join(os.tmpdir(), 'duya-not-a-checkout'));

    expect(observed.registered).toBe(false);
    expect(observed.reclaimable).toBe(false);
    expect(observed.retainReason).toBe('not_registered');
  });

  it('answers a reclaim request with the refusal, not an error', async () => {
    const client = await openClient();

    const result = await client.requestCheckoutReclaim(path.join(os.tmpdir(), 'duya-not-a-checkout'));

    // A refusal is the answer to "may this be deleted". Only a transport
    // failure rejects, so this must resolve.
    expect(result).toEqual({ removed: false, reason: 'not_registered' });
  });
});

describe('the integration methods over real HTTP', () => {
  it('reads an empty projection for an unknown session', async () => {
    const client = await openClient();

    const records = await client.observeIntegrationsForSession('s-1' as SessionId);

    expect(records).toEqual([]);
  });

  it('reports a session with nothing to sync as its own verdict', async () => {
    const client = await openClient();

    const result = await client.syncIntegrations('s-1' as SessionId);

    // The sync route answers with the result ITSELF, not wrapped in an
    // envelope — so the client must not unwrap it.
    expect(result).toEqual({ status: 'no_checkpoints', written: [], failed: [] });
  });
});
