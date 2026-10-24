/**
 * What the browser transport sends to the BFF, and what it refuses to send.
 *
 * The shared renderer hands the transport a run request that carries the model
 * the user picked, the provider, and the thinking-effort level. Those are the
 * run's configuration, so the transport has to carry them: a request that
 * silently dropped them would run with a configuration the screen never
 * showed. The mirror image matters just as much — a raw working directory or a
 * free-form options bag is authority the browser must not hand out, and the
 * transport refuses it instead of forwarding it.
 */

import { describe, expect, it } from 'vitest';
import { ApiClient, ApiError, type FetchLike } from '../../src/client/api.js';

interface Recorded {
  readonly path: string;
  readonly method: string;
  readonly body: unknown;
}

function recordingFetch(overrides: Record<string, unknown> = {}): {
  fetchImpl: FetchLike;
  recorded: Recorded[];
} {
  const recorded: Recorded[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const path = new URL(input, 'http://stub.local').pathname;
    const method = init?.method ?? 'GET';
    let body: unknown = undefined;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    recorded.push({ path, method, body });
    if (path === '/api/bootstrap') {
      return new Response(JSON.stringify({ apiVersion: 1, csrfToken: 'csrf-token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (path === '/api/runs/start') {
      return new Response(JSON.stringify({ accepted: true, stage: 'dispatched', runId: 'run-1' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (path.endsWith('/messages')) {
      return new Response(JSON.stringify({ messages: [], nextCursor: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(overrides[path] ?? {}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, recorded };
}

describe('ApiClient run start', () => {
  it('carries the model, the provider and the thinking effort', async () => {
    const { fetchImpl, recorded } = recordingFetch();
    const client = new ApiClient({ fetchImpl });

    const result = await client.startHostRun({
      sessionId: 'session-1' as never,
      prompt: 'hello',
      model: 'proof-model',
      providerId: 'browser-proof',
      effort: 'high',
    });

    expect(result).toEqual({ accepted: true, stage: 'dispatched', runId: 'run-1' });
    const start = recorded.find((entry) => entry.path === '/api/runs/start');
    expect(start?.body).toEqual({
      sessionId: 'session-1',
      prompt: 'hello',
      model: 'proof-model',
      providerId: 'browser-proof',
      effort: 'high',
    });
  });

  it('refuses a request that carries authority the browser may not hand out', async () => {
    const { fetchImpl, recorded } = recordingFetch();
    const client = new ApiClient({ fetchImpl });

    await expect(client.startHostRun({
      sessionId: 'session-1' as never,
      prompt: 'hello',
      workingDirectory: 'C:/',
    } as never)).rejects.toBeInstanceOf(ApiError);
    await expect(client.startHostRun({
      sessionId: 'session-1' as never,
      prompt: 'hello',
      options: { maxTurns: 999 },
    } as never)).rejects.toBeInstanceOf(ApiError);

    expect(recorded.filter((entry) => entry.path === '/api/runs/start')).toHaveLength(0);
  });
});

describe('ApiClient message read', () => {
  it('refuses a source filter it cannot express', async () => {
    const { fetchImpl } = recordingFetch();
    const client = new ApiClient({ fetchImpl });

    await expect(client.readHostMessages('session-1' as never, { sources: ['user'] }))
      .rejects.toBeInstanceOf(ApiError);
  });

  it('asks for the whole transcript in ONE request', async () => {
    // The Host's paged read re-projects the ENTIRE transcript on every page, so
    // a client that pages to the end of a 10k-message transcript pays for it
    // 100 times. The whole read asks for one projection.
    //
    // The gate is the REQUEST COUNT, not a duration: it is exact on any
    // machine, so a regression that reintroduces per-page projection fails
    // here instead of showing up as a slow session.
    const requests: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      const url = new URL(input, 'http://stub.local');
      requests.push(`${url.pathname}${url.search}`);
      if (url.pathname === '/api/bootstrap') {
        return new Response(JSON.stringify({ apiVersion: 1, csrfToken: 'csrf-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ messages: [], nextCursor: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const client = new ApiClient({ fetchImpl });

    await client.readAllHostMessages('session-1' as never);
    await client.readAllMessages('session-1');

    expect(requests.filter((entry) => entry.includes('/messages'))).toEqual([
      '/api/sessions/session-1/messages?all=1',
      '/api/sessions/session-1/messages?all=1',
    ]);
  });
});
