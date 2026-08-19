/**
 * packages/cli/src/program/build-agent-runner.ts
 *
 * In-process dispatch for the `duya_cli` agent tool.
 *
 * Replaces the legacy hand-rolled `switch (inv.command)` chain.
 * The agent tool resolves a normalized `CliInvocation` through the
 * **same** descriptor registry the CLI bundle uses, so adding a
 * new subcommand in `descriptors.ts` automatically makes it
 * available to both the `duya` CLI and the `duya_cli` agent tool.
 *
 * Stream capture: the descriptor's `run(ctx)` callbacks write to
 * `process.stdout` / `process.stderr` (the format chosen by the
 * descriptor — text tables or JSON). The agent's subprocess is the
 * desktop process, so we MUST capture those writes and return them
 * in the result envelope — otherwise the agent's TTY would be
 * polluted with the CLI's output. This is the only place stream
 * capture happens; the external `duya` CLI bundle does not use
 * this runner (it uses `buildControlPlane`, which does NOT
 * capture, since the user wants to see the output).
 */

import { CLI_DESCRIPTORS } from './descriptors.js';
import {
  listCommandNames,
  listSubcommandNames,
  resolveSubcommand,
  type CliCommandDescriptor,
  type CliSubcommandContext,
  type ExitCode,
} from './registry.js';
import type { OutputFormat } from '../api/format.js';
import { parseFormat } from '../api/format.js';

/**
 * Subcommands that require an `<id>` argument. When the agent
 * tool invokes one of these without an id, we return exit 64
 * with a friendly message before dispatching to the handler.
 * Mirrors the legacy `runner.ts` switch-chain behavior.
 */
const ID_REQUIRED_SUBCOMMANDS: Record<string, true> = {
  'plugin:info': true,
  'plugin:enable': true,
  'plugin:disable': true,
  'session:show': true,
  'skill:info': true,
  'skill:enable': true,
  'skill:disable': true,
  'mcp:info': true,
  'provider:info': true,
  'channel:info': true,
  'cron:info': true,
  'cron:update': true,
  'cron:delete': true,
  'cron:run': true,
  'cron:runs': true,
  'message:show': true,
};

/**
 * Invocation shape consumed by the agent tool.
 * Mirrors `DuyaCliTool/runner.ts:CliInvocation`.
 */
export interface CliInvocation {
  command: string;
  subcommand?: string;
  id?: string;
  format?: string;
  yes?: boolean;
  extraArgs?: string[];
  /**
   * Working directory for resolving relative paths (e.g. cron's
   * `--from-file`). Defaults to `process.cwd()` when absent. The
   * agent tool threads the session workspace here so relative
   * paths resolve against the session, not the worker process cwd.
   */
  cwd?: string;
  fromFile?: string;
  /**
   * Plan 99 P3: inline JSON body for `duya cron create` (avoids the
   * agent having to write a temp file via `--from-file`).
   * Consumed by the cron `create`/`update` subcommand when set.
   */
  cronBodyJson?: string;
  prompt?: string;
  platform?: string;
  limit?: string;
  offset?: string;
  // Plan 102 — `duya config` / `duya mcp add` argv surface.
  // Single-value fields are passed as parsed types (string|boolean|number).
  // Multi-value fields (args, env, agents) are kept as string[] in argv
  // form; the descriptor's run() decides how to validate / coerce.
  configId?: string;
  configName?: string;
  configType?: string;
  configBaseUrl?: string;
  configApiKey?: string;
  configActive?: boolean;
  configEnabled?: boolean;
  configModel?: string;
  configProvider?: string;
  configMaxTokens?: string;
  configTemperature?: string;
  configTopP?: string;
  configTopK?: string;
  configEnableThinking?: boolean;
  configThinkingBudget?: string;
  configCode?: string;
  configUser?: string;
  configStyleId?: string;
  configInclude?: string;
  configClear?: boolean;
  configArgs?: string[];
  configEnv?: string[];
  configAgents?: string[];
  // Plan 102 — `duya agent create` argv surface (in-process tool parity
  // with the external CLI's build-control-plane routing).
  agentId?: string;
  agentName?: string;
  agentDescription?: string;
  agentWorkspace?: string;
  agentModel?: string;
  agentInstructionsFile?: string;
  agentToolsProfile?: string;
  agentAllow?: string[] | string;
  agentDeny?: string[] | string;
  agentPlugins?: string[] | string;
  // Plan 200 P4 — plugin list / install / uninstall flags.
  enabled?: boolean;
  verbose?: boolean;
  fromPath?: string;
  scope?: string;
  deleteData?: boolean;
}

export interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Thrown when CLI command code calls `process.exit()` while running
 * inside the in-process agent runner.
 *
 * The CLI command modules (`commands/mcp.ts`, `commands/agent.ts`,
 * `commands/config.ts`) were written for the standalone `duya` binary
 * where `process.exit(code)` is the correct way to terminate with a
 * non-zero status. When the same code is dispatched in-process via
 * `buildAgentRunner` (the `duya_cli` agent tool), a bare
 * `process.exit()` kills the whole agent worker mid-chat — it bypasses
 * the worker's crash handlers, leaves no crash log, and swallows the
 * hint written to stderr (captureStreams had replaced the stream). The
 * guard below converts the exit into a thrown error that
 * `buildAgentRunner` maps back into the regular result envelope.
 */
export class InProcessCliExit extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`CLI command called process.exit(${code}) inside the in-process runner`);
    this.name = 'InProcessCliExit';
    this.code = typeof code === 'number' && Number.isFinite(code) ? code : 0;
  }
}

/**
 * Symbol key used by captureStreams to attach partial stdout/stderr to
 * a thrown error, so a hint written to stderr right before a
 * process.exit() call survives into the result envelope.
 */
const CAPTURED_CHUNKS: unique symbol = Symbol('duya.cli.capturedChunks');

/**
 * Temporarily replace `process.exit` with a throwing stub for the
 * duration of one in-process CLI dispatch. Returns a restore function.
 *
 * Scope: ONLY the in-process runner. The standalone `duya` CLI
 * (`buildControlPlane`) never installs this guard, so its
 * `process.exit()` semantics are unchanged.
 */
function guardProcessExit(): () => void {
  const original = process.exit;
  const guarded: typeof process.exit = ((code?: unknown): never => {
    throw new InProcessCliExit(typeof code === 'number' ? code : 0);
  }) as unknown as typeof process.exit;
  (process as { exit: typeof process.exit }).exit = guarded;
  return () => {
    (process as { exit: typeof process.exit }).exit = original;
  };
}

/**
 * Build the agent-side resolver. Returns a function that takes a
 * normalized `CliInvocation` and returns a result, with the
 * same exit-code semantics as the CLI bundle.
 */
