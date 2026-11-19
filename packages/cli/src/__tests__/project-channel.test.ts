/**
 * `duya project channel …` against a real Host over real HTTP.
 *
 * ## What this file is guarding
 *
 * Three things that a formatting test could never show:
 *
 * 1. **Reachability.** The routes exist and the CLI's wiring matches them. The
 *    CLI builds paths, the Host parses them; only a real round trip proves the
 *    two agree.
 * 2. **The credential path.** A token in argv is refused before any request is
 *    made, and a token that did go in never comes back in the output.
 * 3. **Model exclusion.** `program/descriptors.ts` is what the `duya_cli` tool
 *    projects into a model turn. The channel subcommands must not be resolvable
 *    through it — a structural guarantee, not a prompt instruction.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  InspectProjectChannelInput,
  ProjectChannelChannelInspection,
  ProjectChannelIdentityVerification,
  ProjectChannelRuntimeObservation,
  ProjectChannelTransportPort,
  ProjectChannelTransportSendInput,
  StartProjectChannelTransportInput,
  VerifyProjectChannelIdentityInput,
} from '@duya/agent-protocol/project-channels';
import { startLocalHost, type LocalHostHandle } from '@duya/host/local-host';
import { CliApiClient } from '../api/client.js';
import { APP_NOT_RUNNING_HINT, CliApiError } from '../api/errors.js';
import { CLI_DESCRIPTORS } from '../program/descriptors.js';
import { resolveSubcommand } from '../program/registry.js';
import {
  PROJECT_CHANNEL_TOKEN_ENV,
  runProjectChannelBind,
  runProjectChannelConnect,
  runProjectChannelDisconnect,
  runProjectChannelList,
  runProjectChannelStatus,
  runProjectChannelUnbind,
  runProjectChannelUpdate,
  type ProjectChannelCommandOptions,
} from '../commands/project-channel.js';

const TOKEN = 'token-a';
const BOT_USER_ID = 'bot-a';
const GUILD_ID = 'guild-1';
const CHANNEL_ID = 'channel-1';
const MEMBER_ID = 'member-1';

/**
 * The smallest transport that behaves like Discord for control-plane purposes.
 *
 * Deliberately not the Host package's fixture: this file must fail if the CLI
 * or the routes drift, and reaching across packages for a shared fixture would
 * hide a missing export behind a type-only import.
 */
class StubTransport implements ProjectChannelTransportPort {
  private readonly observations = new Map<string, ProjectChannelRuntimeObservation>();

  async start(input: StartProjectChannelTransportInput): Promise<ProjectChannelRuntimeObservation> {
    const observation: ProjectChannelRuntimeObservation = {
      connectionId: input.connectionId,
      generation: input.generation,
      observedBotUserId: BOT_USER_ID,
      state: 'connected',
      errorCode: null,
      observedAt: 5_000,
    };
    this.observations.set(input.connectionId, observation);
    return observation;
  }

  async stop(): Promise<void> {}

  observe(connectionId: string): ProjectChannelRuntimeObservation | null {
    return this.observations.get(connectionId) ?? null;
  }

  async verifyIdentity(input: VerifyProjectChannelIdentityInput): Promise<ProjectChannelIdentityVerification> {
    if (input.token !== TOKEN) throw Object.assign(new Error('401'), { code: 'credential_invalid' });
    return { botUserId: BOT_USER_ID, verifiedAt: 4_000 };
  }

  async inspectChannel(input: InspectProjectChannelInput): Promise<ProjectChannelChannelInspection> {
    if (input.guildId !== GUILD_ID || input.channelId !== CHANNEL_ID) {
      throw Object.assign(new Error('unknown channel'), { code: 'invalid_target' });
    }
    return { guildId: GUILD_ID, channelId: CHANNEL_ID, isTextChannel: true, isThread: false, inspectedAt: 4_100 };
  }

  async send(_input: ProjectChannelTransportSendInput): Promise<{ platformMessageId: string }> {
    return { platformMessageId: 'platform-msg-1' };
  }
}

const temporaryRoots: string[] = [];
const hosts: LocalHostHandle[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const host of hosts.splice(0)) await host.close();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Harness {
  readonly projectId: string;
  readonly client: CliApiClient;
  readonly deps: { client: () => Promise<CliApiClient> };
  readonly out: string[];
  readonly err: string[];
}

async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'duya-cli-channel-'));
  temporaryRoots.push(root);
  const dataRoot = join(root, 'data');
  const host = await startLocalHost({
    dataRoot,
    databasePath: join(dataRoot, 'databases', 'duya-main.db'),
    rolloutRoot: join(dataRoot, 'sessions'),
    attachmentsRoot: join(dataRoot, 'attachments'),
    runtimeFilePath: join(dataRoot, 'runtime', 'host-api.json'),
    port: 0,
    token: 'host-token',
    projectChannelTransport: new StubTransport(),
  });
  hosts.push(host);

  const client = new CliApiClient(host.origin, 'host-token');
  const workspace = await mkdtemp(join(tmpdir(), 'duya-cli-workspace-'));
  temporaryRoots.push(workspace);
  const created = await client.post<{ project: { project_id: string } }>('/v1/projects', {
    name: 'Alpha',
    paths: [{ path: workspace, description: null }],
  });

  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  });

  return {
    projectId: created.project.project_id,
    client,
    deps: { client: async () => client },
    out,
    err,
  };
}

function options(projectId: string, overrides: Partial<ProjectChannelCommandOptions> = {}): ProjectChannelCommandOptions {
  return { projectId, format: 'json', ...overrides };
}

