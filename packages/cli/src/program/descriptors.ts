/**
 * packages/agent/src/cli/program/descriptors.ts
 *
 * Single source of truth for all `duya` CLI commands.
 *
 * Both the external CLI bundle (`cli/index.ts`) and the in-process
 * agent tool (`DuyaCliTool/runner.ts`) consume the exported
 * `CLI_DESCRIPTORS` array. Adding a new top-level command is:
 *   1. Add a new entry below.
 *   2. Add the new path to `CliCommandPath` in `registry.ts`.
 *   3. (If the agent tool should expose it) update
 *      `packages/agent/src/tool/DuyaCliTool/constants.ts`.
 *
 * Subcommands are pure data: each sub's `run(ctx)` adapter
 * translates `(args[], options, format)` into the existing
 * `run*Command(format, ...args)` signature, so the legacy
 * implementations in `commands/*.ts` are not modified.
 */

import { runDoctorCommand } from '../commands/doctor.js';
import { runInstallCliCommand, runUninstallCliCommand } from '../commands/install.js';
import { runMCPAddCommand, runMCPAssignCommand, runMCPRemoveCommand } from '../commands/mcp.js';
import { runPluginCommand } from '../commands/plugin.js';
import { runProviderInfoCommand, runProviderListCommand } from '../commands/provider.js';
import { runSessionCommand } from '../commands/session.js';
import {
  runSkillDisableCommand,
  runSkillEnableCommand,
  runSkillInfoCommand,
  runSkillListCommand,
} from '../commands/skill.js';
import { runStatusCommand, runStatusCommandCtx } from '../commands/status.js';
import { runUpdateStatus, runUpdateCheck, runUpdateDownload, runUpdateInstall } from '../commands/update.js';
import { runBackupPlan, runBackupCreate, runBackupVerify, runBackupRestore } from '../commands/backup.js';
import { runSecurityAudit, runSecurityFix } from '../commands/security.js';
import { runVoiceDoctorCommand, runVoiceSetupCommand, runVoiceEnableCommand, runVoiceDisableCommand, runVoiceSetCommand } from '../commands/voice.js';
import {
  runMessageSend,
  runSkillInstall,
  runSkillUninstall,
  runSkillSync,
  runChannelTest,
  runChannelSendTest,
} from '../commands/extra.js';
import {
  runCronEnable,
  runCronDisable,
  runCronLogs,
  runGatewayReloadSecrets,
  runGatewayRpc,
} from '../commands/extra2.js';
import { runChannelCommand } from '../commands/channel.js';
import { runCronCommand } from '../commands/cron.js';
import { runMessageCommand } from '../commands/message.js';
import { runGatewayCommand } from '../commands/gateway.js';
import {
  runConfigPairingApprove,
  runConfigPairingCheck,
  runConfigPairingList,
  runConfigPairingRevoke,
  runConfigProviderAdd,
  runConfigProviderInfo,
  runConfigProviderList,
  runConfigProviderRemove,
  runConfigProviderSetDefault,
  runConfigSettingsSet,
  runConfigSettingsShow,
  runConfigStyleList,
  runConfigStyleSet,
  runConfigVisionSet,
  runConfigVisionShow,
  runConfigKvSet,
  runConfigKvGet,
  runConfigKvUnset,
  runConfigValidate,
} from '../commands/config.js';
import { runAgentList, runAgentCreate, runAgentDelete } from '../commands/agent.js';
import { runHookListCommand, runHookValidateCommand, runHookAddCommand, runHookRemoveCommand } from '../commands/hooks.js';
import { runMemoryDoctor, runMemorySetup, runMemoryStatus, runMemoryEnable, runMemoryDisable, runMemorySet } from '../commands/memory.js';

import {
  type CliSubcommand,
  type CliSubcommandContext,
  type ExitCode,
  defineDescriptors,
} from './registry.js';
import type { OutputFormat } from '../api/format.js';

const ok = (n: number): ExitCode => n as ExitCode;

/**
 * Loose signature for legacy `run*Command` functions. The adapter
 * trusts the caller to pass the right number of args (validated by
 * the descriptor's `args[]` metadata).
 */
type LegacyFn = (...args: unknown[]) => Promise<number>;

/**
 * Adapter: invoke a legacy `run*Command(format, ...args)` function
 * with the descriptor's `run(ctx)` shape.
 */
function adaptLegacy(
  fn: LegacyFn,
  argIndices: number[],
): (ctx: CliSubcommandContext) => Promise<ExitCode> {
  return async (ctx) => {
    const args = argIndices
      .map((i) => ctx.args[i])
      .filter((a): a is string => a !== undefined) as unknown[];
    const code = await fn(ctx.format, ...args);
    return ok(code);
  };
}

/**
 * Adapter for `run*InfoCommand(id, format)` legacy functions where
 * the resource id comes BEFORE the format. `adaptLegacy` would pass
 * `format` as the first arg, which routes "text" into the id slot
 * and produces "Plugin not found: text" / "Skill 'text' not found" /
 * etc. Use this adapter for the `info` subcommand family.
 */
function adaptIdFirst(
  fn: LegacyFn,
  argIndices: number[],
): (ctx: CliSubcommandContext) => Promise<ExitCode> {
  return async (ctx) => {
    const args = argIndices
      .map((i) => ctx.args[i])
      .filter((a): a is string => a !== undefined) as unknown[];
    const code = await fn(...args, ctx.format);
    return ok(code);
  };
}

/**
 * Adapter for skill-style write ops that need `yes`.
 */
function adaptWrite(
  fn: LegacyFn,
): (ctx: CliSubcommandContext) => Promise<ExitCode> {
  return async (ctx) => {
    const id = ctx.args[0];
    if (!id) {
      process.stderr.write('id argument required\n');
      return 64;
    }
    const code = await fn(id, ctx.options.yes === true, ctx.format);
    return ok(code);
  };
}

/**
 * Adapter for paginated list commands.
 */
function adaptPaginated(
  fn: LegacyFn,
): (ctx: CliSubcommandContext) => Promise<ExitCode> {
  return async (ctx) => {
    const pagination =
      ctx.options.limit !== undefined || ctx.options.offset !== undefined
        ? {
            limit: typeof ctx.options.limit === 'string' ? ctx.options.limit : undefined,
            offset: typeof ctx.options.offset === 'string' ? ctx.options.offset : undefined,
          }
        : undefined;
    const code = await fn(ctx.format, pagination);
    return ok(code);
  };
}

// ============================================================================
// Subcommand definitions
// ============================================================================

const subStatus: CliSubcommand = {
  description: 'Show the running DUYA desktop app status',
  options: [
    { flags: '--watch', description: 'Poll every 2s; Ctrl+C to stop' },
    { flags: '--interval <ms>', description: 'Watch interval in ms (default 2000; minimum 250)' },
  ],
  run: (ctx) => runStatusCommandCtx(ctx),
};

