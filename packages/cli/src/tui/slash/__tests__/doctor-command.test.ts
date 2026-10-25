/**
 * `/doctor` — the CLI's face of the shared diagnostic.
 *
 * ## What this pins
 *
 * The panel is the only thing a user sees, so two things matter there:
 *
 *  1. it groups by the SHARED category list, so the panel and the `duya
 *     doctor` command describe the same report;
 *  2. it separates "this Host could not answer" from "this check failed".
 *
 * The second is the one worth a test. The CLI is routinely used with no
 * desktop app running — that is the normal case for a CLI-only install — and
 * a panel that rendered that as `[ERROR]` would make a healthy install look
 * broken while training the reader to ignore the errors.
 */

import { describe, expect, it, vi } from 'vitest';

import { DOCTOR_COMMANDS } from '../doctor.js';
import { resolveTuiSlashCommand } from '../registry.js';
import type { TuiSlashContext } from '../types.js';

const state = vi.hoisted(() => ({ hostReachable: false }));

vi.mock('@duya/host/agent-profile-config', () => ({
  resolveConfigRoot: () => '/tmp/duya-doctor-slash-test',
}));

vi.mock('../../../commands/doctor-probe.js', () => ({
  resolveRuntimeFact: async () => ({ kind: 'absent' as const, reason: 'runtime file not found' }),
  createDesktopCliApiProbe: () => ({
    probeStatus: async () => (state.hostReachable
      ? { kind: 'known' as const, value: { statusCode: 200, authFailed: false, serverError: false } }
      : { kind: 'unavailable' as const, reason: 'DUYA is not running. Open the DUYA app and retry.' }),
    listPlugins: async () => (state.hostReachable
      ? { kind: 'known' as const, value: { count: 2 } }
      : { kind: 'unavailable' as const, reason: 'DUYA is not running. Open the DUYA app and retry.' }),
    querySessions: async () => (state.hostReachable
      ? { kind: 'known' as const, value: { hasSessions: true } }
      : { kind: 'unavailable' as const, reason: 'DUYA is not running. Open the DUYA app and retry.' }),
  }),
}));

const COMMAND = DOCTOR_COMMANDS[0]!;

async function runPanel(): Promise<string> {
  const panels: string[][] = [];
  const ctx = {
    client: {},
    session: { id: 'session-1' },
    tui: {
      printNotice: () => {},
      printError: () => {},
      showPanel: (_title: string, lines: readonly string[]) => { panels.push([...lines]); },
    },
    busy: false,
  } as unknown as TuiSlashContext;

  await COMMAND.run(ctx, '');
  const last = panels[panels.length - 1];
  expect(last, 'the command must show a panel').toBeDefined();
  return (last ?? []).join('\n');
}

describe('/doctor', () => {
  it('is reachable as a slash command', () => {
    expect(resolveTuiSlashCommand('doctor')).toBe(COMMAND);
  });

  it('groups the report by the shared category list', async () => {
    state.hostReachable = true;
    const panel = await runPanel();

    expect(panel).toContain('[config]');
    expect(panel).toContain('[runtime]');
    expect(panel).toContain('[desktop]');
    expect(panel).toContain('[plugin]');
    expect(panel).toContain('[session]');
    // The categories appear in the shared list's order.
    const order = [...panel.matchAll(/^ {2}\[(\w+)\]/gm)].map((match) => match[1]);
    expect(order).toEqual(['config', 'runtime', 'desktop', 'plugin', 'session']);
  });

  it('reports an unreachable Host as not checked, never as an error', async () => {
    state.hostReachable = false;
    const panel = await runPanel();

    expect(panel).not.toContain('[ERROR]');
    // The groups whose checks never ran say so.
    expect(panel).toContain('[desktop]  (not checked)');
    expect(panel).toContain('[plugin]  (not checked)');
    expect(panel).toContain('[session]  (not checked)');
    // And the reason is on the screen, so the reader is not left guessing.
    expect(panel).toContain('DUYA is not running');
  });

  it('reports the facts a reachable Host returned', async () => {
    state.hostReachable = true;
    const panel = await runPanel();

    expect(panel).toContain('[OK]');
    expect(panel).toContain('2 plugins registered');
    expect(panel).not.toContain('(not checked)');
  });
});
