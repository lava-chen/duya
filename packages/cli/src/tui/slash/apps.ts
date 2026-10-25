/**
 * packages/cli/src/tui/slash/apps.ts
 *
 * `/apps` — the app connectors (slack, google, microsoft365, wecom,
 * qq-mail, remote-mcp, …) this Host has connected.
 *
 * ## Why the CLI asks the Host
 *
 * The TUI is a pure HTTP client of the Host (see packages/cli/src/chat.ts),
 * so the connector list is a Host read: `GET /v1/local/app-connections`.
 * The client unwraps the envelope and hands back the connection records.
 *
 * ## Credentials never travel
 *
 * A connection record carries the provider, the account label, the granted
 * scopes and the state — never a token, a secret or a password. That is the
 * Host's contract, and this command does not ask for anything else, so
 * nothing sensitive can reach the terminal through it.
 *
 * ## "No connections" and "this Host cannot answer" are different answers
 *
 * A Host without the app-connection API answers 404
 * `app_connection_api_unavailable`. That is not "no connectors are
 * connected" — it is "this Host cannot answer the question", and the two
 * are rendered differently. An empty list is a fact that was observed; a
 * refusal is not, and a panel that said "no connections" for a Host that
 * never answered would report a fact it never observed.
 */

import type { TuiSlashCommandDef, TuiSlashContext } from './types.js';
import { describeError, hostErrorCode, showPanel } from './shared.js';

const FOOTER = '↑↓ / PgUp / PgDn scroll · Esc close';

/** One connected app, as the Host reports it. */
interface AppConnectionEntry {
  readonly provider: string;
  readonly accountLabel: string;
  readonly accountId: string;
  readonly status: string;
  readonly scopes: readonly string[];
  readonly lastError: string | null;
}

/**
 * Narrow one unknown record into the fields this command shows.
 *
 * The payload arrives over HTTP as JSON, so the declared type describes the
 * happy path and not a guarantee: one malformed entry must not take the
 * whole listing down.
 */
function narrowConnection(value: unknown): AppConnectionEntry | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const rawScopes = record['scopes'];
  const scopes = Array.isArray(rawScopes)
    ? (rawScopes as unknown[]).filter((scope): scope is string => typeof scope === 'string')
    : [];
  const lastError = record['lastError'];
  return {
    provider: typeof record['provider'] === 'string' ? record['provider'] : '',
    accountLabel: typeof record['accountLabel'] === 'string' ? record['accountLabel'] : '',
    accountId: typeof record['accountId'] === 'string' ? record['accountId'] : '',
    status: typeof record['status'] === 'string' ? record['status'] : 'unknown',
    scopes,
    lastError: typeof lastError === 'string' && lastError !== '' ? lastError : null,
  };
}

/**
 * The connections in a payload.
 *
 * `undefined` means the payload is not a connection list at all — a
 * different fact from "no connector is connected", and one the caller has to
 * report differently.
 */
function readConnections(payload: unknown): readonly AppConnectionEntry[] | undefined {
  if (!Array.isArray(payload)) return undefined;
  const connections: AppConnectionEntry[] = [];
  for (const item of payload) {
    const entry = narrowConnection(item);
    if (entry !== undefined) connections.push(entry);
  }
  return connections;
}

/** The listing, one row per connector. */
function connectionLines(connections: readonly AppConnectionEntry[]): string[] {
  if (connections.length === 0) {
    return [
      'No app connections.',
      '',
      '  This Host stores the connection metadata only — the credentials never',
      '  reach it, and this command never asks for them.',
    ];
  }

  const rows = connections.map((entry) => ({
    provider: entry.provider !== '' ? entry.provider : '(unknown)',
    account: entry.accountLabel !== '' ? entry.accountLabel : entry.accountId || '(no account)',
    status: entry.status,
    scopes: entry.scopes.length === 0 ? '(none)' : entry.scopes.join(', '),
  }));
  const providerWidth = Math.max(8, ...rows.map((row) => row.provider.length));
  const accountWidth = Math.max(7, ...rows.map((row) => row.account.length));
  const statusWidth = Math.max(6, ...rows.map((row) => row.status.length));

  const lines = [`${rows.length} app connection${rows.length === 1 ? '' : 's'}`];
  for (const [index, row] of rows.entries()) {
    lines.push(
      `  ${row.provider.padEnd(providerWidth)}  ${row.account.padEnd(accountWidth)}  `
      + `${row.status.padEnd(statusWidth)}  ${row.scopes}`,
    );
    const lastError = connections[index]?.lastError;
    if (lastError !== null && lastError !== undefined) {
      lines.push(`  ${' '.repeat(providerWidth + 2 + accountWidth + 2)}last error: ${lastError}`);
    }
  }
  return lines;
}

const APPS_COMMAND: TuiSlashCommandDef = {
  name: 'apps',
  description: 'List the connected app connectors',
  group: 'Session info',
  async run(ctx: TuiSlashContext) {
    let payload: unknown;
    try {
      payload = await ctx.client.listAppConnections();
    } catch (error) {
      // A Host without the app-connection API cannot answer. That is not the
      // same as an empty list, and it is rendered differently.
      if (hostErrorCode(error) === 'app_connection_api_unavailable') {
        showPanel(ctx, 'App connections', [
          'This Host does not serve the app connections, so it cannot answer.',
          '',
          '  That is different from "no app connections" — here the question was',
          '  never asked of an authority that could answer it.',
          '',
          '  Source: Host app connections (GET /v1/local/app-connections),',
          '  404 app_connection_api_unavailable.',
        ], { footer: FOOTER, scrollable: true });
        return { kind: 'handled' };
      }
      ctx.tui.printError(`Could not read the app connections: ${describeError(error)}`);
      return { kind: 'handled' };
    }

    const connections = readConnections(payload);
    if (connections === undefined) {
      ctx.tui.printError(
        'Could not read the app connections: the Host answered with something that is not a connection list.',
      );
      return { kind: 'handled' };
    }

    showPanel(ctx, 'App connections', connectionLines(connections), { footer: FOOTER, scrollable: true });
    return { kind: 'handled' };
  },
};

export const APPS_COMMANDS: readonly TuiSlashCommandDef[] = [APPS_COMMAND];