export function buildAgentRunner(): (inv: CliInvocation) => Promise<CliRunResult> {
  return async (inv) => {
    // Plan 108 — help is a virtual subcommand that lives in the
    // agent tool's dispatcher (not in the descriptor registry) so
    // `duya <command> --help` / `duya <command> help` work the same
    // way they do in the Commander-driven CLI bundle. Without this
    // branch the runner would fall through to "unknown subcommand"
    // and return exit 64. We handle it before the id-required
    // preflight so `duya help` (no command) is also valid.
    if (inv.subcommand === 'help' || inv.command === 'help') {
      return {
        exitCode: 0,
        stdout: renderHelp(
          inv.command === 'help' ? undefined : inv.command,
          parseFormat(inv.format),
        ),
        stderr: '',
      };
    }

    // Pre-flight check: subcommands that require an <id> argument
    // must return exit code 64 with a friendly hint when the id is
    // missing. This mirrors the legacy `DuyaCliTool/runner.ts`
    // behavior and keeps the agent tool's error contract stable.
    const idRequired = ID_REQUIRED_SUBCOMMANDS[`${inv.command}:${inv.subcommand ?? ''}`];
    if (idRequired && !inv.id) {
      return {
        exitCode: 64,
        stdout: '',
        stderr: `${inv.command} ${inv.subcommand} requires an <id> argument`,
      };
    }

    const resolvedSubcommand = resolveInvocationSubcommand(inv.command, inv.subcommand);
    const resolved = resolveSubcommand(CLI_DESCRIPTORS, inv.command, resolvedSubcommand);
    if (!resolved) {
      return {
        exitCode: 64,
        stdout: '',
        stderr: buildUnknownError(inv),
      };
    }
    const { sub } = resolved;

    // Argument extraction: ids come from `inv.id` (first arg) and
    // `inv.extraArgs[0]` (second arg) for two-arg subcommands like
    // `message show <sessionId> <msgId>`.
    const args: string[] = [];
    if (inv.id) args.push(inv.id);
    if (inv.extraArgs) args.push(...inv.extraArgs);

    const format: OutputFormat = parseFormat(inv.format);
    const ctx: CliSubcommandContext = {
      args,
      format,
      options: {
        yes: inv.yes,
        limit: inv.limit,
        offset: inv.offset,
        cwd: inv.cwd,
        fromFile: inv.fromFile,
        // Plan 99 P3: pass inline JSON body through to cron command
        cron: inv.cronBodyJson,
        prompt: inv.prompt,
        platform: inv.platform,
        // Plan 102 — `duya config` argv surface, forwarded to the
        // descriptor's run() via the open `options` bag.
        configId: inv.configId,
        configName: inv.configName,
        configType: inv.configType,
        configBaseUrl: inv.configBaseUrl,
        configApiKey: inv.configApiKey,
        configActive: inv.configActive,
        configEnabled: inv.configEnabled,
        configModel: inv.configModel,
        configProvider: inv.configProvider,
        configMaxTokens: inv.configMaxTokens,
        configTemperature: inv.configTemperature,
        configTopP: inv.configTopP,
        configTopK: inv.configTopK,
        configEnableThinking: inv.configEnableThinking,
        configThinkingBudget: inv.configThinkingBudget,
        configCode: inv.configCode,
        configUser: inv.configUser,
        configStyleId: inv.configStyleId,
        configInclude: inv.configInclude,
        configClear: inv.configClear,
        configArgs: inv.configArgs,
        configEnv: inv.configEnv,
        configAgents: inv.configAgents,
        agentId: inv.agentId,
        agentName: inv.agentName,
        agentDescription: inv.agentDescription,
        agentWorkspace: inv.agentWorkspace,
        agentModel: inv.agentModel,
        agentInstructionsFile: inv.agentInstructionsFile,
        agentToolsProfile: inv.agentToolsProfile,
        agentAllow: inv.agentAllow,
        agentDeny: inv.agentDeny,
        agentPlugins: inv.agentPlugins,
        enabled: inv.enabled,
        verbose: inv.verbose,
        fromPath: inv.fromPath,
        scope: inv.scope,
        deleteData: inv.deleteData,
      },
    };

    // Capture stdout/stderr for the duration of sub.run so the
    // agent's TTY is not polluted. Restore originals in `finally`.
    //
    // Guard process.exit: command code written for the standalone CLI
    // may call process.exit(code) on API failures (see writeErrorAndExit
    // in commands/mcp.ts / agent.ts / config.ts). Inside the agent
    // worker that would kill the whole process mid-chat with exit code
    // 1, no crash log and no stderr. Convert it to the regular result
    // envelope instead (exit code + captured output).
    const restoreExit = guardProcessExit();
    try {
      const { value, stdout, stderr } = await captureStreams(async () => sub.run(ctx));
      return { exitCode: value, stdout, stderr };
    } catch (err) {
      if (err instanceof InProcessCliExit) {
        const captured = (err as unknown as Record<PropertyKey, unknown>)[CAPTURED_CHUNKS] as
          | { stdout: string; stderr: string }
          | undefined;
        return {
          exitCode: err.code,
          stdout: captured?.stdout ?? '',
          stderr: captured?.stderr ?? `command aborted with exit code ${err.code}`,
        };
      }
      throw err;
    } finally {
      restoreExit();
    }
  };
}

function resolveInvocationSubcommand(
  command: string,
  subcommand: string | undefined,
): string | undefined {
  if (subcommand) return subcommand;
  const cmd = CLI_DESCRIPTORS.find((d) => d.name === command);
  if (!cmd?.subcommands) return undefined;
  const subcommandNames = Object.keys(cmd.subcommands);
  if (subcommandNames.length === 1 && subcommandNames[0] === 'default') {
    return 'default';
  }
  return undefined;
}

/**
 * Capture process.stdout / process.stderr for the duration of `fn`,
 * restoring the originals on completion (success or failure).
 *
 * This lives in `@duya/cli` (not in the agent) because it is the
 * agent's view of the contract: when the agent calls a CLI command
 * through the contract, it gets back a result envelope. The
 * contract owns the boundary; the agent doesn't have to know about
 * stdout capture at all.
 */
