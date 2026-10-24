/**
 * packages/cli/src/tui/slash/__tests__/mcp.test.ts
 *
 * `/mcp` — the MCP servers the Host was configured with.
 *
 * ## What these cases pin
 *
 *  1. Every server is listed with the fields that matter: name, state,
 *     transport and the target it connects to (the command line for a
 *     stdio server, the URL for an http one). The desktop's own
 *     `duya mcp list` shows the same set, so the two surfaces do not
 *     drift.
 *
 *  2. "No servers" and "this Host cannot answer" are different facts and
 *     are rendered differently. A Host that answers 404
 *     `mcp_inventory_unavailable` must NOT be shown an empty inventory:
 *     the question was never asked of an authority that could answer it.
 *
 *  3. A transport failure is an error, and it says what failed.
 *
 *  4. The scope line is always there. The list covers the user's own
 *     configuration only, and it says so — a user who sees a plugin's
 *     server missing must not conclude that the list is broken.
 *
 *  5. Credentials never reach the screen. The Host deliberately omits
 *     `env` and `headers`; this command must not print them even if a
 *     payload carries them.
 *
 *  6. A read works while a turn is streaming.
 *
 * The handler is called directly rather than through the registry: the
 * registry entry is another writer's file, and a test that depended on it
 * would fail here for a reason that has nothing to do with this command.
 */

import { describe, expect, it, vi } from 'vitest';

import type { HostSessionHttpClient } from '@duya/host/http-client';

import { MCP_COMMANDS } from '../mcp.js';
import type { TuiSlashContext, TuiSlashHost } from '../types.js';

const SESSION_ID = 's-mcp-1';

const COMMAND = MCP_COMMANDS[0];
if (COMMAND === undefined) throw new Error('the mcp command is not exported');

// ───────────────────────────── fixtures ─────────────────────────────

/** A Host HTTP error, shaped like the one the client throws. */
function hostError(status: number, code: string): Error {
  return Object.assign(
    new Error(`Duya Host request failed (${status}: ${code})`),
    { status, code },
  );
}

interface Harness {
  readonly notices: string[];
  readonly errors: string[];
  readonly panels: Array<{ title: string; lines: readonly string[] }>;
  /** Everything the command put on the screen, in one string. */
  readonly output: string;
}

/**
 * Run `/mcp` against a client whose inventory read answers with
 * `inventory` (or fails with `error`).
 */
async function run(options: {
  readonly inventory?: unknown;
  readonly error?: Error;
  readonly busy?: boolean;
  /** A client that has no inventory method at all. */
  readonly withoutMethod?: boolean;
  /** A host without a panel surface: the command must fall back to notices. */
  readonly withoutPanel?: boolean;
}): Promise<Harness> {
  const notices: string[] = [];
  const errors: string[] = [];
  const panels: Array<{ title: string; lines: readonly string[] }> = [];

  const client = options.withoutMethod === true
    ? {}
    : {
      listMcpServers: vi.fn(async () => {
        if (options.error !== undefined) throw options.error;
        return options.inventory ?? { servers: [] };
      }),
    };
  const tui: TuiSlashHost = {
    printNotice: (text) => { notices.push(text); },
    printError: (text) => { errors.push(text); },
    choose: async () => null,
    ...(options.withoutPanel === true
      ? {}
      : { showPanel: (title: string, lines: readonly string[]) => { panels.push({ title, lines }); } }),
  };
  const ctx = {
    client: client as unknown as HostSessionHttpClient,
    session: { id: SESSION_ID },
    tui,
    busy: options.busy ?? false,
  } as unknown as TuiSlashContext;

  await COMMAND.run(ctx, '');

  return {
    notices,
    errors,
    panels,
    output: [
      ...notices,
      ...panels.flatMap((panel) => [panel.title, ...panel.lines]),
      ...errors,
    ].join('\n'),
  };
}

/** One stdio server. */
function stdioServer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'filesystem',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
    enabled: true,
    ...overrides,
  };
}

// ───────────────────────────── cases ─────────────────────────────

