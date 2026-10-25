/**
 * packages/cli/src/tui/slash/__tests__/apps.test.ts
 *
 * `/apps` — the app connectors this Host has connected.
 *
 * ## What these cases pin
 *
 *  1. Every connector is listed with the fields that matter: provider,
 *     account, state and the scopes it was granted.
 *
 *  2. "No connections" and "this Host cannot answer" are different facts and
 *     are rendered differently. A Host that answers 404
 *     `app_connection_api_unavailable` must NOT be shown an empty list: the
 *     question was never asked of an authority that could answer it.
 *
 *  3. A transport failure is an error, and it says what failed.
 *
 *  4. A malformed record does not take the whole listing down.
 *
 *  5. Credentials never reach the screen, even if a payload carries them.
 *
 * The handler is called directly rather than through the registry: the
 * registry entry is another writer's file, and a test that depended on it
 * would fail here for a reason that has nothing to do with this command.
 */

import { describe, expect, it, vi } from 'vitest';

import type { HostSessionHttpClient } from '@duya/host/http-client';

import { APPS_COMMANDS } from '../apps.js';
import type { TuiSlashContext, TuiSlashHost } from '../types.js';

const SESSION_ID = 's-apps-1';

const COMMAND = APPS_COMMANDS[0];
if (COMMAND === undefined) throw new Error('the apps command is not exported');

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

/** Run `/apps` against a client whose connection read answers or fails. */
async function run(options: {
  readonly connections?: unknown;
  readonly error?: Error;
  readonly busy?: boolean;
  /** A host without a panel surface: the command must fall back to notices. */
  readonly withoutPanel?: boolean;
}): Promise<Harness> {
  const notices: string[] = [];
  const errors: string[] = [];
  const panels: Array<{ title: string; lines: readonly string[] }> = [];

  const client = {
    listAppConnections: vi.fn(async () => {
      if (options.error !== undefined) throw options.error;
      return options.connections ?? [];
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

/** One connected app. */
function connection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'c-1',
    provider: 'slack',
    accountLabel: 'ops@example.com',
    accountId: 'U123',
    scopes: ['chat:read', 'chat:write'],
    status: 'connected',
    expiresAt: null,
    lastError: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    connectionSlug: 'slack-ops',
    ...overrides,
  };
}

describe('/apps', () => {
  it('lists every connector with its provider, account, state and scopes', async () => {
    const harness = await run({
      connections: [
        connection(),
        connection({
          id: 'c-2',
          provider: 'wecom',
          accountLabel: 'Corp',
          accountId: 'corp-1',
          scopes: [],
          status: 'expired',
        }),
      ],
    });

    expect(harness.panels).toHaveLength(1);
    expect(harness.panels[0]?.title).toBe('App connections');
    const body = harness.panels[0]?.lines.join('\n') ?? '';
    expect(body).toContain('2 app connections');
    expect(body).toContain('slack');
    expect(body).toContain('ops@example.com');
    expect(body).toContain('connected');
    expect(body).toContain('chat:read, chat:write');
    expect(body).toContain('wecom');
    expect(body).toContain('expired');
    // A connector with no scopes says so instead of printing an empty cell.
    expect(body).toContain('(none)');
  });

  it('says an empty list is an empty list', async () => {
    const harness = await run({ connections: [] });

    const body = harness.panels[0]?.lines.join('\n') ?? '';
    expect(body).toContain('No app connections.');
    // The refusal wording must NOT appear here: the Host answered.
    expect(harness.output).not.toContain('cannot answer');
  });

  it('tells a Host that cannot answer apart from one with no connections', async () => {
    const harness = await run({
      error: hostError(404, 'app_connection_api_unavailable'),
    });

    const body = harness.panels[0]?.lines.join('\n') ?? '';
    expect(body).toContain('This Host does not serve the app connections, so it cannot answer.');
    expect(body).toContain('app_connection_api_unavailable');
    // It must NOT read as "no connections".
    expect(body).not.toContain('No app connections.');
  });

  it('reports a transport failure as an error', async () => {
    const harness = await run({ error: hostError(500, 'internal_error') });

    expect(harness.errors.join('\n')).toContain('Could not read the app connections');
    expect(harness.errors.join('\n')).toContain('internal_error');
  });

  it('keeps a malformed record from taking the listing down', async () => {
    const harness = await run({
      connections: [connection(), 'not-a-record', null, { provider: 'wecom' }],
    });

    const body = harness.panels[0]?.lines.join('\n') ?? '';
    expect(body).toContain('2 app connections');
    expect(body).toContain('wecom');
  });

  it('never prints credentials, even when the payload carries them', async () => {
    const harness = await run({
      connections: [connection({ accessToken: 'xoxb-secret', password: 'hunter2' })],
    });

    expect(harness.output).not.toContain('xoxb-secret');
    expect(harness.output).not.toContain('hunter2');
  });

  it('falls back to notices when the host has no panel surface', async () => {
    const harness = await run({ connections: [connection()], withoutPanel: true });

    expect(harness.panels).toHaveLength(0);
    expect(harness.notices.join('\n')).toContain('App connections');
    expect(harness.notices.join('\n')).toContain('slack');
  });

  it('reads while a turn is streaming', async () => {
    const harness = await run({ connections: [connection()], busy: true });

    expect(harness.errors).toEqual([]);
    expect(harness.panels).toHaveLength(1);
  });
});
