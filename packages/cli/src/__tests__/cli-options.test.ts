/**
 * The Commander options of `duya`.
 *
 * ## The trap this guards
 *
 * Commander stores an option under its camelCase attribute name. Reading
 * `--client-scoped` as `getOptionValue('client-scoped')` returns `undefined`
 * instead of throwing, so the option is silently dropped. That is not
 * cosmetic: a Host asked to be client-scoped becomes one that never stops,
 * and `--api-format` and `--runtime-file` become options that do nothing.
 *
 * Only a single-word flag has the same name either way, which is why the
 * bug survived in exactly the hyphenated options.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProgram } from '../index.js';

const mocks = vi.hoisted(() => ({
  startLocalHost: vi.fn(async () => ({
    origin: 'http://127.0.0.1:1234',
    port: 1234,
    runtimeFilePath: '/tmp/host-api.json',
    close: async () => {},
  })),
  runChatCommand: vi.fn(async () => 0),
  runTuiCommand: vi.fn(async () => 0),
}));

vi.mock('@duya/host/local-host', () => ({
  startLocalHost: mocks.startLocalHost,
  readLocalHostRuntime: vi.fn(async () => null),
}));
vi.mock('../chat.js', () => ({ runChatCommand: mocks.runChatCommand }));
vi.mock('../tui-command.js', () => ({ runTuiCommand: mocks.runTuiCommand }));

/**
 * `duya project channel` argv wiring.
 *
 * The commands are mocked so the assertions are about what Commander handed
 * them: a flag that is declared but read under the wrong attribute name, or a
 * repeated `--member` silently keeping only the last value, would both look
 * fine in a hand-run and silently narrow an allowlist here.
 */
const channelMocks = vi.hoisted(() => ({
  PROJECT_CHANNEL_TOKEN_ENV: 'DUYA_DISCORD_BOT_TOKEN',
  runProjectChannelList: vi.fn(async () => 0),
  runProjectChannelStatus: vi.fn(async () => 0),
  runProjectChannelConnect: vi.fn(async () => 0),
  runProjectChannelBind: vi.fn(async () => 0),
  runProjectChannelUpdate: vi.fn(async () => 0),
  runProjectChannelUnbind: vi.fn(async () => 0),
  runProjectChannelDisconnect: vi.fn(async () => 0),
}));
vi.mock('../commands/project-channel.js', () => channelMocks);

beforeEach(() => {
  mocks.startLocalHost.mockClear();
  mocks.runChatCommand.mockClear();
  mocks.runTuiCommand.mockClear();
});

describe('duya default TUI route', () => {
  it('opens the generic Session TUI when no subcommand is given', async () => {
    const program = buildProgram();

    await program.parseAsync(['node', 'duya']);

    expect(mocks.runTuiCommand).toHaveBeenCalledWith(expect.objectContaining({
      session: undefined,
      workingDirectory: undefined,
      model: undefined,
      providerId: undefined,
      apiFormat: undefined,
    }));
  });
});

describe('duya project route', () => {
  it('passes an explicit project id to the Coordinator TUI', async () => {
    const program = buildProgram();

    await program.parseAsync(['node', 'duya', 'project', '--project', 'project-123']);

    expect(mocks.runTuiCommand).toHaveBeenCalledWith(expect.objectContaining({
      projectMode: true,
      projectId: 'project-123',
    }));
  });
});

describe('duya serve --client-scoped', () => {
  it('hands the Host a client-scoped lifetime', async () => {
    const program = buildProgram();

    await program.parseAsync(['node', 'duya', 'serve', '--client-scoped']);

    expect(mocks.startLocalHost).toHaveBeenCalledWith(
      expect.objectContaining({ clientScoped: true }),
    );
  });

  it('leaves an ordinary serve running until it is stopped', async () => {
    const program = buildProgram();

    await program.parseAsync(['node', 'duya', 'serve']);

    expect(mocks.startLocalHost).toHaveBeenCalledWith(
      expect.objectContaining({ clientScoped: false }),
    );
  });
});

describe('hyphenated options', () => {
  it('reads --api-format and --runtime-file for the chat client', async () => {
    const program = buildProgram();

    await program.parseAsync([
      'node', 'duya', 'chat', '--api-format', 'openai', '--runtime-file', '/tmp/host-api.json',
    ]);

    expect(mocks.runChatCommand).toHaveBeenCalledWith(
      expect.objectContaining({ apiFormat: 'openai', runtimeFile: '/tmp/host-api.json' }),
    );
  });

  it('reads --api-format for the TUI', async () => {
    const program = buildProgram();

    await program.parseAsync(['node', 'duya', 'tui', '--api-format', 'anthropic']);

    expect(mocks.runTuiCommand).toHaveBeenCalledWith(
      expect.objectContaining({ apiFormat: 'anthropic' }),
    );
  });
});

