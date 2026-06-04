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
import { runMCPAddCommand, runMCPAssignCommand, runMCPInfoCommand, runMCPListCommand, runMCPRemoveCommand } from '../commands/mcp.js';
import { runPluginCommand } from '../commands/plugin.js';
import { runProviderInfoCommand, runProviderListCommand } from '../commands/provider.js';
import { runSessionCommand } from '../commands/session.js';
import {
  runSkillDisableCommand,
  runSkillEnableCommand,
  runSkillInfoCommand,
  runSkillListCommand,
} from '../commands/skill.js';
import { runStatusCommand } from '../commands/status.js';
import { runChannelCommand } from '../commands/channel.js';
import { runCronCommand } from '../commands/cron.js';
import { runMessageCommand } from '../commands/message.js';
import { runGatewayCommand } from '../commands/gateway.js';
import {
  runConfigPairingApprove,
  runConfigPairingCheck,
  runConfigPairingList,
  runConfigPairingRevoke,
  runConfigProviderActivate,
  runConfigProviderAdd,
  runConfigProviderInfo,
  runConfigProviderList,
  runConfigProviderRemove,
  runConfigSettingsSet,
  runConfigSettingsShow,
  runConfigStyleList,
  runConfigStyleSet,
  runConfigVisionSet,
  runConfigVisionShow,
} from '../commands/config.js';

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
  run: (ctx) => adaptLegacy(runStatusCommand as LegacyFn, [])(ctx),
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
  run: (ctx) => adaptLegacy(runPluginCommand.info as LegacyFn, [0])(ctx),
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
  run: (ctx) => adaptLegacy(runSessionCommand.show as LegacyFn, [0])(ctx),
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
  run: (ctx) => adaptLegacy(runSkillInfoCommand as LegacyFn, [0])(ctx),
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

const subMCPList: CliSubcommand = {
  description: 'List available MCP servers (id / name / source / enabled / connected)',
  run: (ctx) => adaptLegacy(runMCPListCommand as LegacyFn, [])(ctx),
};

const subMCPInfo: CliSubcommand = {
  description: 'Show details for one available MCP server (adds command / args)',
  args: [{ name: 'id', required: true, description: 'MCP id (e.g. bundled:literature)' }],
  run: (ctx) => adaptLegacy(runMCPInfoCommand as LegacyFn, [0])(ctx),
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
    { flags: '--arg <value>', description: 'Command argument (repeatable)' },
    { flags: '--env <KEY=VAL>', description: 'Environment variable (repeatable, KEY=VAL form)' },
    { flags: '--agent <id>', description: 'Agent profile id allowed to use this server (repeatable)' },
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
    { flags: '--agent <id>', description: 'Agent profile id (repeatable; empty = all)' },
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
  run: (ctx) => adaptLegacy(runProviderInfoCommand as LegacyFn, [0])(ctx),
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
    { flags: '--prompt <text>', description: 'Inline prompt (only valid for simple text-only crons)' },
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

const subConfigProviderActivate: CliSubcommand = {
  description: 'Mark a provider as the active one. Plan 102 write op; replaces `duya_config provider_activate`.',
  write: true,
  args: [{ name: 'id', required: true, description: 'Provider id' }],
  options: [{ flags: '--yes', description: 'Skip confirmation prompt' }],
  run: (ctx) => runConfigProviderActivate(ctx),
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
    description: 'Inspect and toggle installed plugins via the DUYA desktop app',
    subcommands: {
      list: subPluginList,
      info: subPluginInfo,
      enable: subPluginEnable,
      disable: subPluginDisable,
      doctor: subPluginDoctor,
    },
  },
  {
    name: 'session',
    description: 'Session management',
    subcommands: { list: subSessionList, show: subSessionShow },
  },
  {
    name: 'doctor',
    description: 'Run read-only diagnostic checks on DUYA runtime and data stores',
    subcommands: { default: subDoctor },
  },
  {
    name: 'skill',
    description: 'Inspect and toggle available skills',
    subcommands: {
      list: subSkillList,
      info: subSkillInfo,
      enable: subSkillEnable,
      disable: subSkillDisable,
    },
  },
  {
    name: 'mcp',
    description: 'Inspect and manage MCP servers (Plan 102: add/remove/assign replaces `duya_config mcp_server_*`)',
    subcommands: {
      list: subMCPList,
      info: subMCPInfo,
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
    description: 'Inspect gateway IM channels and platforms (telegram / qq / feishu)',
    subcommands: {
      list: subChannelList,
      info: subChannelInfo,
      platforms: subChannelPlatforms,
      status: subChannelStatus,
    },
  },
  {
    name: 'cron',
    description: 'Manage scheduled jobs (Phase 7 write surface for create/update/delete/run)',
    subcommands: {
      list: subCronList,
      info: subCronInfo,
      create: subCronCreate,
      update: subCronUpdate,
      delete: subCronDelete,
      run: subCronRun,
      runs: subCronRuns,
    },
  },
  {
    name: 'message',
    description: 'Inspect messages within a session (read-only)',
    subcommands: { list: subMessageList, show: subMessageShow, count: subMessageCount },
  },
  {
    name: 'gateway',
    description: 'Inspect and control the IM gateway subprocess (status / start / stop / restart)',
    subcommands: {
      status: subGatewayStatus,
      start: subGatewayStart,
      stop: subGatewayStop,
      restart: subGatewayRestart,
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
      'provider-activate': subConfigProviderActivate,
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
    },
  },
  {
    name: 'setup',
    description: 'Interactive setup wizard for configuration (legacy; preserved as-is)',
  },
]);