async function captureStreams<T>(fn: () => Promise<T>): Promise<{ value: T; stdout: string; stderr: string }> {
  const outChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);

  const captureWrite =
    (chunks: Buffer[]): ((chunk: unknown) => boolean) =>
    (chunk: unknown): boolean => {
      if (typeof chunk === 'string') {
        chunks.push(Buffer.from(chunk, 'utf-8'));
      } else if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk);
      } else {
        chunks.push(Buffer.from(String(chunk), 'utf-8'));
      }
      return true;
    };

  // Patch the streams. We use a typed cast because Node's
  // `Writable.write` has more overloads than our chunk collector.
  (process.stdout as unknown as { write: (b: unknown) => boolean }).write = captureWrite(outChunks);
  (process.stderr as unknown as { write: (b: unknown) => boolean }).write = captureWrite(errChunks);

  try {
    const value = await fn();
    return {
      value,
      stdout: Buffer.concat(outChunks).toString('utf-8'),
      stderr: Buffer.concat(errChunks).toString('utf-8'),
    };
  } catch (err) {
    // Attach partial output to the thrown error so callers can surface
    // hints written to stdout/stderr before the failure (e.g. a hint
    // written right before process.exit was intercepted).
    if (err !== null && (typeof err === 'object' || typeof err === 'function')) {
      (err as Record<PropertyKey, unknown>)[CAPTURED_CHUNKS] = {
        stdout: Buffer.concat(outChunks).toString('utf-8'),
        stderr: Buffer.concat(errChunks).toString('utf-8'),
      };
    }
    throw err;
  } finally {
    (process.stdout as unknown as { write: typeof origStdout }).write = origStdout;
    (process.stderr as unknown as { write: typeof origStderr }).write = origStderr;
  }
}

/**
 * Build a friendly "unknown command" or "unknown subcommand" error.
 */
function buildUnknownError(inv: CliInvocation): string {
  if (inv.subcommand) {
    const cmd = CLI_DESCRIPTORS.find((d) => d.name === inv.command);
    if (cmd) {
      return `unknown ${inv.command} subcommand: ${inv.subcommand} (expected: ${listSubcommandNames(cmd)})`;
    }
  }
  return `unknown command: ${inv.command} (allowed: ${listCommandNames(CLI_DESCRIPTORS)})`;
}

/**
 * Render help text for either a specific top-level command or the
 * full command list. Plan 108 — the agent tool needs the same
 * "describe the subcommands I can use" affordance the external
 * Commander CLI auto-provides via `--help` / `help [command]`. We
 * don't go through Commander (this path never touches argv parsing),
 * so we synthesize the text from the descriptor registry.
 *
 * `format: 'json'` returns a structured list so the agent can
 * consume it programmatically. `format: 'text'` returns the
 * human-readable table.
 */
export function renderHelp(
  commandName: string | undefined,
  format: OutputFormat = 'text',
): string {
  if (!commandName) {
    if (format === 'json') {
      return JSON.stringify(
        {
          commands: CLI_DESCRIPTORS.map((d) => ({
            name: d.name,
            description: d.description,
            subcommands: d.subcommands ? Object.entries(d.subcommands).map(([name, sub]) => ({
              name,
              description: sub.description,
            })) : [],
          })),
        },
        null,
        2,
      );
    }
    return renderTopLevelHelp(CLI_DESCRIPTORS);
  }

  const cmd = CLI_DESCRIPTORS.find((d) => d.name === commandName);
  if (!cmd) {
    return `unknown command: ${commandName} (allowed: ${listCommandNames(CLI_DESCRIPTORS)})`;
  }
  if (format === 'json') {
    return JSON.stringify(
      {
        command: cmd.name,
        description: cmd.description,
        subcommands: cmd.subcommands ? Object.entries(cmd.subcommands).map(([name, sub]) => ({
          name,
          description: sub.description,
        })) : [],
      },
      null,
      2,
    );
  }
  return renderCommandHelp(cmd);
}

function renderTopLevelHelp(descriptors: readonly CliCommandDescriptor[]): string {
  const nameWidth = Math.max(8, ...descriptors.map((d) => d.name.length));
  const lines: string[] = [
    'duya — DUYA desktop control plane',
    '',
    'Usage: duya <command> [subcommand] [options]',
    '',
    'Commands:',
  ];
  for (const d of descriptors) {
    lines.push(`  ${d.name.padEnd(nameWidth)}  ${d.description}`);
  }
  lines.push('');
  lines.push('Run `duya <command> help` for subcommand details.');
  return lines.join('\n');
}

function renderCommandHelp(cmd: CliCommandDescriptor): string {
  const lines: string[] = [
    `duya ${cmd.name} — ${cmd.description}`,
    '',
    `Usage: duya ${cmd.name} [subcommand] [options]`,
  ];
  if (cmd.subcommands && Object.keys(cmd.subcommands).length > 0) {
    const nameWidth = Math.max(
      6,
      ...Object.entries(cmd.subcommands).map(([n]) => n.length),
    );
    lines.push('', 'Subcommands:');
    for (const [name, sub] of Object.entries(cmd.subcommands)) {
      lines.push(`  ${name.padEnd(nameWidth)}  ${sub.description}`);
    }
  }
  lines.push('', 'Run `duya <command> --help` for option details.');
  return lines.join('\n');
}
