/**
 * `/read-file` — the production CONSUMER of `workspace_filesystem`.
 *
 * ## What this pins
 *
 * `/capabilities` prints the negotiation; this command is what makes the
 * advertised capability mean something. Two things have to be true for that, and
 * only the second is about printing:
 *
 *  1. the command asks the Host for a file at all, addressed by WORKSPACE ID
 *     and a relative path — never a host filesystem path;
 *  2. when the Host refuses the capability, no request is issued.
 *
 * ## The control in the refusal case
 *
 * "The command printed a refusal" is also what a command that fails for an
 * unrelated reason would print. So the refusal case asserts an EMPTY call log
 * on the client — the read was never attempted — and the success case is the
 * opposing direction on the same fixture, so a command that refused everything
 * cannot pass both.
 */
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceId } from '@duya/agent-protocol';
import type { HostHandshakeV1 } from '@duya/host/http-client';
import { READ_FILE_COMMANDS } from '../slash/read-file.js';
import { resolveTuiSlashCommand } from '../slash/registry.js';
import type { TuiSlashContext } from '../slash/types.js';

const COMMAND = READ_FILE_COMMANDS[0]!;
const WORKSPACE_ID = 'ws-read-file' as WorkspaceId;

const SERVING: HostHandshakeV1 = {
  ok: true,
  host: { name: 'duya-host', version: '0.1.0', kind: 'headless' },
  provides: ['session_persistence', 'workspace_filesystem'],
  unsupported: {},
};

const REFUSING: HostHandshakeV1 = {
  ok: true,
  host: { name: 'duya-host', version: '0.1.0', kind: 'headless' },
  provides: ['session_persistence'],
  unsupported: { workspace_filesystem: 'Host duya-host registers no channel that serves it' },
};

interface Harness {
  readonly notices: string[];
  readonly errors: string[];
  readonly calls: Array<{ workspaceId: string; relativePath: string }>;
}

async function run(options: {
  readonly handshake: HostHandshakeV1;
  readonly args: string;
  readonly workspace?: { readonly state: 'bound'; readonly workspaceId: WorkspaceId } | { readonly state: 'legacy_unbound' };
}): Promise<Harness> {
  const notices: string[] = [];
  const errors: string[] = [];
  const calls: Array<{ workspaceId: string; relativePath: string }> = [];
  const readWorkspaceFile = vi.fn(async (input: { workspaceId: string; relativePath: string }) => {
    calls.push({ workspaceId: input.workspaceId, relativePath: input.relativePath });
    return {
      workspaceId: input.workspaceId as WorkspaceId,
      relativePath: input.relativePath,
      totalBytes: 21,
      content: 'notes from the Host\n',
      truncated: false,
    };
  });
  const ctx = {
    client: { handshake: vi.fn(async () => options.handshake), readWorkspaceFile },
    session: {
      id: 'session-1',
      workspace: options.workspace ?? { state: 'bound', workspaceId: WORKSPACE_ID },
    },
    tui: {
      printNotice: (text: string) => void notices.push(text),
      printError: (message: string) => void errors.push(message),
    },
    busy: false,
  } as unknown as TuiSlashContext;

  await COMMAND.run(ctx, options.args);
  return { notices, errors, calls };
}

describe('/read-file', () => {
  it('is reachable as a slash command', () => {
    expect(resolveTuiSlashCommand('read-file')).toBe(COMMAND);
  });

  it('reads the file through the Host, addressed by workspace identity', async () => {
    const { notices, errors, calls } = await run({ handshake: SERVING, args: 'notes.md' });

    expect(errors).toEqual([]);
    // Workspace ID plus a relative path. No host path is ever constructed here,
    // which is the whole reason the route takes these two fields.
    expect(calls).toEqual([{ workspaceId: WORKSPACE_ID, relativePath: 'notes.md' }]);
    expect(notices.join('\n')).toContain('notes from the Host');
    expect(notices.join('\n')).toContain('notes.md — 21 bytes');
  });

  it('issues no read at all when the Host refuses the capability', async () => {
    const { errors, calls } = await run({ handshake: REFUSING, args: 'notes.md' });

    // The point of the gate: a refusal costs one handshake, not a failed read.
    expect(calls).toEqual([]);
    expect(errors.join('\n')).toContain('does not provide workspace_filesystem');
    // The Host's own sentence, not a paraphrase of it.
    expect(errors.join('\n')).toContain('registers no channel that serves it');
  });

  it('says the session has no workspace rather than reading something anyway', async () => {
    const { errors, calls } = await run({
      handshake: SERVING,
      args: 'notes.md',
      workspace: { state: 'legacy_unbound' },
    });

    expect(calls).toEqual([]);
    expect(errors.join('\n')).toContain('no workspace identity');
  });

  it('refuses an empty path without asking the Host anything', async () => {
    const { errors, calls } = await run({ handshake: SERVING, args: '   ' });

    expect(calls).toEqual([]);
    expect(errors.join('\n')).toContain('/read-file');
  });
});
