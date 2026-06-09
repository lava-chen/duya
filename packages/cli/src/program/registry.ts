/**
 * packages/agent/src/cli/program/registry.ts
 *
 * Frozen command-registration contract shared by the external `duya`
 * CLI bundle and the in-process `duya_cli` agent tool.
 *
 * Adding a new top-level command is a 2-step process:
 *   1. Add the path to `CliCommandPath`.
 *   2. Add a descriptor to `descriptors.ts`.
 *
 * Adding a subcommand is a 1-step process:
 *   - Add it to the relevant descriptor's `subcommands` map.
 *
 * Both the agent tool (`DuyaCliTool/runner.ts`) and the CLI bundle
 * (`cli/index.ts`) consume `descriptors.ts` directly — there is no
 * separate dispatch table to keep in sync.
 */

import type { OutputFormat } from '../api/format.js';

/**
 * Top-level command paths recognized by the CLI.
 *
 * Frozen v1.0.0 — see `docs/design-docs/cli-control-plane/roadmap.md §3.4`.
 * Adding a new path is a breaking change for the `duya_cli` agent tool's
 * `command` field, so it must be coordinated with the agent tool's
 * command-path enum (see `packages/agent/src/tool/DuyaCliTool/constants.ts`).
 *
 * Note: `setup` was previously in this list but is no longer exposed by
 * `@duya/cli`. The interactive setup wizard lives in `@duya/agent`'s own
 * REPL entry (`packages/agent/src/cli/setup/index.ts`); users running
 * the legacy `duya-agent setup` wizard are routed through the agent
 * package, not the control plane.
 */
export type CliCommandPath =
  | 'status'
  | 'doctor'
  | 'plugin'
  | 'session'
  | 'skill'
  | 'mcp'
  | 'provider'
  | 'channel'
  | 'cron'
  | 'message'
  | 'gateway'
  | 'update'
  | 'backup'
  | 'security'
  | 'install-cli'
  | 'uninstall-cli'
  | 'config';

/**
 * Normalized invocation that every subcommand `run` function receives.
 *
 * - `args[0]` is the canonical `<id>` / `<sessionId>` / `<cronId>`
 *   depending on the subcommand.
 * - `args[1]` is the secondary id (e.g. message show needs
 *   `<sessionId> <msgId>`).
 * - `options.yes` is `true` when the user passed `--yes`.
 * - `options.limit` / `options.offset` are pagination values
 *   (parsed by the descriptor's `pagination` flag).
 */
export interface CliSubcommandContext {
  args: string[];
  options: CliSubcommandOptions;
  format: OutputFormat;
}

export interface CliSubcommandOptions {
  yes?: boolean;
  limit?: string;
  offset?: string;
  fromFile?: string;
  /** Plan 99 P3: inline JSON body for cron create/update. */
  cron?: string;
  prompt?: string;
  platform?: string;
  // Plan 102 — `duya config` argv surface, forwarded from
  // build-agent-runner / build-control-plane. Open key bag so the
  // descriptor's run() can read individual fields without forcing a
  // schema change for every new flag.
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
  [key: string]: string | boolean | string[] | undefined;
}

/**
 * All subcommand `run` functions return an exit code. Errors that
 * are user-facing are written to `process.stderr` by the run function
 * itself; the descriptor does not interpret them.
 *
 * Exit codes (frozen):
 *   0   — success
 *   1   — generic error
 *   2   — app unavailable (open DUYA and retry)
 *   3   — interactive required (write op without --yes in non-TTY)
 *   64  — usage error (unknown subcommand, missing required arg)
 */
export type ExitCode = 0 | 1 | 2 | 3 | 64;

export interface CliSubcommand {
  description: string;
  args?: CliSubcommandArg[];
  options?: CliSubcommandOption[];
  /** When true, the run function is expected to require `--yes` in
   *  non-interactive mode and to log an audit entry on success. */
  write?: boolean;
  /** When true, descriptor accepts `--limit` / `--offset` query
   *  params and passes them as `options.limit` / `options.offset`. */
  pagination?: boolean;
  run: (ctx: CliSubcommandContext) => Promise<ExitCode>;
}

export interface CliSubcommandArg {
  name: string;
  required: boolean;
  description: string;
}

export interface CliSubcommandOption {
  flags: string;
  description: string;
}

export interface CliCommandDescriptor {
  name: CliCommandPath;
  description: string;
  subcommands?: Record<string, CliSubcommand>;
}

/**
 * All descriptors, in stable order. The order here drives the
 * top-level help output. Frozen at 14 entries.
 */
export type CliDescriptorSet = readonly CliCommandDescriptor[];

/**
 * Build a frozen descriptor set from a plain array. Use this when
 * assembling descriptors in `descriptors.ts` to get a precise type.
 */
export function defineDescriptors(
  descriptors: readonly CliCommandDescriptor[],
): CliDescriptorSet {
  return Object.freeze([...descriptors]);
}

/**
 * Resolve a command + subcommand path to its descriptor entry.
 * Returns `null` if either the command or subcommand is unknown.
 */
export function resolveSubcommand(
  descriptors: CliDescriptorSet,
  command: string,
  subcommand: string | undefined,
): { command: CliCommandDescriptor; sub: CliSubcommand; subName: string } | null {
  const cmd = descriptors.find((d) => d.name === command);
  if (!cmd || !cmd.subcommands) return null;
  if (!subcommand) return null;
  const sub = cmd.subcommands[subcommand];
  if (!sub) return null;
  return { command: cmd, sub, subName: subcommand };
}

/**
 * Build the `allowed:` list for error messages, e.g.
 * "(allowed: status | plugin | ... | setup)".
 */
export function listCommandNames(descriptors: CliDescriptorSet): string {
  return descriptors.map((d) => d.name).join(' | ');
}

/**
 * Build the `expected:` list for an unknown-subcommand error, e.g.
 * "(expected: list | info | enable | disable)".
 */
export function listSubcommandNames(cmd: CliCommandDescriptor): string {
  if (!cmd.subcommands) return '(no subcommands)';
  return Object.keys(cmd.subcommands).join(' | ');
}
