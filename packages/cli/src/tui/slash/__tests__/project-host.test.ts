/**
 * `/project` against a running Host.
 *
 * The command's own test mocks the client, and the host's own test drives the
 * route. This one joins them: the command module as the TUI loads it, the
 * HTTP client as the TUI holds it, and the local Host as the TUI attaches
 * to — because "the picker reads `/v1/projects`" is only true if all three
 * agree on the wire.
 *
 * The order matters and is the point of the whole change: the directory is
 * registered BEFORE the session starts, so the Host binds the session to the
 * project instead of minting a workspace of its own.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startLocalHost, type LocalHostHandle } from '@duya/host/local-host';
import { HostSessionHttpClient } from '@duya/host/http-client';
import type { HostSessionRecord } from '@duya/agent-protocol';
import { PROJECT_COMMANDS } from '../project.js';
import type { TuiSlashActions, TuiSlashContext, TuiSlashHost } from '../types.js';

const TOKEN = 'project-host-test-token';
const COMMAND = PROJECT_COMMANDS[0];
if (COMMAND === undefined) throw new Error('project.ts exports no command');

const hosts: LocalHostHandle[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('/project against a running Host', () => {
  it('registers a directory, then offers it in the picker', async () => {
    const dataRoot = mkdtempSync(path.join(os.tmpdir(), 'duya-project-host-'));
    roots.push(dataRoot);
    const host = await startLocalHost({ dataRoot, port: 0, token: TOKEN, ephemeral: true });
    hosts.push(host);
    const client = new HostSessionHttpClient(host.origin, TOKEN);

    const notices: string[] = [];
    const errors: string[] = [];
    const choiceSets: string[][] = [];
    const switches: string[] = [];
    const tui = {
      printNotice: (text: string) => { notices.push(text); },
      printError: (text: string) => { errors.push(text); },
      choose: async () => null,
      chooseFiltered: async (_title: string, choices: readonly { label: string; value: string }[]) => {
        choiceSets.push(choices.map((choice) => `${choice.label} | ${choice.value}`));
        return null;
      },
      promptText: async () => null,
    } as unknown as TuiSlashHost;

    const actions: TuiSlashActions = {
      interrupt: () => {},
      adoptSession: async () => {},
      startFreshSession: async () => {},
      startSessionInDirectory: async (directory: string) => { switches.push(directory); },
      reloadTranscript: async () => {},
    };
    const ctx = {
      client,
      session: { id: 'session-1' } as HostSessionRecord,
      tui,
      busy: false,
      actions,
    } as TuiSlashContext;

    // Nothing is registered yet, so the picker offers nothing but the row that
    // registers one.
    await COMMAND.run(ctx, '');
    expect(choiceSets.at(-1)).toEqual(['Register a directory… | add-directory']);

    await COMMAND.run(ctx, 'add E:\\cloned-projects\\codex');
    expect(errors).toEqual([]);
    expect(notices).toContain('Registered codex at E:\\cloned-projects\\codex.');
    expect(switches).toEqual(['E:\\cloned-projects\\codex']);

    choiceSets.length = 0;
    await COMMAND.run(ctx, '');
    expect(choiceSets.at(-1)).toEqual([
      'codex | E:\\cloned-projects\\codex',
      'Register a directory… | add-directory',
    ]);

    // The row is the one the Desktop's project page reads.
    const rows = await client.listProjects();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('codex');
    expect(rows[0]?.canonical_root).toBe('E:\\cloned-projects\\codex');
    expect(rows[0]?.paths).toEqual([{ path: 'E:\\cloned-projects\\codex', description: null }]);
  });
});
