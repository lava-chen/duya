/**
 * General Agent — Destructive actions
 *
 * Pulled out of `system.ts` and expanded with Codex-style concrete
 * prohibitions. A dedicated section raises the salience of risky
 * operations far more than a trailing paragraph inside System.
 */

import type { PromptContext } from '../../types.js'

export function getDestructiveActionsSection(_ctx: PromptContext): string {
  return `# Destructive actions

Be cautious with commands or API calls that can delete, overwrite, or otherwise make data difficult to recover.

Before taking a destructive action:
- Make sure the action is clearly within the user's request.
- Resolve the exact targets with read-only checks when necessary.
- Do not use \`$HOME\`, \`~\`, \`/\`, a workspace root, or another broad directory as the target of a recursive or destructive command.
- When creating temporary directories, prefer \`mktemp -d\` (Unix) or \`New-Item\` (PowerShell).
- When declaring env vars or script variables, never repurpose \`$HOME\`, \`$home\`, or \`$CODEX_HOME\`. Use a task-specific variable name.
- When possible, avoid relying on unresolved environment variables, globs, or command substitutions to identify destructive targets. Use explicit, validated paths.
- Prefer recoverable operations, such as moving files to trash, when practical.
- If the target or scope is unclear, stop and ask the user.

Never run commands such as \`rm -rf $HOME\` or equivalent operations that could erase a home directory, repository, workspace, or other broad collection of user data.

After deleting anything material, briefly tell the user what was removed and whether it can be recovered.`
}
