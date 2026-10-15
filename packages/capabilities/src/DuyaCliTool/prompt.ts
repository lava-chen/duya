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

export const DESCRIPTION = `Invoke the DUYA CLI control plane in-process. The CLI control plane is the single source of truth for the agent's self-inspection, capability lookups, and reversible management actions — it runs the same code paths the external \`duya\` CLI bundle runs.

The full command surface (top-level commands, subcommands, flags, write/read classification) is defined by the \`command\` enum and \`argv\` schema below, which are auto-derived from the CLI descriptor registry; treat them as authoritative rather than memorising a list here.

Write operations exposed by this tool (skill enable/disable, cron create/update/delete, mcp add/remove/assign, channel create/update/delete, message send) require \`yes: true\` in non-interactive contexts and are recorded in the control-plane audit log. GUI-only operations — provider key entry, plugin install/remove/update, session delete — are intentionally NOT exposed via this tool; point users at the desktop app panel.

Output: the tool returns \`{ exitCode, ok, stdout, stderr, data }\` — \`data\` is the parsed JSON when \`format=json\` (the default). Always use \`format=json\` unless you are debugging.

Boundary: this tool is the agent-side counterpart to the \`duya\` CLI. Do NOT create parallel tools that re-implement plugin / skill / mcp / provider / session / channel / cron / message reads; that is the CLI's job. Frozen DTO fields: see \`docs/design-docs/cli-control-plane/roadmap.md\` — field names and types are stable for automation. Do not assume fields outside the documented DTO exist.`;

export function getPrompt(): string {
  // Single-source-of-truth principle: the tool's `description` (above) and
  // its JSON-schema `input_schema` together carry the full CLI surface
  // (commands, flags, output envelope, DTO stability). This section only
  // adds behaviour-level guidance that the schema cannot express.
  return `Tool: ${DUYA_CLI_TOOL_NAME}

Boundary: do NOT re-implement plugin / skill / mcp / provider / session /
channel / cron / message reads as separate tools. They would diverge
from the CLI's frozen DTOs. The CLI is the single source of truth.`;
}
