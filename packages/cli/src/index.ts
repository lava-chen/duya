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
import * as fs from 'node:fs';
import * as path from 'node:path';
import { startLocalHost } from '@duya/host/local-host';
import { buildControlPlane } from './program/build-control-plane.js';
import { runChatCommand, runTuiCommand, type ChatCommandOptions, type TuiCommandOptions } from './chat.js';

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
 */
/**
 * Resolve the worker entry the Host-owned execution controller spawns.
 *
 * `DUYA_HOST_WORKER_PATH` wins; otherwise the repository layout is probed the
 * same way the Desktop Agent Server resolves its dev bundle. Absent, `duya
 * serve` stays a ledger-only Host — execution ownership requires a worker
 * entry, and inventing one would be worse than not offering execution.
 */
function resolveServeWorkerPath(): string | undefined {
  const explicit = process.env.DUYA_HOST_WORKER_PATH;
  if (explicit !== undefined && explicit.trim().length > 0) return path.resolve(explicit.trim());
  const devBundle = path.join(process.cwd(), 'packages', 'agent', 'bundle', 'agent-process-entry.js');
  if (fs.existsSync(devBundle)) return devBundle;
  const devDist = path.join(process.cwd(), 'packages', 'agent', 'dist', 'process', 'agent-process-entry.js');
  if (fs.existsSync(devDist)) return devDist;
  return undefined;
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('duya')
    .description('DUYA Host control plane (serve, status, plugins, sessions, crons, channels, ...)')
    .version('0.1.0');
  buildControlPlane(program);

  // The Host is a long-running process command, so it is intentionally kept
  // out of the descriptor registry consumed by the in-process duya_cli tool.
  const serve = program.command('serve').description('Start the local Duya Host service');
  serve.option('--port <port>', 'Loopback HTTP port (0 selects an available port)', '0');
  serve.action(async () => {
    const rawPort: unknown = serve.getOptionValue('port');
    const port = typeof rawPort === 'string' ? Number(rawPort) : Number.NaN;
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      process.stderr.write('Port must be an integer between 0 and 65535.\n');
      process.exitCode = 64;
      return;
    }

    try {
      const workerPath = resolveServeWorkerPath();
      const host = await startLocalHost({ port, ...(workerPath === undefined ? {} : { workerPath }) });
      process.stdout.write(`Duya Host listening at ${host.origin}\n`);
      process.stdout.write(`Runtime descriptor: ${host.runtimeFilePath}\n`);
      process.stdout.write(
        workerPath === undefined
          ? 'Execution: LEDGER-ONLY (no worker entry found; set DUYA_HOST_WORKER_PATH)\n'
          : `Execution: enabled (worker: ${workerPath})\n`,
      );
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
  chat.option('--model <model>', 'Model override for the runs started by this chat');
  chat.option('--provider <id>', 'Provider override for the runs started by this chat (e.g. deepseek, glm-cn)');
  chat.option('--api-format <format>', 'API format override: anthropic | openai');
  chat.option('-p, --print <prompt>', 'Run a single prompt and exit (non-interactive)');
  chat.action(async () => {
    const asString = (value: unknown): string | undefined =>
      typeof value === 'string' && value.length > 0 ? value : undefined;
    const options: ChatCommandOptions = {
      origin: asString(chat.getOptionValue('origin')),
      token: asString(chat.getOptionValue('token')),
      runtimeFile: asString(chat.getOptionValue('runtime-file')),
      session: asString(chat.getOptionValue('session')),
      model: asString(chat.getOptionValue('model')),
      providerId: asString(chat.getOptionValue('provider')),
      apiFormat: asString(chat.getOptionValue('api-format')) as 'anthropic' | 'openai' | undefined,
      print: asString(chat.getOptionValue('print')),
    };
    process.exitCode = await runChatCommand(options);
  });

  // `duya tui` — ephemeral Host + TUI in one process.
  const tui = program.command('tui').description('Start an ephemeral Duya Host and open the full-screen TUI');
  tui.option('--port <port>', 'HTTP port for the embedded Host (0 = auto)', '0');
  tui.option('--session <id>', 'Continue an existing session instead of creating one');
  tui.option('--model <model>', 'Default model override');
  tui.option('--provider <id>', 'Default provider override (e.g. deepseek, glm-cn)');
  tui.option('--api-format <format>', 'API format override: anthropic | openai');
  tui.action(async () => {
    const asString = (value: unknown): string | undefined =>
      typeof value === 'string' && value.length > 0 ? value : undefined;
    const asInt = (value: unknown): number | undefined => {
      if (typeof value === 'string') {
        const n = Number(value);
        return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : undefined;
      }
      return undefined;
    };
    const options: TuiCommandOptions = {
      port: asInt(tui.getOptionValue('port')),
      session: asString(tui.getOptionValue('session')),
      model: asString(tui.getOptionValue('model')),
      providerId: asString(tui.getOptionValue('provider')),
      apiFormat: asString(tui.getOptionValue('api-format')) as 'anthropic' | 'openai' | undefined,
    };
    process.exitCode = await runTuiCommand(options);
  });

  return program;
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
