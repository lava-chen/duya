// Plan 460 — generic REST template invoker unit tests.

import { describe, expect, it, vi } from 'vitest';
import { invokeRestTemplate, getPath } from '../connectors/rest-invoker.js';
import type { AppToolDeclaration } from '@duya/plugin-core/src/connectors/app-schema.js';

function tool(partial: Partial<AppToolDeclaration> & { invoke: AppToolDeclaration['invoke'] }): AppToolDeclaration {
  return {
    name: 'acme_search',
    description: 'Search',
    inputSchema: { type: 'object', properties: {} },
    inputSchemaSummary: 'q',
    riskTier: 'read',
    ...partial,
  } as AppToolDeclaration;
}

function okJson(fetchImpl: ReturnType<typeof vi.fn>, body: unknown, status = 200): void {
  fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
}

describe('getPath', () => {
  it('resolves nested dot paths through objects and arrays', () => {
    expect(getPath({ a: { b: [{ c: 42 }] } }, 'a.b.0.c')).toBe(42);
  });

  it('returns undefined for missing paths', () => {
    expect(getPath({ a: 1 }, 'a.b')).toBeUndefined();
    expect(getPath({ a: [1] }, 'a.x')).toBeUndefined();
  });

  it('returns the root when path is empty', () => {
    expect(getPath({ x: 1 }, '')).toEqual({ x: 1 });
  });
});

describe('invokeRestTemplate', () => {
  it('expands ${args.*} and auto-attaches Bearer auth', async () => {
    const fetchImpl = vi.fn();
    okJson(fetchImpl, { items: [] });

    const t = tool({
      invoke: {
        method: 'GET',
        url: 'https://api.acme.example/v1/search?q=${args.query}',
        query: { limit: '${args.limit}' },
      },
    });

    const result = await invokeRestTemplate(t, {
      args: { query: 'hello world', limit: 5 },
      accessToken: 'tok123',
      tokenType: 'Bearer',
    }, fetchImpl as unknown as typeof fetch);

    expect(result.success).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('q=hello+world');
    expect(String(url)).toContain('limit=5');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok123' });
  });

  it('does not override a declared Authorization header', async () => {
    const fetchImpl = vi.fn();
    okJson(fetchImpl, { ok: true });

    const t = tool({
      invoke: {
        method: 'GET',
        url: 'https://api.acme.example/v1/me',
        headers: { Authorization: 'Token ${accessToken}' },
      },
    });

    await invokeRestTemplate(t, { args: {}, accessToken: 'abc', tokenType: 'Bearer' }, fetchImpl as unknown as typeof fetch);

    const [, init] = fetchImpl.mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Token abc' });
  });

  it('expands templates inside JSON body string leaves', async () => {
    const fetchImpl = vi.fn();
    okJson(fetchImpl, { ok: true });

    const t = tool({
      invoke: {
        method: 'POST',
        url: 'https://api.acme.example/v1/items',
        body: { name: '${args.name}', meta: { tags: ['${args.tag}'] } },
      },
    });

    await invokeRestTemplate(t, { args: { name: 'widget', tag: 'x' }, accessToken: 't', tokenType: 'Bearer' }, fetchImpl as unknown as typeof fetch);

    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      name: 'widget',
      meta: { tags: ['x'] },
    });
  });

  it('projects data through response.dataPath', async () => {
    const fetchImpl = vi.fn();
    okJson(fetchImpl, { ok: true, data: { results: [1, 2] } });

    const t = tool({
      invoke: {
        method: 'GET',
        url: 'https://api.acme.example/v1/search',
        response: { ok: 'ok', dataPath: 'data.results' },
      },
    });

    const result = await invokeRestTemplate(t, { args: {}, accessToken: 't', tokenType: 'Bearer' }, fetchImpl as unknown as typeof fetch);
    expect(result).toMatchObject({ success: true, data: [1, 2] });
  });

  it('treats response.ok=false as failure and uses errorPath/errorTemplate', async () => {
    const fetchImpl = vi.fn();
    okJson(fetchImpl, { ok: false, error: 'rate_limited' }, 429);

    const t = tool({
      invoke: {
        method: 'GET',
        url: 'https://api.acme.example/v1/search',
        response: {
          ok: 'ok',
          errorPath: 'error',
          errorTemplate: 'Acme rejected: ${error}',
          retryableStatus: [429],
        },
      },
    });

    const result = await invokeRestTemplate(t, { args: {}, accessToken: 't', tokenType: 'Bearer' }, fetchImpl as unknown as typeof fetch);
    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('Acme rejected: rate_limited');
    expect(result.error?.retriable).toBe(true);
  });

  it('fails with http_<status> and retriable=true on 5xx by default', async () => {
    const fetchImpl = vi.fn();
    okJson(fetchImpl, { error: 'boom' }, 503);

    const t = tool({ invoke: { method: 'GET', url: 'https://api.acme.example/v1/x' } });

    const result = await invokeRestTemplate(t, { args: {}, accessToken: 't', tokenType: 'Bearer' }, fetchImpl as unknown as typeof fetch);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('http_503');
    expect(result.error?.retriable).toBe(true);
  });

  it('maps network errors to retriable network_error', async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error('ECONNRESET'));

    const t = tool({ invoke: { method: 'GET', url: 'https://api.acme.example/v1/x' } });

    const result = await invokeRestTemplate(t, { args: {}, accessToken: 't', tokenType: 'Bearer' }, fetchImpl as unknown as typeof fetch);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('network_error');
    expect(result.error?.retriable).toBe(true);
  });

  it('fails closed on a tool without an invoke template', async () => {
    const t = tool({ invoke: undefined } as unknown as AppToolDeclaration);
    const result = await invokeRestTemplate(t, { args: {}, accessToken: 't', tokenType: 'Bearer' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('invalid_arguments');
  });

  it('falls back to the raw text body when the response is not JSON', async () => {
    const fetchImpl = vi.fn();
    fetchImpl.mockResolvedValueOnce(new Response('plain text result', { status: 200 }));

    const t = tool({ invoke: { method: 'GET', url: 'https://api.acme.example/v1/raw' } });

    const result = await invokeRestTemplate(t, { args: {}, accessToken: 't', tokenType: 'Bearer' }, fetchImpl as unknown as typeof fetch);
    expect(result.success).toBe(true);
    expect(result.data).toBe('plain text result');
  });
});