const subPluginInstall: CliSubcommand = {
  description: 'Install a plugin from the catalog (or from a local path). Phase 7 write op; --yes required in non-TTY.',
  write: true,
  args: [{ name: 'id', required: false, description: 'Catalog plugin id (omit when --from-path is set)' }],
  options: [
    { flags: '--from-path <dir>', description: 'Install a plugin from a local directory' },
    { flags: '--scope <scope>', description: 'Install scope: user | system (default user)' },
    { flags: '--yes', description: 'Skip confirmation prompt (required in non-interactive mode)' },
  ],
  run: async (ctx) => ok(await runPluginCommand.install(ctx as never)),
};

const subPluginUninstall: CliSubcommand = {
  description: 'Uninstall a plugin. Phase 7 write op; --yes required in non-TTY.',
  write: true,
  args: [{ name: 'id', required: true, description: 'Plugin id' }],
  options: [
    { flags: '--delete-data', description: 'Also delete the plugin data directory' },
    { flags: '--yes', description: 'Skip confirmation prompt' },
  ],
  run: async (ctx) => ok(await runPluginCommand.uninstall(ctx as never)),
};

const subPluginUpdate: CliSubcommand = {
  description: 'Update a plugin to the latest catalog version. Phase 7 write op; --yes required in non-TTY.',
  write: true,
  args: [{ name: 'id', required: true, description: 'Plugin id' }],
  options: [{ flags: '--yes', description: 'Skip confirmation prompt' }],
  run: async (ctx) => ok(await runPluginCommand.update(ctx as never)),
};

const subPluginList: CliSubcommand = {
  description: 'List installed plugins (id / name / version / enabled / capabilities / source)',
  options: [
    { flags: '--enabled', description: 'Only show enabled plugins' },
    { flags: '--verbose', description: 'Show detailed per-plugin blocks instead of a table' },
  ],
  run: async (ctx) => {
    const code = await runPluginCommand.list({
      enabled: ctx.options.enabled === true,
      verbose: ctx.options.verbose === true,
      format: ctx.format,
    });
    return ok(code);
  },
};

const subPluginInfo: CliSubcommand = {
  description: 'Show details for one installed plugin (adds description + permissions)',
  args: [{ name: 'id', required: true, description: 'Plugin id (e.g. com.duya.literature)' }],
  run: (ctx) => adaptIdFirst(runPluginCommand.info as LegacyFn, [0])(ctx),
};

const subPluginEnable: CliSubcommand = {
  description: 'Enable a plugin (Phase 7 write op; restart desktop app to apply). GUI-only: install/remove/update are NOT exposed via CLI.',
  write: true,
  args: [{ name: 'id', required: true, description: 'Plugin id' }],
  options: [{ flags: '--yes', description: 'Skip confirmation (required in non-interactive mode)' }],
  run: adaptWrite(runPluginCommand.enable as LegacyFn),
};

const subPluginDisable: CliSubcommand = {
  description: 'Disable a plugin (Phase 7 write op; restart desktop app to apply). GUI-only: install/remove/update are NOT exposed via CLI.',
  write: true,
  args: [{ name: 'id', required: true, description: 'Plugin id' }],
  options: [{ flags: '--yes', description: 'Skip confirmation (required in non-interactive mode)' }],
  run: adaptWrite(runPluginCommand.disable as LegacyFn),
};

const subPluginDoctor: CliSubcommand = {
  description: 'Report plugin load / manifest / registry issues (subset of duya doctor)',
  run: (ctx) => adaptLegacy(runPluginCommand.doctor as LegacyFn, [])(ctx),
};

const subSessionList: CliSubcommand = {
  description: 'List top-level user-visible sessions (id / title / updatedAt / messageCount)',
  pagination: true,
  options: [
    { flags: '--limit <n>', description: 'Page size (1–100, default 20)' },
    { flags: '--offset <n>', description: 'Page offset (≥ 0, default 0)' },
  ],
  run: adaptPaginated(runSessionCommand.list as LegacyFn),
};

const subSessionShow: CliSubcommand = {
  description: 'Show details for one top-level session (adds createdAt + model)',
  args: [{ name: 'id', required: true, description: 'Session id' }],
  run: (ctx) => adaptIdFirst(runSessionCommand.show as LegacyFn, [0])(ctx),
};

const subDoctor: CliSubcommand = {
  description: 'Run read-only diagnostic checks on DUYA runtime and data stores',
  run: (ctx) => adaptLegacy(runDoctorCommand as LegacyFn, [])(ctx),
};

const subSkillList: CliSubcommand = {
  description: 'List available skills (id / name / description / source / enabled)',
  run: (ctx) => adaptLegacy(runSkillListCommand as LegacyFn, [])(ctx),
};

const subSkillInfo: CliSubcommand = {
  description: 'Show details for one available skill',
  args: [{ name: 'id', required: true, description: 'Skill id (e.g. bundled:code-review)' }],
  run: (ctx) => adaptIdFirst(runSkillInfoCommand as LegacyFn, [0])(ctx),
};

const subSkillEnable: CliSubcommand = {
  description: 'Enable a skill (removes the disabled override). Phase 7 write op.',
  write: true,
  args: [{ name: 'id', required: true, description: 'Skill id' }],
  options: [{ flags: '--yes', description: 'Skip confirmation prompt (required in non-interactive mode)' }],
  run: adaptWrite(runSkillEnableCommand as LegacyFn),
};

const subSkillDisable: CliSubcommand = {
  description: 'Disable a skill (writes the disabled override). Phase 7 write op.',
  write: true,
  args: [{ name: 'id', required: true, description: 'Skill id' }],
  options: [{ flags: '--yes', description: 'Skip confirmation prompt (required in non-interactive mode)' }],
  run: adaptWrite(runSkillDisableCommand as LegacyFn),
};

const subSkillInstall: CliSubcommand = {
  description: 'Install a skill from a local directory. Plan 200 P4.3 write op; --yes required in non-TTY.',
  write: true,
  args: [{ name: 'id', required: false, description: 'Skill id (default: directory name)' }],
  options: [
    { flags: '--from-path <dir>', description: 'Path to a local skill directory' },
    { flags: '--yes', description: 'Skip confirmation prompt' },
  ],
  run: (ctx) => runSkillInstall(ctx),
};

const subSkillUninstall: CliSubcommand = {
  description: 'Uninstall a user-installed skill. Plan 200 P4.3 write op; --yes required in non-TTY.',
  write: true,
  args: [{ name: 'id', required: true, description: 'Skill id' }],
  options: [{ flags: '--yes', description: 'Skip confirmation prompt' }],
  run: (ctx) => runSkillUninstall(ctx),
};

const subSkillSync: CliSubcommand = {
  description: 'Re-sync bundled skills (matches what the auto-updater does). Plan 200 P4.3.',
  run: (ctx) => runSkillSync(ctx),
};

