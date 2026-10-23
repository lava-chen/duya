/**
 * Plan 621 — HTTP wiring for the two new route families, against the REAL
 * composition (`startLocalHost`): the checkout provider is wired, so a session
 * that is not inside a checkout observes as `checkout: null` — which is a
 * different answer from "this Host cannot observe checkouts". The named-404
 * shell for an uncomposed Host is covered by the route unit in
 * `http-server.ts`; these tests pin what a composed Host actually answers.
 *
 * The successful checkout bodies are covered by `checkout-api.test.ts` against
 * a fake port; here the real provider runs against paths that are not
 * checkouts, which is the refusal side of the same contract.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startLocalHost, type LocalHostHandle } from '../src/local-host.js';

const TOKEN = 'checkout-integration-http-test-token';
const roots: string[] = [];
const hosts: LocalHostHandle[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function open(): Promise<LocalHostHandle> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-checkout-http-'));
  roots.push(dataRoot);
  const host = await startLocalHost({ dataRoot, port: 0, token: TOKEN, ephemeral: true });
  hosts.push(host);
  return host;
}

function headers(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
}

describe('checkout routes over the real composition', () => {
  it('answers "not in a checkout" for a session that has none', async () => {
    const host = await open();

    const observed = await fetch(`${host.origin}/v1/checkouts?sessionId=s-1`, { headers: headers() });
    expect(observed.status).toBe(200);
    expect(await observed.json()).toEqual({
      checkout: { sessionId: 's-1', checkout: null, isOwner: false },
    });
  });

  it('observes a path that is not a checkout as unregistered and not reclaimable', async () => {
    const host = await open();

    const byRoot = await fetch(`${host.origin}/v1/checkouts?root=/tmp/duya-not-a-checkout`, {
      headers: headers(),
    });
    expect(byRoot.status).toBe(200);
    const body = (await byRoot.json()) as { checkout: { registered: boolean; reclaimable: boolean; retainReason: string | null } };
    expect(body.checkout.registered).toBe(false);
    expect(body.checkout.reclaimable).toBe(false);
    expect(body.checkout.retainReason).toBe('not_registered');
  });

  it('answers a reclaim request with the refusal, not an error', async () => {
    const host = await open();
    const reclaimed = await fetch(`${host.origin}/v1/checkouts/reclaim`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ root: '/tmp/duya-not-a-checkout' }),
    });
    expect(reclaimed.status).toBe(200);
    expect(await reclaimed.json()).toEqual({ result: { removed: false, reason: 'not_registered' } });
  });

  it('rejects the wrong method once the provider is composed', async () => {
    const host = await open();
    const response = await fetch(`${host.origin}/v1/checkouts?sessionId=s-1`, {
      method: 'DELETE',
      headers: headers(),
    });
    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({ error: { code: 'method_not_allowed' } });
  });
});

describe('integration routes', () => {
  it('answers an empty projection for an unlinked session', async () => {
    const host = await open();
    const response = await fetch(`${host.origin}/v1/integrations?sessionId=s-1`, { headers: headers() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ records: [] });
  });

  it('requires a sessionId and rejects other methods', async () => {
    const host = await open();

    const missing = await fetch(`${host.origin}/v1/integrations`, { headers: headers() });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: { code: 'invalid_integration_query' } });

    const wrongMethod = await fetch(`${host.origin}/v1/integrations?sessionId=s-1`, {
      method: 'DELETE',
      headers: headers(),
    });
    expect(wrongMethod.status).toBe(405);
    expect(await wrongMethod.json()).toEqual({ error: { code: 'method_not_allowed' } });
  });

  it('links a session idempotently and validates the body', async () => {
    const host = await open();
    const body = { repo: 'duya/duya', prNumber: 21, sessionId: 's-1' };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(`${host.origin}/v1/integrations/link`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ linked: true });
    }

    for (const invalid of [
      { repo: '', prNumber: 21, sessionId: 's-1' },
      { repo: 'duya/duya', prNumber: 0, sessionId: 's-1' },
      { repo: 'duya/duya', prNumber: 21, sessionId: '' },
    ]) {
      const response = await fetch(`${host.origin}/v1/integrations/link`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(invalid),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: { code: 'invalid_integration_link' } });
    }

    // A link is an association, not an observation: nothing is projected until
    // a PR state has actually been read.
    const projected = await fetch(`${host.origin}/v1/integrations?sessionId=s-1`, { headers: headers() });
    expect(await projected.json()).toEqual({ records: [] });
  });
});
