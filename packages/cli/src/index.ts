/**
 * packages/cli/src/index.ts
 *
 * DUYA desktop control plane — entry point for the bundled `duya`
 * wrapper script.
 *
 * This package is the *boundary* between the agent runtime
 * (`@duya/agent`) and the desktop app's localhost HTTP API. It does
 * NOT import any agent runtime (no `duyaAgent`, no `REPL`, no
 * `QueryEngine`, no `loadSkills`). It is a few hundred lines of
 * TypeScript that reads userData/runtime/cli-api.json, parses argv,
 * and dispatches HTTP calls to the desktop.
 *
 * The reusable terminal UI is exported separately from `@duya/cli/tui`.
 * It accepts run frames and completion candidates from its host, so it does
 * not pull Agent session or runtime dependencies into this package.
 *
 * The agent's `duya_cli` tool consumes the same `program/registry.ts`
 * + `program/build-agent-runner.ts` via `@duya/cli/contract`, so the
 * in-agent dispatch and the external CLI are guaranteed to share
 * the same command set.
 */

import { Command } from '@commander-js/extra-typings';
import { startLocalHost } from '@duya/host/local-host';
import { buildControlPlane } from './program/build-control-plane.js';
import { runChatCommand, type ChatCommandOptions } from './chat.js';
// `duya tui` boots an ephemeral Host, so it belongs to the bootstrap layer, not
// to `chat.ts`. Keeping it out of the client entry is what lets gate G11-1
// hold `chat.ts` free of the execution engine.
import { runTuiCommand, type TuiCommandOptions } from './tui-command.js';
import { parseFormat } from './api/format.js';
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
} from './commands/project-channel.js';
import { resolveHostWorkerPath } from './worker-path.js';

export { CLI_DESCRIPTORS } from './program/descriptors.js';
export type { CliCommandPath, ExitCode } from './program/registry.js';
export { buildAgentRunner, type CliInvocation, type CliRunResult } from './program/build-agent-runner.js';
export { createCliHostSession, type CliHostSession } from './host-session.js';
export { createHostTaskStore } from './host-task-store.js';
export * from './contract/index.js';