// Plan 102 / Plan 99 §3.3 Phase 7 — mcp write ops. The `mcp add`
// subcommand accepts repeatable `--arg`, `--env KEY=VAL`, and
// `--agent` flags via Commander's collect() pattern. The run
// function reads the parsed arrays from `ctx.options.configArgs` /
// `configEnv` / `configAgents` (forwarded by build-control-plane).
const subMCPAdd: CliSubcommand = {
  description: 'Add a new MCP server. Phase 7 write op. Plan 102: replaces `duya_config mcp_server_add`.',
  write: true,
  options: [
    { flags: '--server <name>', description: 'Unique MCP server name' },
    { flags: '--command <cmd>', description: 'Command to run (npx, uvx, node, etc.)' },
    { flags: '--arg <value>', description: 'Command argument (repeatable)', collect: true },
    { flags: '--env <KEY=VAL>', description: 'Environment variable (repeatable, KEY=VAL form)', collect: true },
    { flags: '--agent <id>', description: 'Agent profile id allowed to use this server (repeatable)', collect: true },
    { flags: '--yes', description: 'Skip confirmation prompt' },
  ],
  run: (ctx) => runMCPAddCommand(ctx),
};

const subMCPRemove: CliSubcommand = {
  description: 'Remove an MCP server. Phase 7 write op. Plan 102: replaces `duya_config mcp_server_remove`.',
  write: true,
  args: [{ name: 'name', required: true, description: 'MCP server name' }],
  options: [{ flags: '--yes', description: 'Skip confirmation prompt' }],
  run: (ctx) => runMCPRemoveCommand(ctx),
};

const subMCPAssign: CliSubcommand = {
  description: 'Assign allowed agent profiles to an MCP server. Phase 7 write op. Plan 102: replaces `duya_config mcp_server_assign`.',
  write: true,
  args: [{ name: 'name', required: true, description: 'MCP server name' }],
  options: [
    { flags: '--agent <id>', description: 'Agent profile id (repeatable; empty = all)', collect: true },
    { flags: '--yes', description: 'Skip confirmation prompt' },
  ],
  run: (ctx) => runMCPAssignCommand(ctx),
};

const subProviderList: CliSubcommand = {
  description: 'List configured providers (id / type / hasKey / isActive / model)',
  run: (ctx) => adaptLegacy(runProviderListCommand as LegacyFn, [])(ctx),
};

const subProviderInfo: CliSubcommand = {
  description: 'Show details for one provider (adds headers / extraEnv keys)',
  args: [{ name: 'id', required: true, description: 'Provider id (e.g. anthropic, openai, ollama)' }],
  run: (ctx) => adaptIdFirst(runProviderInfoCommand as LegacyFn, [0])(ctx),
};

const subChannelList: CliSubcommand = {
  description: 'List discovered channels (id / platform / name / guild / type / bound)',
  options: [{ flags: '--platform <platform>', description: 'Filter by platform (telegram/qq/feishu)' }],
  run: (ctx) => runChannelCommand.list(ctx),
};

const subChannelInfo: CliSubcommand = {
  description: 'Show details for one channel (adds binding + duyaSessionId)',
  args: [{ name: 'id', required: true, description: 'Channel id (platform:guild:channel form)' }],
  run: (ctx) => runChannelCommand.info(ctx),
};

const subChannelPlatforms: CliSubcommand = {
  description: 'List configured platforms (telegram / qq / feishu) with status',
  run: (ctx) => runChannelCommand.platforms(ctx),
};

const subChannelStatus: CliSubcommand = {
  description: 'Show ChannelStatus snapshot (connected / lastError / streaming / toolProgress)',
  options: [{ flags: '--platform <platform>', description: 'Filter to a single platform' }],
  run: (ctx) => runChannelCommand.status(ctx),
};

const subChannelTest: CliSubcommand = {
  description: 'Verify a channel id is well-formed. Plan 200 P4.3.',
  args: [{ name: 'channelId', required: true, description: 'Channel id (platform:guild:channel form)' }],
  run: (ctx) => runChannelTest(ctx),
};

const subChannelSendTest: CliSubcommand = {
  description: 'Record a test-send against a channel (live send ships in Plan 200 R3). Plan 200 P4.3.',
  args: [{ name: 'channelId', required: true, description: 'Channel id' }],
  options: [{ flags: '--text <text>', description: 'Test message text (default "ping from duya cli")' }],
  run: (ctx) => runChannelSendTest(ctx),
};

const subChannelSend: CliSubcommand = {
  description: 'Proactively send a plain text message to a channel via the gateway (no inbound trigger).',
  write: true,
  args: [
    { name: 'channelId', required: false, description: 'Channel id (platform:chatId form); omit when using --platform/--chat' },
    { name: 'text', required: false, description: 'Message text; may also be passed via --text' },
  ],
  options: [
    { flags: '--platform <platform>', description: 'Platform (telegram/qq/feishu); requires --chat' },
    { flags: '--chat <chatId>', description: 'Platform chat id; requires --platform' },
    { flags: '--text <text>', description: 'Message text (alternative to the positional arg)' },
  ],
  run: (ctx) => runChannelCommand.send(ctx),
};

const subCronList: CliSubcommand = {
  description: 'List all scheduled jobs (id / name / schedule / nextRunAt / lastRunAt / lastError)',
  run: (ctx) => runCronCommand.list(ctx),
};

const subCronInfo: CliSubcommand = {
  description: 'Show details for one scheduled job (adds prompt / model / concurrencyPolicy)',
  args: [{ name: 'id', required: true, description: 'Cron job id' }],
  run: (ctx) => runCronCommand.info(ctx),
};

const subCronCreate: CliSubcommand = {
  description: 'Create a new scheduled job. Phase 7 write op.',
  write: true,
  options: [
    { flags: '--from-file <path>', description: 'Path to JSON file containing the cron spec' },
    { flags: '--cron <json>', description: 'Inline JSON body (avoids needing a temp file)' },
    { flags: '--yes', description: 'Skip confirmation prompt (required in non-interactive mode)' },
  ],
  run: (ctx) => runCronCommand.create(ctx),
};

const subCronUpdate: CliSubcommand = {
  description: 'Update a scheduled job. Phase 7 write op.',
  write: true,
  args: [{ name: 'id', required: true, description: 'Cron job id' }],
  options: [
    { flags: '--from-file <path>', description: 'Path to JSON file containing the patch spec' },
    { flags: '--cron <json>', description: 'Inline JSON patch body' },
    { flags: '--yes', description: 'Skip confirmation prompt' },
  ],
  run: (ctx) => runCronCommand.update(ctx),
};

