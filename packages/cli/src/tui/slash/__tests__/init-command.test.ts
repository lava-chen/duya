/**
 * `/init` — the CLI's face of the AGENTS.md write.
 *
 * ## What this pins
 *
 * The write happens on the HOST, and the CLI only reports what came back.
 * Three things matter in that reporting:
 *
 *  1. "created", "upgraded" and "left alone" are different facts, and the
 *     command says which one happened;
 *  2. a file without a duya marker was the USER's own — overwriting it is
 *     reported as such rather than passed over quietly;
 *  3. a Host that cannot write into a workspace is not a failed write.
 */

import { describe, expect, it } from 'vitest';

import { INIT_COMMANDS } from '../init.js';
import type { TuiSlashContext } from '../types.js';

const COMMAND = INIT_COMMANDS[0]!;

interface RunOutcome {
  readonly notices: string[];
  readonly errors: string[];
}

async function runWith(client: unknown): Promise<RunOutcome> {
  const notices: string[] = [];
  const errors: string[] = [];
  const ctx = {
    client,
    session: { id: 'session-1' },
    tui: {
      printNotice: (message: string) => notices.push(message),
      printError: (message: string) => errors.push(message),
      showPanel: () => {},
    },
    busy: false,
  } as unknown as TuiSlashContext;

  await COMMAND.run(ctx, '');
  return { notices, errors };
}

describe('/init', () => {
  it('reports a created file', async () => {
    const outcome = await runWith({
      async writeAgentsMd(sessionId: string) {
        expect(sessionId).toBe('session-1');
        return {
          ok: true,
          path: '/repo/AGENTS.md',
          created: true,
          upgraded: false,
          unchanged: false,
          version: 1,
        };
      },
    });

    expect(outcome.errors).toEqual([]);
    expect(outcome.notices.join('\n')).toContain('/repo/AGENTS.md');
    expect(outcome.notices.join('\n')).toContain('Created');
  });

  it('reports a file that was left alone as unchanged', async () => {
    const outcome = await runWith({
      async writeAgentsMd() {
        return {
          ok: true,
          path: '/repo/AGENTS.md',
          created: false,
          upgraded: false,
          unchanged: true,
          version: 1,
        };
      },
    });

    expect(outcome.errors).toEqual([]);
    expect(outcome.notices.join('\n')).toContain('already current');
  });

  it('says out loud that a file without a marker was the user\'s own', async () => {
    const outcome = await runWith({
      async writeAgentsMd() {
        return {
          ok: true,
          path: '/repo/AGENTS.md',
          created: false,
          upgraded: true,
          unchanged: false,
          version: 1,
          replacedUnmarked: true,
        };
      },
    });

    expect(outcome.errors).toEqual([]);
    expect(outcome.notices.join('\n')).toContain('no duya marker');
  });

  it('reports a refusal from the Host as an error', async () => {
    const outcome = await runWith({
      async writeAgentsMd() {
        return {
          ok: false,
          created: false,
          upgraded: false,
          unchanged: false,
          version: 0,
          error: 'This session has no working directory.',
        };
      },
    });

    expect(outcome.errors.join('\n')).toContain('no working directory');
    expect(outcome.notices).toEqual([]);
  });

  it('says so when the client cannot write at all', async () => {
    const outcome = await runWith({});

    expect(outcome.errors.join('\n')).toContain('does not offer the write route');
    expect(outcome.notices).toEqual([]);
  });
});
