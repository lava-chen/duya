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
  configArgs?: string[];
  configEnv?: string[];
  configAgents?: string[];
}

export interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Build the agent-side resolver. Returns a function that takes a
 * normalized `CliInvocation` and returns a result, with the
 * same exit-code semantics as the CLI bundle.
 */
export function buildAgentRunner(): (inv: CliInvocation) => Promise<CliRunResult> {
  return async (inv) => {
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
        configArgs: inv.configArgs,
        configEnv: inv.configEnv,
        configAgents: inv.configAgents,
      },
    };

    // Capture stdout/stderr for the duration of sub.run so the
    // agent's TTY is not polluted. Restore originals in `finally`.
    const { value, stdout, stderr } = await captureStreams(async () => sub.run(ctx));
    return { exitCode: value, stdout, stderr };
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
