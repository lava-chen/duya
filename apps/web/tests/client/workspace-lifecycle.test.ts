/**
 * The Web's adapter for the shared workspace-lifecycle port.
 *
 * The adapter is allowed to do exactly one thing: forward. The Host owns the
 * session -> checkout -> pull-request mapping and the authority to delete a
 * checkout, so an adapter that re-derived either would be a second answer to
 * the same question — and the two would drift.
 *
 * The tests below therefore check that the adapter asks the right route and
 * hands back what came back, and that the three answers the contract keeps
 * apart stay apart on the way through:
 *
 *   - "this surface cannot observe checkouts" is not "this session has no
 *     checkout";
 *   - an `unknown` observation stays `unknown`;
 *   - a reclaim refusal resolves.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { createWebWorkspaceLifecycle } from '../../src/client/ui-services-adapter.js';
import {
  clearWorkspaceLifecycle,
  configureWorkspaceLifecycle,
  peekWorkspaceLifecycle,
} from '@/services/workspace-lifecycle';
import { createLifecycleBff, integrationRecord, jsonResponse, observedCheckout } from './lifecycle-bff.js';

// The registry is process-wide, and the shared renderer reads it, so every
// case starts from "this surface installed no adapter".
beforeEach(() => {
  const installed = peekWorkspaceLifecycle();
  if (installed !== null) clearWorkspaceLifecycle(installed);
});

describe('the Web workspace-lifecycle adapter', () => {
  it('installs nothing until the surface asks for it', () => {
    // A surface with no adapter has no checkout questions to answer, and the
    // shared panel says so. The Web installs one explicitly, so the registry
    // is empty until it does.
    expect(peekWorkspaceLifecycle()).toBeNull();
  });

  it('forwards the checkout observation of a session to the BFF', async () => {
    const bff = createLifecycleBff({
      '/api/checkouts?sessionId=session-1': () => jsonResponse({
        checkout: {
          sessionId: 'session-1',
          checkout: observedCheckout(),
          isOwner: true,
        },
      }),
    });
    const port = createWebWorkspaceLifecycle({ fetchImpl: bff.fetchImpl });

    const view = await port.checkouts?.observeForSession('session-1' as never);

    expect(view?.sessionId).toBe('session-1');
    expect(view?.isOwner).toBe(true);
    expect(bff.calls[0]?.path).toBe('/api/checkouts?sessionId=session-1');
  });

  it('forwards the integration projection of a session to the BFF', async () => {
    const bff = createLifecycleBff({
      '/api/integrations?sessionId=session-1': () => jsonResponse({
        records: [integrationRecord()],
      }),
    });
    const port = createWebWorkspaceLifecycle({ fetchImpl: bff.fetchImpl });

    const records = await port.integrations?.observeForSession('session-1' as never);

    expect(records).toHaveLength(1);
    expect(records?.[0]?.repo).toBe('duya/duya');
    expect(bff.calls[0]?.path).toBe('/api/integrations?sessionId=session-1');
  });

  it('carries an unknown observation through unchanged, with its reason', async () => {
    const bff = createLifecycleBff({
      '/api/integrations?sessionId=session-1': () => jsonResponse({
        records: [integrationRecord({ state: 'unknown', observedError: 'gh: not authenticated' })],
      }),
    });
    const port = createWebWorkspaceLifecycle({ fetchImpl: bff.fetchImpl });

    const records = await port.integrations?.observeForSession('session-1' as never);

    // "We could not look" is not "the pull request is open", and the adapter
    // is not the place where that distinction is allowed to blur.
    expect(records?.[0]?.state).toBe('unknown');
    expect(records?.[0]?.observedError).toBe('gh: not authenticated');
  });

  it('forwards the explicit refresh and reports its status unchanged', async () => {
    const bff = createLifecycleBff({
      '/api/integrations/sync': () => jsonResponse({
        result: {
          status: 'no_origin_remote',
          written: [],
          failed: [],
        },
      }),
    });
    const port = createWebWorkspaceLifecycle({ fetchImpl: bff.fetchImpl });

    const result = await port.integrations?.refreshForSession('session-1' as never);

    expect(result?.status).toBe('no_origin_remote');
    const refresh = bff.calls.find((call) => call.path === '/api/integrations/sync');
    expect(refresh?.method).toBe('POST');
    expect(refresh?.body).toEqual({ sessionId: 'session-1' });
  });

  it('resolves a reclaim refusal instead of reporting it as a failure', async () => {
    const bff = createLifecycleBff({
      '/api/checkouts/reclaim': () => jsonResponse({
        result: { removed: false, reason: 'owner_alive' },
      }),
    });
    const port = createWebWorkspaceLifecycle({ fetchImpl: bff.fetchImpl });

    // The Host declined and nothing was deleted. That is the answer to "may
    // this be deleted", so it resolves.
    const result = await port.checkouts?.requestReclaim('/repo/checkout');

    expect(result).toEqual({ removed: false, reason: 'owner_alive' });
  });

  it('fails loudly when the Host does not serve the namespace', async () => {
    const bff = createLifecycleBff({
      '/api/checkouts?sessionId=session-1': () => jsonResponse(
        { error: { code: 'checkout_api_unavailable' } },
        404,
      ),
    });
    const port = createWebWorkspaceLifecycle({ fetchImpl: bff.fetchImpl });

    // An empty checkout would read as "this session has no checkout", and
    // that is a fact the Host never stated.
    await expect(port.checkouts?.observeForSession('session-1' as never)).rejects.toMatchObject({
      status: 404,
      code: 'checkout_api_unavailable',
    });
  });

  it('is the port the shared renderer reads once the surface installs it', () => {
    const port = createWebWorkspaceLifecycle();
    configureWorkspaceLifecycle(port);

    expect(peekWorkspaceLifecycle()).toBe(port);
    expect(peekWorkspaceLifecycle()?.checkouts).toBeDefined();
    expect(peekWorkspaceLifecycle()?.integrations).toBeDefined();

    clearWorkspaceLifecycle(port);
    expect(peekWorkspaceLifecycle()).toBeNull();
  });
});
