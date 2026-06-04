/**
 * packages/agent/src/tool/DuyaCliTool/DuyaCliTool.ts
 *
 * The single agent-side entry point to the DUYA CLI control plane.
 *
 * The agent must use this tool — NOT bespoke tool implementations —
 * for everything the CLI control plane covers.
 *
 * ## Two invocation styles
 *
 * 1. **Structured** (legacy Phase 8, frozen):
 *    ```
 *    { command, subcommand?, id?, format?, yes? }
 *    ```
 *    Preserved for backward compatibility with the original Phase 8
 *    frozen contract (see `docs/design-docs/cli-control-plane/roadmap.md`
 *    §6 Phase 8). New code should prefer argv.
 *
 * 2. **argv** (Plan 99):
 *    ```
 *    { argv: ['cron', 'list', '--format', 'json'] }
 *    ```
 *    Mirrors the external `duya` CLI bundle 1:1. No translation layer,
 *    no schema drift — what the agent sends is what the user would
 *    type at the terminal. This unlocks the full CLI surface
 *    (including channel/cron/message added in plan 98) without
 *    touching the agent's Zod schema.
 *
 * ## Schema
 *
 * The Zod `inputSchema` is **derived from `descriptors.ts`** (Plan 99)
 * so the enum of valid `command` values is auto-generated and stays
 * in sync with the descriptor registry. argv-style bypasses the
 * structured enum entirely and goes through the same `buildAgentRunner`
 * dispatcher.
 */

import { z } from 'zod/v4';
import { DUYA_CLI_TOOL_NAME } from './constants.js';
import { DESCRIPTION } from './prompt.js';
import { runCliCommand, type CliInvocation } from './runner.js';
import type { OutputFormat } from '@duya/cli/contract';
import { CLI_DESCRIPTORS } from '@duya/cli/contract';
import type { CliCommandPath } from '@duya/cli/contract';
import type { Tool, ToolResult } from '../../types.js';
import type { ToolExecutor } from '../registry.js';

// ---------------------------------------------------------------------------
// Schema (Plan 99 — auto-generated enum from descriptors)
// ---------------------------------------------------------------------------

/**
 * Frozen v1.0.0 set of top-level command paths the agent may invoke.
 * Auto-derived from `CLI_DESCRIPTORS` so the two cannot drift.
 */
const COMMANDS: readonly CliCommandPath[] = CLI_DESCRIPTORS.map((d) => d.name);

/**
 * Subcommand map: `command -> [allowed subcommand names]`. Auto-derived.
 */
const SUBCOMMANDS: Partial<Record<CliCommandPath, readonly string[]>> = Object.fromEntries(
  CLI_DESCRIPTORS.filter((d) => d.subcommands).map((d) => [
    d.name,
    Object.keys(d.subcommands!),
  ]),
);

const inputSchema = z
  .object({
    // argv-style (Plan 99 — preferred for new code)
    argv: z
      .array(z.string())
      .optional()
      .describe(
        'Positional CLI argv, mirrors the external `duya` CLI 1:1. Example: ["cron", "list", "--format", "json"]. Mutually exclusive with command/subcommand fields.',
      ),
    format: z
      .enum(['json', 'text'])
      .optional()
      .describe(
        'Output format. Applies to structured command/subcommand style and as the default for argv style. Default: json. Always prefer json in agent context.',
      ),
    yes: z
      .boolean()
      .optional()
      .describe(
        'Skip confirmation prompt. Required for write operations in non-interactive mode.',
      ),

    // Structured (Phase 8, frozen — preserved for backward compat)
    command: z
      .enum(COMMANDS as [CliCommandPath, ...CliCommandPath[]])
      .optional()
      .describe(
        'Top-level CLI command (Phase 8 frozen enum). Prefer `argv` for new code.',
      ),
    subcommand: z
      .string()
      .optional()
      .describe(
        'Subcommand for the top-level command (Phase 8 style). Use `argv` for new code.',
      ),
    id: z
      .string()
      .optional()
      .describe('Skill/Plugin/Session/MCP/Provider id (Phase 8 style).'),
  })
  .refine((data) => data.argv !== undefined || data.command !== undefined, {
    message: 'either argv or command must be provided',
  });

