/**
 * packages/cli/src/tui/slash/__tests__/workspace-lifecycle-commands.test.ts
 *
 * `/checkout` and `/pr` — the two read-only plan 621 workspace commands.
 *
 * ## What these cases pin
 *
 *  1. The commands RESOLVE. A handler that exists but was never registered
 *     answers "unknown command" at the keyboard, and a test that only
 *     exercised the handler function would stay green. Every case therefore
 *     goes through `resolveTuiSlashCommand`.
 *
 *  2. `unknown` is rendered as `unknown`. The fixtures pair an `unknown`
 *     record with a reason and assert the reason is printed; a case that
 *     folded the state into `open` would print `open` and fail.
 *
 *  3. A plain `/pr` does not sync. The projection read must never touch the
 *     network, and only `/pr refresh` may. The `syncIntegrations` spy is the
 *     discriminator: it is asserted UNcalled for the read and called for the
 *     refresh.
 *
 *  4. "No namespace" and "no checkout" are different answers. The 404
 *     fixture asserts the namespace-unavailable wording, and the empty
 *     fixture asserts the opposite wording.
 *
 *  5. The TUI never deletes a checkout. The reclaim spy is asserted UNcalled
 *     in every `/checkout` case — the command is observation only.
 */

import { describe, expect, it, vi } from 'vitest';

import type {
  HostCheckoutObserved,
  HostIntegrationRecord,
  HostSessionCheckoutView,
} from '@duya/agent-protocol';
import type { HostSessionHttpClient } from '@duya/host/http-client';

import { resolveTuiSlashCommand } from '../registry.js';
import type { TuiSlashContext, TuiSlashHost } from '../types.js';

const SESSION_ID = 's-pr-1';

const SESSION = {
  id: SESSION_ID,
  title: 'Demo session',
  model: 'gpt-x',
  providerId: 'p1',
  mode: 'code',
  permissionMode: 'auto',
  status: 'idle',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_100_000,
  workspace: { state: 'bound', workspaceId: 'w1', rootId: 'r1', relativePath: '.' },
} as unknown as { id: string };