describe('duya project channel argv', () => {
  beforeEach(() => {
    for (const fn of Object.values(channelMocks)) {
      if (typeof fn === 'function' && 'mockClear' in fn) fn.mockClear();
    }
  });

  it('keeps `duya project` opening the TUI when no channel subcommand is given', async () => {
    const program = buildProgram();

    await program.parseAsync(['node', 'duya', 'project', '--project', 'project-123']);

    expect(mocks.runTuiCommand).toHaveBeenCalledWith(expect.objectContaining({ projectMode: true }));
    expect(channelMocks.runProjectChannelList).not.toHaveBeenCalled();
    expect(channelMocks.runProjectChannelStatus).not.toHaveBeenCalled();
  });

  it('routes each channel subcommand to its own handler with the parsed flags', async () => {
    const program = buildProgram();

    await program.parseAsync(['node', 'duya', 'project', 'channel', 'list', '--project', 'p1', '--format', 'json']);
    expect(channelMocks.runProjectChannelList).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'p1', format: 'json',
    }));
    expect(mocks.runTuiCommand).not.toHaveBeenCalled();

    await program.parseAsync(['node', 'duya', 'project', 'channel', 'status', '--project', 'p1']);
    expect(channelMocks.runProjectChannelStatus).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1' }));
  });

  it('collects every --member, whether repeated or comma-separated', async () => {
    const program = buildProgram();

    await program.parseAsync([
      'node', 'duya', 'project', 'channel', 'bind',
      '--project', 'p1', '--connection', 'c1', '--guild', 'g1', '--channel', 'ch1',
      '--member', 'a,b', '--member', 'c', '--allow-proactive',
    ]);

    expect(channelMocks.runProjectChannelBind).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'p1', connectionId: 'c1', guildId: 'g1', channelId: 'ch1',
      members: ['a', 'b', 'c'], allowProactive: true,
    }));
  });

  it('defaults proactive to off unless the operator says otherwise', async () => {
    const program = buildProgram();

    await program.parseAsync([
      'node', 'duya', 'project', 'channel', 'bind',
      '--project', 'p1', '--connection', 'c1', '--guild', 'g1', '--channel', 'ch1', '--member', 'a',
    ]);

    // No `allowProactive` key at all: the binding decides, not the CLI.
    expect(channelMocks.runProjectChannelBind).toHaveBeenCalledWith(
      expect.not.objectContaining({ allowProactive: true }),
    );
  });

  it('maps --proactive and --state onto the update patch', async () => {
    const program = buildProgram();

    await program.parseAsync([
      'node', 'duya', 'project', 'channel', 'update',
      '--project', 'p1', '--binding', 'b1', '--revision', '3', '--proactive', 'on', '--state', 'disabled',
    ]);

    expect(channelMocks.runProjectChannelUpdate).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'p1', bindingId: 'b1', expectedRevision: 3, allowProactive: true, enabled: false,
    }));
  });

  it('hands a plaintext --token to the command so it can be refused', async () => {
    const program = buildProgram();

    await program.parseAsync(['node', 'duya', 'project', 'channel', 'connect', '--project', 'p1', '--token', 'secret']);

    // The CLI never sends it; the command sees it only to explain why not.
    expect(channelMocks.runProjectChannelConnect).toHaveBeenCalledWith(
      expect.objectContaining({ plaintextToken: 'secret' }),
    );
  });

  it('passes the revision through for unbind and disconnect', async () => {
    const program = buildProgram();

    await program.parseAsync(['node', 'duya', 'project', 'channel', 'unbind', '--project', 'p1', '--binding', 'b1', '--revision', '4']);
    expect(channelMocks.runProjectChannelUnbind).toHaveBeenCalledWith(
      expect.objectContaining({ bindingId: 'b1', expectedRevision: 4 }),
    );

    await program.parseAsync(['node', 'duya', 'project', 'channel', 'disconnect', '--project', 'p1', '--connection', 'c1', '--revision', '2']);
    expect(channelMocks.runProjectChannelDisconnect).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'c1', expectedRevision: 2 }),
    );
  });
});