export type DuyaCliInput = z.infer<typeof inputSchema>;

// ---------------------------------------------------------------------------
// Envelope helpers
// ---------------------------------------------------------------------------

function toolSuccess(payload: unknown): ToolResult {
  return {
    id: crypto.randomUUID(),
    name: DUYA_CLI_TOOL_NAME,
    result: JSON.stringify(payload, null, 2),
  };
}

function toolError(message: string, extra?: Record<string, unknown>): ToolResult {
  return {
    id: crypto.randomUUID(),
    name: DUYA_CLI_TOOL_NAME,
    result: JSON.stringify({ error: message, ...(extra ?? {}) }),
    error: true,
  };
}

// ---------------------------------------------------------------------------
// argv-style parser
// ---------------------------------------------------------------------------

/**
 * Parse `argv` into a `CliInvocation` understood by `runCliCommand`.
 * Supports `--key value` and `--key=value` forms. Unknown flags are
 * passed through as strings under `extraArgs` (or ignored if the
 * descriptor has a `pagination` / `write` flag, etc.).
 */
function parseArgv(argv: string[]): CliInvocation {
  const out: CliInvocation = { command: '', extraArgs: [] };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--format' && i + 1 < argv.length) {
      out.format = argv[++i];
      continue;
    }
    if (tok.startsWith('--format=')) {
      out.format = tok.slice('--format='.length);
      continue;
    }
    if (tok === '--yes') {
      out.yes = true;
      continue;
    }
    if (tok === '--limit' && i + 1 < argv.length) {
      out.limit = argv[++i];
      continue;
    }
    if (tok.startsWith('--limit=')) {
      out.limit = tok.slice('--limit='.length);
      continue;
    }
    if (tok === '--offset' && i + 1 < argv.length) {
      out.offset = argv[++i];
      continue;
    }
    if (tok.startsWith('--offset=')) {
      out.offset = tok.slice('--offset='.length);
      continue;
    }
    if (tok === '--platform' && i + 1 < argv.length) {
      out.platform = argv[++i];
      continue;
    }
    if (tok.startsWith('--platform=')) {
      out.platform = tok.slice('--platform='.length);
      continue;
    }
    if (tok === '--from-file' && i + 1 < argv.length) {
      out.fromFile = argv[++i];
      continue;
    }
    if (tok.startsWith('--from-file=')) {
      out.fromFile = tok.slice('--from-file='.length);
      continue;
    }
    if (tok === '--cron' && i + 1 < argv.length) {
      // Plan 99 P3: inline JSON body for cron create
      out.cronBodyJson = argv[++i];
      continue;
    }
    if (tok.startsWith('--cron=')) {
      out.cronBodyJson = tok.slice('--cron='.length);
      continue;
    }
    if (tok === '--prompt' && i + 1 < argv.length) {
      out.prompt = argv[++i];
      continue;
    }
    if (tok.startsWith('--prompt=')) {
      out.prompt = tok.slice('--prompt='.length);
      continue;
    }
    // Plan 102 (config command) — provider / settings / vision / style / pairing flags
    if (tok === '--id' && i + 1 < argv.length) { out.configId = argv[++i]; continue; }
    if (tok.startsWith('--id=')) { out.configId = tok.slice('--id='.length); continue; }
    if (tok === '--name' && i + 1 < argv.length) { out.configName = argv[++i]; continue; }
    if (tok.startsWith('--name=')) { out.configName = tok.slice('--name='.length); continue; }
    if (tok === '--type' && i + 1 < argv.length) { out.configType = argv[++i]; continue; }
    if (tok.startsWith('--type=')) { out.configType = tok.slice('--type='.length); continue; }
    if (tok === '--base-url' && i + 1 < argv.length) { out.configBaseUrl = argv[++i]; continue; }
    if (tok.startsWith('--base-url=')) { out.configBaseUrl = tok.slice('--base-url='.length); continue; }
    if (tok === '--api-key' && i + 1 < argv.length) { out.configApiKey = argv[++i]; continue; }
    if (tok.startsWith('--api-key=')) { out.configApiKey = tok.slice('--api-key='.length); continue; }
    if (tok === '--active') { out.configActive = true; continue; }
    if (tok === '--enabled') { out.configEnabled = true; continue; }
    if (tok === '--model' && i + 1 < argv.length) { out.configModel = argv[++i]; continue; }
    if (tok.startsWith('--model=')) { out.configModel = tok.slice('--model='.length); continue; }
    if (tok === '--provider' && i + 1 < argv.length) { out.configProvider = argv[++i]; continue; }
    if (tok.startsWith('--provider=')) { out.configProvider = tok.slice('--provider='.length); continue; }
    if (tok === '--max-tokens' && i + 1 < argv.length) { out.configMaxTokens = argv[++i]; continue; }
    if (tok.startsWith('--max-tokens=')) { out.configMaxTokens = tok.slice('--max-tokens='.length); continue; }
    if (tok === '--temperature' && i + 1 < argv.length) { out.configTemperature = argv[++i]; continue; }
    if (tok.startsWith('--temperature=')) { out.configTemperature = tok.slice('--temperature='.length); continue; }
    if (tok === '--top-p' && i + 1 < argv.length) { out.configTopP = argv[++i]; continue; }
    if (tok.startsWith('--top-p=')) { out.configTopP = tok.slice('--top-p='.length); continue; }
    if (tok === '--top-k' && i + 1 < argv.length) { out.configTopK = argv[++i]; continue; }
    if (tok.startsWith('--top-k=')) { out.configTopK = tok.slice('--top-k='.length); continue; }
    if (tok === '--enable-thinking') { out.configEnableThinking = true; continue; }
    if (tok === '--thinking-budget' && i + 1 < argv.length) { out.configThinkingBudget = argv[++i]; continue; }
    if (tok.startsWith('--thinking-budget=')) { out.configThinkingBudget = tok.slice('--thinking-budget='.length); continue; }
    if (tok === '--code' && i + 1 < argv.length) { out.configCode = argv[++i]; continue; }
    if (tok.startsWith('--code=')) { out.configCode = tok.slice('--code='.length); continue; }
    if (tok === '--user' && i + 1 < argv.length) { out.configUser = argv[++i]; continue; }
    if (tok.startsWith('--user=')) { out.configUser = tok.slice('--user='.length); continue; }
    if (tok === '--style-id' && i + 1 < argv.length) { out.configStyleId = argv[++i]; continue; }
    if (tok.startsWith('--style-id=')) { out.configStyleId = tok.slice('--style-id='.length); continue; }
    if (tok === '--include' && i + 1 < argv.length) { out.configInclude = argv[++i]; continue; }
    if (tok.startsWith('--include=')) { out.configInclude = tok.slice('--include='.length); continue; }
    // Plan 102 (mcp add) — repeatable flags
    if (tok === '--arg' && i + 1 < argv.length) { (out.configArgs ??= []).push(argv[++i]); continue; }
    if (tok.startsWith('--arg=')) { (out.configArgs ??= []).push(tok.slice('--arg='.length)); continue; }
    if (tok === '--env' && i + 1 < argv.length) { (out.configEnv ??= []).push(argv[++i]); continue; }
    if (tok.startsWith('--env=')) { (out.configEnv ??= []).push(tok.slice('--env='.length)); continue; }
    if (tok === '--agent' && i + 1 < argv.length) { (out.configAgents ??= []).push(argv[++i]); continue; }
    if (tok.startsWith('--agent=')) { (out.configAgents ??= []).push(tok.slice('--agent='.length)); continue; }
    if (tok.startsWith('--')) {
      // Unknown long flag — skip value if next token is not a flag
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) i++;
      continue;
    }
    // Positional arg
    if (out.command === '') {
      out.command = tok;
    } else if (out.subcommand === undefined) {
      out.subcommand = tok;
    } else if (out.id === undefined) {
      out.id = tok;
    } else {
      out.extraArgs!.push(tok);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tool class
// ---------------------------------------------------------------------------

export class DuyaCliTool implements Tool, ToolExecutor {
  readonly name = DUYA_CLI_TOOL_NAME;
  readonly description = DESCRIPTION;
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    description:
      'Single agent-side entry point to the DUYA CLI control plane. Two styles supported: structured (command/subcommand/id) or argv (preferred for new code).',
    properties: {
      argv: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Positional CLI argv, 1:1 with the external `duya` CLI. Example: ["cron", "list", "--format", "json"]. Preferred for new code.',
      },
      command: {
        type: 'string',
        enum: [...COMMANDS],
        description:
          'Top-level CLI command (Phase 8 frozen enum). Auto-derived from the descriptor registry. Prefer `argv` for new code.',
      },
      subcommand: {
        type: 'string',
        description:
          'Subcommand for the top-level command. Required for plugin/session/skill/mcp/provider/channel/cron/message.',
      },
      id: {
        type: 'string',
        description: 'Resource id (plugin/skill/session/mcp/provider/channel/cron).',
      },
      format: {
        type: 'string',
        enum: ['json', 'text'],
        description: 'Output format. Default: json. Always prefer json in agent context.',
      },
      yes: {
        type: 'boolean',
        description: 'Skip confirmation prompt for write operations.',
      },
    },
    required: [],
  };

  toTool(): Tool {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.input_schema,
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) {
      return toolError(`Invalid input: ${parsed.error.message}`);
    }
    const data = parsed.data;

    // ---------------------------------------------------------------
    // Resolve invocation: argv OR structured
    // ---------------------------------------------------------------
    let invocation: CliInvocation;

    if (data.argv !== undefined) {
      if (data.argv.length === 0) {
        return toolError('argv must be a non-empty array');
      }
      if (data.command !== undefined || data.subcommand !== undefined || data.id !== undefined) {
        return toolError(
          'argv is mutually exclusive with command/subcommand/id (use one style only)',
        );
      }
      invocation = parseArgv(data.argv);
      if (data.format !== undefined) invocation.format = data.format;
      if (data.yes !== undefined) invocation.yes = data.yes;
    } else {
      // Structured (Phase 8) — preserved for backward compat
      const command = data.command!;
      const subs = SUBCOMMANDS[command as keyof typeof SUBCOMMANDS];
      if (subs && subs.length > 0 && !subs.includes('default')) {
        // Multi-subcommand surface: require + validate subcommand
        if (!data.subcommand) {
          return toolError(`command '${command}' requires a subcommand`, {
            allowedSubcommands: [...subs],
          });
        }
        if (!subs.includes(data.subcommand)) {
          return toolError(`unknown subcommand '${data.subcommand}' for '${command}'`, {
            allowedSubcommands: [...subs],
          });
        }
      } else if (data.subcommand) {
        // Single-subcommand surface (status / doctor / install-cli etc.):
        // any subcommand is rejected with the legacy "does not accept" hint.
        return toolError(`command '${command}' does not accept a subcommand`, {
          subcommand: data.subcommand,
        });
      }
      invocation = {
        command,
        subcommand: data.subcommand,
        id: data.id,
        format: (data.format ?? 'json') as OutputFormat,
        yes: data.yes,
      };
    }

    // ---------------------------------------------------------------
    // Dispatch
    // ---------------------------------------------------------------
    const result = await runCliCommand(invocation);

    // For json format, attempt to parse stdout so the agent can
    // consume it as a structured object instead of a string blob.
    let parsedStdout: unknown = result.stdout;
    const fmt = (invocation.format ?? 'json') as OutputFormat;
    if (fmt !== 'text') {
      const trimmed = result.stdout.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          parsedStdout = JSON.parse(trimmed);
        } catch {
          // keep as string
        }
      }
    }

    return toolSuccess({
      command: invocation.command,
      subcommand: invocation.subcommand ?? null,
      argv: invocation.extraArgs,
      exitCode: result.exitCode,
      ok: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      data: parsedStdout,
    });
  }
}

export const duyaCliTool = new DuyaCliTool();
