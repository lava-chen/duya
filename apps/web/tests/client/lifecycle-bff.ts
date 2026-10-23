/**
 * A stub of the same-origin BFF for the checkout and integration namespaces.
 *
 * The routes and the response shapes mirror `src/server/web-bff.ts` exactly,
 * because a stub that is more forgiving than the server would let the
 * transport ship a shape the server never sends.
 */

import type { FetchLike } from '../../src/client/api.js';

export interface LifecycleCall {
  readonly path: string;
  readonly method: string;
  readonly body: unknown;
}

export interface LifecycleBff {
  readonly fetchImpl: FetchLike;
  readonly calls: readonly LifecycleCall[];
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function createLifecycleBff(handlers: Record<string, () => Response> = {}): LifecycleBff {
  const calls: LifecycleCall[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input, 'http://stub.local');
    const method = init?.method ?? 'GET';
    let body: unknown = undefined;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ path: `${url.pathname}${url.search}`, method, body });
    if (url.pathname === '/api/bootstrap') {
      return jsonResponse({ apiVersion: 1, csrfToken: 'csrf-token' });
    }
    const handler = handlers[`${url.pathname}${url.search}`] ?? handlers[url.pathname];
    if (handler !== undefined) return handler();
    return jsonResponse({ error: { code: 'not_found' } }, 404);
  };
  return { fetchImpl, calls };
}

/** One observed checkout, as the Host would report it. */
export function observedCheckout(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    root: '/repo/.claude/worktrees/task-1',
    cwd: '/repo/.claude/worktrees/task-1',
    registered: true,
    worktree: 'clean',
    ownerSessionId: 'session-1',
    ownerUnreadable: false,
    locked: false,
    reclaimable: true,
    retainReason: null,
    observedAt: 1_700_000_000_000,
    ...overrides,
  };
}

/** One observed pull request, as the Host would report it. */
export function integrationRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repo: 'duya/duya',
    prNumber: 21,
    state: 'open',
    headSha: 'abc',
    baseRef: 'main',
    url: 'https://github.com/duya/duya/pull/21',
    observedAt: 1_700_000_000_000,
    observedError: null,
    ...overrides,
  };
}
