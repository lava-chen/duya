/**
 * packages/agent/src/tool/DuyaCliTool/DuyaCliTool.ts
 *
 * The single agent-side entry point to the DUYA CLI control plane.
 *
 * The agent must use this tool — NOT bespoke tool implementations —
 * for everything the CLI control plane covers:
 *   - system / runtime / doctor status
 *   - plugin / skill / mcp / provider state queries
 *   - session lookups
 *   - skill enable / disable (reversible; audit logged)
 *
 * The tool runs the *same* code paths the external `duya` CLI
 * bundle runs. There is no second implementation.
 */

import { z } from 'zod/v4';
import { DUYA_CLI_TOOL_NAME } from './constants.js';
import { DESCRIPTION } from './prompt.js';
import { runCliCommand, type CliInvocation } from './runner.js';
import type { OutputFormat } from '../../cli/api/format.js';
import type { Tool, ToolResult } from '../../types.js';
import type { ToolExecutor } from '../registry.js';

// Command path schema. Frozen list — matches the CLI surface that
// the agent is permitted to invoke. v0 covers read-only + skill
// enable/disable. Future writes (provider, plugin, mcp, session)
// stay out of scope until the permission model and audit strategy
// are extended to those families.
const COMMANDS = [
  'status',
  'doctor',
  'plugin',
  'session',
  'skill',
  'mcp',
  'provider',
  'install-cli',
  'uninstall-cli',
] as const;

const SUBCOMMANDS = {
  plugin: ['list', 'info'] as const,
  session: ['list', 'show'] as const,
  skill: ['list', 'info', 'enable', 'disable'] as const,
  mcp: ['list', 'info'] as const,
  provider: ['list', 'info'] as const,
} satisfies Partial<Record<typeof COMMANDS[number], readonly string[]>>;

const inputSchema = z.object({
  command: z.enum(COMMANDS).describe(
    'Top-level CLI command. One of: status | doctor | plugin | session | skill | mcp | provider | install-cli | uninstall-cli.',
  ),
  subcommand: z
    .string()
    .optional()
    .describe(
      'Required for: plugin (list|info), session (list|show), skill (list|info|enable|disable), mcp (list|info), provider (list|info). Omit for: status, doctor, install-cli, uninstall-cli.',
    ),
  id: z
    .string()
    .optional()
    .describe(
      'Skill/Plugin/Session/MCP/Provider id (required for *.info and skill enable/disable).',
    ),
  format: z
    .enum(['json', 'text'])
    .optional()
    .describe('Output format for the CLI command. Default: json. Always prefer json in agent context.'),
  yes: z
    .boolean()
    .optional()
    .describe(
      'Skip confirmation prompt. Required for skill enable / disable in non-interactive mode.',
    ),
});

export type DuyaCliInput = z.infer<typeof inputSchema>;

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

export class DuyaCliTool implements Tool, ToolExecutor {
  readonly name = DUYA_CLI_TOOL_NAME;
  readonly description = DESCRIPTION;
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        enum: [...COMMANDS],
        description:
          'Top-level CLI command. One of: status | doctor | plugin | session | skill | mcp | provider | install-cli | uninstall-cli.',
      },
      subcommand: {
        type: 'string',
        description:
          'Required for: plugin (list|info), session (list|show), skill (list|info|enable|disable), mcp (list|info), provider (list|info). Omit for: status, doctor, install-cli, uninstall-cli.',
      },
      id: {
        type: 'string',
        description:
          'Skill/Plugin/Session/MCP/Provider id (required for *.info and skill enable/disable).',
      },
      format: {
        type: 'string',
        enum: ['json', 'text'],
        description: 'Output format. Default: json.',
      },
      yes: {
        type: 'boolean',
        description: 'Skip confirmation prompt. Required for skill enable/disable.',
      },
    },
    required: ['command'],
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

    // Validate subcommand presence and set membership
    const subs = SUBCOMMANDS[data.command as keyof typeof SUBCOMMANDS];
    if (subs) {
      if (!data.subcommand) {
        return toolError(
          `command '${data.command}' requires a subcommand`,
          { allowedSubcommands: [...subs] },
        );
      }
      if (!(subs as readonly string[]).includes(data.subcommand)) {
        return toolError(
          `unknown subcommand '${data.subcommand}' for '${data.command}'`,
          { allowedSubcommands: [...subs] },
        );
      }
    } else if (data.subcommand) {
      return toolError(
        `command '${data.command}' does not accept a subcommand`,
        { subcommand: data.subcommand },
      );
    }

    const invocation: CliInvocation = {
      command: data.command,
      subcommand: data.subcommand,
      id: data.id,
      format: (data.format ?? 'json') as OutputFormat,
      yes: data.yes,
    };

    const result = await runCliCommand(invocation);

    // For json format, attempt to parse stdout so the agent can
    // consume it as a structured object instead of a string blob.
    let parsedStdout: unknown = result.stdout;
    if (data.format !== 'text') {
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
      command: data.command,
      subcommand: data.subcommand ?? null,
      exitCode: result.exitCode,
      ok: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      data: parsedStdout,
    });
  }
}

export const duyaCliTool = new DuyaCliTool();
