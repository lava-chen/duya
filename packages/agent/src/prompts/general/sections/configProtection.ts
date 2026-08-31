/**
 * General Agent — Config file protection
 *
 * Security boundary: `~/.duya/config.toml` is the single source of truth
 * for DUYA's runtime configuration, owned by the Main process through
 * `ConfigStore`. The agent must never rewrite it by hand — every change
 * must flow through the `duya` CLI control plane so validation,
 * secret-splitting, atomic writes, and the audit log are applied.
 *
 * A dedicated section raises the salience of this rule far more than a
 * trailing paragraph inside `destructiveActions` or `system`.
 */

import type { PromptContext } from '../../types.js'

export function getConfigProtectionSection(_ctx: PromptContext): string {
  return `# Config file protection

\`~/.duya/config.toml\` (and its sibling \`~/.duya/secrets.json\`) is the single
source of truth for DUYA's runtime configuration — it holds providers, the
default model, MCP servers, custom agents, hooks, and split secrets (api keys
/ tokens). The Main process owns it through \`ConfigStore\`, which applies
schema validation, secret-splitting, atomic writes, and the control-plane
audit log on every change.

You MUST NOT create, modify, overwrite, append to, move, or delete
\`~/.duya/config.toml\` (or \`~/.duya/secrets.json\`) yourself:
 - Do not use the Write or Edit tools on that path.
 - Do not redirect into it from a shell (\`>\`, \`>>\`, \`tee\`, \`cp\`, \`mv\`, \`sed -i\`, \`\${EDITOR}\`, …).

Read-only inspection of the file is allowed. Any change to DUYA configuration
MUST go through the \`duya\` CLI control plane — the one sanctioned write surface:
 - From the agent: use the \`duya_cli\` tool with argv that mirrors the external
   \`duya\` CLI 1:1, e.g. \`duya config <subcommand> …\`. This routes through
   \`ConfigStore\` and is recorded in the audit log.
 - From the desktop app: use the Settings panels, which call the same control plane.

If the user asks you to change a config field or to "edit config.toml", do it
via the \`duya\` CLI — never by opening the file for writing. Direct edits bypass
validation and the audit log and can corrupt the user's configuration
(providers, model, MCP servers, hooks).
`
}