/**
 * Build the `duya` Commander program. Pure function — no I/O,
 * no argv mutation. The caller (`bin/duya`) wires argv to
 * `program.parse(argv)`.
 *
 * ## Reading an option
 *
 * Commander stores an option under its camelCase attribute name, so
 * `--client-scoped` is read as `clientScoped` and `--runtime-file` as
 * `runtimeFile`. Reading the hyphenated name returns `undefined` — the option
 * is then silently ignored, which is how `--api-format` and `--runtime-file`
 * stopped working. Only a single-word flag has the same name either way.
 */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name('duya')
    .description('DUYA Host control plane (serve, status, plugins, sessions, crons, channels, ...)')
    .version(process.env.DUYA_CLI_VERSION ?? '0.1.0');
  addTuiOptions(program, { includeSession: true, includeWorkspace: true, includePort: true });
  program.action(async () => {
    process.exitCode = await runTuiCommand(readTuiOptions(program));
  });
  buildControlPlane(program);

  // The Host is a long-running process command, so it is intentionally kept
  // out of the descriptor registry consumed by the in-process duya_cli tool.
  const serve = program.command('serve').description('Start the local Duya Host service');
  serve.option('--port <port>', 'Loopback HTTP port (0 selects an available port)', '0');
  serve.option(
    '--client-scoped',
    'Stop the Host once its last client disconnects (used by `duya tui`)',
  );
  serve.action(async () => {
    const rawPort: unknown = serve.getOptionValue('port');
    const port = typeof rawPort === 'string' ? Number(rawPort) : Number.NaN;
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      process.stderr.write('Port must be an integer between 0 and 65535.\n');
      process.exitCode = 64;
      return;
    }
    const clientScoped = serve.getOptionValue('clientScoped') === true;

    try {
      const workerPath = resolveHostWorkerPath();
      // Only a persistent Host with execution can receive Project messages.
      // Import the transport subpath without starting the legacy Gateway process.
      const projectChannelTransport = !clientScoped && workerPath !== undefined
        ? (await import('@duya/gateway/project-channels')).createProjectDiscordTransport()
        : undefined;
      const host = await startLocalHost({
        port,
        clientScoped,
        ...(workerPath === undefined ? {} : { workerPath }),
        ...(projectChannelTransport === undefined ? {} : { projectChannelTransport }),
      });
      process.stdout.write(`Duya Host listening at ${host.origin}\n`);
      process.stdout.write(`Runtime descriptor: ${host.runtimeFilePath}\n`);
      process.stdout.write(
        workerPath === undefined
          ? 'Execution: LEDGER-ONLY (no worker entry found; set DUYA_HOST_WORKER_PATH)\n'
          : `Execution: enabled (worker: ${workerPath})\n`,
      );
      if (clientScoped) {
        process.stdout.write('Lifetime: client-scoped (stops when the last client disconnects)\n');
      }
      let stopping = false;
      const stop = (): void => {
        if (stopping) return;
        stopping = true;
        void host.close().then(() => {
          process.stdout.write('Duya Host stopped.\n');
        }).catch((error: unknown) => {
          process.stderr.write(`Duya Host shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`);
          process.exitCode = 1;
        });
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    } catch (error) {
      process.stderr.write(`Could not start Duya Host: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  });

  // `duya chat` — the Host-backed chat client (plan 587/12 gate 4). It holds
  // no agent runtime: every turn is a Host run (start → durable events →
  // terminal), the same path the Desktop uses.
  const chat = program.command('chat').description('Chat through a running Duya Host (start one with `duya serve`)');
  chat.option('--origin <origin>', 'Host origin, e.g. http://127.0.0.1:43110 (else DUYA_HOST_ORIGIN or the runtime descriptor)');
  chat.option('--token <token>', 'Host auth token (else DUYA_HOST_TOKEN or the runtime descriptor)');
  chat.option('--runtime-file <file>', 'Runtime descriptor path (default <dataRoot>/runtime/host-api.json)');
  chat.option('--session <id>', 'Continue an existing session instead of creating one');
  chat.option('--workspace <dir>', 'Working directory for a new session (defaults to the current directory)');
  chat.option('--model <model>', 'Model override for the runs started by this chat');
  chat.option('--provider <id>', 'Provider override for the runs started by this chat (e.g. deepseek, glm-cn)');
  chat.option('--api-format <format>', 'API format override: anthropic | openai');
  chat.option('-p, --print <prompt>', 'Run a single prompt and exit (non-interactive)');
  chat.action(async () => {
    const asString = (value: unknown): string | undefined =>
      typeof value === 'string' && value.length > 0 ? value : undefined;
    const options: ChatCommandOptions = {
      origin: asString(optionValue(chat, 'origin')),
      token: asString(optionValue(chat, 'token')),
      runtimeFile: asString(optionValue(chat, 'runtimeFile')),
      session: asString(optionValue(chat, 'session')),
      workingDirectory: asString(optionValue(chat, 'workspace')),
      model: asString(optionValue(chat, 'model')),
      providerId: asString(optionValue(chat, 'provider')),
      apiFormat: asString(optionValue(chat, 'apiFormat')) as 'anthropic' | 'openai' | undefined,
      print: asString(optionValue(chat, 'print')),
    };
    process.exitCode = await runChatCommand(options);
  });

  // `duya tui` — the TUI client. It attaches to the Host that owns this data
  // directory and starts one only when none is running.
  const tui = program
    .command('tui')
    .description('Open the TUI against the Duya Host that owns this data directory (DUYA_TUI_INLINE=1 for the inline screen model)');
  addTuiOptions(tui, { includeSession: true, includeWorkspace: true, includePort: true });
  tui.action(async () => {
    process.exitCode = await runTuiCommand(readTuiOptions(tui));
  });

  const project = program.command('project').description('Open a Project Coordinator TUI (or manage its channel bot)');
  addTuiOptions(project, { includeProject: true, includePort: true });
  project.action(async () => {
    process.exitCode = await runTuiCommand({
      ...readTuiOptions(project),
      projectMode: true,
      projectId: asString(optionValue(project, 'project')),
    });
  });
  addProjectChannelCommands(project);

  return program;
}

/**
 * `duya project channel …` — a local operator surface, not a model surface.
 *
 * These are registered on the commander tree only. The `duya_cli` tool resolves
 * commands through `program/descriptors.ts`, so by never adding this path there
 * the credential-carrying subcommands are structurally unreachable from a model
 * turn — not merely discouraged in a prompt.
 *
 * `duya project` on its own keeps opening the Coordinator TUI: the subcommands
 * do not change the parent's action.
 */
function addProjectChannelCommands(project: Command): void {
  const channel = project.command('channel').description("Manage this Project's own Discord bot: connect, bind channels, revoke, disconnect");

  const setup = channel.command('setup')
    .description('Open the interactive Discord setup')
    .option('--project <id>', 'Project id');
  setup.action(async () => {
    process.exitCode = await runTuiCommand({
      ...readTuiOptions(project),
      projectMode: true,
      projectChannelsOnly: true,
      projectId: asString(ancestorOption(setup, 'project')),
    });
  });

  const withFormat = (command: Command): Command =>
    command.option('--format <format>', 'Output format: text | json', 'text');

  /** `--member` may be repeated or comma-separated; both mean the same list. */
  const memberOption = (command: Command): Command =>
    command.option('--member <userId>', 'Allowed Discord user id; repeat the flag or comma-separate', collectOption, [] as string[]);

  const list = withFormat(
    channel.command('list')
      .description("List this Project's channel bindings, their members and send permissions")
      .option('--project <id>', 'Project id'),
  );
  list.action(async (): Promise<void> => {
    process.exitCode = await runProjectChannelList(readChannelOptions(list));
  });

  const status = withFormat(
    channel.command('status')
      .description('Show the connection, transport state and recent deliveries')
      .option('--project <id>', 'Project id'),
  );
  status.action(async (): Promise<void> => {
    process.exitCode = await runProjectChannelStatus(readChannelOptions(status));
  });

  const connect = withFormat(
    channel.command('connect')
      .description(`Configure or rotate the Project's Discord bot (credential from ${PROJECT_CHANNEL_TOKEN_ENV} or stdin)`)
      .option('--project <id>', 'Project id')
      .option('--label <label>', 'Operator-facing label for the connection')
      .option('--revision <n>', 'Current revision; required to rotate an existing connection', (value) => Number(value))
      // Declared only to be refused with instructions; never read as a value.
      .option('--token <token>', 'Refused: credentials must not appear on the command line'),
  );
  connect.action(async (): Promise<void> => {
    process.exitCode = await runProjectChannelConnect(readChannelOptions(connect));
  });

  const bind = memberOption(withFormat(
    channel.command('bind')
      .description('Authorize one guild channel and a non-empty member allowlist')
      .option('--project <id>', 'Project id')
      .option('--connection <id>', 'Connection id from `channel status`')
      .option('--guild <id>', 'Discord guild (server) id')
      .option('--channel <id>', 'Discord text channel id')
      .option('--allow-proactive', 'Let the Coordinator send without a triggering message (default off)')
      .option('--label <label>', 'Operator-facing label for the binding'),
  ));
  bind.action(async (): Promise<void> => {
    process.exitCode = await runProjectChannelBind(readChannelOptions(bind));
  });

  const update = memberOption(withFormat(
    channel.command('update')
      .description('Change members, proactive permission or enabled state (compare-and-set)')
      .option('--project <id>', 'Project id')
      .option('--binding <id>', 'Binding id')
      .option('--revision <n>', 'Expected revision; the write fails if it moved', (value) => Number(value))
      .option('--proactive <on|off>', 'Set the proactive permission explicitly')
      .option('--state <enabled|disabled>', 'Enable or stop the binding'),
  ));
  update.action(async (): Promise<void> => {
    process.exitCode = await runProjectChannelUpdate(readChannelOptions(update));
  });

  const unbind = withFormat(
    channel.command('unbind')
      .description('Revoke a binding (the bot credential is kept)')
      .option('--project <id>', 'Project id')
      .option('--binding <id>', 'Binding id')
      .option('--revision <n>', 'Expected revision', (value) => Number(value)),
  );
  unbind.action(async (): Promise<void> => {
    process.exitCode = await runProjectChannelUnbind(readChannelOptions(unbind));
  });

  const disconnect = withFormat(
    channel.command('disconnect')
      .description('Disable the connection locally; the Discord application is not deleted')
      .option('--project <id>', 'Project id')
      .option('--connection <id>', 'Connection id')
      .option('--revision <n>', 'Expected revision', (value) => Number(value)),
  );
  disconnect.action(async (): Promise<void> => {
    process.exitCode = await runProjectChannelDisconnect(readChannelOptions(disconnect));
  });
}

/** Collect repeated `--member` values, splitting any comma-separated ones. */
function collectOption(value: string, previous: string[]): string[] {
  return [...previous, ...value.split(',').map((part) => part.trim()).filter((part) => part !== '')];
}

/**
 * Read a channel subcommand's own flags.
 *
 * Each subcommand declares `--project` itself rather than inheriting it: the
 * parent also carries `--project` for the TUI, and commander would otherwise
 * parse the value in one shape and look for it in another.
 */
/**
 * Read an option from a command or any of its ancestors.
 *
 * `--project` exists on both `duya project` (for the TUI) and the channel
 * subcommands, and Commander resolves the flag against the nearest ancestor
 * that declares it — so the value the operator typed after the subcommand
 * still lands on `project`. Reading only the leaf command would see
 * `undefined` and silently target no project at all.
 */
function ancestorOption(command: Command, name: string): unknown {
  let current: Command | null = command;
  while (current !== null) {
    const value = current.getOptionValue(name);
    if (value !== undefined) return value;
    // Commander types `parent` as the untyped base class; the walk only needs
    // `getOptionValue`, which every command has.
    current = (current.parent ?? null) as Command | null;
  }
  return undefined;
}

function readChannelOptions(command: Command): ProjectChannelCommandOptions {
  const proactive = asString(ancestorOption(command, 'proactive'));
  const state = asString(ancestorOption(command, 'state'));
  const members = ancestorOption(command, 'member');
  // Two shapes for the same permission: `bind --allow-proactive` (one-way) and
  // `update --proactive on|off` (explicit). Absent from both means "leave the
  // binding's own setting alone", so the key must stay out of the patch.
  const allowProactive = ancestorOption(command, 'allowProactive') === true
    ? true
    : proactive === undefined ? undefined : proactive === 'on' || proactive === 'true';
  return {
    projectId: asString(ancestorOption(command, 'project')),
    connectionId: asString(ancestorOption(command, 'connection')),
    bindingId: asString(ancestorOption(command, 'binding')),
    guildId: asString(ancestorOption(command, 'guild')),
    channelId: asString(ancestorOption(command, 'channel')),
    members: Array.isArray(members)
      ? members.filter((value): value is string => typeof value === 'string')
      : typeof members === 'string' ? [members] : [],
    // One flag name for every compare-and-set write: `--revision`.
    expectedRevision: typeof ancestorOption(command, 'revision') === 'number'
      ? ancestorOption(command, 'revision') as number
      : undefined,
    ...(allowProactive === undefined ? {} : { allowProactive }),
    ...(state === undefined ? {} : { enabled: state === 'enabled' }),
    label: asString(ancestorOption(command, 'label')),
    plaintextToken: asString(ancestorOption(command, 'token')),
    format: parseFormat(asString(ancestorOption(command, 'format'))),
  };
}

function addTuiOptions(
  command: Command,
  options: { includePort?: boolean; includeSession?: boolean; includeWorkspace?: boolean; includeProject?: boolean } = {},
): void {
  if (options.includePort) command.option('--port <port>', 'HTTP port for the embedded Host (0 = auto)', '0');
  if (options.includeSession) command.option('--session <id>', 'Continue an existing session instead of creating one');
  if (options.includeWorkspace) command.option('--workspace <dir>', 'Working directory for a new session (defaults to the current directory)');
  command.option('--model <model>', 'Default model override');
  command.option('--provider <id>', 'Default provider override (e.g. deepseek, glm-cn)');
  command.option('--api-format <format>', 'API format override: anthropic | openai');
  if (options.includeProject) command.option('--project <id>', 'Open this project directly without the selector');
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asInt(value: unknown): number | undefined {
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : undefined;
  }
  return undefined;
}

function optionValue(command: Command, name: string): unknown {
  return command.getOptionValue(name) ?? command.parent?.getOptionValue(name);
}

function readTuiOptions(command: Command): TuiCommandOptions {
  return {
    port: asInt(optionValue(command, 'port')),
    session: asString(optionValue(command, 'session')),
    workingDirectory: asString(optionValue(command, 'workspace')),
    model: asString(optionValue(command, 'model')),
    providerId: asString(optionValue(command, 'provider')),
    apiFormat: asString(optionValue(command, 'apiFormat')) as 'anthropic' | 'openai' | undefined,
  };
}

// Standalone entry: when run as `node packages/cli/dist/index.js`,
// parse argv and dispatch.
if (
  // Detect "run as entry point" without `import.meta.url` shenanigans:
  // we are the entry if there's no parent module. This works for CJS
  // bundles (require.main === module) and for ESM bundles whose
  // bundle output is a single file.
  (typeof require !== 'undefined' && (require as { main?: unknown }).main === module) ||
  // ESM entry: process.argv[1] is the path that was executed. If
  // it resolves to this file, we are the entry.
  (typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('index.js'))
) {
  const program = buildProgram();
  program.parse(process.argv);
}