const subCronDelete: CliSubcommand = {
  description: 'Delete a scheduled job. Phase 7 write op.',
  write: true,
  args: [{ name: 'id', required: true, description: 'Cron job id' }],
  options: [{ flags: '--yes', description: 'Skip confirmation prompt' }],
  run: (ctx) => runCronCommand.delete(ctx),
};

const subCronRun: CliSubcommand = {
  description: 'Trigger a scheduled job immediately. Phase 7 write op.',
  write: true,
  args: [{ name: 'id', required: true, description: 'Cron job id' }],
  options: [{ flags: '--yes', description: 'Skip confirmation prompt' }],
  run: (ctx) => runCronCommand.run(ctx),
};

const subCronRuns: CliSubcommand = {
  description: 'List run history for a scheduled job',
  pagination: true,
  args: [{ name: 'id', required: true, description: 'Cron job id' }],
  run: (ctx) => runCronCommand.runs(ctx),
};

const subCronEnable: CliSubcommand = {
  description: 'Enable a cron job. Plan 200 P4.4 write op; --yes required in non-TTY.',
  write: true,
  args: [{ name: 'id', required: true, description: 'Cron job id' }],
  options: [{ flags: '--yes', description: 'Skip confirmation prompt' }],
  run: (ctx) => runCronEnable(ctx),
};

const subCronDisable: CliSubcommand = {
  description: 'Disable a cron job. Plan 200 P4.4 write op; --yes required in non-TTY.',
  write: true,
  args: [{ name: 'id', required: true, description: 'Cron job id' }],
  options: [{ flags: '--yes', description: 'Skip confirmation prompt' }],
  run: (ctx) => runCronDisable(ctx),
};

const subCronLogs: CliSubcommand = {
  description: 'Show recent run logs for a cron job (Plan 200 P4.4).',
  args: [{ name: 'id', required: true, description: 'Cron job id' }],
  options: [{ flags: '--limit <n>', description: 'Page size (1–200, default 20)' }],
  run: (ctx) => runCronLogs(ctx),
};

const subGatewayReloadSecrets: CliSubcommand = {
  description: 'Reload the gateway secrets snapshot. Plan 200 P4.4 (full impl ships in R4).',
  run: (ctx) => runGatewayReloadSecrets(ctx),
};

const subGatewayRpc: CliSubcommand = {
  description: 'Generic JSON-RPC proxy to the gateway process. Plan 200 P4.4 (full impl ships in R4).',
  args: [{ name: 'method', required: true, description: 'Method name' }],
  options: [{ flags: '--params <json>', description: 'JSON params payload' }],
  run: (ctx) => runGatewayRpc(ctx),
};

const subMessageList: CliSubcommand = {
  description: 'List messages in a session (id / role / msgType / createdAt / tokenUsage)',
  pagination: true,
  args: [{ name: 'sessionId', required: true, description: 'Session id' }],
  run: (ctx) => runMessageCommand.list(ctx),
};

const subMessageShow: CliSubcommand = {
  description: 'Show full details for one message (adds toolInput / thinking / attachments)',
  args: [
    { name: 'sessionId', required: true, description: 'Session id' },
    { name: 'msgId', required: true, description: 'Message id' },
  ],
  run: (ctx) => runMessageCommand.show(ctx),
};

const subMessageCount: CliSubcommand = {
  description: 'Get the message count for a session',
  args: [{ name: 'sessionId', required: true, description: 'Session id' }],
  run: (ctx) => runMessageCommand.count(ctx),
};

const subMessageSend: CliSubcommand = {
  description: 'Append a user message to a session. Plan 200 P4.3.',
  args: [
    { name: 'sessionId', required: true, description: 'Session id' },
    { name: 'content', required: true, description: 'Message text' },
  ],
  run: (ctx) => runMessageSend(ctx),
};

const subGatewayStatus: CliSubcommand = {
  description: 'Show gateway process status, pid, uptime, and channel bindings (read-only)',
  run: (ctx) => runGatewayCommand.status(ctx),
};

const subGatewayStart: CliSubcommand = {
  description: 'Start the gateway subprocess; waits up to 30s for ready. Phase 7 write op.',
  write: true,
  options: [
    { flags: '--no-wait', description: 'Return immediately after the POST resolves (fire-and-forget)' },
    { flags: '--yes', description: 'Skip confirmation prompt (required in non-interactive mode)' },
  ],
  run: (ctx) => runGatewayCommand.start(ctx),
};

const subGatewayStop: CliSubcommand = {
  description: 'Stop the gateway subprocess gracefully (SIGTERM, then SIGKILL fallback). Phase 7 write op.',
  write: true,
  options: [{ flags: '--yes', description: 'Skip confirmation prompt (required in non-interactive mode)' }],
  run: (ctx) => runGatewayCommand.stop(ctx),
};

const subGatewayRestart: CliSubcommand = {
  description: 'Stop and start the gateway subprocess; waits up to 30s for ready. Phase 7 write op.',
  write: true,
  options: [
    { flags: '--no-wait', description: 'Return immediately after the POST resolves (fire-and-forget)' },
    { flags: '--yes', description: 'Skip confirmation prompt (required in non-interactive mode)' },
  ],
  run: (ctx) => runGatewayCommand.restart(ctx),
};

const subInstallCli: CliSubcommand = {
  description: 'Install the `duya` wrapper script to invoke the bundled CLI from any shell',
  run: (ctx) => adaptLegacy(runInstallCliCommand as LegacyFn, [])(ctx),
};

const subUninstallCli: CliSubcommand = {
  description: 'Remove the `duya` wrapper script installed by `duya install-cli`',
  run: (ctx) => adaptLegacy(runUninstallCliCommand as LegacyFn, [])(ctx),
};

const subUpdateStatus: CliSubcommand = {
  description: 'Show the current updater state (version / checking / downloading / available / progress / error)',
  run: (ctx) => runUpdateStatus(ctx),
};

const subUpdateCheck: CliSubcommand = {
  description: 'Kick off an update check; reports the latest available version',
  run: (ctx) => runUpdateCheck(ctx),
};

const subUpdateDownload: CliSubcommand = {
  description: 'Start downloading the latest update. Phase 7 write op; --yes required in non-TTY.',
  write: true,
  options: [{ flags: '--yes', description: 'Skip confirmation prompt (required in non-interactive mode)' }],
  run: (ctx) => runUpdateDownload(ctx),
};

const subUpdateInstall: CliSubcommand = {
  description: 'Quit the desktop app and install the downloaded update (app will restart). Phase 7 write op; --yes required in non-TTY.',
  write: true,
  options: [{ flags: '--yes', description: 'Skip confirmation prompt (required in non-interactive mode)' }],
  run: (ctx) => runUpdateInstall(ctx),
};

const subBackupPlan: CliSubcommand = {
  description: 'Preview which paths a backup would include (no writes)',
  run: (ctx) => runBackupPlan(ctx),
};

