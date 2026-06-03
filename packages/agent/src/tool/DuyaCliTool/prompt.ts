/**
 * packages/agent/src/tool/DuyaCliTool/prompt.ts
 *
 * Frozen prompt section for the duya_cli tool.
 *
 * Mirrors the pattern in other DUYA tools: a description for the
 * JSON schema, and a getPrompt() function that returns a compact
 * section for inclusion in the agent's system prompt (see
 * prompts/agent-system.ts).
 */
import { DUYA_CLI_TOOL_NAME } from './constants.js';

export const DESCRIPTION = `Invoke the DUYA CLI control plane in-process. The CLI control plane is the single source of truth for the agent's self-inspection, capability lookups, and reversible management actions.

This is the ONLY tool you should use for:
- Checking your own state (runtime, doctor, providers, plugins, skills, MCP, sessions)
- Enabling or disabling a skill (reversible; audit logged)
- Inspecting install / uninstall of the duya CLI wrapper

Read-only by default. The two write operations exposed (skill enable / skill disable) require \`yes: true\` in non-interactive contexts and are recorded in the control-plane audit log. Provider key entry, plugin install/remove, mcp add/remove, and session delete are NOT exposed via this tool (they are GUI-only operations).

Output: the tool returns \`{ exitCode, ok, stdout, stderr, data }\` — \`data\` is the parsed JSON when \`format=json\` (the default). Always use \`format=json\` unless you are debugging.

Boundary rules:
- This tool is the agent-side counterpart to the \`duya\` CLI. Do NOT create parallel tools that re-implement plugin / skill / mcp / provider / session reads; that is the CLI's job.
- Frozen DTO fields: see \`docs/design-docs/cli-control-plane/roadmap.md\`. Field names and types are stable for automation. Do not assume fields outside the documented DTO exist.`;

export function getPrompt(): string {
  return `Tool: ${DUYA_CLI_TOOL_NAME} — invoke the DUYA CLI control plane

Use this tool for self-inspection and reversible management. It is the only entry point for:
  - status / doctor
  - plugin list / plugin info <id>
  - skill list / skill info <id> / skill enable <id> / skill disable <id>
  - mcp list / mcp info <id>
  - provider list / provider info <id>
  - session list / session show <id>
  - install-cli / uninstall-cli

Inputs:
  - command (required): one of the top-level commands above
  - subcommand: required for plugin / session / skill / mcp / provider
  - id: required for *.info and skill enable/disable
  - format: 'json' (default) or 'text' (debug only)
  - yes: must be true for skill enable/disable when running headlessly

Output: \`{ exitCode, ok, stdout, stderr, data }\` — \`data\` is the parsed JSON when format=json.

Boundary: do NOT re-implement plugin / skill / mcp / provider / session reads as separate tools. They would diverge from the CLI's frozen DTOs.`;
}
