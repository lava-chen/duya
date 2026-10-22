/**
 * Plan 621 slice B — HTTP wiring for the two new route families.
 *
 * These tests pin what a real `startLocalHost` composition answers today:
 * `/v1/integrations` is wired to the projection store, and `/v1/checkouts`
 * answers a named 404 because no checkout provider exists in this tree until
 * slice A lands. The point is that "this Host cannot observe checkouts" never
 * reads like "this session has no checkout".
 *
 * The successful checkout bodies are covered by `checkout-api.test.ts` against
 * a fake port; the route shell itself cannot be exercised without A's provider.
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

describe('checkout routes without a provider', () => {
  it('answers a named 404 for both observation and reclaim', async () => {
    const host = await open();

    const observed = await fetch(`${host.origin}/v1/checkouts?sessionId=s-1`, { headers: headers() });
    expect(observed.status).toBe(404);
    expect(await observed.json()).toEqual({ error: { code: 'checkout_api_unavailable' } });

    const byRoot = await fetch(`${host.origin}/v1/checkouts?root=/tmp/wt`, { headers: headers() });
    expect(byRoot.status).toBe(404);

    const reclaimed = await fetch(`${host.origin}/v1/checkouts/reclaim`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ root: '/tmp/wt' }),
    });
    expect(reclaimed.status).toBe(404);
    expect(await reclaimed.json()).toEqual({ error: { code: 'checkout_api_unavailable' } });
  });

  it('rejects the wrong method before it looks at the body', async () => {
    const host = await open();
    const response = await fetch(`${host.origin}/v1/checkouts?sessionId=s-1`, {
      method: 'DELETE',
      headers: headers(),
    });
    // 404 first: an uncomposed Host does not advertise a method table either.
    expect(response.status).toBe(404);
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
