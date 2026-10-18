/**
 * `/capabilities` — the production caller of the capability handshake.
 *
 * ## What this pins
 *
 * The gate exists and is tested on its own; this pins that a user can actually
 * SEE it. A refusal that never reaches the screen is the D9 shape of problem
 * again: the capability is absent, the code correctly refuses, and the person
 * at the keyboard has no idea why the feature did not work.
 *
 * ## The control in the second case
 *
 * "The command printed a refusal" is also what you would see if the command
 * refused everything. The second case shows the same command reporting the
 * capability as available, so the first case is a fact about this Host rather
 * than a property of the command.
 */
import { describe, expect, it, vi } from 'vitest';
import type { HostHandshakeV1 } from '@duya/host/http-client';
import { CAPABILITIES_COMMANDS } from '../slash/capabilities.js';
import { resolveTuiSlashCommand } from '../slash/registry.js';
import type { TuiSlashContext } from '../slash/types.js';

const COMMAND = CAPABILITIES_COMMANDS[0]!;

async function run(handshake: HostHandshakeV1): Promise<{ notices: string[]; errors: string[]; readIssued: boolean }> {
  const notices: string[] = [];
  const errors: string[] = [];
  // The read is the thing the gate is supposed to prevent. Recording whether it
  // was reached is what separates "refused" from "refused, then tried anyway".
  const importRollout = vi.fn();
  const ctx = {
    client: { handshake: vi.fn(async () => handshake), importRollout },
    session: { id: 'session-1' },
    tui: { printNotice: (text: string) => void notices.push(text), printError: (message: string) => void errors.push(message) },
    busy: false,
  } as unknown as TuiSlashContext;

  await COMMAND.run(ctx, '');
  return { notices, errors, readIssued: importRollout.mock.calls.length > 0 };
}

describe('/capabilities', () => {
  it('is reachable as a slash command', () => {
    expect(resolveTuiSlashCommand('capabilities')).toBe(COMMAND);
  });

  it('states the Host reason when the capability is refused', async () => {
    const { notices, readIssued } = await run({
      ok: true,
      host: { name: 'duya-host', version: '0.1.0', kind: 'headless' },
      provides: ['session_persistence'],
      unsupported: { workspace_filesystem: 'Host duya-host registers no channel that serves it' },
    });

    const printed = notices.join('\n');
    expect(printed).toContain('Host duya-host 0.1.0');
    expect(printed).toContain('provides (1): session_persistence');
    // The verdict line and the Host's own sentence are separate lines, and the
    // capability is named once — `describeRefusal` already names it, so an
    // inline prefix printed it twice.
    expect(printed).toContain('  workspace_filesystem: unavailable\n    ');
    expect(printed).toContain('does not provide workspace_filesystem');
    expect(printed).toContain('Host duya-host registers no channel that serves it');
    expect(readIssued).toBe(false);
  });

  it('reports the capability as available when the Host serves it', async () => {
    // The control: same command, different Host. Without it, the refusal case
    // above could not be told from "this command always refuses".
    const { notices } = await run({
      ok: true,
      host: { name: 'duya-host', version: '0.1.0', kind: 'headless' },
      provides: ['session_persistence', 'workspace_filesystem'],
      unsupported: { some_other_capability: 'not wired' },
    });

    const printed = notices.join('\n');
    expect(printed).toContain('provides (2): session_persistence, workspace_filesystem');
    expect(printed).toContain('workspace_filesystem: available');
  });

  it('does not report an undeclaring Host as serving nothing', async () => {
    // `provides: []` and "no `provides` field at all" are different facts, and
    // printing an empty list for the second claims the Host serves nothing,
    // which is a statement nobody made.
    const silent = await run({ ok: true, host: { name: 'duya-host', version: '0.1.0', kind: 'headless' } });
    expect(silent.notices.join('\n')).toContain('provides: not declared');

    const empty = await run({ ok: true, host: { name: 'duya-host', version: '0.1.0', kind: 'headless' }, provides: [] });
    expect(empty.notices.join('\n')).toContain('provides (0): (none)');
  });
});