describe('/mcp', () => {
  it('is a session-info command named mcp, with no aliases', () => {
    expect(COMMAND.name).toBe('mcp');
    expect(COMMAND.aliases).toBeUndefined();
    expect(COMMAND.group).toBe('Session info');
  });

  it('lists every configured server with its transport, target and state', async () => {
    const { output, errors, panels } = await run({
      inventory: {
        servers: [
          stdioServer(),
          {
            name: 'remote',
            transport: 'streamable-http',
            url: 'https://example.com/mcp',
            enabled: false,
          },
        ],
      },
    });

    expect(errors).toEqual([]);
    expect(panels).toHaveLength(1);
    expect(panels[0]?.title).toBe('MCP servers');
    expect(output).toContain('2 MCP servers configured');
    // The stdio server: name, state, transport and the command line, in
    // one row — so a field that moved to another row fails here.
    expect(output).toMatch(/filesystem\s+on\s+stdio\s+npx -y @modelcontextprotocol\/server-filesystem \/tmp/);
    // The http server: the same fields, the URL as its target.
    expect(output).toMatch(/remote\s+off\s+streamable-http\s+https:\/\/example\.com\/mcp/);
    // A rendered list, not a JSON dump.
    expect(output).not.toContain('"transport"');
  });

  it('says plainly when no servers are configured', async () => {
    const { output, errors } = await run({ inventory: { servers: [] } });

    expect(errors).toEqual([]);
    expect(output).toContain('No MCP servers are configured');
  });

  it('says the Host cannot answer when the inventory is unavailable', async () => {
    const { output, errors } = await run({
      error: hostError(404, 'mcp_inventory_unavailable'),
    });

    // Not an empty inventory: the question was never asked of an
    // authority that could answer it.
    expect(output).not.toContain('No MCP servers are configured');
    expect(output).toContain('does not serve the MCP inventory');
    expect(output).toContain('mcp_inventory_unavailable');
    expect(errors).toEqual([]);
  });

  it('reports a transport failure as an error', async () => {
    const { output, errors, panels } = await run({
      error: new Error('connect ECONNREFUSED 127.0.0.1:4321'),
    });

    expect(errors.join('\n')).toContain('Could not read the MCP inventory');
    expect(errors.join('\n')).toContain('ECONNREFUSED');
    // No listing is shown for a read that failed.
    expect(panels).toEqual([]);
    expect(output).not.toContain('MCP servers configured');
  });

  it('reports a payload that is not an inventory', async () => {
    const { errors, panels } = await run({ inventory: { unexpected: true } });

    expect(errors.join('\n')).toContain('not an inventory');
    expect(panels).toEqual([]);
  });

  it('states what the list does not cover', async () => {
    const { output } = await run({ inventory: { servers: [stdioServer()] } });

    // Plugin-declared servers are not in this list, and there is no live
    // connection status or tool list here.
    expect(output).toContain('plugin-declared MCP servers are not listed');
    expect(output).toContain('no live connection status or tool list');
  });

  it('states the scope even when nothing is configured', async () => {
    const { output } = await run({ inventory: { servers: [] } });

    expect(output).toContain('plugin-declared MCP servers are not listed');
  });

  it('never prints credentials', async () => {
    const { output } = await run({
      inventory: {
        servers: [
          stdioServer({
            env: { MCP_TOKEN: 'secret-token-value' },
            headers: { Authorization: 'Bearer secret-header-value' },
          }),
        ],
      },
    });

    expect(output).not.toContain('secret-token-value');
    expect(output).not.toContain('secret-header-value');
    expect(output).not.toContain('MCP_TOKEN');
  });

  it('skips a malformed entry instead of failing the whole listing', async () => {
    const { output, errors } = await run({
      inventory: { servers: ['not-an-object', stdioServer({ name: 'good' })] },
    });

    expect(errors).toEqual([]);
    expect(output).toContain('1 MCP server configured');
    expect(output).toMatch(/good\s+on\s+stdio/);
  });

  it('works while a turn is streaming, because a listing is a read', async () => {
    const { output, errors } = await run({
      inventory: { servers: [stdioServer()] },
      busy: true,
    });

    expect(errors).toEqual([]);
    expect(output).toMatch(/filesystem\s+on\s+stdio/);
  });

  it('falls back to plain notices when the host has no panel surface', async () => {
    const { notices, panels } = await run({
      inventory: { servers: [stdioServer()] },
      withoutPanel: true,
    });

    expect(panels).toEqual([]);
    expect(notices.join('\n')).toMatch(/filesystem\s+on\s+stdio/);
  });

  it('says so when its own Host client has no inventory method', async () => {
    const { errors } = await run({ withoutMethod: true });

    expect(errors.join('\n')).toContain('cannot read the MCP inventory');
  });
});
