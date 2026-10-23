/**
 * What the browser transport sends for the checkout and integration
 * namespaces, and what it refuses to send.
 *
 * The Host is the authority for all of it (plan 621 §4.3), so this transport
 * has exactly two jobs: ask the right question, and hand back what came
 * back. The tests below hold it to both, and to the three distinctions the
 * contract insists on:
 *
 *   - an `unknown` observation is `unknown`, never `open`;
 *   - a reclaim refusal is an answer, not a failure;
 *   - a Host that cannot answer fails loudly instead of being reported as an
 *     empty observation.
 */

import { describe, expect, it } from 'vitest';
import { ApiClient, ApiError } from '../../src/client/api.js';
import { createLifecycleBff, integrationRecord, jsonResponse, observedCheckout } from './lifecycle-bff.js';

describe('ApiClient checkout observations', () => {
  it('asks for the checkout of a session and hands back what the Host observed', async () => {
    const bff = createLifecycleBff({
      '/api/checkouts?sessionId=session-1': () => jsonResponse({
        checkout: {
          sessionId: 'session-1',
          checkout: observedCheckout(),
          isOwner: true,
        },
      }),
    });
    const client = new ApiClient({ fetchImpl: bff.fetchImpl });

    const view = await client.observeCheckoutForSession('session-1' as never);

    expect(view.sessionId).toBe('session-1');
    expect(view.isOwner).toBe(true);
    expect(view.checkout?.root).toBe('/repo/.claude/worktrees/task-1');
    expect(view.checkout?.reclaimable).toBe(true);
    expect(bff.calls.map((entry) => entry.path)).toEqual(['/api/checkouts?sessionId=session-1']);
  });

  it('asks for one checkout by its root path', async () => {
    const bff = createLifecycleBff({
      '/api/checkouts?root=%2Frepo%2Fcheckout': () => jsonResponse({
        checkout: observedCheckout({ root: '/repo/checkout' }),
      }),
    });
    const client = new ApiClient({ fetchImpl: bff.fetchImpl });

    const checkout = await client.observeCheckoutByRoot('/repo/checkout');

    expect(checkout.root).toBe('/repo/checkout');
    expect(bff.calls[0]?.path).toBe('/api/checkouts?root=%2Frepo%2Fcheckout');
  });

  it('reports a session that is not inside a managed checkout as an answer', async () => {
    const bff = createLifecycleBff({
      '/api/checkouts?sessionId=session-1': () => jsonResponse({
        checkout: { sessionId: 'session-1', checkout: null, isOwner: false },
      }),
    });
    const client = new ApiClient({ fetchImpl: bff.fetchImpl });

    const view = await client.observeCheckoutForSession('session-1' as never);

    expect(view.checkout).toBeNull();
    expect(view.isOwner).toBe(false);
  });
});

describe('ApiClient reclaim', () => {
  it('sends the root with the CSRF token and resolves a refusal', async () => {
    const bff = createLifecycleBff({
      '/api/checkouts/reclaim': () => jsonResponse({
        result: { removed: false, reason: 'dirty_tracked' },
      }),
    });
    const client = new ApiClient({ fetchImpl: bff.fetchImpl });

    // A refusal is the Host's answer. It resolves; it does not reject.
    const result = await client.requestCheckoutReclaim('/repo/checkout');

    expect(result).toEqual({ removed: false, reason: 'dirty_tracked' });
    const reclaim = bff.calls.find((entry) => entry.path === '/api/checkouts/reclaim');
    expect(reclaim?.method).toBe('POST');
    expect(reclaim?.body).toEqual({ root: '/repo/checkout' });
  });

  it('resolves a removal as well', async () => {
    const bff = createLifecycleBff({
      '/api/checkouts/reclaim': () => jsonResponse({ result: { removed: true } }),
    });
    const client = new ApiClient({ fetchImpl: bff.fetchImpl });

    await expect(client.requestCheckoutReclaim('/repo/checkout')).resolves.toEqual({ removed: true });
  });
});

