/**
 * Plan 621 slice B — Host `HostCheckoutApiV1` over a fake observation port.
 *
 * The port is A's `CheckoutProvider` shape (plan appendix A), so these tests
 * drive the DTO mapping only: which dimension lands in which field, that
 * "unowned" and "owner unreadable" stay distinguishable, and that a retain
 * verdict is passed through instead of being re-derived here. Nothing here
 * touches git; A owns that behaviour and its own fixtures.
 */

import { describe, expect, it } from 'vitest';
import type {
  CheckoutObservation,
  CheckoutObservationPort,
} from '../src/checkout-api.js';
import { HostCheckoutApiError, createHostCheckoutApi } from '../src/checkout-api.js';

const ROOT = '/tmp/duya-worktrees/wt-1';

function observation(overrides: Partial<CheckoutObservation> = {}): CheckoutObservation {
  return {
    registered: true,
    worktree: 'clean',
    owner: null,
    locked: false,
    reclaim: { ok: true },
    observedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function port(overrides: Partial<CheckoutObservationPort> = {}): CheckoutObservationPort {
  return {
    observe: async () => observation(),
    list: async () => [],
    reclaim: async () => ({ removed: true }),
    ...overrides,
  };
}

function api(overrides: {
  port?: CheckoutObservationPort;
  resolve?: (sessionId: string) => Promise<string | null>;
} = {}) {
  return createHostCheckoutApi({
    ...(overrides.port === undefined ? {} : { port: overrides.port }),
    ...(overrides.resolve === undefined
      ? {}
      : { resolveSessionCheckoutRoot: overrides.resolve }),
  });
}

describe('HostCheckoutApiV1 — missing collaborators', () => {
  it('refuses every method when the Host has no checkout port', async () => {
    const checkout = api();
    await expect(checkout.observeForSession('s-1')).rejects.toBeInstanceOf(HostCheckoutApiError);
    await expect(checkout.observeCheckout(ROOT)).rejects.toMatchObject({
      code: 'checkout_observation_unavailable',
      status: 503,
    });
    await expect(checkout.listCheckouts('/src')).rejects.toMatchObject({
      code: 'checkout_observation_unavailable',
    });
    await expect(checkout.requestReclaim(ROOT)).rejects.toMatchObject({
      code: 'checkout_observation_unavailable',
    });
  });

  it('refuses per-session observation without a session resolver, and never answers "no checkout"', async () => {
    const checkout = api({ port: port() });
    await expect(checkout.observeForSession('s-1')).rejects.toMatchObject({
      code: 'checkout_session_resolver_unavailable',
    });
    // A direct observation still works: the gap is the resolution, not the port.
    await expect(checkout.observeCheckout(ROOT)).resolves.toMatchObject({ root: ROOT });
  });

  it('rejects empty selectors as a client error', async () => {
    const checkout = api({ port: port(), resolve: async () => null });
    await expect(checkout.observeForSession('  ')).rejects.toMatchObject({
      code: 'invalid_checkout_query',
      status: 400,
    });
    await expect(checkout.observeCheckout('')).rejects.toMatchObject({ code: 'invalid_checkout_query' });
    await expect(checkout.requestReclaim('')).rejects.toMatchObject({ code: 'invalid_checkout_query' });
  });
});

describe('HostCheckoutApiV1 — session views', () => {
  it('reports no checkout when the resolver has no answer, without observing anything', async () => {
    let observed = 0;
    const checkout = api({
      port: port({ observe: async () => { observed += 1; return observation(); } }),
      resolve: async () => null,
    });

    const view = await checkout.observeForSession('s-1');
    expect(view).toEqual({ sessionId: 's-1', checkout: null, isOwner: false });
    expect(observed).toBe(0);
  });

  it('marks the owning session as owner', async () => {
    const checkout = api({
      port: port({ observe: async () => observation({ owner: { sessionId: 's-1' } }) }),
      resolve: async () => ROOT,
    });

    const view = await checkout.observeForSession('s-1');
    expect(view.isOwner).toBe(true);
    expect(view.checkout?.ownerSessionId).toBe('s-1');
    expect(view.checkout?.ownerUnreadable).toBe(false);
    expect(view.checkout?.root).toBe(ROOT);
  });

  it('reports a different session as a non-owner without hiding the real owner', async () => {
    const checkout = api({
      port: port({ observe: async () => observation({ owner: { sessionId: 's-owner' } }) }),
      resolve: async () => ROOT,
    });

    const view = await checkout.observeForSession('s-other');
    expect(view.isOwner).toBe(false);
    expect(view.checkout?.ownerSessionId).toBe('s-owner');
    expect(view.checkout?.ownerUnreadable).toBe(false);
  });

  it('keeps "no owner" and "owner unreadable" distinguishable', async () => {
    const unowned = api({
      port: port({ observe: async () => observation({ owner: null }) }),
      resolve: async () => ROOT,
    });
    const unreadable = api({
      port: port({
        observe: async () => observation({ owner: 'unreadable', reclaim: { ok: false, reason: 'unreadable' } }),
      }),
      resolve: async () => ROOT,
    });

    const unownedView = await unowned.observeForSession('s-1');
    expect(unownedView.checkout?.ownerSessionId).toBeNull();
    expect(unownedView.checkout?.ownerUnreadable).toBe(false);

    const unreadableView = await unreadable.observeForSession('s-1');
    expect(unreadableView.checkout?.ownerSessionId).toBeNull();
    // The whole point of the second field: unknown ownership is not ownership-free.
    expect(unreadableView.checkout?.ownerUnreadable).toBe(true);
    expect(unreadableView.checkout?.reclaimable).toBe(false);
    expect(unreadableView.checkout?.retainReason).toBe('unreadable');
    expect(unreadableView.isOwner).toBe(false);
  });
});

describe('HostCheckoutApiV1 — observation passthrough', () => {
  it('passes the provider verdict through instead of re-deriving it', async () => {
    const cases = [
      { worktree: 'dirty_tracked' as const, reason: 'dirty_tracked' as const },
      { worktree: 'untracked' as const, reason: 'untracked' as const },
      { worktree: 'ignored' as const, reason: 'ignored' as const },
    ];
    for (const { worktree, reason } of cases) {
      const checkout = api({
        port: port({ observe: async () => observation({ worktree, reclaim: { ok: false, reason } }) }),
      });
      const observed = await checkout.observeCheckout(ROOT);
      expect(observed.worktree).toBe(worktree);
      expect(observed.reclaimable).toBe(false);
      expect(observed.retainReason).toBe(reason);
    }
  });

  it('reports reclaimable with a null reason when the provider allows removal', async () => {
    const checkout = api({ port: port() });
    const observed = await checkout.observeCheckout(ROOT);
    expect(observed).toEqual({
      root: ROOT,
      cwd: ROOT,
      registered: true,
      worktree: 'clean',
      ownerSessionId: null,
      ownerUnreadable: false,
      locked: false,
      reclaimable: true,
      retainReason: null,
      observedAt: 1_700_000_000_000,
    });
  });

  it('keeps registered/locked independent from the reclaim verdict', async () => {
    const checkout = api({
      port: port({
        observe: async () => observation({
          registered: false,
          locked: true,
          reclaim: { ok: false, reason: 'not_registered' },
        }),
      }),
    });
    const observed = await checkout.observeCheckout(ROOT);
    expect(observed.registered).toBe(false);
    expect(observed.locked).toBe(true);
    expect(observed.retainReason).toBe('not_registered');
  });

  it('maps listed roots without leaking the port-only sourceCwd', async () => {
    const checkout = api({
      port: port({
        list: async () => [{
          root: ROOT,
          cwd: `${ROOT}/packages/host`,
          sourceRoot: '/src/duya',
          baseSha: 'c'.repeat(40),
        }],
      }),
    });
    const roots = await checkout.listCheckouts('/src/duya');
    expect(roots).toEqual([{
      root: ROOT,
      cwd: `${ROOT}/packages/host`,
      sourceRoot: '/src/duya',
      baseSha: 'c'.repeat(40),
    }]);
  });

  it('returns a refusal from reclaim as a normal result', async () => {
    const refused = api({ port: port({ reclaim: async () => ({ removed: false, reason: 'owner_alive' }) }) });
    await expect(refused.requestReclaim(ROOT)).resolves.toEqual({ removed: false, reason: 'owner_alive' });

    const removed = api({ port: port({ reclaim: async () => ({ removed: true }) }) });
    await expect(removed.requestReclaim(ROOT)).resolves.toEqual({ removed: true });
  });
});