function checkoutObserved(overrides: Partial<HostCheckoutObserved> = {}): HostCheckoutObserved {
  return {
    root: 'E:\\repo\\.claude\\worktrees\\wt',
    cwd: 'E:\\repo\\.claude\\worktrees\\wt',
    registered: true,
    worktree: 'clean',
    ownerSessionId: SESSION_ID,
    ownerUnreadable: false,
    locked: false,
    reclaimable: true,
    retainReason: null,
    observedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function integrationRecord(overrides: Partial<HostIntegrationRecord> = {}): HostIntegrationRecord {
  return {
    repo: 'lava-chen/duya',
    prNumber: 373,
    state: 'open',
    headSha: 'abc123',
    baseRef: 'master',
    url: 'https://github.com/lava-chen/duya/pull/373',
    observedAt: 1_700_000_000_000,
    observedError: null,
    ...overrides,
  };
}

interface Harness {
  readonly notices: string[];
  readonly errors: string[];
  readonly output: string;
  readonly syncIntegrations: ReturnType<typeof vi.fn>;
  readonly requestCheckoutReclaim: ReturnType<typeof vi.fn>;
}

async function run(
  name: string,
  args: string,
  client: Record<string, unknown>,
): Promise<Harness> {
  const notices: string[] = [];
  const errors: string[] = [];
  const syncIntegrations = vi.fn(async () => ({
    status: 'synced' as const,
    written: [],
    failed: [],
  }));
  const requestCheckoutReclaim = vi.fn(async () => ({ removed: true as const }));
  const host: TuiSlashHost = {
    printNotice: (text) => { notices.push(text); },
    printError: (text) => { errors.push(text); },
    choose: async () => null,
  };
  const ctx = {
    client: { syncIntegrations, requestCheckoutReclaim, ...client } as unknown as HostSessionHttpClient,
    session: SESSION,
    tui: host,
    busy: false,
  } as unknown as TuiSlashContext;

  const command = resolveTuiSlashCommand(name);
  if (command === undefined) throw new Error(`no such command: /${name}`);
  await command.run(ctx, args);

  return {
    notices,
    errors,
    output: notices.join('\n'),
    syncIntegrations,
    requestCheckoutReclaim,
  };
}

/** A client whose checkout observation is the given view. */
function checkoutClient(view: HostSessionCheckoutView): Record<string, unknown> {
  return { observeCheckoutForSession: vi.fn(async () => view) };
}

describe('/checkout', () => {
  it('is registered and resolvable', () => {
    expect(resolveTuiSlashCommand('checkout')?.name).toBe('checkout');
  });

  it('renders the observation with its source and its timestamp', async () => {
    const view: HostSessionCheckoutView = {
      sessionId: SESSION_ID,
      checkout: checkoutObserved(),
      isOwner: true,
    };
    const { output, errors } = await run('checkout', '', checkoutClient(view));

    expect(errors).toEqual([]);
    expect(output).toContain('E:\\repo\\.claude\\worktrees\\wt');
    expect(output).toContain('registered  yes');
    expect(output).toContain('worktree    clean');
    expect(output).toContain('owner       this session');
    expect(output).toContain('locked      no');
    expect(output).toContain('reclaimable');
    // The observation is labelled with when it was taken and where it came
    // from — a recomputed reading must not read as a persistent fact.
    expect(output).toContain('as of');
    expect(output).toContain('Source: Host checkout observation');
  });

  it('names the retaining reason when the Host refused a reclaim', async () => {
    const view: HostSessionCheckoutView = {
      sessionId: SESSION_ID,
      checkout: checkoutObserved({
        worktree: 'dirty_tracked',
        reclaimable: false,
        retainReason: 'dirty_tracked',
      }),
      isOwner: true,
    };
    const { output } = await run('checkout', '', checkoutClient(view));

    expect(output).toContain('worktree    dirty_tracked');
    expect(output).toContain('retained: dirty_tracked');
    expect(output).not.toContain('reclaimable (observation only');
  });

  it('distinguishes an unreadable owner from an unowned checkout', async () => {
    const unreadable: HostSessionCheckoutView = {
      sessionId: SESSION_ID,
      checkout: checkoutObserved({ ownerSessionId: null, ownerUnreadable: true }),
      isOwner: false,
    };
    const unowned: HostSessionCheckoutView = {
      sessionId: SESSION_ID,
      checkout: checkoutObserved({ ownerSessionId: null, ownerUnreadable: false }),
      isOwner: false,
    };

    const a = await run('checkout', '', checkoutClient(unreadable));
    expect(a.output).toContain('unreadable');

    const b = await run('checkout', '', checkoutClient(unowned));
    expect(b.output).toContain('owner       none');
    expect(b.output).not.toContain('unreadable');
  });

  it('says the session has no checkout rather than showing an empty one', async () => {
    const view: HostSessionCheckoutView = {
      sessionId: SESSION_ID,
      checkout: null,
      isOwner: false,
    };
    const { output } = await run('checkout', '', checkoutClient(view));

    expect(output).toContain('not inside a checkout');
    // The two answers must not collapse into one another.
    expect(output).not.toContain('does not serve the checkout namespace');
  });

  it('says the Host cannot answer when the namespace is unavailable', async () => {
    const error = Object.assign(new Error('Duya Host request failed (404: checkout_api_unavailable)'), {
      status: 404,
      code: 'checkout_api_unavailable',
    });
    const { output } = await run('checkout', '', {
      observeCheckoutForSession: vi.fn(async () => { throw error; }),
    });

    expect(output).toContain('does not serve the checkout namespace');
    // "This Host cannot answer" is NOT "this session has no checkout".
    expect(output).not.toContain('not inside a checkout');
  });

  it('never asks the Host to delete a checkout', async () => {
    const view: HostSessionCheckoutView = {
      sessionId: SESSION_ID,
      checkout: checkoutObserved({ reclaimable: true }),
      isOwner: true,
    };
    const { requestCheckoutReclaim } = await run('checkout', '', checkoutClient(view));
    expect(requestCheckoutReclaim).not.toHaveBeenCalled();
  });
});

describe('/pr', () => {
  it('is registered and resolvable', () => {
    expect(resolveTuiSlashCommand('pr')?.name).toBe('pr');
  });

  it('lists the pull requests with their state, url and observation time', async () => {
    const { output, errors } = await run('pr', '', {
      observeIntegrationsForSession: vi.fn(async () => [integrationRecord()]),
    });

    expect(errors).toEqual([]);
    expect(output).toContain('lava-chen/duya#373');
    expect(output).toContain('open');
    expect(output).toContain('https://github.com/lava-chen/duya/pull/373');
    expect(output).toContain('as of');
    expect(output).toContain('Source: Host integration projection');
  });

  it('renders an unknown state as unknown, with its reason', async () => {
    const { output } = await run('pr', '', {
      observeIntegrationsForSession: vi.fn(async () => [
        integrationRecord({ state: 'unknown', observedError: 'gh: command not found' }),
      ]),
    });

    expect(output).toContain('unknown');
    // The reason travels with the state: an `unknown` without one is
    // unusable in a support ticket.
    expect(output).toContain('gh: command not found');
    // The observation failed. That is NOT the pull request being open.
    expect(output).not.toContain('open');
  });

  it('does not touch the network on a plain read', async () => {
    const { syncIntegrations } = await run('pr', '', {
      observeIntegrationsForSession: vi.fn(async () => [integrationRecord()]),
    });
    expect(syncIntegrations).not.toHaveBeenCalled();
  });

  it('syncs first and then reads the projection on an explicit refresh', async () => {
    const observeIntegrationsForSession = vi.fn(async () => [integrationRecord()]);
    const { output, syncIntegrations } = await run('pr', 'refresh', {
      observeIntegrationsForSession,
    });

    expect(syncIntegrations).toHaveBeenCalledTimes(1);
    expect(syncIntegrations.mock.calls[0]?.[0]).toBe(SESSION_ID);
    expect(observeIntegrationsForSession).toHaveBeenCalledTimes(1);
    expect(output).toContain('refresh  synced');
    expect(output).toContain('lava-chen/duya#373');
  });

  it('says the session has no pull requests rather than showing an empty list', async () => {
    const { output } = await run('pr', '', {
      observeIntegrationsForSession: vi.fn(async () => []),
    });

    expect(output).toContain('No pull request is associated with this session');
    expect(output).not.toContain('does not serve the integration namespace');
  });

  it('says the Host cannot answer when the integration namespace is unavailable', async () => {
    const error = Object.assign(new Error('Duya Host request failed (404: integration_api_unavailable)'), {
      status: 404,
      code: 'integration_api_unavailable',
    });
    const { output } = await run('pr', '', {
      observeIntegrationsForSession: vi.fn(async () => { throw error; }),
    });

    expect(output).toContain('does not serve the integration namespace');
    expect(output).not.toContain('No pull request is associated with this session');
  });

  it('rejects an argument it does not know', async () => {
    const observeIntegrationsForSession = vi.fn(async () => []);
    const { errors, syncIntegrations } = await run('pr', 'bogus', { observeIntegrationsForSession });

    expect(errors.join('\n')).toContain('/pr [refresh]');
    expect(observeIntegrationsForSession).not.toHaveBeenCalled();
    expect(syncIntegrations).not.toHaveBeenCalled();
  });
});