describe('ApiClient integrations', () => {
  it('carries an unknown observation through unchanged, with its reason', async () => {
    const bff = createLifecycleBff({
      '/api/integrations?sessionId=session-1': () => jsonResponse({
        records: [integrationRecord({ state: 'unknown', observedError: 'gh: not authenticated' })],
      }),
    });
    const client = new ApiClient({ fetchImpl: bff.fetchImpl });

    const records = await client.observeIntegrationsForSession('session-1' as never);

    expect(records).toHaveLength(1);
    // "We could not look" is not "the pull request is open".
    expect(records[0]?.state).toBe('unknown');
    expect(records[0]?.observedError).toBe('gh: not authenticated');
    expect(bff.calls[0]?.path).toBe('/api/integrations?sessionId=session-1');
  });

  it('refuses a state this transport cannot name instead of guessing one', async () => {
    const bff = createLifecycleBff({
      '/api/integrations?sessionId=session-1': () => jsonResponse({
        records: [integrationRecord({ state: 'brand_new_state' })],
      }),
    });
    const client = new ApiClient({ fetchImpl: bff.fetchImpl });

    await expect(client.observeIntegrationsForSession('session-1' as never))
      .rejects.toBeInstanceOf(ApiError);
  });

  it('asks the Host to refresh and reports the outcome as it happened', async () => {
    const bff = createLifecycleBff({
      '/api/integrations/sync': () => jsonResponse({
        result: {
          status: 'observation_failed',
          written: [{ repo: 'duya/duya', prNumber: 21 }],
          failed: [{ ref: 'refs/duya/checkpoint/session-1/1', reason: 'gh: rate limited' }],
        },
      }),
    });
    const client = new ApiClient({ fetchImpl: bff.fetchImpl });

    const result = await client.refreshIntegrationsForSession('session-1' as never);

    expect(result.status).toBe('observation_failed');
    expect(result.written).toEqual([{ repo: 'duya/duya', prNumber: 21 }]);
    expect(result.failed).toEqual([
      { ref: 'refs/duya/checkpoint/session-1/1', reason: 'gh: rate limited' },
    ]);
    const refresh = bff.calls.find((entry) => entry.path === '/api/integrations/sync');
    expect(refresh?.method).toBe('POST');
    expect(refresh?.body).toEqual({ sessionId: 'session-1' });
  });
});

describe('ApiClient lifecycle error mapping', () => {
  it('turns a Host refusal into an ApiError that keeps the status and the code', async () => {
    const bff = createLifecycleBff({
      '/api/checkouts?sessionId=session-1': () => jsonResponse(
        { error: { code: 'checkout_api_unavailable' } },
        404,
      ),
    });
    const client = new ApiClient({ fetchImpl: bff.fetchImpl });

    await expect(client.observeCheckoutForSession('session-1' as never)).rejects.toMatchObject({
      status: 404,
      code: 'checkout_api_unavailable',
    });
  });

  it('refuses a malformed observation instead of casting one', async () => {
    const bff = createLifecycleBff({
      '/api/checkouts?sessionId=session-1': () => jsonResponse({
        checkout: { sessionId: 'session-1', checkout: { root: '/repo' }, isOwner: false },
      }),
    });
    const client = new ApiClient({ fetchImpl: bff.fetchImpl });

    await expect(client.observeCheckoutForSession('session-1' as never)).rejects.toBeInstanceOf(ApiError);
  });

  it('refuses a malformed refresh outcome instead of casting one', async () => {
    const bff = createLifecycleBff({
      '/api/integrations/sync': () => jsonResponse({ result: { status: 'synced' } }),
    });
    const client = new ApiClient({ fetchImpl: bff.fetchImpl });

    await expect(client.refreshIntegrationsForSession('session-1' as never)).rejects.toBeInstanceOf(ApiError);
  });
});
