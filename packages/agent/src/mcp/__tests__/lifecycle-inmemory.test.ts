/**
 * Plan 580 Phase 2.5 — Lifecycle Truth (chain A integration layer).
 *
 * Drives the REAL `MCPClient` (the chain-A production class) against a
 * real MCP SDK server over `InMemoryTransport`, injected through the
 * `buildTransport` seam — no subprocess, no HTTP:
 *
 *   1) server-side tool add + `notifications/tools/list_changed` →
 *      debounced (500ms) transactional rediscovery replaces the tool
 *      set and fires `onToolsChanged` — the hook `MCPManager` uses to
 *      replace-set the agent registry (plan 580 §D2).
 *   2) a forced transport close → `onclose` (the ONLY death signal,
 *      §D2) → status `degraded` → `callTool` fails fast with
 *      `MCP_TRANSPORT` instead of hanging on the SDK default timeout.
 */

import { describe, it, expect, vi } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { MCPClient } from '../index.js';
import type { MCPServerConfig } from '../../types.js';

// ─── Fixture: real in-memory MCP server + injectable client transport ──

async function createFixture(initialTools: string[]) {
  let tools = [...initialTools];
  let failNext: Error | undefined;
  const server = new Server(
    { name: 'lifecycle-fixture', version: '0.0.1' },
    { capabilities: { tools: { listChanged: true } } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (failNext) {
      const err = failNext;
      failNext = undefined;
      throw err;
    }
    return {
      tools: tools.map((name) => ({
        name,
        description: `fixture tool ${name}`,
        inputSchema: { type: 'object', properties: {} },
      })),
    };
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  return {
    clientTransport,
    setTools: (names: string[]) => {
      tools = [...names];
    },
    failNextList: (err?: Error) => {
      failNext = err ?? new Error('fetch failed: ECONNRESET');
    },
    notifyChanged: () => {
      void server.notification({ method: 'notifications/tools/list_changed' });
    },
    close: async () => {
      await server.close().catch(() => undefined);
    },
  };
}

/** Production `MCPClient` with the transport swapped for the fixture pair. */
class TestMCPClient extends MCPClient {
  private injected: Transport | null = null;

  setInjectedTransport(t: Transport): void {
    this.injected = t;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected override buildTransport(): Transport {
    if (!this.injected) throw new Error('fixture did not inject a transport');
    return this.injected;
  }
}

function makeConfig(name: string): MCPServerConfig {
  // `buildTransport` is overridden, so the stdio command is never used.
  return { name, transport: 'stdio', command: 'unused-by-fixture' };
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe('chain A lifecycle truth (plan 580 Phase 2.5)', () => {
  it('server-side tool add + list_changed → debounced rediscovery replaces the tool set and fires onToolsChanged', async () => {
    const fx = await createFixture(['alpha']);
    const client = new TestMCPClient(makeConfig('lifecycle-a'));
    client.setInjectedTransport(fx.clientTransport);
    const changedFrom: string[] = [];
    client.setOnToolsChanged((name) => changedFrom.push(name));

    await client.connect();
    expect(client.getStatus()).toBe('connected');
    expect(client.getTools().map((t) => t.name)).toEqual(['alpha']);

    // Server-side add + the notification the SDK delivers to the REAL
    // setNotificationHandler registered during connect().
    fx.setTools(['alpha', 'beta', 'gamma']);
    fx.notifyChanged();

    // 500ms debounce + rediscovery; poll instead of fixed sleeps.
    await vi.waitFor(
      () => {
        expect(client.getTools().map((t) => t.name)).toEqual(['alpha', 'beta', 'gamma']);
      },
      { timeout: 4_000, interval: 50 },
    );
    expect(changedFrom).toEqual(['lifecycle-a']);
    expect(client.getStatus()).toBe('connected'); // replace-set ≠ availability change

    await client.disconnect().catch(() => undefined);
    await fx.close();
  });

  it('forced transport close → status degraded → callTool fails fast with MCP_TRANSPORT', async () => {
    const fx = await createFixture(['alpha']);
    const client = new TestMCPClient(makeConfig('lifecycle-b'));
    client.setInjectedTransport(fx.clientTransport);

    await client.connect();
    expect(client.getStatus()).toBe('connected');
    expect(client.getTools().length).toBe(1);

    // Force-close the CLIENT side of the pair — onclose is the only
    // death signal (plan 580 §D2; no speculative reconnect detection).
    await fx.clientTransport.close();
    expect(client.getStatus()).toBe('degraded');

    // Degraded → fail-fast error result, never a 120s hang.
    const result = await client.callTool('alpha', {});
    expect(result.error).toBe(true);
    expect(result.result).toContain('[MCP_TRANSPORT]');

    await fx.close();
  });

  it('failed rediscovery (server list error) keeps last-known inventory (D6)', async () => {
    const fx = await createFixture(['alpha', 'beta']);
    const client = new TestMCPClient(makeConfig('lifecycle-c'));
    client.setInjectedTransport(fx.clientTransport);
    const changedFrom: string[] = [];
    client.setOnToolsChanged((name) => changedFrom.push(name));

    await client.connect();
    expect(client.getTools().map((t) => t.name)).toEqual(['alpha', 'beta']);

    // Server tools/list now throws; still notify → rediscovery fails →
    // last-known inventory survives, callback never fires.
    fx.setTools(['should-never-appear']);
    fx.failNextList(new Error('fetch failed: ECONNRESET'));
    fx.notifyChanged();
    await new Promise((r) => setTimeout(r, 900)); // > debounce + failure window
    expect(client.getTools().map((t) => t.name)).toEqual(['alpha', 'beta']);
    expect(changedFrom).toEqual([]);

    // Recovery: the next list succeeds → replace-set commit fires.
    fx.setTools(['alpha', 'beta', 'gamma']);
    fx.notifyChanged();
    await vi.waitFor(
      () => {
        expect(client.getTools().map((t) => t.name)).toEqual(['alpha', 'beta', 'gamma']);
      },
      { timeout: 4_000, interval: 50 },
    );
    expect(changedFrom).toEqual(['lifecycle-c']);

    await client.disconnect().catch(() => undefined);
    await fx.close();
  });
});