const subBackupCreate: CliSubcommand = {
  description: 'Create a new local backup archive. Phase 7 write op; --yes required in non-TTY.',
  write: true,
  options: [
    { flags: '--output-dir <dir>', description: 'Directory to write the archive into (default: cwd)' },
    { flags: '--include-workspace', description: 'Also include the configured workspace directory' },
    { flags: '--only-config', description: 'Back up just the active config file (no DB, no sessions)' },
    { flags: '--dry-run', description: 'Preview the plan without writing' },
    { flags: '--verify', description: 'Verify the archive immediately after writing' },
    { flags: '--yes', description: 'Skip confirmation prompt (required in non-interactive mode)' },
  ],
  run: (ctx) => runBackupCreate(ctx),
};

const subBackupVerify: CliSubcommand = {
  description: 'Verify an existing backup archive',
  args: [{ name: 'archive', required: true, description: 'Path to the .tar.gz archive' }],
  run: (ctx) => runBackupVerify(ctx),
};

const subBackupRestore: CliSubcommand = {
  description: 'Restore from a backup archive. Phase 2 ships dry-run only; the live swap ships in Plan 200 R2.',
  write: true,
  args: [{ name: 'archive', required: true, description: 'Path to the .tar.gz archive' }],
  options: [
    { flags: '--dry-run', description: 'Plan only; do not touch userData' },
    { flags: '--yes', description: 'Skip confirmation prompt' },
  ],
  run: (ctx) => runBackupRestore(ctx),
};

const subSecurityAudit: CliSubcommand = {
  description: 'Run a read-only security audit on DUYA config + state. Exits 1 on high-severity findings for CI gates.',
  options: [{ flags: '--deep', description: 'Run the deeper checks (filesystem perms, etc.)' }],
  run: (ctx) => runSecurityAudit(ctx),
};

const subSecurityFix: CliSubcommand = {
  description: 'Apply auto-fixes for security findings that support it. Phase 7 write op; --yes required in non-TTY.',
  write: true,
  options: [{ flags: '--yes', description: 'Skip confirmation prompt (required in non-interactive mode)' }],
  run: (ctx) => runSecurityFix(ctx),
};

const subVoiceDoctor: CliSubcommand = {
  description: 'Read-only whisper environment diagnostics (binary detection + model cache status)',
  run: (ctx) => adaptLegacy(runVoiceDoctorCommand as LegacyFn, [])(ctx),
};

const subVoiceSetup: CliSubcommand = {
  description: 'Guided first-use setup: download + verify the configured whisper model and report binary readiness',
  write: true,
  run: (ctx) => adaptLegacy(runVoiceSetupCommand as LegacyFn, [])(ctx),
};

const subVoiceEnable: CliSubcommand = {
  description: 'Enable voice input by writing `voice.enabled = true` to the config',
  write: true,
  options: [{ flags: '--yes', description: 'Skip confirmation prompt (required in non-interactive mode)' }],
  run: (ctx) => adaptLegacy(runVoiceEnableCommand as LegacyFn, [])(ctx),
};

const subVoiceDisable: CliSubcommand = {
  description: 'Disable voice input by writing `voice.enabled = false` to the config',
  write: true,
  options: [{ flags: '--yes', description: 'Skip confirmation prompt (required in non-interactive mode)' }],
  run: (ctx) => adaptLegacy(runVoiceDisableCommand as LegacyFn, [])(ctx),
};

const subVoiceSet: CliSubcommand = {
  description: 'Write a value under the `[voice]` config section (e.g. `duya voice set stt.engine local` / `duya voice set stt.local.model ggml-base.bin`)',
  write: true,
  args: [
    { name: 'path', required: true, description: 'Dot path under voice (e.g. stt.engine)' },
    { name: 'value', required: true, description: 'Value to write (string)' },
  ],
  options: [{ flags: '--yes', description: 'Skip confirmation prompt (required in non-interactive mode)' }],
  run: (ctx) => adaptLegacy(runVoiceSetCommand as LegacyFn, [0, 1])(ctx),
};

// ============================================================================
// Plan 102 — `duya config …` subcommand tree. The single agent-side
// (and terminal-side) entry point for desktop configuration that
// replaces the legacy `duya_config` tool.
//
// The tree is flattened to match the existing 2-level pattern
// (`cron create`, `plugin enable`, etc.): every leaf subcommand is a
// direct sub of `config`, named with a dash-joined qualifier
// (`config-provider-add`, `config-settings-set`, etc.).
//
// `write: true` markers drive Plan 99 §5.1's `runPermissionGate` —
// every write op requires `--yes` in non-interactive mode.
// ============================================================================

const subConfigProviderList: CliSubcommand = {
  description: 'List configured LLM providers (id / type / hasKey / isActive / model).',
  run: (ctx) => runConfigProviderList(ctx),
};

const subConfigProviderInfo: CliSubcommand = {
  description: 'Show details for one configured provider.',
  args: [{ name: 'id', required: true, description: 'Provider id' }],
  run: (ctx) => runConfigProviderInfo(ctx),
};

const subConfigProviderAdd: CliSubcommand = {
  description: 'Add or update a provider. Plan 102 write op; replaces `duya_config provider_add`.',
  write: true,
  options: [
    { flags: '--id <id>', description: 'Provider id (unique)' },
    { flags: '--name <name>', description: 'Display name' },
    { flags: '--type <type>', description: 'Provider type: openai | anthropic | ollama | openai-compatible | gemini | deepseek' },
    { flags: '--base-url <url>', description: 'API base URL (optional)' },
    { flags: '--api-key <key>', description: 'API key (stored encrypted; optional)' },
    { flags: '--active', description: 'Mark as the active provider' },
    { flags: '--yes', description: 'Skip confirmation prompt' },
  ],
  run: (ctx) => runConfigProviderAdd(ctx),
};

const subConfigProviderRemove: CliSubcommand = {
  description: 'Remove a provider. Plan 102 write op; replaces `duya_config provider_remove`.',
  write: true,
  args: [{ name: 'id', required: true, description: 'Provider id' }],
  options: [{ flags: '--yes', description: 'Skip confirmation prompt' }],
  run: (ctx) => runConfigProviderRemove(ctx),
};

const subConfigProviderSetDefault: CliSubcommand = {
  description:
    'Set the soft default provider. The default is the implicit fallback when a thread has no explicit provider, and for vision, gateway, title generation, embedding, and scheduled automation. Pass --clear to unset the default.',
  write: true,
  args: [{ name: 'id', required: true, description: 'Provider id (ignored when --clear is set)' }],
  options: [
    { flags: '--clear', description: 'Unset the default provider' },
    { flags: '--yes', description: 'Skip confirmation prompt' },
  ],
  run: (ctx) => runConfigProviderSetDefault(ctx),
};

