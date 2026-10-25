/**
 * packages/cli/src/tui/slash/__tests__/app.test.ts
 *
 * `/app` — hand this session over to the desktop app.
 *
 * ## What these cases pin
 *
 *  1. The handover names the session it handed over.
 *
 *  2. "This Host cannot answer" and "the handover failed" are different
 *     facts and are rendered differently. A Host that answers 404
 *     `session_handoff_unavailable` must NOT be reported as a failed
 *     handover: the request was never accepted by an authority that could
 *     perform it.
 *
 *  3. A Host that answers 200 with `ok: false` IS a refusal, and it says
 *     so.
 *
 *  4. A client without the handover method says so instead of crashing.
 *
 * The handler is called directly rather than through the registry: the
 * registry entry is another writer's file, and a test that depended on it
 * would fail here for a reason that has nothing to do with this command.
 */

import { describe, expect, it, vi } from 'vitest';

import type { HostSessionHttpClient } from '@duya/host/http-client';

import { APP_COMMANDS } from '../app.js';
import type { TuiSlashContext, TuiSlashHost } from '../types.js';

const SESSION_ID = 's-app-1';

const COMMAND = APP_COMMANDS[0];
if (COMMAND === undefined) throw new Error('the app command is not exported');

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

/** Run `/app` against a client whose handover answers or fails. */
async function run(options: {
  readonly answer?: unknown;
  readonly error?: Error;
  /** A client that has no handover method at all. */
  readonly withoutMethod?: boolean;
  readonly busy?: boolean;
}): Promise<Harness> {
  const notices: string[] = [];
  const errors: string[] = [];
  const panels: Array<{ title: string; lines: readonly string[] }> = [];

  const handover = vi.fn(async () => {
    if (options.error !== undefined) throw options.error;
    return options.answer ?? { ok: true };
  });
  const client = options.withoutMethod === true ? {} : { openInDesktopApp: handover };
  const tui: TuiSlashHost = {
    printNotice: (text) => { notices.push(text); },
    printError: (text) => { errors.push(text); },
    choose: async () => null,
    showPanel: (title: string, lines: readonly string[]) => { panels.push({ title, lines }); },
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

describe('/app', () => {
  it('hands the current session over and names it', async () => {
    const harness = await run({ answer: { ok: true } });

    expect(harness.errors).toEqual([]);
    expect(harness.notices.join('\n')).toContain('Handed session s-app-1 to the desktop app.');
  });

  it('tells a Host that cannot answer apart from one that refused', async () => {
    const harness = await run({
      error: hostError(404, 'session_handoff_unavailable'),
    });

    const body = harness.panels[0]?.lines.join('\n') ?? '';
    expect(body).toContain('This Host does not serve the session handover, so it cannot answer.');
    expect(body).toContain('session_handoff_unavailable');
    // It must NOT read as a failed handover.
    expect(harness.output).not.toContain('refused');
  });

  it('reports a Host that answers no as a refusal', async () => {
    const harness = await run({ answer: { ok: false } });

    expect(harness.errors.join('\n')).toContain('refused');
    expect(harness.errors.join('\n')).toContain('s-app-1');
  });

  it('reports a transport failure as an error', async () => {
    const harness = await run({ error: hostError(500, 'internal_error') });

    expect(harness.errors.join('\n')).toContain('Could not hand the session over');
    expect(harness.errors.join('\n')).toContain('internal_error');
  });

  it('says so when the client has no handover method', async () => {
    const harness = await run({ withoutMethod: true });

    expect(harness.errors.join('\n')).toContain('does not offer the handover route');
    expect(harness.panels).toHaveLength(0);
  });

  it('reports an answer that is not a handover answer as an error', async () => {
    const harness = await run({ answer: { fine: true } });

    expect(harness.errors.join('\n')).toContain('is not a handover answer');
  });
});
