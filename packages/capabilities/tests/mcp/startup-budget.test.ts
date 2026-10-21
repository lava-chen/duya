/**
 * The MCP startup budget is ONE budget, not one per phase.
 *
 * ## What this pins
 *
 * `DEFAULT_STARTUP_TIMEOUT_MS` is documented as "spawn + handshake + listTools"
 * — a single allowance for the whole startup. `connect()` used to spend that
 * allowance twice: `withTimeout(..., startupMs, ...)` for the handshake, and
 * then `createDeadlineClock(startupMs)` — the same `startupMs`, in full again —
 * for the discovery pass. A server could therefore take up to twice its
 * documented budget before being declared unreachable.
 *
 * The fixture makes that observable: the handshake and the `tools/list` are each
 * given less than the budget on their own, and more than the budget together.
 * Correct is failure. The old code reported success.
 *
 * `deadline.ts` states the contract this call site was violating — "every tool
 * call / discovery pass produces ONE deadline" (plan 580 §D5) — and the second
 * test exists so that "fix" it by shrinking the budget arbitrarily cannot pass:
 * a server whose work genuinely fits must still connect.
 *
 * No subprocess and no network: the same real `MCPClient` and real SDK server
 * over `InMemoryTransport` that `lifecycle-inmemory.test.ts` uses, with the
 * handshake delay injected by wrapping the client's transport.
 */

import { describe, it, expect } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type {
  MessageExtraInfo,
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { MCPClient } from '../../src/MCP/MCPManager.js';
import type { MCPServerConfig } from '../../src/MCP/ports.js';

const HANDSHAKE_DELAY_MS = 600;
const LIST_DELAY_MS = 600;
/**
 * Budgets are chosen so every assertion holds under proportional slowdown.
 *
 * A loaded CI runner stretches every timer by some factor. A test that passes
 * with 150ms of headroom locally can fail there for reasons that have nothing
 * to do with the code under test, so each case keeps a wide margin instead:
 * "over budget" is over by 2x, "fits" has 5x the room it needs.
 */
const OVER_BUDGET_MS = 900;
const ROOMY_BUDGET_MS = 3_000;
const SINGLE_PHASE_BUDGET_MS = 250;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Delay the first outbound message — the `initialize` request — so the
 * handshake costs real wall-clock time without a slow server.
 *
 * The event forwarding in the constructor is load-bearing: the SDK installs
 * `onmessage`/`onclose`/`onerror` on whatever transport it is handed, so a
 * wrapper that only forwards `send` swallows every response and makes
 * `connect()` hang forever. That failure looks like a timeout, which means a
 * test asserting "this times out" would pass for entirely the wrong reason.
 */
class SlowHandshakeTransport implements Transport {
  private sent = 0;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  constructor(
    private readonly inner: Transport,
    private readonly delayMs: number,
  ) {
    inner.onmessage = (message, extra) => { this.onmessage?.(message, extra); };
    inner.onerror = (error) => { this.onerror?.(error); };
    inner.onclose = () => { this.onclose?.(); };
  }

  get sessionId(): string | undefined {
    return this.inner.sessionId;
  }

  async start(): Promise<void> {
    await this.inner.start();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    this.sent += 1;
    if (this.sent === 1) await sleep(this.delayMs);
    await this.inner.send(message, options);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}

async function createFixture(options: { listDelayMs: number }): Promise<{
  clientTransport: Transport;
  close: () => Promise<void>;
}> {
  const server = new Server(
    { name: 'startup-budget-fixture', version: '0.0.1' },
    { capabilities: { tools: { listChanged: true } } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (options.listDelayMs > 0) await sleep(options.listDelayMs);
    return {
      tools: [
        {
          name: 'alpha',
          description: 'fixture tool alpha',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    };
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return {
    clientTransport,
    close: async () => { await server.close().catch(() => undefined); },
  };
}

class TestMCPClient extends MCPClient {
  private injected: Transport | null = null;

  setInjectedTransport(transport: Transport): void {
    this.injected = transport;
  }

  protected override buildTransport(): Transport {
    if (!this.injected) throw new Error('fixture did not inject a transport');
    return this.injected;
  }
}

function makeConfig(startupTimeoutMs: number): MCPServerConfig {
  // `buildTransport` is overridden, so the stdio command is never used.
  return {
    name: 'startup-budget',
    transport: 'stdio',
    command: 'unused-by-fixture',
    startupTimeoutSec: startupTimeoutMs / 1000,
  };
}

describe('MCP startup budget covers the whole startup', () => {
  it('fails when the handshake and discovery together exceed one budget', async () => {
    // Each phase fits the budget alone. Together they do not. Handing discovery
    // a fresh clock is what let this configuration through.
    const fx = await createFixture({ listDelayMs: LIST_DELAY_MS });
    const client = new TestMCPClient(makeConfig(OVER_BUDGET_MS));
    client.setInjectedTransport(new SlowHandshakeTransport(fx.clientTransport, HANDSHAKE_DELAY_MS));

    await expect(client.connect()).rejects.toThrow(/timed out|deadline/i);

    expect(client.isConnected()).toBe(false);
    await fx.close();
  });

  it('connects when the same work fits the single budget', async () => {
    // The guard against "fix" it by shrinking the budget. 600 + 600 against
    // 3000ms is comfortable, and the fixture is otherwise identical.
    const fx = await createFixture({ listDelayMs: LIST_DELAY_MS });
    const client = new TestMCPClient(makeConfig(ROOMY_BUDGET_MS));
    client.setInjectedTransport(new SlowHandshakeTransport(fx.clientTransport, HANDSHAKE_DELAY_MS));

    await client.connect();

    expect(client.isConnected()).toBe(true);
    expect(client.getTools().map((tool) => tool.name)).toContain('alpha');
    await client.disconnect();
    await fx.close();
  });

  it('still fails when the handshake alone exceeds the budget', async () => {
    // The pre-existing per-phase bound has to survive: one budget for the
    // startup does not mean "no bound on any single phase".
    const fx = await createFixture({ listDelayMs: 0 });
    const client = new TestMCPClient(makeConfig(SINGLE_PHASE_BUDGET_MS));
    client.setInjectedTransport(new SlowHandshakeTransport(fx.clientTransport, 900));

    await expect(client.connect()).rejects.toThrow(/timed out|deadline/i);

    expect(client.isConnected()).toBe(false);
    await fx.close();
  });
});