describe('duya project channel', () => {
  it('is not reachable through the model-facing command registry', () => {
    // The `duya_cli` tool resolves through these descriptors. If `project`
    // ever appears there with a `channel` subcommand, a model could rotate a
    // bot credential — so the absence is the control, and it is asserted.
    expect(resolveSubcommand(CLI_DESCRIPTORS, 'project', 'channel')).toBeNull();
    expect(CLI_DESCRIPTORS.some((descriptor) => descriptor.name === 'project')).toBe(false);
  });

  it('refuses a credential in argv without making a request', async () => {
    let called = false;
    const exit = await runProjectChannelConnect(
      options('project-a', { plaintextToken: TOKEN }),
      { client: async () => { called = true; throw new Error('must not connect'); } },
    );
    expect(exit).toBe(64);
    expect(called).toBe(false);
  });

  it('refuses to bind with no allowed members instead of accepting everyone', async () => {
    let called = false;
    const exit = await runProjectChannelBind(
      options('project-a', { connectionId: 'conn-1', guildId: GUILD_ID, channelId: CHANNEL_ID }),
      { client: async () => { called = true; throw new Error('must not connect'); } },
    );
    expect(exit).toBe(64);
    expect(called).toBe(false);
  });

  it('reports an unavailable Host as exit 2 rather than a stack trace', async () => {
    // This is exactly what `CliApiClient.connect()` throws when no runtime
    // descriptor exists: "no Host is running", not "the request failed".
    const exit = await runProjectChannelStatus(
      options('project-a'),
      { client: async () => { throw new CliApiError('app_not_running', APP_NOT_RUNNING_HINT, APP_NOT_RUNNING_HINT); } },
    );
    expect(exit).toBe(2);
  });

  it('connects from the environment, binds, updates, unbinds and disconnects', async () => {
    const { projectId, deps, out, err } = await harness();
    vi.stubEnv(PROJECT_CHANNEL_TOKEN_ENV, TOKEN);

    expect(await runProjectChannelConnect(options(projectId), deps)).toBe(0);
    expect(err.join('')).toBe('');
    // The credential went in; it does not come back out.
    expect(out.join('')).not.toContain(TOKEN);
    expect(out.join('')).toContain(BOT_USER_ID);

    out.length = 0;
    expect(await runProjectChannelStatus(options(projectId), deps)).toBe(0);
    const status = JSON.parse(out.join(''));
    const connectionId = status.connection.connectionId as string;
    const connectionRevision = status.connection.revision as number;
    expect(status.observation.state).toBe('connected');

    out.length = 0;
    expect(await runProjectChannelBind(
      options(projectId, { connectionId, guildId: GUILD_ID, channelId: CHANNEL_ID, members: [MEMBER_ID] }),
      deps,
    )).toBe(0);
    const binding = JSON.parse(out.join('')).binding;
    expect(binding.allowProactive).toBe(false);

    out.length = 0;
    expect(await runProjectChannelUpdate(
      options(projectId, { bindingId: binding.bindingId, expectedRevision: binding.revision, allowProactive: true }),
      deps,
    )).toBe(0);
    const patched = JSON.parse(out.join('')).binding;
    expect(patched.allowProactive).toBe(true);

    out.length = 0;
    expect(await runProjectChannelList(options(projectId), deps)).toBe(0);
    const overview = JSON.parse(out.join(''));
    expect(overview.bindings).toHaveLength(1);
    expect(overview.bindings[0].allowedUserIds).toEqual([MEMBER_ID]);

    out.length = 0;
    expect(await runProjectChannelUnbind(
      options(projectId, { bindingId: patched.bindingId, expectedRevision: patched.revision }),
      deps,
    )).toBe(0);
    expect(JSON.parse(out.join('')).binding.enabled).toBe(false);

    out.length = 0;
    expect(await runProjectChannelDisconnect(
      options(projectId, { connectionId, expectedRevision: connectionRevision }),
      deps,
    )).toBe(0);
    expect(JSON.parse(out.join('')).connection.enabled).toBe(false);
  });

  it('turns a stale revision into an explanation, not a silent overwrite', async () => {
    const { projectId, deps, err } = await harness();
    vi.stubEnv(PROJECT_CHANNEL_TOKEN_ENV, TOKEN);
    await runProjectChannelConnect(options(projectId), deps);

    // Revision 1 has already moved to 2 by the time this lands.
    vi.stubEnv(PROJECT_CHANNEL_TOKEN_ENV, TOKEN);
    expect(await runProjectChannelConnect(
      options(projectId, { expectedRevision: 1, label: 'renamed' }),
      deps,
    )).toBe(0);
    expect(await runProjectChannelConnect(
      options(projectId, { expectedRevision: 1, label: 'again' }),
      deps,
    )).toBe(1);
    expect(err.join('')).toContain('changed since you read it');
  });

  it('prints a text table only when asked, and json by default in these tests', async () => {
    const { projectId, deps, out } = await harness();
    vi.stubEnv(PROJECT_CHANNEL_TOKEN_ENV, TOKEN);
    await runProjectChannelConnect(options(projectId), deps);

    out.length = 0;
    expect(await runProjectChannelStatus(options(projectId, { format: 'text' }), deps)).toBe(0);
    const text = out.join('');
    expect(text).toContain('connection:');
    expect(text).toContain('bindings: none');
    // A text render is still not a JSON document.
    expect(() => JSON.parse(text)).toThrow();
  });
});
