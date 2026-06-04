/**
 * packages/agent/src/cli/program/build-agent-runner.ts
 *
 * In-process dispatch for the `duya_cli` agent tool.
 *
 * Replaces the legacy hand-rolled `switch (inv.command)` chain in
 * `DuyaCliTool/runner.ts:116-247`. The agent tool now resolves a
 * normalized `CliInvocation` through the **same** descriptor
 * registry the CLI bundle uses, so adding a new subcommand in
 * `descriptors.ts` automatically makes it available to both the
 * `duya` CLI and the `duya_cli` agent tool.
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

    const resolved = resolveSubcommand(CLI_DESCRIPTORS, inv.command, inv.subcommand);
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
      },
    };

    const exitCode: ExitCode = await sub.run(ctx);
    return { exitCode, stdout: '', stderr: '' };
  };
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