const subConfigSettingsShow: CliSubcommand = {
  description: 'Show current agent settings (model / maxTokens / temperature / topP / topK / enableThinking / thinkingBudget).',
  run: (ctx) => runConfigSettingsShow(ctx),
};

const subConfigSettingsSet: CliSubcommand = {
  description: 'Patch agent settings. Plan 102 write op; replaces `duya_config settings_set`.',
  write: true,
  options: [
    { flags: '--model <model>', description: 'Default model name' },
    { flags: '--max-tokens <n>', description: 'Max tokens per response' },
    { flags: '--temperature <n>', description: 'Temperature (0–2)' },
    { flags: '--top-p <n>', description: 'Top-p sampling (0–1)' },
    { flags: '--top-k <n>', description: 'Top-k sampling' },
    { flags: '--enable-thinking', description: 'Enable extended thinking' },
    { flags: '--thinking-budget <n>', description: 'Thinking token budget' },
    { flags: '--yes', description: 'Skip confirmation prompt' },
  ],
  run: (ctx) => runConfigSettingsSet(ctx),
};

const subConfigVisionShow: CliSubcommand = {
  description: 'Show current vision settings (provider / model / baseUrl / enabled).',
  run: (ctx) => runConfigVisionShow(ctx),
};

const subConfigVisionSet: CliSubcommand = {
  description: 'Patch vision settings. Plan 102 write op; replaces `duya_config vision_set` (renames `isActive` → `enabled` at the wire boundary).',
  write: true,
  options: [
    { flags: '--provider <provider>', description: 'Vision provider name' },
    { flags: '--model <model>', description: 'Vision model name' },
    { flags: '--base-url <url>', description: 'API base URL' },
    { flags: '--api-key <key>', description: 'API key (stored encrypted)' },
    { flags: '--enabled', description: 'Enable vision' },
    { flags: '--yes', description: 'Skip confirmation prompt' },
  ],
  run: (ctx) => runConfigVisionSet(ctx),
};

const subConfigStyleList: CliSubcommand = {
  description: 'List available output styles.',
  run: (ctx) => runConfigStyleList(ctx),
};

const subConfigStyleSet: CliSubcommand = {
  description: 'Set the active output style. Plan 102 write op; replaces `duya_config style_set`.',
  write: true,
  args: [{ name: 'styleId', required: true, description: 'Output style id' }],
  options: [{ flags: '--yes', description: 'Skip confirmation prompt' }],
  run: (ctx) => runConfigStyleSet(ctx),
};

const subConfigPairingList: CliSubcommand = {
  description: 'List pending + approved pairing requests.',
  options: [
    { flags: '--include <scope>', description: 'Restrict to `pending` or `approved` (default: both)' },
  ],
  run: (ctx) => runConfigPairingList(ctx),
};

const subConfigPairingApprove: CliSubcommand = {
  description: 'Approve a pending pairing code. Plan 102 write op; replaces `duya_config pairing_approve`.',
  write: true,
  options: [
    { flags: '--platform <platform>', description: 'Platform name (telegram / qq / feishu / discord / whatsapp)' },
    { flags: '--code <code>', description: '8-character pairing code' },
    { flags: '--yes', description: 'Skip confirmation prompt' },
  ],
  run: (ctx) => runConfigPairingApprove(ctx),
};

const subConfigPairingRevoke: CliSubcommand = {
  description: 'Revoke an approved pairing. Plan 102 write op; replaces `duya_config pairing_revoke`.',
  write: true,
  options: [
    { flags: '--platform <platform>', description: 'Platform name' },
    { flags: '--user <userId>', description: 'Platform user id' },
    { flags: '--yes', description: 'Skip confirmation prompt' },
  ],
  run: (ctx) => runConfigPairingRevoke(ctx),
};

const subConfigPairingCheck: CliSubcommand = {
  description: 'Check whether a (platform, user) pair is approved.',
  options: [
    { flags: '--platform <platform>', description: 'Platform name' },
    { flags: '--user <userId>', description: 'Platform user id' },
  ],
  run: (ctx) => runConfigPairingCheck(ctx),
};

const subConfigKvSet: CliSubcommand = {
  description: 'Generic config KV set. Plan 200 P4 write op; merges --value into the top-level key.',
  write: true,
  args: [{ name: 'key', required: false, description: 'agentSettings | uiPreferences | visionSettings | outputStyles | apiProviders' }],
  options: [
    { flags: '--key <key>', description: 'Top-level config key (alternative to positional arg)' },
    { flags: '--value <json>', description: 'JSON object to merge into the key' },
    { flags: '--yes', description: 'Skip confirmation prompt' },
  ],
  run: (ctx) => runConfigKvSet(ctx),
};

const subConfigKvGet: CliSubcommand = {
  description: 'Get the value at a top-level config key (returns JSON).',
  args: [{ name: 'key', required: false, description: 'agentSettings | uiPreferences | visionSettings | outputStyles | apiProviders' }],
  options: [{ flags: '--key <key>', description: 'Top-level config key (alternative to positional arg)' }],
  run: (ctx) => runConfigKvGet(ctx),
};

const subConfigKvUnset: CliSubcommand = {
  description: 'Unset a top-level config key (or a sub-path). Plan 200 P4 write op; --yes required in non-TTY.',
  write: true,
  args: [{ name: 'key', required: false, description: 'agentSettings | uiPreferences | visionSettings | outputStyles | apiProviders' }],
  options: [
    { flags: '--key <key>', description: 'Top-level config key (alternative to positional arg)' },
    { flags: '--path <dot.path>', description: 'Sub-path under the key (e.g. visionSettings.model); omit to clear the whole key' },
    { flags: '--yes', description: 'Skip confirmation prompt' },
  ],
  run: (ctx) => runConfigKvUnset(ctx),
};

const subConfigValidate: CliSubcommand = {
  description: 'Validate a candidate config value without writing. Exits 1 on invalid.',
  args: [{ name: 'key', required: false, description: 'agentSettings | uiPreferences | visionSettings | outputStyles | apiProviders' }],
  options: [
    { flags: '--key <key>', description: 'Top-level config key' },
    { flags: '--value <json>', description: 'JSON object to validate' },
  ],
  run: (ctx) => runConfigValidate(ctx),
};

// ============================================================================
// Plan 102 — `duya agent …` custom config-driven agents
// (create / list / delete). Thin wrappers around /v1/config/agents.
// ============================================================================

const subAgentList: CliSubcommand = {
  description: 'List configured custom agents (id / name / model / workspace / agents_md).',
  run: (ctx) => runAgentList(ctx),
};

