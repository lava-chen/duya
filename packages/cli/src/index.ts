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
      const host = await startLocalHost({
        port,
        clientScoped,
        ...(workerPath === undefined ? {} : { workerPath }),
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

  const project = program.command('project').description('Open a Project Coordinator TUI');
  addTuiOptions(project, { includeProject: true, includePort: true });
  project.action(async () => {
    process.exitCode = await runTuiCommand({
      ...readTuiOptions(project),
      projectMode: true,
      projectId: asString(optionValue(project, 'project')),
    });
  });

  return program;
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