const subAgentCreate: CliSubcommand = {
  description:
    'Create a custom config-driven agent. Plan 102 write op; creates the workspace dir and seeds a placeholder instructions file when needed. --yes required in non-TTY.',
  write: true,
  options: [
    { flags: '--id <id>', description: 'Agent id (defaults to a slug of --name)' },
    { flags: '--name <name>', description: 'Agent display name' },
    { flags: '--workspace <path>', description: 'Working directory for the agent' },
    { flags: '--model <model>', description: 'Default model' },
    { flags: '--instructions-file <path>', description: 'Path to a global instructions (AGENTS.md-like) file' },
    { flags: '--tools-profile <profile>', description: 'Tools profile (e.g. minimal / standard / full)' },
    { flags: '--allow <pattern>', description: 'Allow tool pattern (repeatable or comma-separated)', collect: true },
    { flags: '--deny <pattern>', description: 'Deny tool pattern (repeatable or comma-separated)', collect: true },
    { flags: '--plugins <ref>', description: 'Plugin reference (repeatable or comma-separated)', collect: true },
    { flags: '--yes', description: 'Skip confirmation prompt' },
  ],
  run: (ctx) => runAgentCreate(ctx),
};

const subAgentDelete: CliSubcommand = {
  description: 'Delete a custom config-driven agent. Plan 102 write op; --yes required in non-TTY.',
  write: true,
  args: [{ name: 'id', required: true, description: 'Agent id' }],
  options: [{ flags: '--yes', description: 'Skip confirmation prompt' }],
  run: (ctx) => runAgentDelete(ctx),
};

const subSessionSearch: CliSubcommand = {
  description: 'Search top-level user-visible sessions by title (substring match)',
  options: [
    { flags: '--q <query>', description: 'Search query (alternative to positional arg)' },
    { flags: '--limit <n>', description: 'Page size (1–100, default 20)' },
    { flags: '--offset <n>', description: 'Page offset (≥ 0, default 0)' },
  ],
  run: async (ctx) => ok(await runSessionCommand.search(ctx as never)),
};

const subSessionExport: CliSubcommand = {
  description: 'Export a session to JSON (default) or Markdown',
  args: [{ name: 'id', required: true, description: 'Session id' }],
  options: [
    { flags: '--format <json|md>', description: 'Output format (default json)' },
    { flags: '--output <path>', description: 'Write to this file instead of stdout' },
  ],
  run: async (ctx) => ok(await runSessionCommand.export(ctx as never)),
};

const subSessionImport: CliSubcommand = {
  description: 'Import a previously exported session from a JSON file',
  args: [{ name: 'file', required: true, description: 'Path to a JSON export' }],
  run: async (ctx) => ok(await runSessionCommand.import(ctx as never)),
};

// ============================================================================
// `duya hook` — hook.json registration (list / validate / add / remove)
// ============================================================================

const subHookList: CliSubcommand = {
  description: 'List hook.json files registered under [hooks] files, with per-file parse status',
  run: (ctx) => adaptLegacy(runHookListCommand as LegacyFn, [])(ctx),
};

const subHookValidate: CliSubcommand = {
  description: 'Validate a hook.json path without writing (readable + well-formed hooks object)',
  args: [{ name: 'path', required: true, description: 'Path to hook.json (absolute, or relative to ~/.duya; ~ allowed)' }],
  run: (ctx) => adaptLegacy(runHookValidateCommand as LegacyFn, [0])(ctx),
};

const subHookAdd: CliSubcommand = {
  description: 'Validate and register a hook.json path under [hooks] files. Write op; --yes required in non-TTY.',
  write: true,
  args: [{ name: 'path', required: true, description: 'Path to hook.json (absolute, or relative to ~/.duya; ~ allowed)' }],
  options: [{ flags: '--yes', description: 'Skip confirmation prompt (required in non-interactive mode)' }],
  run: (ctx) => adaptLegacy(runHookAddCommand as LegacyFn, [0])(ctx),
};

const subHookRemove: CliSubcommand = {
  description: 'Remove a hook.json path from [hooks] files. Write op; --yes required in non-TTY.',
  write: true,
  args: [{ name: 'path', required: true, description: 'Path to hook.json (as registered, or any equivalent form)' }],
  options: [{ flags: '--yes', description: 'Skip confirmation prompt (required in non-interactive mode)' }],
  run: (ctx) => adaptLegacy(runHookRemoveCommand as LegacyFn, [0])(ctx),
};

// ============================================================================
// `duya memory` — memory RAG diagnostics + config writes (plan 431)
// ============================================================================

const subMemoryDoctor: CliSubcommand = {
  description: 'Machine evaluation + current [memory.rag] config + embedding provider/model recommendation (read-only)',
  run: (ctx) => runMemoryDoctor(ctx),
};

const subMemoryStatus: CliSubcommand = {
  description: 'Show memory RAG config + index state (documents / embedding) (read-only)',
  run: (ctx) => runMemoryStatus(ctx),
};

const subMemorySetup: CliSubcommand = {
  description: 'Enable [memory.rag] and set the embedding provider/model (--auto or --provider/--model). Write op; --yes required in non-TTY.',
  write: true,
  options: [
    { flags: '--auto', description: 'Use the backend hardware/config recommendation' },
    { flags: '--provider <provider>', description: 'Embedding provider id; requires --model' },
    { flags: '--model <model>', description: 'Embedding model id (optional with --provider)' },
    { flags: '--yes', description: 'Skip confirmation prompt (required in non-interactive mode)' },
  ],
  run: (ctx) => runMemorySetup(ctx),
};

const subMemoryEnable: CliSubcommand = {
  description: 'Enable memory RAG (`memory.rag.enabled = true`). Write op; --yes required in non-TTY.',
  write: true,
  options: [{ flags: '--yes', description: 'Skip confirmation prompt (required in non-interactive mode)' }],
  run: (ctx) => runMemoryEnable(ctx),
};

const subMemoryDisable: CliSubcommand = {
  description: 'Disable memory RAG (`memory.rag.enabled = false`). Write op; --yes required in non-TTY.',
  write: true,
  options: [{ flags: '--yes', description: 'Skip confirmation prompt (required in non-interactive mode)' }],
  run: (ctx) => runMemoryDisable(ctx),
};

const subMemorySet: CliSubcommand = {
  description: 'Write a single `memory.rag.<path>` value (e.g. `enabled true`, `embedding_model bge-m3`). Write op; --yes required in non-TTY.',
  write: true,
  args: [
    { name: 'path', required: true, description: 'memory.rag key (enabled | index_path | scan_paths | embedding_enabled | embedding_provider | embedding_model)' },
    { name: 'value', required: true, description: 'Value (true/false coerced to boolean)' },
  ],
  options: [{ flags: '--yes', description: 'Skip confirmation prompt (required in non-interactive mode)' }],
  run: (ctx) => runMemorySet(ctx),
};

// ============================================================================
// Top-level descriptors (frozen order — drives help output)
// ============================================================================

export const CLI_DESCRIPTORS = defineDescriptors([
  {
    name: 'status',
    description: 'Show the running DUYA desktop app status',
    subcommands: { default: subStatus },
  },
  {
    name: 'plugin',
    description: 'Inspect, install, update, and toggle installed plugins via the DUYA desktop app',
    subcommands: {
      list: subPluginList,
      info: subPluginInfo,
      install: subPluginInstall,
      uninstall: subPluginUninstall,
      update: subPluginUpdate,
      enable: subPluginEnable,
      disable: subPluginDisable,
      doctor: subPluginDoctor,
    },
  },
  {
    name: 'session',
    description: 'Session management (list / show / search / export / import)',
    subcommands: {
      list: subSessionList,
      show: subSessionShow,
      search: subSessionSearch,
      export: subSessionExport,
      import: subSessionImport,
    },
  },
  {
    name: 'doctor',
    description: 'Run read-only diagnostic checks on DUYA runtime and data stores',
    subcommands: { default: subDoctor },
  },
  {
    name: 'skill',
    description: 'Inspect, install, sync, and toggle available skills',
    subcommands: {
      list: subSkillList,
      info: subSkillInfo,
      install: subSkillInstall,
      uninstall: subSkillUninstall,
      sync: subSkillSync,
      enable: subSkillEnable,
      disable: subSkillDisable,
    },
  },
  {
    name: 'mcp',
    description: 'Manage MCP servers (Plan 102: add/remove/assign). Read/test subcommands removed with the old MCP inventory framework.',
    subcommands: {
      add: subMCPAdd,
      remove: subMCPRemove,
      assign: subMCPAssign,
    },
  },
  {
    name: 'provider',
    description: 'Provider configuration',
    subcommands: { list: subProviderList, info: subProviderInfo },
  },
  {
    name: 'channel',
    description: 'Inspect, test, and trigger gateway IM channels (telegram / qq / feishu)',
    subcommands: {
      list: subChannelList,
      info: subChannelInfo,
      platforms: subChannelPlatforms,
      status: subChannelStatus,
      test: subChannelTest,
      'send-test': subChannelSendTest,
      send: subChannelSend,
    },
  },
  {
    name: 'cron',
    description: 'Manage scheduled jobs (list / info / create / update / delete / run / enable / disable / runs / logs)',
    subcommands: {
      list: subCronList,
      info: subCronInfo,
      create: subCronCreate,
      update: subCronUpdate,
      delete: subCronDelete,
      run: subCronRun,
      enable: subCronEnable,
      disable: subCronDisable,
      runs: subCronRuns,
      logs: subCronLogs,
    },
  },
  {
    name: 'message',
    description: 'Inspect or append messages within a session',
    subcommands: {
      list: subMessageList,
      show: subMessageShow,
      count: subMessageCount,
      send: subMessageSend,
    },
  },
  {
    name: 'gateway',
    description: 'Inspect and control the IM gateway subprocess (status / start / stop / restart / reload-secrets / rpc)',
    subcommands: {
      status: subGatewayStatus,
      start: subGatewayStart,
      stop: subGatewayStop,
      restart: subGatewayRestart,
      'reload-secrets': subGatewayReloadSecrets,
      rpc: subGatewayRpc,
    },
  },
  {
    name: 'update',
    description: 'Inspect and trigger the desktop app auto-updater (status / check / download / install)',
    subcommands: {
      status: subUpdateStatus,
      check: subUpdateCheck,
      download: subUpdateDownload,
      install: subUpdateInstall,
    },
  },
  {
    name: 'backup',
    description: 'Inspect and manage local backup archives (plan / create / verify / restore)',
    subcommands: {
      plan: subBackupPlan,
      create: subBackupCreate,
      verify: subBackupVerify,
      restore: subBackupRestore,
    },
  },
  {
    name: 'security',
    description: 'Read-only security audit + optional auto-fix (Plan 200 Phase 3)',
    subcommands: {
      audit: subSecurityAudit,
      fix: subSecurityFix,
    },
  },
  {
    name: 'voice',
    description: 'Whisper environment diagnostics, first-use setup, and voice config writes (doctor / setup / enable / disable / set)',
    subcommands: {
      doctor: subVoiceDoctor,
      setup: subVoiceSetup,
      enable: subVoiceEnable,
      disable: subVoiceDisable,
      set: subVoiceSet,
    },
  },
  {
    name: 'install-cli',
    description: 'Install the `duya` wrapper script to invoke the bundled CLI',
    subcommands: { default: subInstallCli },
  },
  {
    name: 'uninstall-cli',
    description: 'Remove the `duya` wrapper script installed by `duya install-cli`',
    subcommands: { default: subUninstallCli },
  },
  {
    name: 'agent',
    description: 'Manage custom config-driven agents (create / list / delete)',
    subcommands: {
      create: subAgentCreate,
      list: subAgentList,
      delete: subAgentDelete,
    },
  },
  {
    name: 'hook',
    description: 'Manage hook.json files registered under [hooks] files (list / validate / add / remove)',
    subcommands: {
      list: subHookList,
      validate: subHookValidate,
      add: subHookAdd,
      remove: subHookRemove,
    },
  },
  {
    name: 'memory',
    description: 'Memory RAG diagnostics and config (doctor / status / setup / enable / disable / set)',
    subcommands: {
      doctor: subMemoryDoctor,
      status: subMemoryStatus,
      setup: subMemorySetup,
      enable: subMemoryEnable,
      disable: subMemoryDisable,
      set: subMemorySet,
    },
  },
  {
    name: 'config',
    description: 'Read and modify DUYA desktop configuration (providers / agent settings / vision / output style / pairing). Plan 102: replaces the legacy `duya_config` tool.',
    subcommands: {
      // Flat subcommand naming (matches `cron create`, `plugin enable`).
      // The third level of the conceptual tree (e.g. "provider add")
      // is encoded by dashes in the sub-name. argv parser in
      // DuyaCliTool.ts maps `config-provider-add` from the agent's
      // argv; the run*Command functions read individual flags from
      // `ctx.options`.
      'provider-list': subConfigProviderList,
      'provider-info': subConfigProviderInfo,
      'provider-add': subConfigProviderAdd,
      'provider-remove': subConfigProviderRemove,
      'provider-set-default': subConfigProviderSetDefault,
      'settings-show': subConfigSettingsShow,
      'settings-set': subConfigSettingsSet,
      'vision-show': subConfigVisionShow,
      'vision-set': subConfigVisionSet,
      'style-list': subConfigStyleList,
      'style-set': subConfigStyleSet,
      'pairing-list': subConfigPairingList,
      'pairing-approve': subConfigPairingApprove,
      'pairing-revoke': subConfigPairingRevoke,
      'pairing-check': subConfigPairingCheck,
      // Phase 4.2 — generic KV.
      'kv-set': subConfigKvSet,
      'kv-get': subConfigKvGet,
      'kv-unset': subConfigKvUnset,
      'validate': subConfigValidate,
    },
  },
]);
